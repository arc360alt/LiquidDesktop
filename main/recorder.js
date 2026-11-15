// Screen recording (the screenshot tool's Record mode): ffmpeg grabs the X screen (all or part of it), with
// the microphone and/or what the computer plays (PulseAudio / PipeWire), and encodes it on the graphics card when
// it can (NVENC on NVIDIA, VA-API on AMD / Intel), on the processor otherwise.
// Saved to ~/Videos/ScreenRecordings (Settings › General › Screen Recordings) when you stop it.
const { ipcMain, webContents, app } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const FORMATS = { mp4: 'aac', mov: 'aac', mkv: 'libopus', webm: 'libopus' };
const broadcast = (ch, ...a) => { for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.getType() !== 'webview') wc.send(ch, ...a); };
const out = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 3000 }, (err, so) => resolve(err ? '' : String(so).trim())));
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

let mode = 'windowed';
let rec = null;        // { proc, file, started, opts }
let ffmpeg = null;     // its path, once found

const findFfmpeg = () => {
  if (ffmpeg !== null) return ffmpeg;
  for (const d of (process.env.PATH || '/usr/bin').split(':')) if (exists(path.join(d, 'ffmpeg'))) return (ffmpeg = path.join(d, 'ffmpeg'));
  return (ffmpeg = '');
};
const nvidia = () => exists('/proc/driver/nvidia/version') || exists('/sys/module/nvidia_drm');
const renderNode = () => ['/dev/dri/renderD128', '/dev/dri/renderD129'].find(exists);

