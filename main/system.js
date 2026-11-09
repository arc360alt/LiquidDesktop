// System backend for LiquidDesktop: files, apps, hardware controls, processes and terminals.
// Every handler is exposed to the renderer through ipcMain.handle('<name>').
const { ipcMain, shell, app, clipboard } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

const HOME = os.homedir();

function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 4000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, out: String(stdout || ''), err: String(stderr || '') });
    });
  });
}

const which = (() => {
  const cache = {};
  return (bin) => {
    if (bin in cache) return cache[bin];
    const dirs = (process.env.PATH || '/usr/bin:/bin').split(':');
    cache[bin] = dirs.some((d) => { try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { return false; } });
    return cache[bin];
  };
})();

/* ------------------------------------------------------------------ files */

async function listDir(dir) {
  dir = dir || HOME;
  const names = await fsp.readdir(dir);
  const out = [];
  await Promise.all(names.map(async (name) => {
    const p = path.join(dir, name);
    try {
      const st = await fsp.stat(p);
      out.push({ name, path: p, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs,
        ext: st.isDirectory() ? '' : path.extname(name).slice(1).toLowerCase(), hidden: name.startsWith('.') });
    } catch {
      out.push({ name, path: p, isDir: false, size: 0, mtime: 0, ext: '', hidden: name.startsWith('.'), broken: true });
    }
  }));
  return out;
}

async function searchFiles(query, root = HOME, limit = 40) {
  query = String(query || '').toLowerCase();
  if (!query) return [];
  const results = [];
  const queue = [{ dir: root, depth: 0 }];
  const skip = new Set(['node_modules', '.git', '.cache', '.local', '.npm', '.cargo', '.rustup', '.var', 'snap', '.mozilla', '.config', '.nvm', '.proto']);
  let visited = 0;
  while (queue.length && results.length < limit && visited < 4000) {
    const { dir, depth } = queue.shift();
    visited++;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.name.toLowerCase().includes(query)) {
        results.push({ name: e.name, path: p, isDir: e.isDirectory(), ext: path.extname(e.name).slice(1).toLowerCase() });
        if (results.length >= limit) break;
      }
      if (e.isDirectory() && depth < 5) queue.push({ dir: p, depth: depth + 1 });
    }
  }
  return results;
}

async function trash(p) {
  if (which('gio')) {
    const r = await run('gio', ['trash', p]);
    if (r.ok) return true;
  }
  const tdir = path.join(HOME, '.local/share/Trash');
  await fsp.mkdir(path.join(tdir, 'files'), { recursive: true });
  await fsp.mkdir(path.join(tdir, 'info'), { recursive: true });
  let base = path.basename(p), dest = path.join(tdir, 'files', base), n = 1;
  while (fs.existsSync(dest)) dest = path.join(tdir, 'files', `${base}.${n++}`);
  await fsp.rename(p, dest);
  await fsp.writeFile(path.join(tdir, 'info', path.basename(dest) + '.trashinfo'),
    `[Trash Info]\nPath=${encodeURI(p)}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`);
  return true;
}

async function uniquePath(dir, name) {
  let p = path.join(dir, name), n = 2;
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  while (fs.existsSync(p)) p = path.join(dir, `${stem} ${n++}${ext}`);
  return p;
}

/* ------------------------------------------------------------------ apps (.desktop files) */

const ICON_THEMES = ['Papirus', 'hicolor', 'Adwaita', 'breeze', 'elementary', 'AdwaitaLegacy', 'oxygen'];
const ICON_SIZES = ['scalable', '512x512', '256x256', '128x128', '96x96', '64x64', '48x48', '256', '128', '64', '48'];
const ICON_ROOTS = [path.join(HOME, '.local/share/icons'), '/usr/share/icons', '/var/lib/flatpak/exports/share/icons',
  path.join(HOME, '.local/share/flatpak/exports/share/icons')];
const iconCache = new Map();

