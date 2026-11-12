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

// liquid-desktop-update (or an "Update All" in the App Store) leaves a marker when it succeeds:
// tell the desktop, which offers to log out so the new version starts.
function watchUpdates() {
  const marker = path.join(app.getPath('userData'), 'update-done');
  setInterval(() => {
    if (!fs.existsSync(marker)) return;
    try { fs.unlinkSync(marker); } catch { return; }
    const { webContents } = require('electron');
    for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.getType() !== 'webview') wc.send('sys:updated');
  }, 3000);
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

/* ------------------------------------------------------------------ Users & Accounts */
// Your account: picture and full name through AccountsService (what login screens such as SDDM read; a
// user may change their own without a password), plus ~/.face for older greeters; password via passwd(1).
const ACC = () => `/org/freedesktop/Accounts/User${os.userInfo().uid}`;
async function accountInfo() {
  const me = os.userInfo();
  const pw = (await run('getent', ['passwd', me.username])).out.split(':');
  const groups = (await run('id', ['-Gn'])).out.trim().split(/\s+/).filter(Boolean);
  let realName = '', icon = '';
  if (which('busctl')) {
    const r = await run('busctl', ['get-property', 'org.freedesktop.Accounts', ACC(), 'org.freedesktop.Accounts.User', 'RealName', 'IconFile']);
    const v = [...r.out.matchAll(/^s "(.*)"$/gm)].map((m) => m[1]);
    realName = v[0] || ''; icon = v[1] || '';
  }
  realName = realName || pw[4]?.split(',')[0] || '';
  let avatar = null;
  for (const f of [icon, path.join(HOME, '.face.icon'), path.join(HOME, '.face')].filter(Boolean)) {
    try { const b = fs.readFileSync(f); if (b.length) { avatar = 'data:image/png;base64,' + b.toString('base64'); break; } } catch { /* not readable */ }
  }
  return { user: me.username, uid: me.uid, fullName: realName || me.username, home: me.homedir, shell: me.shell || pw[6]?.trim(), groups,
    admin: groups.some((g) => ['wheel', 'sudo', 'admin'].includes(g)), avatar, accountsService: which('busctl') ? true : false };
}
async function setRealName(name) {
  name = String(name || '').trim().slice(0, 120);
  if (!which('busctl')) throw new Error('AccountsService isn’t available');
  const r = await run('busctl', ['call', 'org.freedesktop.Accounts', ACC(), 'org.freedesktop.Accounts.User', 'SetRealName', 's', name]);
  if (!r.ok) throw new Error(r.err.trim() || 'Couldn’t change the name');
  return true;
}
async function setAvatar(dataUrl) {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(String(dataUrl));
  if (!m) throw new Error('Not an image');
  const buf = Buffer.from(m[2], 'base64');
  const face = path.join(HOME, '.face');
  fs.writeFileSync(face, buf); fs.writeFileSync(face + '.icon', buf);
  if (which('busctl')) await run('busctl', ['call', 'org.freedesktop.Accounts', ACC(), 'org.freedesktop.Accounts.User', 'SetIconFile', 's', face]);
  return true;
}
function changePassword(current, next) {
  // passwd only talks to a terminal: run it in one (script) and answer its three prompts
  return new Promise((resolve) => {
    if (!which('passwd') || !which('script')) return resolve({ ok: false, error: 'passwd isn’t available' });
    const c = spawn('script', ['-qfec', 'passwd', '/dev/null'], { env: { ...process.env, LC_ALL: 'C' } });
    let out = '', step = 0;
    const answer = () => {
      const t = out.toLowerCase();
      const want = (t.match(/(current|old|new|retype|again)[^:]*password[^:]*:\s*$|password:\s*$/) || [])[0];
      if (!want) return;
      out = '';
      c.stdin.write((step === 0 ? current : next) + '\n');
      step++;
    };
    c.stdout.on('data', (d) => { out += d.toString(); answer(); });
    const timer = setTimeout(() => c.kill(), 20000);
    c.on('exit', (code) => {
      clearTimeout(timer);
      const msg = out.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter((l) => l && !/password:?$/i.test(l)).pop() || '';
      resolve(code === 0 ? { ok: true } : { ok: false, error: step <= 1 || /authentication token manipulation|authentication failure/i.test(msg) ? 'The current password is incorrect.' : msg.replace(/^passwd:\s*/, '') || 'The password wasn’t changed.' });
    });
  });
}

