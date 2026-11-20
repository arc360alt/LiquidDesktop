// Phone Mirroring (the Phone Mirroring app): your Android phone's screen in a window on the desktop, which you can
// use with the mouse and keyboard — like the Mac's iPhone Mirroring. Done by scrcpy (free, open source) over adb:
// USB debugging with a cable, or Wireless debugging (Android 11+) paired once with a code.
// The scrcpy window gets the X class "liquid-mirroring" (SDL's WM class), so the desktop shows it as Phone
// Mirroring, and its title bar gets Back / Home / App Switcher buttons (renderer/js/frame.js → mirror:key).
const { ipcMain, webContents } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLASS = 'liquid-mirroring';
const which = (cmd) => { for (const d of (process.env.PATH || '/usr/bin').split(':')) { const p = path.join(d, cmd); try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* not here */ } } return null; };
const scrcpyPath = () => process.env.LIQUID_SCRCPY || which('scrcpy');
// scrcpy's own downloads come with an adb next to it; otherwise the system's
const adbPath = () => process.env.ADB || (scrcpyPath() && [path.join(path.dirname(scrcpyPath()), 'adb')].find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } })) || which('adb');
const adb = (args, timeout = 12000) => new Promise((resolve) => {
  const bin = adbPath();
  if (!bin) return resolve({ ok: false, out: '', err: 'adb isn’t installed' });
  execFile(bin, args, { timeout, env: { ...process.env, LC_ALL: 'C' } }, (err, out, er) => resolve({ ok: !err, out: String(out || ''), err: String(er || err?.message || '').trim() }));
});
const broadcast = (ch, v) => { for (const wc of webContents.getAllWebContents()) { try { if (!wc.isDestroyed()) wc.send(ch, v); } catch { /* gone */ } } };

const sessions = new Map();   // serial → { proc, title, started, log }
let lastError = null;

async function devices() {
  if (!adbPath()) return [];
  const r = await adb(['devices', '-l']);
  const out = [];
  for (const line of r.out.split('\n').slice(1)) {
    const m = line.match(/^(\S+)\s+(device|unauthorized|offline|no permissions|authorizing|recovery|sideload)\b(.*)$/);
    if (!m) continue;
    const [, serial, state, rest] = m;
    const prop = (k) => (rest.match(new RegExp(`\\b${k}:(\\S+)`)) || [])[1] || '';
    out.push({ serial, state: state === 'no permissions' ? 'permissions' : state, model: prop('model').replace(/_/g, ' ') || serial, product: prop('product'),
      wireless: /_adb-tls-connect|:\d+$/.test(serial) && !/usb:/.test(rest), mirroring: sessions.has(serial) });
  }
  // a friendlier name than the model code, from the phone's settings (only for ones that let us)
  await Promise.all(out.filter((d) => d.state === 'device').map(async (d) => {
    const n = await adb(['-s', d.serial, 'shell', 'settings', 'get', 'global', 'device_name'], 4000);
    const name = n.out.trim();
    if (n.ok && name && name !== 'null') d.name = name;
    const v = await adb(['-s', d.serial, 'shell', 'getprop', 'ro.build.version.sdk'], 4000);
    d.sdk = +v.out.trim() || null;
  }));
  return out;
}
/** Wireless debugging phones nearby (adb's own mDNS): ones waiting to pair, and ones to connect to. */
async function nearby() {
  if (!adbPath()) return { pairing: [], connect: [] };
  const r = await adb(['mdns', 'services'], 5000);
  const pairing = [], connect = [];
  for (const line of r.out.split('\n')) {
    const m = line.match(/^(\S+)\s+(_adb-tls-(pairing|connect)\._tcp)\.?\s+([\d.]+:\d+)/);
    if (!m) continue;
    (m[3] === 'pairing' ? pairing : connect).push({ name: m[1], addr: m[4] });
  }
  return { pairing, connect };
}