function resolveIcon(name) {
  if (!name) return null;
  if (iconCache.has(name)) return iconCache.get(name);
  let found = null;
  if (name.startsWith('/')) found = fs.existsSync(name) ? name : null;
  else {
    outer: for (const root of ICON_ROOTS) {
      for (const theme of ICON_THEMES) {
        for (const size of ICON_SIZES) {
          for (const sub of ['apps', '']) {
            for (const ext of ['svg', 'png']) {
              const variants = [path.join(root, theme, size, sub, `${name}.${ext}`), path.join(root, theme, sub, size, `${name}.${ext}`)];
              for (const p of variants) if (fs.existsSync(p)) { found = p; break outer; }
            }
          }
        }
      }
    }
    if (!found) for (const ext of ['svg', 'png', 'xpm']) {
      const p = `/usr/share/pixmaps/${name}.${ext}`;
      if (fs.existsSync(p)) { found = p; break; }
    }
  }
  iconCache.set(name, found);
  return found;
}

function parseDesktopFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const entry = {};
  let inMain = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) { inMain = line === '[Desktop Entry]'; continue; }
    if (!inMain || !line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
    if (!(k in entry)) entry[k] = v;
  }
  return entry;
}

let appsCache = null;
const APP_DIRS = [path.join(HOME, '.local/share/applications'), '/usr/share/applications', '/usr/local/share/applications',
  '/var/lib/flatpak/exports/share/applications', path.join(HOME, '.local/share/flatpak/exports/share/applications')];

// Installing or removing an app (App Store, pacman, flatpak in a terminal…) changes one of these folders:
// tell every LiquidDesktop window so the launcher, Spotlight and Dock pick it up.
function watchApps() {
  const sig = () => APP_DIRS.map((d) => { try { const st = fs.statSync(d); return st.mtimeMs + ':' + fs.readdirSync(d).length; } catch { return '-'; } }).join('|');
  let last = sig();
  setInterval(() => {
    const now = sig();
    if (now === last) return;
    last = now;
    appsCache = null;
    iconCache.clear();
    const { webContents } = require('electron');
    for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.getType() !== 'webview') wc.send('apps:changed');
  }, 2500);
}

async function listApps(force) {
  if (appsCache && !force) return appsCache;
  const dirs = APP_DIRS;
  const seen = new Map();
  const desktopEnv = (process.env.XDG_CURRENT_DESKTOP || '').split(':');
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.desktop')); } catch { continue; }
    for (const f of files) {
      if (seen.has(f)) continue;
      try {
        const e = parseDesktopFile(path.join(dir, f));
        if (e.Type !== 'Application' || e.NoDisplay === 'true' || e.Hidden === 'true' || !e.Exec) { seen.set(f, null); continue; }
        if (e.OnlyShowIn && !e.OnlyShowIn.split(';').some((d) => desktopEnv.includes(d))) { seen.set(f, null); continue; }
        seen.set(f, {
          id: 'desktop:' + f, file: path.join(dir, f), name: e.Name || f, comment: e.Comment || e.GenericName || '',
          exec: e.Exec, terminal: e.Terminal === 'true', icon: resolveIcon(e.Icon), iconName: e.Icon || '',
          categories: (e.Categories || '').split(';').filter(Boolean), wmClass: e.StartupWMClass || '', keywords: (e.Keywords || '').split(';').filter(Boolean),
        });
      } catch { /* unreadable entry */ }
    }
  }
  appsCache = [...seen.values()].filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  return appsCache;
}

function launchExec(exec, terminal) {
  let cmd = exec.replace(/%[fFuUdDnNickvm]/g, '').replace(/%%/g, '%').trim();
  if (terminal) {
    for (const t of ['kitty', 'alacritty', 'foot', 'xfce4-terminal', 'gnome-terminal', 'konsole', 'xterm']) {
      if (which(t)) { cmd = `${t} -e ${cmd}`; break; }
    }
  }
  const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: 'ignore', cwd: HOME, env: launchEnv() });
  child.unref();
  return true;
}

