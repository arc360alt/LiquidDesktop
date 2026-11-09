// App Store back end: Flathub (web API + flatpak) and Arch Linux packages (AppStream data + pacman).
const { ipcMain, net } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FLATHUB = 'https://flathub.org/api/v2/';
const run = (cmd, args, opts = {}) => new Promise((res) => execFile(cmd, args, { timeout: opts.timeout || 20000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
  (err, out, errOut) => res({ ok: !err, out: String(out || ''), err: String(errOut || '') })));
const has = (bin) => (process.env.PATH || '').split(':').some((d) => { try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { return false; } });

/* ------------------------------------------------------------------ Flathub (cached) */
const cache = new Map();
async function flathub(p, body) {
  const key = p + (body ? JSON.stringify(body) : '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 30 * 60_000) return hit.v;
  const res = await net.fetch(FLATHUB + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (!res.ok) throw new Error(`Flathub returned ${res.status}`);
  const v = await res.json();
  cache.set(key, { t: Date.now(), v });
  return v;
}

/* ------------------------------------------------------------------ Arch Linux AppStream catalog */
let archApps = null;
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function loadArchCatalog() {
  if (archApps) return archApps;
  archApps = [];
  const dir = '/usr/share/swcatalog/xml';
  const seen = new Set();
  for (const repo of ['core', 'extra', 'multilib']) {
    let xml;
    try { xml = zlib.gunzipSync(fs.readFileSync(path.join(dir, `${repo}.xml.gz`))).toString('utf8'); } catch { continue; }
    for (const m of xml.matchAll(/<component type="desktop-application">([\s\S]*?)<\/component>/g)) {
      const c = m[1];
      const tag = (t) => { const x = c.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return x ? unxml(x[1].trim()) : ''; };
      const pkg = tag('pkgname');
      if (!pkg || seen.has(pkg)) continue;
      seen.add(pkg);
      const icon = (c.match(/<icon type="cached" width="128" height="128">([^<]+)<\/icon>/) || c.match(/<icon type="cached" width="64" height="64">([^<]+)<\/icon>/) || [])[1];
      const iconSize = c.includes('width="128" height="128">' + icon) ? '128x128' : '64x64';
      const desc = (c.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
      archApps.push({
        source: 'pacman', id: pkg, pkg, repo, name: tag('name') || pkg, summary: tag('summary'),
        description: unxml(desc.replace(/<li>/g, '• ').replace(/<\/(p|li)>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim(),
        icon: icon ? `/usr/share/swcatalog/icons/archlinux-arch-${repo}/${iconSize}/${icon}` : null,
        launchable: (c.match(/<launchable type="desktop-id">([^<]+)<\/launchable>/) || [])[1] || null,
        categories: [...c.matchAll(/<category>([^<]+)<\/category>/g)].map((x) => x[1]),
        keywords: [...c.matchAll(/<keyword>([^<]+)<\/keyword>/g)].map((x) => x[1].toLowerCase()),
        homepage: (c.match(/<url type="homepage">([^<]+)<\/url>/) || [])[1] || null,
        screenshots: [...c.matchAll(/<image[^>]*type="source"[^>]*>([^<]+)<\/image>/g)].map((x) => unxml(x[1])).slice(0, 6),
        developer: tag('developer_name') || unxml((c.match(/<developer[^>]*>\s*<name>([^<]+)<\/name>/) || [])[1] || ''),
      });
    }
  }
  return archApps;
}

async function pacmanSearch(q) {
  if (!has('pacman') || !q.trim()) return [];
  const r = await run('pacman', ['-Ss', q.trim()]);
  const out = [];
  const lines = r.out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\w[\w-]*)\/(\S+) (\S+)(.*)$/);
    if (!m) continue;
    out.push({ source: 'pacman', id: m[2], pkg: m[2], repo: m[1], version: m[3], installed: /\[installed/.test(m[4]), summary: (lines[i + 1] || '').trim() });
  }
  return out.slice(0, 60);
}

async function pacmanInfo(pkg) {
  const r = await run('pacman', ['-Si', pkg]);
  const info = {};
  let key = null;
  for (const line of r.out.split('\n')) {
    const m = line.match(/^([A-Za-z][A-Za-z ]+?)\s*: (.*)$/);
    if (m) { key = m[1]; info[key] = m[2]; } else if (key && line.startsWith(' ')) info[key] += ' ' + line.trim();
  }
  return info;
}

async function installed() {
  const out = { pacman: [], flatpak: [] };
  if (has('pacman')) out.pacman = (await run('pacman', ['-Qq'])).out.split('\n').filter(Boolean);
  if (has('flatpak')) {
    const r = await run('flatpak', ['list', '--app', '--columns=application,version,installation,name']);
    out.flatpak = r.out.split('\n').filter(Boolean).map((l) => { const [id, version, installation, name] = l.split('\t'); return { id, version, installation, name }; });
  }
  return out;
}

async function updates() {
  const out = { pacman: [], flatpak: [], pacmanAvailable: has('checkupdates') };
  if (has('checkupdates')) {
    // checkupdates uses a private copy of the sync database, so it never leaves the system half-updated
    const r = await run('checkupdates', [], { timeout: 90000 });
    out.pacman = r.out.split('\n').filter(Boolean).map((l) => { const [pkg, from, , to] = l.split(' '); return { pkg, from, to }; });
  }
  if (has('flatpak')) {
    const r = await run('flatpak', ['remote-ls', '--updates', '--app', '--columns=application,version,name'], { timeout: 60000 });
    out.flatpak = r.out.split('\n').filter(Boolean).map((l) => { const [id, version, name] = l.split('\t'); return { id, version, name }; });
  }
  return out;
}

/* ------------------------------------------------------------------ sudo password (memory only, 10 minutes) */
let sudoPass = null, sudoUntil = 0;
async function sudoStatus() {
  if ((await run('sudo', ['-n', 'true'])).ok) return { needed: false };
  return { needed: !(sudoPass && Date.now() < sudoUntil) };
}
function checkSudo(password) {
  return new Promise((resolve) => {
    const c = spawn('sudo', ['-S', '-k', '-p', '', '-v'], { stdio: ['pipe', 'ignore', 'pipe'] });
    c.on('exit', (code) => { if (code === 0) { sudoPass = password; sudoUntil = Date.now() + 10 * 60_000; } resolve(code === 0); });
    c.stdin.end(password + '\n');
  });
}

/* ------------------------------------------------------------------ Flathub: user or system? */
// Like the flatpak command: use the system-wide "flathub" remote when there is one, else a per-user one.
async function flatpakRemotes() {
  const r = await run('flatpak', ['remotes', '--columns=name,options']);
  const out = { system: false, user: false };
  for (const line of r.out.split('\n')) {
    const [name, opts = ''] = line.split('\t');
    if (name !== 'flathub' || /disabled/.test(opts)) continue;
    if (/user/.test(opts)) out.user = true; else out.system = true;
  }
  return out;
}
async function flatpakScope(pref = 'auto') {
  if (pref === 'user' || pref === 'system') return pref;
  return (await flatpakRemotes()).system ? 'system' : 'user';
}
const FLATHUB_REPO = 'https://dl.flathub.org/repo/flathub.flatpakrepo';

/* ------------------------------------------------------------------ jobs (install / remove / update) */
let jobSeq = 0;
function startJob(sender, job) {
  const id = ++jobSeq;
  let cmd, args, needsSudo = false;
  const fp = ['--noninteractive', '-y'];
  if (job.source === 'flatpak') {
    const sys = job.installation === 'system';
    const where = sys ? '--system' : '--user';
    if (job.action === 'install') {
      if (sys) { cmd = 'flatpak'; args = ['install', where, ...fp, 'flathub', job.id]; needsSudo = true; }
      // a per-user install needs a per-user Flathub remote: add it first if it's missing (no password needed)
      else { cmd = 'sh'; args = ['-c', `flatpak remote-add --user --if-not-exists flathub ${FLATHUB_REPO} && exec flatpak install --user ${fp.join(' ')} flathub "$1"`, 'sh', job.id]; }
    } else if (job.action === 'remove') { cmd = 'flatpak'; args = ['uninstall', ...fp, where, job.id]; needsSudo = sys; }
    else if (job.action === 'update') {
      if (job.id) { cmd = 'flatpak'; args = ['update', where, ...fp, job.id]; needsSudo = sys; }
      // update everything: system-wide apps (as root) and this user's apps
      else { cmd = 'sh'; args = ['-c', `sudo -S -p '' flatpak update --system ${fp.join(' ')}; flatpak update --user ${fp.join(' ')} </dev/null`]; job.feedPassword = true; }
    }
  } else {
    needsSudo = true;
    if (job.action === 'install') { cmd = 'pacman'; args = ['-S', '--noconfirm', '--needed', job.id]; }
    else if (job.action === 'remove') { cmd = 'pacman'; args = ['-Rns', '--noconfirm', job.id]; }
    else if (job.action === 'update') { cmd = 'pacman'; args = ['-Syu', '--noconfirm']; }
  }
  if (!cmd) throw new Error('Unknown job');
  const env = { ...process.env, LC_ALL: 'C' };
  // flatpak and pacman only print progress (percentages) on a terminal, so run them in a pseudo-terminal
  // via script(1). Not for the "update everything" shell, whose inner sudo reads the password: a pty would echo it.
  if (has('script') && !job.feedPassword) {
    const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
    args = ['-qfec', `stty cols 120 rows 40 2>/dev/null; exec ${[cmd, ...args].map(q).join(' ')}`, '/dev/null'];
    cmd = 'script';
  }
  const child = needsSudo ? spawn('sudo', ['-S', '-p', '', cmd, ...args], { env }) : spawn(cmd, args, { env });
  if (needsSudo || job.feedPassword) child.stdin.end((sudoPass || '') + '\n'); else child.stdin.end();
  const send = (msg) => { if (!sender.isDestroyed()) sender.send('store:progress', { job: id, ...msg }); };
  let tail = '';
  const onData = (d) => {
    const text = d.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][0-9A-Za-z]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    tail = (tail + text).slice(-4000);
    const pcts = [...text.matchAll(/(\d{1,3})%/g)].map((m) => +m[1]).filter((n) => n <= 100);
    const line = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).pop();
    // "Installing 2/3…" (flatpak) or "(2/3) installing" (pacman): fold the step into one overall percentage
    const steps = [...tail.slice(-600).matchAll(/(?:^|[\s(])(\d+)\/(\d+)(?=[\s)…]|\.\.\.)/g)].pop();
    let percent = pcts.length ? pcts[pcts.length - 1] : undefined;
    if (percent !== undefined && steps && +steps[2] > 1 && +steps[1] <= +steps[2]) percent = Math.round(((+steps[1] - 1) + percent / 100) / +steps[2] * 100);
    send({ line, percent });
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => send({ done: true, ok: false, error: err.message }));
  child.on('exit', (code) => {
    // a system-wide update finished: let the desktop offer to log out (see watchUpdates in system.js)
    if (code === 0 && job.action === 'update' && !job.id) { try { fs.writeFileSync(path.join(require('electron').app.getPath('userData'), 'update-done'), String(Date.now())); } catch { /* ignore */ } }
  });
  child.on('exit', (code) => send({ done: true, ok: code === 0, error: code === 0 ? null : tail.split('\n').filter(Boolean).slice(-3).join('\n') }));
  return id;
}

function register() {
  const h = (ch, fn) => ipcMain.handle(ch, async (e, ...a) => { try { return await fn(...a, e); } catch (err) { return { __error: String(err.message || err) }; } });
  h('store:flathub', (p) => flathub(p));
  h('store:flathubSearch', (q) => flathub('search', { query: q, filters: [] }));
  h('store:archApps', () => loadArchCatalog());
  h('store:pacmanSearch', pacmanSearch);
  h('store:pacmanInfo', pacmanInfo);
  h('store:installed', installed);
  h('store:updates', updates);
  h('store:caps', () => ({ flatpak: has('flatpak'), pacman: has('pacman'), appstream: fs.existsSync('/usr/share/swcatalog/xml/extra.xml.gz') }));
  h('store:sudoStatus', sudoStatus);
  h('store:flatpakScope', flatpakScope);
  h('store:sudoCheck', checkSudo);
  h('store:job', (job, e) => startJob(e.sender, job));
  h('store:launchFlatpak', (id) => { spawn('flatpak', ['run', id], { detached: true, stdio: 'ignore' }).unref(); return true; });
}

/** Run a shell script as root with the remembered sudo password (or passwordless sudo). */
function sudoScript(script) {
  return new Promise((resolve) => {
    const c = spawn('sudo', ['-S', '-p', '', 'sh', '-c', script], { env: { ...process.env, LC_ALL: 'C' } });
    let out = '';
    c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
    c.on('exit', (code) => resolve({ ok: code === 0, out: out.trim() }));
    c.on('error', (e) => resolve({ ok: false, out: e.message }));
    c.stdin.end((sudoPass || '') + '\n');
  });
}

module.exports = { register, sudoStatus, checkSudo, sudoScript };