/* ------------------------------------------------------------------ Activity Monitor */
// Live numbers from /proc, sampled between calls: per-process CPU % (of one core, like top), memory,
// threads, disk I/O, plus system CPU/memory/swap and disk and network throughput.
const PAGE = 4096, HZ = 100;
let prevSample = null;
const uidNames = (() => { let m = null; return () => { if (m) return m; m = new Map(); for (const l of (readFile('/etc/passwd') || '').split('\n')) { const f = l.split(':'); if (f.length > 2) m.set(Number(f[2]), f[0]); } return m; }; })();
function cpuTimes() {
  const f = (readFile('/proc/stat') || '').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = f;
  return { user: user + nice, system: system + irq + softirq, idle: idle + iowait, total: user + nice + system + idle + iowait + irq + softirq + steal };
}
function diskBytes() {
  let r = 0, w = 0;
  for (const l of (readFile('/proc/diskstats') || '').split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f.length < 10 || !/^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|mmcblk\d+|hd[a-z]+)$/.test(f[2])) continue;
    r += Number(f[5]) * 512; w += Number(f[9]) * 512;
  }
  return { r, w };
}
function netBytes() {
  const ifs = {};
  for (const l of (readFile('/proc/net/dev') || '').split('\n').slice(2)) {
    const [name, rest] = l.split(':'); if (!rest) continue;
    const n = name.trim(); if (n === 'lo') continue;
    const f = rest.trim().split(/\s+/).map(Number);
    ifs[n] = { rx: f[0], tx: f[8], rxp: f[1], txp: f[9] };
  }
  return ifs;
}
function procStats() {
  const now = Date.now(), cpu = cpuTimes(), cores = os.cpus().length || 1;
  const prev = prevSample, dt = prev ? Math.max(0.2, (now - prev.t) / 1000) : 1;
  const dTotal = prev ? Math.max(1, cpu.total - prev.cpu.total) : 1;
  const names = uidNames(), me = os.userInfo().uid;
  const procs = [], seen = new Map();
  let threads = 0;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const pid = Number(d);
    try {
      const raw = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const close = raw.lastIndexOf(')');
      let name = raw.slice(raw.indexOf('(') + 1, close);
      const f = raw.slice(close + 2).split(' ');
      const ticks = Number(f[11]) + Number(f[12]), nth = Number(f[17]), rss = Number(f[21]) * PAGE;
      if (name.length >= 15) { try { const c = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0')[0]; if (c) name = c.split('/').pop(); } catch { /* gone */ } }
      let uid = -1; try { uid = fs.statSync(`/proc/${d}`).uid; } catch { /* gone */ }
      let io = null;
      if (uid === me) { try { const t = fs.readFileSync(`/proc/${d}/io`, 'utf8'); io = { r: Number(t.match(/read_bytes:\s*(\d+)/)?.[1] || 0), w: Number(t.match(/write_bytes:\s*(\d+)/)?.[1] || 0) }; } catch { /* not allowed */ } }
      const p0 = prev?.procs.get(pid);
      const cpuPct = p0 ? Math.max(0, ((ticks - p0.ticks) / dTotal) * 100 * cores) : 0;
      seen.set(pid, { ticks, io });
      threads += nth;
      procs.push({ pid, name, user: names.get(uid) || String(uid), mine: uid === me, cpu: Math.round(cpuPct * 10) / 10, cpuTime: ticks / HZ, threads: nth, rss, ppid: Number(f[1]), state: f[0],
        ioR: io && p0?.io ? Math.max(0, (io.r - p0.io.r) / dt) : 0, ioW: io && p0?.io ? Math.max(0, (io.w - p0.io.w) / dt) : 0, ioTotalR: io?.r || 0, ioTotalW: io?.w || 0 });
    } catch { /* process exited while we looked */ }
  }
  const mi = readFile('/proc/meminfo') || '', kb = (k) => Number(mi.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm'))?.[1] || 0) * 1024;
  const disk = diskBytes(), net = netBytes();
  const rate = (a, b) => (prev ? Math.max(0, (a - b) / dt) : 0);
  const netTot = Object.values(net).reduce((t, x) => ({ rx: t.rx + x.rx, tx: t.tx + x.tx }), { rx: 0, tx: 0 });
  const prevNetTot = prev ? Object.values(prev.net).reduce((t, x) => ({ rx: t.rx + x.rx, tx: t.tx + x.tx }), { rx: 0, tx: 0 }) : netTot;
  const out = {
    cores, procs, threads, uptime: os.uptime(), load: os.loadavg(), battery: battery(),
    cpu: prev ? 100 * (1 - (cpu.idle - prev.cpu.idle) / dTotal) : cpuUsage(),
    cpuUser: prev ? (100 * (cpu.user - prev.cpu.user)) / dTotal : 0, cpuSystem: prev ? (100 * (cpu.system - prev.cpu.system)) / dTotal : 0,
    memTotal: kb('MemTotal') || os.totalmem(), memFree: kb('MemAvailable') || os.freemem(), memCached: kb('Cached') + kb('Buffers'), swapTotal: kb('SwapTotal'), swapUsed: kb('SwapTotal') - kb('SwapFree'),
    diskR: rate(disk.r, prev?.disk.r ?? disk.r), diskW: rate(disk.w, prev?.disk.w ?? disk.w), diskTotalR: disk.r, diskTotalW: disk.w,
    netRx: rate(netTot.rx, prevNetTot.rx), netTx: rate(netTot.tx, prevNetTot.tx), netTotalRx: netTot.rx, netTotalTx: netTot.tx,
    ifaces: Object.entries(net).map(([name, x]) => ({ name, rx: x.rx, tx: x.tx, rxRate: rate(x.rx, prev?.net[name]?.rx ?? x.rx), txRate: rate(x.tx, prev?.net[name]?.tx ?? x.tx) })),
  };
  prevSample = { t: now, cpu, procs: seen, disk, net };
  return out;
}

/* ------------------------------------------------------------------ graphics card */
// The GPU that actually draws the desktop: on laptops with two GPUs (or a dock / capture card) the first
// lspci entry is often the wrong one. Tries, in order: the OpenGL renderer (glxinfo), the device Chromium
// says is active, the card the firmware booted on (boot_vga), then the first display controller.
let gpuCache = null;
function prettyPci(line) {
  // "Advanced Micro Devices, Inc. [AMD/ATI] Navi 33 [Radeon RX 7600/7600 XT/…]" → "AMD Radeon RX 7600"
  const desc = line.replace(/^.*?(VGA compatible controller|3D controller|Display controller)[^:]*:\s*/i, '').replace(/\s*\[[0-9a-f]{4}:[0-9a-f]{4}\].*$/i, '').replace(/\s*\(rev .*\)$/, '');
  const vendor = /nvidia/i.test(desc) ? 'NVIDIA' : /advanced micro|amd|ati\b/i.test(desc) ? 'AMD' : /intel/i.test(desc) ? 'Intel' : desc.split(/[\s,]/)[0];
  const br = [...desc.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]).filter((b) => !/^(AMD\/ATI|AMD|NVIDIA|Intel)$/i.test(b)).pop();
  const model = br ? br.split('/')[0].trim() : desc.replace(/^.*?(Corporation|Inc\.|Ltd\.?)\s*/i, '').replace(/\[[^\]]*\]\s*/g, '').trim();
  return (model.toLowerCase().startsWith(vendor.toLowerCase()) ? model : `${vendor} ${model}`).trim();
}
async function gpuName() {
  if (gpuCache) return gpuCache;
  const glx = (await run('sh', ['-c', 'glxinfo -B 2>/dev/null | grep -i "renderer string"'])).out;
  const m = glx.match(/renderer string:\s*(.+)/i);
  if (m && !/llvmpipe|softpipe|swrast/i.test(m[1])) return (gpuCache = m[1].replace(/\s*\(.*$/, '').trim());
  const pci = (await run('sh', ['-c', "lspci -nn 2>/dev/null | grep -iE 'vga|3d controller|display controller'"])).out.split('\n').filter(Boolean);
  if (!pci.length) return '';
  const byId = (v, d) => pci.find((l) => l.toLowerCase().includes(`[${v}:${d}]`));
  const hex = (n) => Number(n).toString(16).padStart(4, '0');
  try {
    const info = await app.getGPUInfo('basic');
    const act = (info.gpuDevice || []).find((g) => g.active) || null;
    const l = act && byId(hex(act.vendorId), hex(act.deviceId));
    if (l) return (gpuCache = prettyPci(l));
  } catch { /* GPU info unavailable */ }
  for (const c of (() => { try { return fs.readdirSync('/sys/class/drm').filter((x) => /^card\d+$/.test(x)); } catch { return []; } })()) {
    try {
      if (fs.readFileSync(`/sys/class/drm/${c}/device/boot_vga`, 'utf8').trim() !== '1') continue;
      const v = fs.readFileSync(`/sys/class/drm/${c}/device/vendor`, 'utf8').trim().replace(/^0x/, '');
      const d = fs.readFileSync(`/sys/class/drm/${c}/device/device`, 'utf8').trim().replace(/^0x/, '');
      const l = byId(v, d);
      if (l) return (gpuCache = prettyPci(l));
    } catch { /* no boot_vga */ }
  }
  return (gpuCache = prettyPci(pci[0]));
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
    gpu: await gpuName(),
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
  h('sys:stats', async () => procStats());
  h('sys:account', accountInfo);
  h('sys:setRealName', setRealName);
  h('sys:setAvatar', setAvatar);
  h('sys:changePassword', changePassword);
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
  // the whole screen as an image (session: every monitor's pixels; testing window: just this window)
  const captureScreen = async () => {
    if (mode === 'session') {
      const { desktopCapturer, screen } = require('electron');
      const d = screen.getPrimaryDisplay(), sf = d.scaleFactor || 1;
      const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.bounds.width * sf), height: Math.round(d.bounds.height * sf) } });
      return src.thumbnail;
    }
    return getWindow().webContents.capturePage();
  };
  // save and/or copy a screenshot, as set in Settings › General › Screenshots
  const saveShot = async (img, opts = {}) => {
    const { nativeImage } = require('electron');
    if (typeof img === 'string') img = nativeImage.createFromDataURL(img);
    let file = null;
    if (opts.copy !== false) clipboard.writeImage(img);
    if (opts.save !== false) {
      const dir = (opts.dir || '').replace(/^~(?=\/|$)/, HOME) || path.join(HOME, 'Pictures', 'Screenshots');
      await fsp.mkdir(dir, { recursive: true });
      const d = new Date(), pad = (n) => String(n).padStart(2, '0');
      file = path.join(dir, `Screenshot ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.png`);
      await fsp.writeFile(file, img.toPNG());
    }
    return { file, copied: opts.copy !== false };
  };
  h('sys:screenshot', async (opts) => (await saveShot(await captureScreen(), opts)).file);
  h('sys:capture', async () => (await captureScreen()).toDataURL());
  h('sys:saveScreenshot', (dataUrl, opts) => saveShot(dataUrl, opts));

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

  // custom widgets' data sources: public web addresses only (no local network), small, quick
  h('net:fetch', async (url) => {
    const u = new URL(String(url));
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only web addresses');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (/^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(host)) throw new Error('Local addresses aren’t allowed');
    const { net } = require('electron');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await net.fetch(u.toString(), { signal: ctrl.signal, headers: { 'User-Agent': 'LiquidDesktop-Widget' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 2 * 1024 * 1024) throw new Error('Response too large');
      return buf.toString('utf8');
    } finally { clearTimeout(t); }
  });
  // a small JPEG of a picture (widgets, previews): never decode multi-megapixel photos in the UI
  const thumbCache = new Map();
  h('fs:thumb', async (p, size = 360) => {
    const st = await fsp.stat(p);
    const key = `${p}|${st.mtimeMs}|${size}`;
    if (thumbCache.has(key)) return thumbCache.get(key);
    const { nativeImage } = require('electron');
    let img = null;
    if (typeof nativeImage.createThumbnailFromPath === 'function') img = await nativeImage.createThumbnailFromPath(p, { width: size, height: size }).catch(() => null);   // macOS/Windows only
    if (!img || img.isEmpty()) { img = nativeImage.createFromPath(p); if (img.isEmpty()) throw new Error('Not a picture'); const s = img.getSize(), k = size / Math.min(s.width, s.height); if (k < 1) img = img.resize({ width: Math.round(s.width * k), height: Math.round(s.height * k), quality: 'good' }); }
    const url = 'data:image/jpeg;base64,' + img.toJPEG(82).toString('base64');
    if (thumbCache.size > 60) thumbCache.delete(thumbCache.keys().next().value);
    thumbCache.set(key, url);
    return url;
  });
  // a picture as a data URL (to embed in a widget)
  h('fs:readDataUrl', async (p) => {
    const st = await fsp.stat(p);
    if (st.size > 8 * 1024 * 1024) throw new Error('That picture is too large (over 8 MB).');
    const ext = path.extname(p).slice(1).toLowerCase();
    const type = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', svg: 'svg+xml', avif: 'avif', bmp: 'bmp' }[ext];
    if (!type) throw new Error('Not a picture');
    return `data:image/${type};base64,${(await fsp.readFile(p)).toString('base64')}`;
  });
  h('apps:list', listApps);
  watchApps();
  watchUpdates();
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
    require('./appthemes').writeXsettings();   // cursor + GTK theme for GTK apps
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

module.exports = { register, resolveIcon };