// Native apps launched from the shell should not inherit Electron's internals.
function launchEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('ELECTRON_') || k === 'CHROME_DESKTOP') delete env[k];
  return env;
}

/* ------------------------------------------------------------------ hardware status */

function readFile(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } }

function battery() {
  const base = '/sys/class/power_supply';
  let list = [];
  try { list = fs.readdirSync(base); } catch { return null; }
  for (const d of list) {
    if (readFile(path.join(base, d, 'type')) !== 'Battery') continue;
    const cap = Number(readFile(path.join(base, d, 'capacity')));
    const status = readFile(path.join(base, d, 'status')) || '';
    return { percent: isNaN(cap) ? null : cap, charging: /charging|full/i.test(status) && !/discharging/i.test(status), status };
  }
  return null;
}

async function volume() {
  if (which('wpctl')) {
    const r = await run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@']);
    const m = r.out.match(/Volume:\s*([\d.]+)/);
    if (m) return { level: Math.round(parseFloat(m[1]) * 100), muted: /MUTED/.test(r.out) };
  }
  if (which('pactl')) {
    const r = await run('pactl', ['get-sink-volume', '@DEFAULT_SINK@']);
    const m = r.out.match(/(\d+)%/);
    const mu = await run('pactl', ['get-sink-mute', '@DEFAULT_SINK@']);
    if (m) return { level: Number(m[1]), muted: /yes/.test(mu.out) };
  }
  return null;
}

async function brightness() {
  if (!which('brightnessctl')) return null;
  // only real backlights count (brightnessctl also lists LEDs such as keyboard or network lights)
  const r = await run('brightnessctl', ['-l', '-m', '-c', 'backlight']);
  const line = r.out.split('\n').find((l) => l.split(',')[1] === 'backlight');
  const pct = line && line.split(',')[3];
  return pct ? Number(pct.replace('%', '')) : null;
}

async function wifi() {
  if (!which('nmcli')) return null;
  const radio = await run('nmcli', ['-t', 'radio', 'wifi']);
  const enabled = radio.out.trim() === 'enabled';
  const con = await run('nmcli', ['-t', '-f', 'TYPE,STATE,CONNECTION', 'device']);
  let ssid = null, wired = false;
  for (const line of con.out.split('\n')) {
    const [type, state, ...name] = line.split(':');
    if (state === 'connected' && type === 'wifi') ssid = name.join(':');
    if (state === 'connected' && type === 'ethernet') wired = true;
  }
  return { enabled, ssid, wired };
}

async function wifiList() {
  if (!which('nmcli')) return [];
  const r = await run('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list'], { timeout: 8000 });
  const nets = new Map();
  for (const line of r.out.split('\n')) {
    if (!line) continue;
    const parts = line.split(/(?<!\\):/);
    const [inuse, ssid, signal, security] = parts.map((s) => (s || '').replace(/\\:/g, ':'));
    if (!ssid) continue;
    const prev = nets.get(ssid);
    if (!prev || Number(signal) > prev.signal) nets.set(ssid, { ssid, signal: Number(signal), secure: !!security && security !== '--', active: inuse === '*' || (prev && prev.active) });
  }
  return [...nets.values()].sort((a, b) => b.active - a.active || b.signal - a.signal);
}

async function bluetooth() {
  if (!which('bluetoothctl')) return null;
  const r = await run('bluetoothctl', ['show'], { timeout: 2500 });
  if (!r.out.trim()) return null;
  return { powered: /Powered:\s*yes/.test(r.out) };
}

async function media() {
  if (!which('playerctl')) return null;
  const r = await run('playerctl', ['metadata', '--format', '{{status}}\t{{title}}\t{{artist}}\t{{mpris:artUrl}}\t{{playerName}}']);
  if (!r.ok || !r.out.trim()) return null;
  const [status, title, artist, art, player] = r.out.trim().split('\t');
  return { status, title, artist, art, player };
}