async function status() {
  const s = scrcpyPath(), a = adbPath();
  let version = null;
  if (s) { const r = await new Promise((res) => execFile(s, ['--version'], { timeout: 5000 }, (e, o) => res(String(o || '')))); version = (r.match(/scrcpy\s+v?([\d.]+)/) || [])[1] || null; }
  return { scrcpy: !!s, adb: !!a, version, devices: a ? await devices() : [], sessions: [...sessions.entries()].map(([serial, x]) => ({ serial, title: x.title, started: x.started })), error: lastError,
    pm: which('pacman') ? 'pacman' : which('apt-get') ? 'apt' : which('dnf') ? 'dnf' : null };
}

async function install() {
  const pm = which('pacman') ? 'pacman -S --needed --noconfirm scrcpy android-tools' : which('apt-get') ? 'DEBIAN_FRONTEND=noninteractive apt-get install -y scrcpy adb'
    : which('dnf') ? 'dnf install -y scrcpy android-tools' : null;
  if (!pm) throw new Error('Install scrcpy and adb with your package manager, then come back.');
  const { sudoScript } = require('./appstore');
  const r = await sudoScript(`set -e\n${pm}`);
  broadcast('mirror:changed');
  if (!r.ok) throw new Error(/incorrect password|password is required/i.test(r.out) ? 'Your password wasn’t accepted.' : r.out.split('\n').slice(-3).join('\n') || 'It couldn’t be installed.');
  return status();
}

/** Pair with Wireless debugging's code (Android: Wireless debugging › Pair device with pairing code). */
async function pair(addr, code) {
  if (!/^[\w.:-]+:\d+$/.test(addr || '')) throw new Error('Enter the IP address and port the phone shows, like 192.168.1.20:37045.');
  if (!/^\d{6}$/.test(String(code || '').trim())) throw new Error('The pairing code is the 6 digits the phone shows.');
  const r = await adb(['pair', addr, String(code).trim()], 20000);
  if (!/Successfully paired/i.test(r.out + r.err)) throw new Error((r.out + ' ' + r.err).replace(/\s+/g, ' ').trim() || 'Pairing didn’t work. Check the code and try again.');
  // paired: connect to it (its connect port differs from the pairing one; adb finds it over mDNS)
  const ip = addr.split(':')[0];
  for (let i = 0; i < 6; i++) {
    const n = await nearby();
    const c = n.connect.find((x) => x.addr.startsWith(ip + ':'));
    if (c) { await adb(['connect', c.addr]); break; }
    await new Promise((res) => setTimeout(res, 1000));
  }
  broadcast('mirror:changed');
  return status();
}
async function connect(addr) {
  const r = await adb(['connect', addr], 15000);
  broadcast('mirror:changed');
  if (!/connected to/i.test(r.out)) throw new Error(r.out.trim() || r.err || 'Couldn’t connect.');
  return status();
}
async function disconnect(serial) { await adb(['disconnect', serial]); broadcast('mirror:changed'); return true; }

