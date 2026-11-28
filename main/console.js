// Console: the system's logs (journalctl), LiquidDesktop's own logs, and crash reports (coredumpctl), for the
// Console app — and a bug report you can save and send: what this computer is, LiquidDesktop's logs, and the
// errors since it started.
const { ipcMain, app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { which, run, broadcast, handler, HOME, dataDir, cacheDir } = require('./common');

const PRI = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const follows = new Map();   // id → journalctl -f process

/** journalctl arguments for a source and filters. */
function journalArgs(q = {}) {
  const a = ['-o', 'json', '--no-pager', '-q'];
  switch (q.source) {
    case 'user': a.push('--user'); break;
    case 'kernel': a.push('-k'); break;
    case 'boot': a.push('-b', '0'); break;
    case 'lastboot': a.push('-b', '-1'); break;
    case 'errors': a.push('-p', '3', '-b', '0'); break;
    case 'session': a.push(`_UID=${process.getuid?.() ?? 1000}`); break;
    default: break;
  }
  if (q.priority != null && q.source !== 'errors') a.push('-p', String(Math.max(0, Math.min(7, q.priority))));
  if (q.since) a.push('--since', `@${Math.floor(q.since / 1000)}`);
  if (q.unit && /^[\w@.:-]+$/.test(q.unit)) a.push('-u', q.unit);
  if (q.grep) a.push('-g', String(q.grep).slice(0, 200), '--case-sensitive=false');
  if (q.before) a.push('--cursor', q.before, '--reverse');   // older pages: from a cursor backwards
  return a;
}
function parse(line) {
  try {
    const j = JSON.parse(line);
    let msg = j.MESSAGE;
    if (Array.isArray(msg)) msg = Buffer.from(msg).toString('utf8');   // binary messages come as byte arrays
    return {
      t: Math.floor(+j.__REALTIME_TIMESTAMP / 1000), pri: j.PRIORITY != null ? +j.PRIORITY : 6, cursor: j.__CURSOR,
      ident: j.SYSLOG_IDENTIFIER || j._COMM || (j._TRANSPORT === 'kernel' ? 'kernel' : '?'), pid: j._PID ? +j._PID : null,
      unit: j._SYSTEMD_USER_UNIT || j._SYSTEMD_UNIT || null, msg: String(msg ?? ''), exe: j._EXE || null, boot: j._BOOT_ID,
    };
  } catch { return null; }
}

/** The newest `limit` entries matching a query (or older ones, before a cursor), newest last. */
async function query(q = {}) {
  if (!which('journalctl')) throw new Error('journalctl isn’t available on this system.');
  const limit = Math.max(10, Math.min(5000, q.limit || 800));
  const args = journalArgs(q);
  if (q.before) args.push('-n', String(limit + 1)); else args.push('-n', String(limit));
  const r = await run('journalctl', args, { timeout: 20000 });
  let out = r.out.split('\n').filter(Boolean).map(parse).filter(Boolean);
  if (q.before) out = out.filter((e) => e.cursor !== q.before).reverse();
  const limited = !r.ok && /No journal files|permission|access/i.test(r.err);
  return { entries: out, note: out.length || !limited ? null : 'You can only see your own messages. To see the whole system’s, your account has to be in the “wheel” or “systemd-journal” group.' };
}

/** Stream new entries as they're written (until stop). */
function follow(id, q = {}) {
  stop(id);
  if (!which('journalctl')) return false;
  const args = journalArgs({ ...q, before: null });
  args.push('-f', '-n', '0');
  const c = spawn('journalctl', args);
  let buf = '';
  let pending = [], timer = null;
  const flush = () => { timer = null; if (pending.length) { broadcast('console:entries', id, pending); pending = []; } };
  c.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) { const e = parse(l); if (e) pending.push(e); }
    if (!timer) timer = setTimeout(flush, 250);   // a burst of messages arrives as one batch
  });
  c.on('exit', () => follows.delete(id));
  follows.set(id, c);
  return true;
}
function stop(id) { const c = follows.get(id); if (c) { try { c.kill(); } catch { /* gone */ } follows.delete(id); } return true; }

/* ------------------------------------------------ LiquidDesktop's own log files */
function logFiles() {
  const ud = app.getPath('userData');
  const list = [
    [path.join(ud, 'crashes.log'), 'LiquidDesktop crashes'],
    [path.join(ud, 'displays.log'), 'Displays (monitor changes)'],
    [cacheDir('picom.log'), 'Compositor (picom)'],
    [cacheDir('session.log'), 'Session'],
    [cacheDir('kdeconnect.log'), 'Phone (KDE Connect)'],
    [path.join(ud, 'android-bridge.log'), 'Android'],
    [path.join(HOME, '.local/share/xorg/Xorg.0.log'), 'X server'],
    [path.join(HOME, '.xsession-errors'), 'X session errors'],
  ];
  // anything else LiquidDesktop or the session script wrote
  for (const d of [cacheDir(), dataDir(), ud]) {
    try { for (const n of fs.readdirSync(d)) if (/\.log$/.test(n) && !list.some(([p]) => p === path.join(d, n))) list.push([path.join(d, n), n.replace(/\.log$/, '')]); } catch { /* none */ }
  }
  return list.filter(([p]) => { try { return fs.statSync(p).isFile(); } catch { return false; } })
    .map(([p, name]) => { const st = fs.statSync(p); return { path: p, name, size: st.size, mtime: st.mtimeMs }; });
}
/** The end of a log file, as lines. */
async function readLog(p, maxBytes = 512 * 1024) {
  if (!logFiles().some((f) => f.path === p)) throw new Error('Not a log file');
  const st = await fsp.stat(p);
  const fh = await fsp.open(p, 'r');
  try {
    const n = Math.min(st.size, maxBytes);
    const b = Buffer.alloc(n);
    await fh.read(b, 0, n, st.size - n);
    let t = b.toString('utf8');
    if (n < st.size) t = t.slice(t.indexOf('\n') + 1);
    return { text: t, truncated: n < st.size, size: st.size };
  } finally { await fh.close(); }
}