// the video encoders to try, best first: the first one that starts is used
function encoders(format) {
  const node = renderNode(), list = [];
  const vaapi = (codec, extra = []) => node && list.push({ name: codec, pre: ['-vaapi_device', node], args: ['-vf', 'format=nv12,hwupload', '-c:v', codec, ...extra] });
  if (format === 'webm') {
    if (nvidia()) list.push({ name: 'av1_nvenc', args: ['-c:v', 'av1_nvenc', '-preset', 'p4', '-cq', '32', '-pix_fmt', 'yuv420p'] });
    vaapi('av1_vaapi', ['-qp', '120']);
    vaapi('vp9_vaapi', ['-global_quality', '60']);
    list.push({ name: 'libvpx-vp9', args: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '0', '-crf', '34', '-pix_fmt', 'yuv420p'] });
    return list;
  }
  if (nvidia()) list.push({ name: 'h264_nvenc', args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23', '-pix_fmt', 'yuv420p'] });
  vaapi('h264_vaapi', ['-qp', '23']);
  list.push({ name: 'libx264', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'] });
  return list;
}

// the folder recordings go in: the setting, else ~/Videos/ScreenRecordings (your own Videos folder if it's renamed)
async function folder(dir) {
  if (dir) return dir.replace(/^~(?=\/|$)/, HOME);
  const videos = (await out('xdg-user-dir', ['VIDEOS'])) || path.join(HOME, 'Videos');
  return path.join(videos && videos !== HOME ? videos : path.join(HOME, 'Videos'), 'ScreenRecordings');
}

// the PulseAudio sources: the microphone, and the "monitor" of the speakers (what the computer plays)
async function audioSources(opts) {
  const list = [];
  if (opts.mic) list.push((await out('pactl', ['get-default-source'])) || 'default');
  if (opts.desktop) { const sink = await out('pactl', ['get-default-sink']); if (sink) list.push(sink + '.monitor'); }
  return list;
}

/** Start one ffmpeg; resolves once it's recording, rejects with its error when it can't start. */
function launch(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(findFfmpeg(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '', done = false;
    const ok = () => { if (!done) { done = true; resolve(proc); } };
    proc.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
      if (/Press \[q\]|frame=\s*\d/.test(err)) ok();
    });
    proc.on('error', (e) => { if (!done) { done = true; reject(e); } });
    proc.on('exit', (code) => { if (!done) { done = true; reject(new Error(lastLine(err) || `ffmpeg stopped (${code})`)); } });
    setTimeout(ok, 6000);   // it hasn't said so, but it hasn't failed either
  });
}
const lastLine = (s) => s.split('\n').map((l) => l.trim()).filter((l) => l && !/^\s*(frame|size)=/.test(l)).pop() || '';

async function start(o = {}) {
  if (rec) throw new Error('Already recording');
  if (mode !== 'session' || !process.env.DISPLAY) throw new Error('Screen recording works in the LiquidDesktop session');
  if (!findFfmpeg()) throw new Error('Screen recording needs ffmpeg (install the ffmpeg package)');
  const format = FORMATS[o.format] ? o.format : 'mp4';
  const fps = [24, 30, 60].includes(+o.fps) ? +o.fps : 60;
  // x11grab and most encoders want even sizes
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  // and an area inside the screen (x11grab won't start otherwise)
  const { screen } = require('electron');
  const sw = Math.max(...screen.getAllDisplays().map((d) => Math.round((d.bounds.x + d.bounds.width) * (d.scaleFactor || 1))));
  const sh = Math.max(...screen.getAllDisplays().map((d) => Math.round((d.bounds.y + d.bounds.height) * (d.scaleFactor || 1))));
  const x = Math.min(Math.max(0, Math.round(o.x || 0)), sw - 16), y = Math.min(Math.max(0, Math.round(o.y || 0)), sh - 16);
  const r = { x, y, w: even(Math.min(o.w || 0, sw - x)), h: even(Math.min(o.h || 0, sh - y)) };
  if (r.w < 16 || r.h < 16) throw new Error('That area is too small to record');

  const dir = await folder(o.dir);
  await fsp.mkdir(dir, { recursive: true });
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  const file = path.join(dir, `Screen Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.${format}`);

  const sources = await audioSources(o);
  const video = ['-thread_queue_size', '512', '-f', 'x11grab', '-draw_mouse', o.pointer === false ? '0' : '1', '-framerate', String(fps),
    '-video_size', `${r.w}x${r.h}`, '-i', `${process.env.DISPLAY}+${r.x},${r.y}`];
  const audio = sources.flatMap((s) => ['-thread_queue_size', '1024', '-f', 'pulse', '-i', s]);
  const mix = sources.length === 2 ? ['-filter_complex', '[1:a][2:a]amix=inputs=2:duration=longest:normalize=0[a]', '-map', '0:v', '-map', '[a]']
    : sources.length === 1 ? ['-map', '0:v', '-map', '1:a'] : ['-map', '0:v'];
  const acodec = sources.length ? ['-c:a', FORMATS[format], '-b:a', '160k'] : [];
  const tail = [...(format === 'mp4' || format === 'mov' ? ['-movflags', '+faststart'] : []), '-y', file];

  let lastErr = null;
  for (const enc of encoders(format)) {
    try {
      const proc = await launch(['-hide_banner', '-loglevel', 'info', '-nostats', ...(enc.pre || []), ...video, ...audio, ...mix, ...enc.args, '-r', String(fps), ...acodec, ...tail]);
      rec = { proc, file, started: Date.now(), encoder: enc.name, stopping: null };
      proc.on('exit', () => {
        if (rec?.proc !== proc || rec.stopping) return;   // stopped on purpose: stop() reports it
        // it stopped by itself (the screen went away, the disk filled…): what was recorded is still saved
        const was = rec; rec = null;
        broadcast('rec:changed', { recording: false, file: exists(was.file) ? was.file : null, error: 'The recording stopped unexpectedly' });
      });
      broadcast('rec:changed', status());
      return status();
    } catch (e) {
      lastErr = e;
      await fsp.rm(file, { force: true }).catch(() => {});
    }
  }
  throw new Error('Could not start recording: ' + (lastErr?.message || 'no video encoder works'));
}

function stop() {
  if (!rec) return Promise.resolve({ file: null });
  if (rec.stopping) return rec.stopping;
  const r = rec;
  r.stopping = new Promise((resolve) => {
    const kill = setTimeout(() => r.proc.kill('SIGINT'), 5000);
    const hard = setTimeout(() => r.proc.kill('SIGKILL'), 12000);
    r.proc.once('exit', () => {
      clearTimeout(kill); clearTimeout(hard);
      if (rec === r) rec = null;
      const file = exists(r.file) ? r.file : null;
      broadcast('rec:changed', { recording: false, file, seconds: Math.round((Date.now() - r.started) / 1000) });
      resolve({ file });
    });
    try { r.proc.stdin.write('q'); r.proc.stdin.end(); } catch { r.proc.kill('SIGINT'); }
  });
  return r.stopping;
}

const status = () => ({
  supported: mode === 'session' && !!process.env.DISPLAY && !!findFfmpeg(),
  recording: !!rec, started: rec?.started || 0, file: rec?.file || null, encoder: rec?.encoder || null,
});

function register(o = {}) {
  mode = o.mode || 'windowed';
  const h = (name, fn) => ipcMain.handle(name, async (_e, ...a) => { try { return await fn(...a); } catch (e) { return { __error: e.message }; } });
  h('rec:start', start);
  h('rec:stop', stop);
  h('rec:status', status);
  h('rec:folder', (dir) => folder(dir));
  // logging out mid-recording: finish the file properly first
  let quitting = false;
  app.on('before-quit', (e) => {
    if (!rec || quitting) return;
    quitting = true; e.preventDefault();
    stop().finally(() => app.quit());
  });
}

module.exports = { register, stop };