/** Start mirroring a phone. */
function start(serial, o = {}) {
  const bin = scrcpyPath();
  if (!bin) throw new Error('Phone Mirroring needs scrcpy. Install it from the Phone Mirroring app.');
  if (sessions.has(serial)) return { ok: true, already: true };
  const title = String(o.title || 'Phone').slice(0, 80);
  const args = ['-s', serial, `--window-title=${title}`, '--stay-awake'];
  if (o.screenOff) args.push('--turn-screen-off');
  if (o.audio === false) args.push('--no-audio');
  if (o.maxSize) args.push(`--max-size=${o.maxSize | 0}`);
  if (o.bitRate) args.push(`--video-bit-rate=${o.bitRate}`);
  if (o.lockOnClose) args.push('--power-off-on-close');
  if (o.keyboard === 'uhid') args.push('--keyboard=uhid');   // the phone sees a real keyboard (Android 9+): every key and layout works
  lastError = null;
  const env = { ...process.env, SDL_VIDEO_X11_WMCLASS: CLASS, SDL_APP_ID: CLASS, ADB: adbPath() || '' };
  const proc = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const s = { proc, title, started: Date.now(), log: '' };
  sessions.set(serial, s);
  const onData = (d) => { s.log = (s.log + d).slice(-8000); };
  proc.stdout.on('data', onData); proc.stderr.on('data', onData);
  proc.on('error', (e) => { lastError = e.message; });
  proc.on('exit', (code) => {
    sessions.delete(serial);
    if (code && code !== 0) {
      // scrcpy's own message, without its log prefixes
      const lines = s.log.split('\n').filter((l) => /ERROR|error:|Could not|not authorized|unauthorized/i.test(l)).map((l) => l.replace(/^\s*(ERROR|WARN|INFO):\s*/, '').trim());
      lastError = lines.slice(-2).join(' ') || `scrcpy stopped (${code}).`;
      if (/audio/i.test(lastError) && o.audio !== false && Date.now() - s.started < 15000) lastError += ' Try again with “Play phone audio” turned off (it needs Android 11 or later).';
    }
    broadcast('mirror:changed', { serial, ended: true, error: code ? lastError : null });
  });
  broadcast('mirror:changed', { serial, started: true });
  return { ok: true };
}
function stop(serial) {
  const s = sessions.get(serial);
  if (s) s.proc.kill('SIGTERM');
  return true;
}

// the phone's buttons, from the mirroring window's title bar
const KEYS = { back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', recents: 'KEYCODE_APP_SWITCH', power: 'KEYCODE_POWER', volup: 'KEYCODE_VOLUME_UP', voldown: 'KEYCODE_VOLUME_DOWN', notifications: null };
async function key(which, title) {
  // the session whose window this is (by its title), else the only one
  const list = [...sessions.entries()];
  const hit = list.find(([, s]) => s.title === title) || (list.length === 1 ? list[0] : null);
  if (!hit) return false;
  const serial = hit[0];
  if (which === 'notifications') return (await adb(['-s', serial, 'shell', 'cmd', 'statusbar', 'expand-notifications'])).ok;
  if (which === 'screenshot') return screenshot(serial, title);
  const code = KEYS[which];
  if (!code) return false;
  return (await adb(['-s', serial, 'shell', 'input', 'keyevent', code])).ok;
}
/** A screenshot of the phone, saved in Pictures/Screenshots like the computer's own. */
async function screenshot(serial, title) {
  const os = require('os');
  const dir = path.join(os.homedir(), 'Pictures', 'Screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  const file = path.join(dir, `${title || 'Phone'} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.png`);
  const bin = adbPath();
  await new Promise((resolve, reject) => {
    const c = spawn(bin, ['-s', serial, 'exec-out', 'screencap', '-p']);
    const out = fs.createWriteStream(file);
    c.stdout.pipe(out);
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('The phone didn’t take the screenshot.'))));
    c.on('error', reject);
  });
  broadcast('mirror:changed', { serial, screenshot: file });
  return file;
}

function register() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (err) { return { __error: String(err.message || err) }; } });
  h('mirror:status', status);
  h('mirror:install', install);
  h('mirror:nearby', nearby);
  h('mirror:pair', pair);
  h('mirror:connect', connect);
  h('mirror:disconnect', disconnect);
  h('mirror:start', start);
  h('mirror:stop', stop);
  h('mirror:key', key);
  // phones plugged in or unplugged: `adb track-devices` tells us (only once adb is installed and running)
  let tracker = null;
  const track = () => {
    if (tracker || !adbPath()) return;
    tracker = spawn(adbPath(), ['track-devices'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let t = null;
    tracker.stdout.on('data', () => { clearTimeout(t); t = setTimeout(() => broadcast('mirror:changed'), 300); });
    tracker.on('exit', () => { tracker = null; });
    tracker.on('error', () => { tracker = null; });
  };
  ipcMain.on('mirror:watch', track);
  const stopAll = () => { for (const s of sessions.values()) s.proc.kill(); tracker?.kill(); };
  require('electron').app.on('will-quit', stopAll);
  process.on('exit', stopAll);
}
module.exports = { register, CLASS };