/* ------------------------------------------------ crash reports */
async function crashes() {
  if (!which('coredumpctl')) return { available: false, list: [] };
  const r = await run('coredumpctl', ['list', '--json=short', '--no-pager', '-q', '--since', '-30d'], { timeout: 15000 });
  let list = [];
  try { list = JSON.parse(r.out || '[]'); } catch { list = []; }
  return { available: true, list: list.map((c) => ({ t: Math.floor(c.time / 1000), pid: c.pid, uid: c.uid, sig: c.sig, exe: c.exe, present: c.corefile === 'present' || c.corefile === 'journal' })).reverse().slice(0, 300) };
}
async function crashInfo(pid) {
  if (!/^\d+$/.test(String(pid))) throw new Error('bad pid');
  const r = await run('coredumpctl', ['info', '--no-pager', String(pid)], { timeout: 20000 });
  return (r.out || r.err).slice(0, 200000);
}

/* ------------------------------------------------ the bug report */
async function report(dest) {
  const lines = [];
  const add = (t = '') => lines.push(t);
  const sec = (t) => { add(); add('='.repeat(72)); add(t); add('='.repeat(72)); };
  add(`LiquidDesktop report — ${new Date().toString()}`);
  sec('This computer');
  add(`LiquidDesktop ${app.getVersion()} · Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`);
  add(`Kernel: ${os.release()} · ${os.arch()} · ${os.cpus()[0]?.model || '?'} × ${os.cpus().length} · ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB`);
  try { add('System: ' + (fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)/m)?.[1] || '?')); } catch { /* none */ }
  add(`Session: ${process.env.XDG_SESSION_TYPE || '?'} · ${process.env.XDG_CURRENT_DESKTOP || '?'} · display ${process.env.DISPLAY || '?'}`);
  try { add('Rendering: ' + fs.readFileSync(path.join(app.getPath('userData'), 'rendering'), 'utf8').trim()); } catch { /* default */ }
  const gl = which('glxinfo') ? await run('glxinfo', ['-B'], { timeout: 5000 }) : null;
  if (gl?.ok) add(gl.out.split('\n').filter((l) => /renderer string|version string|Vendor/i.test(l)).map((l) => '  ' + l.trim()).join('\n'));
  if (which('xrandr')) { const x = await run('xrandr', ['--listmonitors'], { timeout: 4000 }); if (x.ok) add('Monitors:\n' + x.out.trim().split('\n').map((l) => '  ' + l).join('\n')); }
  for (const f of logFiles()) {
    sec(`${f.name} (${f.path}, last 200 lines)`);
    try { const { text } = await readLog(f.path, 128 * 1024); add(text.trimEnd().split('\n').slice(-200).join('\n')); } catch (e) { add('(couldn’t read: ' + e.message + ')'); }
  }
  sec('Errors since this computer started (journalctl -p 3 -b)');
  try { const q = await query({ source: 'errors', limit: 300 }); for (const e of q.entries) add(`${new Date(e.t).toISOString()} ${e.ident}[${e.pid ?? ''}]: ${e.msg}`); if (q.note) add(q.note); } catch (e) { add(e.message); }
  sec('LiquidDesktop and compositor messages this boot');
  try { const q = await query({ source: 'boot', grep: 'liquid|picom|electron', limit: 300 }); for (const e of q.entries) add(`${new Date(e.t).toISOString()} ${e.ident}[${e.pid ?? ''}]: ${e.msg}`); } catch (e) { add(e.message); }
  sec('Crashes in the last 30 days');
  try { const c = await crashes(); if (!c.available) add('coredumpctl isn’t available'); for (const x of c.list.slice(0, 40)) add(`${new Date(x.t).toISOString()} ${x.exe} (pid ${x.pid}, signal ${x.sig})`); } catch (e) { add(e.message); }
  const text = lines.join('\n') + '\n';
  let file = dest;
  if (!file) {
    const desk = fs.existsSync(path.join(HOME, 'Desktop')) ? path.join(HOME, 'Desktop') : HOME;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    file = path.join(desk, `LiquidDesktop Report ${stamp}.txt`);
  }
  await fsp.writeFile(file, text);
  return { path: file, size: text.length };
}

function register() {
  const h = handler(ipcMain);
  h('console:query', query);
  h('console:follow', follow);
  h('console:stop', stop);
  h('console:logFiles', logFiles);
  h('console:readLog', readLog);
  h('console:crashes', crashes);
  h('console:crashInfo', crashInfo);
  h('console:report', report);
  h('console:units', async () => {
    const r = await run('journalctl', ['-F', '_SYSTEMD_UNIT', '--no-pager'], { timeout: 10000 });
    return r.out.split('\n').filter(Boolean).sort().slice(0, 500);
  });
  app.on('will-quit', () => { for (const id of [...follows.keys()]) stop(id); });
}
module.exports = { register, PRI };