let lastCpu = null;
function cpuUsage() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) { for (const k in c.times) total += c.times[k]; idle += c.times.idle; }
  let pct = 0;
  if (lastCpu) {
    const di = idle - lastCpu.idle, dt = total - lastCpu.total;
    pct = dt > 0 ? Math.max(0, Math.min(100, 100 * (1 - di / dt))) : 0;
  }
  lastCpu = { idle, total };
  return pct;
}

function osName() {
  const t = readFile('/etc/os-release') || '';
  const m = t.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
  return m ? m[1] : 'Linux';
}

/* ------------------------------------------------------------------ terminals */

const ptys = new Map();
let ptySeq = 1;

function createPty(sender, { cols = 80, rows = 24, cwd, shell, login, env: extraEnv } = {}) {
  const id = ptySeq++;
  const script = path.join(__dirname, 'ptybridge.py');
  const env = { ...launchEnv(), ...(extraEnv || {}) };
  if (shell && fs.existsSync(shell)) env.SHELL = shell;
  if (login) env.LIQUID_LOGIN_SHELL = '1';
  const child = spawn('python3', ['-I', script, String(cols), String(rows), cwd && fs.existsSync(cwd) ? cwd : HOME], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env,
  });
  child.on('error', (err) => { if (!sender.isDestroyed()) sender.send('pty:data', id, `\r\nCould not start the terminal: ${err.message}\r\n(python3 is required)\r\n`); });
  ptys.set(id, child);
  const send = (ch, ...a) => { if (!sender.isDestroyed()) sender.send(ch, ...a); };
  child.stdout.on('data', (d) => send('pty:data', id, d.toString('utf8')));
  child.stderr.on('data', (d) => send('pty:data', id, d.toString('utf8')));
  child.on('exit', () => { ptys.delete(id); send('pty:exit', id); });
  return id;
}

/* ------------------------------------------------------------------ registration */

