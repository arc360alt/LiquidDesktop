// The LiquidDesktop login screen: a greetd greeter. greetd (a small login daemon) runs it as the "greeter"
// user inside cage (a one-app Wayland kiosk); it shows LiquidDesktop's own web UI — wallpaper, clock, people,
// a glass password field with real blur — and logs in through greetd's socket protocol.
//
//   liquid-desktop-greeter                  what greetd runs (see packaging/greetd-config.toml)
//   electron . --greeter --greeter-test     try it in a window: with $GREETD_SOCK it talks to that socket,
//                                           otherwise the password "test" succeeds and nothing is started
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const { execFile, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(1);
const TEST = argv.includes('--greeter-test');
const exists = (f) => { try { fs.accessSync(f); return true; } catch { return false; } };

/* ------------------------------------------------------------------ people and sessions */
function users() {
  const list = [];
  let text = '';
  try { text = fs.readFileSync('/etc/passwd', 'utf8'); } catch { return list; }
  const shells = (() => { try { return fs.readFileSync('/etc/shells', 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#')); } catch { return null; } })();
  for (const line of text.split('\n')) {
    const [name, , uid, , gecos, home, shell] = line.split(':');
    if (!name || +uid < 1000 || +uid >= 60000) continue;
    if (/nologin|false$/.test(shell || '') || (shells && shell && !shells.includes(shell))) continue;
    let avatar = null;
    for (const f of [`/var/lib/AccountsService/icons/${name}`, path.join(home || '', '.face.icon'), path.join(home || '', '.face')]) {
      if (!exists(f)) continue;
      const img = nativeImage.createFromPath(f);
      if (!img.isEmpty()) { avatar = img.resize({ width: 192, height: 192, quality: 'best' }).toDataURL(); break; }
    }
    list.push({ name, realName: (gecos || '').split(',')[0] || name, avatar });
  }
  return list.sort((a, b) => a.realName.localeCompare(b.realName));
}
function parseDesktop(file) {
  const out = {};
  let inEntry = false;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const l = raw.trim();
    if (l.startsWith('[')) { inEntry = l === '[Desktop Entry]'; continue; }
    if (!inEntry || !l || l.startsWith('#')) continue;
    const i = l.indexOf('=');
    if (i > 0 && !(l.slice(0, i) in out)) out[l.slice(0, i)] = l.slice(i + 1);
  }
  return out;
}
function sessions() {
  const out = [];
  for (const [dir, type] of [['/usr/share/wayland-sessions', 'wayland'], ['/usr/share/xsessions', 'x11']]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.desktop')); } catch { continue; }
    for (const f of files) {
      try {
        const e = parseDesktop(path.join(dir, f));
        if (!e.Exec || e.Hidden === 'true' || e.NoDisplay === 'true') continue;
        out.push({ id: `${type}:${f}`, name: e.Name || f.replace(/\.desktop$/, ''), exec: e.Exec, type, desktopNames: e.DesktopNames || '' });
      } catch { /* unreadable */ }
    }
  }
  // LiquidDesktop first, then the others by name
  return out.sort((a, b) => (/liquid/i.test(b.id) - /liquid/i.test(a.id)) || a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ greetd's protocol */
// Every message is a 32-bit length (native byte order) followed by that much JSON.
class Greetd {
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); this.waiting = []; this.conn = null; }
  open() {
    return new Promise((res, rej) => {
      this.conn = net.createConnection(this.sock, res);
      this.conn.on('error', rej);
      this.conn.on('data', (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        while (this.buf.length >= 4) {
          const n = os.endianness() === 'LE' ? this.buf.readUInt32LE(0) : this.buf.readUInt32BE(0);
          if (this.buf.length < 4 + n) break;
          const msg = JSON.parse(this.buf.subarray(4, 4 + n).toString('utf8'));
          this.buf = this.buf.subarray(4 + n);
          this.waiting.shift()?.(msg);
        }
      });
    });
  }
  ask(obj) {
    return new Promise((res, rej) => {
      const body = Buffer.from(JSON.stringify(obj), 'utf8');
      const len = Buffer.alloc(4);
      if (os.endianness() === 'LE') len.writeUInt32LE(body.length); else len.writeUInt32BE(body.length);
      this.waiting.push(res);
      this.conn.write(Buffer.concat([len, body]));
      setTimeout(() => rej(new Error('greetd didn’t answer')), 30000);
    });
  }
  close() { try { this.conn?.end(); } catch { /* gone */ } }
}

const which = (bin) => (process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':').map((d) => path.join(d, bin)).find(exists) || bin;
function sessionCommand(s) {
  // Exec fields: drop %-codes, split on spaces (quotes respected)
  const parts = (s.exec.match(/"[^"]*"|\S+/g) || []).map((p) => p.replace(/^"|"$/g, '')).filter((p) => !/^%[a-zA-Z]$/.test(p));
  parts[0] = parts[0].startsWith('/') ? parts[0] : which(parts[0]);
  // startx only accepts a session given as a full path: if the program wasn't found, let a shell find it
  if (!parts[0].startsWith('/')) parts.splice(0, parts.length, '/bin/sh', '-c', `exec ${parts.join(' ')}`);
  const env = [`XDG_SESSION_TYPE=${s.type}`, `XDG_SESSION_DESKTOP=${s.id.split(':')[1].replace(/\.desktop$/, '')}`];
  if (s.desktopNames) env.push(`XDG_CURRENT_DESKTOP=${s.desktopNames.replace(/;$/, '').replace(/;/g, ':')}`);
  // an X11 session needs an X server: startx starts one on this seat for the logged-in person
  const run = s.type === 'x11' ? [which('startx'), ...parts, '--', `vt${process.env.XDG_VTNR || '1'}`, '-keeptty'] : parts;
  // between the login screen closing and the desktop drawing, the text console shows through: keep it a
  // black screen (no cursor, text drawn black) and send the startup chatter to a log instead of the screen
  const quiet = [
    "printf '\\033[?25l\\033[30;40m\\033[2J\\033[H' 2>/dev/null",
    'L="${XDG_STATE_HOME:-$HOME/.local/state}/liquid-desktop"; mkdir -p "$L" 2>/dev/null && [ -w "$L" ] || L="${TMPDIR:-/tmp}"',
    '"$@" >"$L/session.log" 2>&1; s=$?',
    "printf '\\033[0m\\033[?25h\\033[2J\\033[H' 2>/dev/null",
    'exit $s',
  ].join('\n');
  // greetd doesn't exec this list as-is: it joins it with spaces and runs it with `/bin/sh -c "exec …"`
  // (greetd/src/session/worker.rs). So it gets one string, every word shell-quoted.
  return { cmd: [shellJoin(['/bin/sh', '-c', quiet, 'liquid-session', ...run])], env };
}
const shellJoin = (args) => args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');

let lastPath = null;
const saved = () => { try { return JSON.parse(fs.readFileSync(lastPath, 'utf8')); } catch { return {}; } };
async function login(username, password, sessionId) {
  const s = sessions().find((x) => x.id === sessionId) || sessions()[0];
  if (!s) return { ok: false, error: 'No desktop sessions are installed.' };
  const { cmd, env } = sessionCommand(s);
  const sock = process.env.GREETD_SOCK;
  if (!sock) {
    if (!TEST) return { ok: false, error: 'greetd isn’t running this login screen.' };
    return password === 'test' ? { ok: true, test: true, cmd, env } : { ok: false, error: 'Incorrect password', auth: true };
  }
  const g = new Greetd(sock);
  try {
    await g.open();
    let r = await g.ask({ type: 'create_session', username });
    let notes = '';
    for (let i = 0; i < 10 && r.type === 'auth_message'; i++) {
      const secret = r.auth_message_type === 'secret', visible = r.auth_message_type === 'visible';
      if (!secret && !visible) notes = r.auth_message;   // info / error messages from PAM
      r = await g.ask({ type: 'post_auth_message_response', response: secret ? password : visible ? username : null });
    }
    if (r.type === 'error') {
      await g.ask({ type: 'cancel_session' }).catch(() => {});
      return { ok: false, auth: r.error_type === 'auth_error', error: r.error_type === 'auth_error' ? 'Incorrect password' : (r.description || notes || 'Couldn’t log in') };
    }
    r = await g.ask({ type: 'start_session', cmd, env });
    if (r.type !== 'success') return { ok: false, error: r.description || 'Couldn’t start the session' };
    try { fs.writeFileSync(lastPath, JSON.stringify({ user: username, session: s.id })); } catch { /* read-only */ }
    setTimeout(() => app.quit(), 750);   // after the fade to black; greetd starts the session once the greeter is gone
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { g.close(); }
}

/* ------------------------------------------------------------------ start */
function run() {
  app.setName('LiquidDesktop Login');
  if (process.env.WAYLAND_DISPLAY) app.commandLine.appendSwitch('ozone-platform', 'wayland');
  // a writable place for Chromium's data and the remembered person/session
  const dataDir = [process.env.LIQUID_GREETER_DATA, '/var/cache/liquid-desktop-greeter', path.join(os.tmpdir(), `liquid-desktop-greeter-${process.getuid?.() ?? 0}`)]
    .filter(Boolean).find((d) => { try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } });
  app.setPath('userData', dataDir);
  lastPath = path.join(dataDir, 'last.json');

  app.whenReady().then(() => {
    ipcMain.handle('greeter:info', () => ({ users: users(), sessions: sessions(), last: saved(), host: os.hostname(), test: TEST }));
    ipcMain.handle('greeter:login', (_e, u, p, s) => login(String(u), String(p), String(s)));
    ipcMain.handle('greeter:power', (_e, action) => {
      if (TEST) return { ok: true, test: true };
      const map = { shutdown: 'poweroff', restart: 'reboot', suspend: 'suspend' };
      if (!map[action]) return { ok: false };
      execFile('systemctl', [map[action]], () => {});
      return { ok: true };
    });
    const win = new BrowserWindow({
      width: 1280, height: 800, fullscreen: !TEST, frame: TEST, backgroundColor: '#0b1220', show: false, title: 'LiquidDesktop Login',
      webPreferences: { preload: path.join(__dirname, 'greeter-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'greeter.html'), { query: TEST ? { test: '1' } : {} });
    // test mode opens in the background, so it never catches typing meant for other windows
    win.once('ready-to-show', () => { if (TEST) win.showInactive(); else { win.show(); win.focus(); } });
  });
  app.on('window-all-closed', () => app.quit());
}

module.exports = { run, sessionCommand, Greetd };