function register({ getWindow, mode }) {
  const h = (name, fn) => ipcMain.handle(name, async (_e, ...args) => {
    try { return await fn(...args); } catch (err) { return { __error: String(err && err.message || err) }; }
  });

  h('sys:info', async () => ({
    mode, version: require('../package.json').version, user: os.userInfo().username, fullName: (await run('getent', ['passwd', os.userInfo().username])).out.split(':')[4]?.split(',')[0] || os.userInfo().username,
    host: os.hostname(), home: HOME, os: osName(), kernel: os.release(), arch: os.arch(),
    cpu: os.cpus()[0]?.model || 'CPU', cores: os.cpus().length, memory: os.totalmem(), uptime: os.uptime(),
    electron: process.versions.electron, chrome: process.versions.chrome,
    gpu: (await run('sh', ['-c', "lspci 2>/dev/null | grep -iE 'vga|3d' | head -1 | cut -d: -f3"])).out.trim(),
  }));
  h('sys:status', async () => {
    const [vol, br, wf, bt] = await Promise.all([volume(), brightness(), wifi(), bluetooth()]);
    return { battery: battery(), volume: vol, brightness: br, wifi: wf, bluetooth: bt };
  });
  h('sys:media', media);
  h('sys:mediaCmd', (cmd) => which('playerctl') && run('playerctl', [cmd]));
  h('sys:setVolume', async (v) => {
    v = Math.max(0, Math.min(100, Math.round(v)));
    if (which('wpctl')) return run('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', `${v}%`]);
    if (which('pactl')) return run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${v}%`]);
  });
  h('sys:setMute', (m) => which('wpctl') ? run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', m ? '1' : '0'])
    : which('pactl') && run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', m ? '1' : '0']));
  h('sys:setBrightness', (v) => which('brightnessctl') && run('brightnessctl', ['-c', 'backlight', 'set', `${Math.max(1, Math.min(100, Math.round(v)))}%`]));
  h('sys:wifiPower', (on) => which('nmcli') && run('nmcli', ['radio', 'wifi', on ? 'on' : 'off']));
  h('sys:wifiList', wifiList);
  h('sys:wifiConnect', (ssid, password) => which('nmcli') &&
    run('nmcli', password ? ['device', 'wifi', 'connect', ssid, 'password', password] : ['device', 'wifi', 'connect', ssid], { timeout: 30000 }));
  h('sys:airplane', (on) => which('nmcli') && run('nmcli', ['radio', 'all', on ? 'off' : 'on']));
  h('sys:bluetoothPower', (on) => which('bluetoothctl') && run('bluetoothctl', ['power', on ? 'on' : 'off']));
  h('sys:stats', async () => {
    const ps = await run('ps', ['-eo', 'pid,user,pcpu,pmem,rss,comm', '--sort=-pcpu', '--no-headers']);
    const procs = ps.out.split('\n').filter(Boolean).slice(0, 120).map((l) => {
      const [pid, user, cpu, mem, rss, ...cmd] = l.trim().split(/\s+/);
      return { pid: Number(pid), user, cpu: Number(cpu), mem: Number(mem), rss: Number(rss) * 1024, name: cmd.join(' ') };
    });
    const [l1, l5, l15] = os.loadavg();
    return { cpu: cpuUsage(), memTotal: os.totalmem(), memFree: Number((readFile('/proc/meminfo') || '').match(/MemAvailable:\s+(\d+)/)?.[1] || 0) * 1024 || os.freemem(),
      load: [l1, l5, l15], uptime: os.uptime(), procs, battery: battery() };
  });
  h('sys:kill', (pid, force) => { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); return true; });
  h('sys:checkPassword', (password) => new Promise((resolve) => {
    if (!which('unix_chkpwd')) return resolve({ ok: true, unsupported: true });
    const c = spawn('unix_chkpwd', [os.userInfo().username, 'nullok'], { stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('exit', (code) => resolve({ ok: code === 0 }));
    c.on('error', () => resolve({ ok: true, unsupported: true }));
    c.stdin.end(Buffer.concat([Buffer.from(String(password)), Buffer.from([0])]));
  }));
  h('sys:power', async (action) => {
    if (mode !== 'session') {
      // Windowed (testing) mode never touches the real machine's power state.
      if (action === 'restart') { app.relaunch(); app.exit(0); }
      if (action === 'shutdown' || action === 'logout') app.quit();
      return { simulated: true };
    }
    if (action === 'logout') return app.quit();
    const map = { shutdown: 'poweroff', restart: 'reboot', suspend: 'suspend' };
    if (map[action]) return run('systemctl', [map[action]]);
  });
  h('sys:screenshot', async () => {
    let img;
    if (mode === 'session') {
      const { desktopCapturer, screen } = require('electron');
      const { width, height } = screen.getPrimaryDisplay().bounds;
      const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
      img = src.thumbnail;
    } else img = await getWindow().webContents.capturePage();
    const dir = path.join(HOME, 'Pictures', 'Screenshots');
    await fsp.mkdir(dir, { recursive: true });
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    const file = path.join(dir, `Screenshot ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.png`);
    await fsp.writeFile(file, img.toPNG());
    return file;
  });

  h('fs:home', () => HOME);
  h('fs:list', listDir);
  h('fs:stat', async (p) => { const st = await fsp.stat(p); return { size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs, isDir: st.isDirectory(), mode: st.mode }; });
  h('fs:read', async (p) => { const st = await fsp.stat(p); if (st.size > 5 * 1024 * 1024) throw new Error('File too large'); return fsp.readFile(p, 'utf8'); });
  h('fs:write', (p, data) => fsp.writeFile(p, data, 'utf8').then(() => true));
  h('fs:mkdir', async (dir, name) => { const p = await uniquePath(dir, name || 'untitled folder'); await fsp.mkdir(p); return p; });
  h('fs:newFile', async (dir, name) => { const p = await uniquePath(dir, name || 'untitled.txt'); await fsp.writeFile(p, ''); return p; });
  h('fs:rename', async (p, name) => { const dest = path.join(path.dirname(p), name); if (fs.existsSync(dest)) throw new Error('Name already in use'); await fsp.rename(p, dest); return dest; });
  h('fs:move', async (p, dir) => { const dest = await uniquePath(dir, path.basename(p)); await fsp.rename(p, dest); return dest; });
  h('fs:copy', async (p, dir) => { const dest = await uniquePath(dir, path.basename(p)); await fsp.cp(p, dest, { recursive: true }); return dest; });
  h('fs:trash', trash);
  h('fs:remove', async (p) => { if (!p || p === '/' || p === HOME) throw new Error('Refusing to delete ' + p); await fsp.rm(p, { recursive: true, force: true }); return true; });
  h('fs:emptyTrash', async () => {
    const t = path.join(HOME, '.local/share/Trash');
    for (const sub of ['files', 'info']) {
      const d = path.join(t, sub);
      for (const n of await fsp.readdir(d).catch(() => [])) await fsp.rm(path.join(d, n), { recursive: true, force: true });
    }
    return true;
  });
  h('fs:open', (p) => shell.openPath(p));
  h('fs:reveal', (p) => shell.showItemInFolder(p));
  h('fs:search', searchFiles);
  h('fs:exists', (p) => fs.existsSync(p));
  h('fs:places', () => {
    const xdg = {};
    const t = readFile(path.join(HOME, '.config/user-dirs.dirs')) || '';
    for (const m of t.matchAll(/XDG_(\w+)_DIR="([^"]+)"/g)) xdg[m[1]] = m[2].replace('$HOME', HOME);
    const pick = (k, d) => xdg[k] || path.join(HOME, d);
    return { home: HOME, desktop: pick('DESKTOP', 'Desktop'), documents: pick('DOCUMENTS', 'Documents'), downloads: pick('DOWNLOAD', 'Downloads'),
      pictures: pick('PICTURES', 'Pictures'), music: pick('MUSIC', 'Music'), videos: pick('VIDEOS', 'Videos'), trash: path.join(HOME, '.local/share/Trash/files') };
  });

  h('apps:list', listApps);
  watchApps();
  h('apps:iconFor', (name) => resolveIcon(name) || resolveIcon(String(name).toLowerCase()));
  h('apps:info', (file) => { const e = parseDesktopFile(file); return { id: 'desktop:' + path.basename(file), file, name: e.Name || path.basename(file), exec: e.Exec, terminal: e.Terminal === 'true', icon: resolveIcon(e.Icon), categories: [], keywords: [] }; });
  h('apps:launch', (exec, terminal) => launchExec(exec, terminal));
  h('apps:run', (cmd) => launchExec(cmd, false));

  h('clip:write', (t) => { clipboard.writeText(String(t)); return true; });
  h('clip:read', () => clipboard.readText());

  // the terminal's output goes back to the window that asked for it (in a session every app is its own window)
  ipcMain.handle('pty:create', (e, opts) => { try { return createPty(e.sender, opts); } catch (err) { return { __error: String(err.message || err) }; } });
  // Settings › Mouse: pointing devices and cursor themes
  const input = require('./input');
  const xcursor = require('./xcursor');
  h('sys:inputDevices', () => input.devices());
  h('sys:inputApply', (cfg) => input.applyConfig(cfg));
  h('sys:cursorThemes', () => xcursor.listThemes());
  h('sys:cursorCss', (theme, size) => xcursor.themeCss(theme, size || 48));
  h('sys:cursorApply', async (theme, size) => {
    size = Math.max(16, Math.min(96, Number(size) || 48));
    // apps started from now on inherit it; the choice is remembered for the next session start
    process.env.XCURSOR_THEME = theme; process.env.XCURSOR_SIZE = String(size);
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(path.join(app.getPath('userData'), 'cursor-theme'), `${theme} ${size}\n`);
    if (mode !== 'session') return { scope: 'window' };
    if (which('xrdb')) { const c = spawn('xrdb', ['-merge']); c.stdin.end(`Xcursor.theme: ${theme}\nXcursor.size: ${size}\n`); }
    const conf = path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'liquid-desktop-xsettingsd.conf');
    try { fs.writeFileSync(conf, `Gtk/CursorThemeName "${theme}"\nGtk/CursorThemeSize ${size}\n`); await run('pkill', ['-HUP', '-x', 'xsettingsd']); } catch { /* no xsettingsd */ }
    app.emit('liquid-cursor-changed', theme, size);
    return { scope: 'session' };
  });
  const displays = require('./displays');
  h('sys:displays', () => displays.list());
  h('sys:setDisplay', (name, cfg) => displays.apply(name, cfg));
  // Software Update: which commit is installed, and is GitHub ahead of it?
  h('sys:updateCheck', async () => {
    const { net } = require('electron');
    const appDir = path.join(__dirname, '..');
    const REPO = 'arc360alt/LiquidDesktop';
    let current = null, how = 'unknown';
    if (appDir.startsWith('/usr/lib/liquid-desktop')) {
      how = 'package';
      const m = (await run('pacman', ['-Q', 'liquid-desktop-git'])).out.match(/\.([0-9a-f]{7,40})-\d+\s*$/m);
      current = m ? m[1] : null;
    } else if (fs.existsSync(path.join(appDir, '.liquid-version'))) {
      how = 'opt'; current = (readFile(path.join(appDir, '.liquid-version')) || '').trim() || null;
    } else if (fs.existsSync(path.join(appDir, '.git'))) {
      how = 'git'; current = (await run('git', ['-C', appDir, 'rev-parse', 'HEAD'])).out.trim() || null;
    }
    const headers = { 'User-Agent': 'LiquidDesktop-updater', Accept: 'application/vnd.github+json' };
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/commits/main`, { headers });
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    const latest = await res.json();
    let behind = null, changes = [];
    if (current) {
      const c = await net.fetch(`https://api.github.com/repos/${REPO}/compare/${current}...main`, { headers });
      if (c.ok) { const cj = await c.json(); behind = cj.ahead_by; changes = (cj.commits || []).slice(-8).reverse().map((x) => x.commit.message.split('\n')[0]); }
    }
    const pkg = JSON.parse(readFile(path.join(appDir, 'package.json')) || '{}');
    return { how, version: pkg.version, current: current ? current.slice(0, 7) : null, latest: latest.sha.slice(0, 7), date: latest.commit?.committer?.date,
      message: (latest.commit?.message || '').split('\n')[0], behind, changes,
      upToDate: !!current && (latest.sha.startsWith(current) || behind === 0), command: how === 'git' ? `cd '${appDir}' && git pull && npm install` : 'liquid-desktop-update' };
  });
  h('sys:monoFonts', async () => {
    const r = await run('fc-list', [':spacing=mono', 'family']);
    return [...new Set(r.out.split('\n').map((l) => l.split(',')[0].trim()).filter(Boolean))].sort();
  });
  h('sys:shells', () => {
    const list = (readFile('/etc/shells') || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/') && fs.existsSync(l));
    return { shells: [...new Set(list)], default: process.env.SHELL || '/bin/bash' };
  });
  ipcMain.on('pty:write', (_e, id, data) => { const c = ptys.get(id); if (c) c.stdin.write(data); });
  ipcMain.on('pty:resize', (_e, id, cols, rows) => { const c = ptys.get(id); if (c && c.stdio[3]) c.stdio[3].write(`${cols} ${rows}\n`); });
  ipcMain.on('pty:kill', (_e, id) => { const c = ptys.get(id); if (c) { c.stdin.end(); c.kill(); } });

  h('shell:toggleFullscreen', () => { const w = getWindow(); w.setFullScreen(!w.isFullScreen()); return w.isFullScreen(); });
  h('shell:devtools', () => getWindow().webContents.toggleDevTools());
  h('shell:quit', () => app.quit());

  app.on('before-quit', () => { for (const c of ptys.values()) c.kill(); });
}

module.exports = { register };
