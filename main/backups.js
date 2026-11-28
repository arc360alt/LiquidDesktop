// Time Machine: backups of your home folder, kept by the hour, the day and the week — like the Mac's.
//  • A backup drive (an external disk formatted for Linux: ext4, Btrfs, XFS…): every hour while it's connected, a
//    complete-looking copy of your home in "LiquidDesktop Backups/<computer> - <you>/<date>", with unchanged files
//    hard-linked to the previous backup (main/backup-worker.js). Old backups are thinned out: hourly ones for a day,
//    daily ones for a month, weekly ones after that — and the oldest go first when the drive gets full.
//  • Local snapshots: on Btrfs, snapper takes a snapshot of /home every hour (instant, no drive needed). Turning it on
//    needs your password once (a snapper configuration that lets you read and make your own snapshots).
//  • System snapshots: on Lumen, the system is snapshotted before every update (lumen-snapshots); they're listed and
//    one can be restored (rolled back) from here.
// Every backup and snapshot is a "point in time" the Time Machine app browses and restores files from.
const { ipcMain, app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { which, run, broadcast, handler, HOME, dataDir, installPackages } = require('./common');

const CFG = dataDir('timemachine.json');
const USER = os.userInfo().username;
const MACHINE = `${os.hostname()} - ${USER}`.replace(/[/\0]/g, '_');
const BASE = 'LiquidDesktop Backups';
const LINUX_FS = /^(ext[234]|btrfs|xfs|f2fs|ntfs3?|jfs|reiserfs|bcachefs|nilfs2)$/;
const DEFAULT_EXCLUDES = ['.cache', '.local/share/Trash', '.thumbnails', '.local/share/Steam', '.steam', '.var/app/com.valvesoftware.Steam', '.local/share/containers', '.local/share/flatpak', '.local/share/waydroid', 'snap'];

let cfg = null;
const loadCfg = () => {
  if (cfg) return cfg;
  try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { cfg = {}; }
  cfg.auto ??= true; cfg.interval ??= 3600e3; cfg.onBattery ??= true;
  cfg.excludes ??= DEFAULT_EXCLUDES.map((e) => path.join(HOME, e));
  return cfg;
};
async function saveCfg() { await fsp.mkdir(path.dirname(CFG), { recursive: true }); await fsp.writeFile(CFG + '.tmp', JSON.stringify(cfg, null, 1)); await fsp.rename(CFG + '.tmp', CFG); }
const changed = () => broadcast('tm:changed');

/* ------------------------------------------------ backup drives */
async function lsblk() {
  const r = await run('lsblk', ['-J', '-b', '-o', 'NAME,PATH,PKNAME,UUID,LABEL,MOUNTPOINTS,FSTYPE,SIZE,FSAVAIL,RM,HOTPLUG,TRAN,TYPE,MODEL'], { timeout: 10000 });
  try { return JSON.parse(r.out).blockdevices || []; } catch { return []; }
}
/** Disks and partitions that could hold backups (not the one your system or home is on). */
async function drives() {
  const tree = await lsblk();
  const out = [];
  const sysDisks = new Set();
  const flat = [];
  const walk = (d, disk) => { flat.push({ d, disk }); for (const c of d.children || []) walk(c, disk); };
  for (const d of tree) walk(d, d);
  for (const { d, disk } of flat) if ((d.mountpoints || []).some((m) => m && /^\/(|home|boot|boot\/efi|efi|usr|var)$/.test(m))) sysDisks.add(disk.name);
  for (const { d, disk } of flat) {
    if (!d.uuid || !d.fstype || /swap|crypto_LUKS|LVM2_member|linux_raid_member|iso9660|squashfs/.test(d.fstype) || d.type === 'loop' || /^zram/.test(d.name)) continue;
    if (sysDisks.has(disk.name)) continue;
    const mount = (d.mountpoints || []).find(Boolean) || null;
    const ok = LINUX_FS.test(d.fstype);
    out.push({
      uuid: d.uuid, device: d.path, label: d.label || disk.model?.trim() || d.name, fstype: d.fstype, size: +d.size || 0, avail: d.fsavail != null ? +d.fsavail : null,
      mount, removable: !!(disk.rm || disk.hotplug || disk.tran === 'usb'), ok,
      reason: ok ? null : `This drive is formatted as ${d.fstype.toUpperCase()}, which can’t keep versions of your files efficiently. Time Machine needs a drive formatted for Linux (ext4 or Btrfs).`,
    });
  }
  return out;
}
/** The chosen backup drive, mounted (udisks mounts it without a password when it's yours to mount). */
async function mountDest() {
  const c = loadCfg();
  if (!c.dest?.uuid) return null;
  const d = (await drives()).find((x) => x.uuid === c.dest.uuid);
  if (!d) return null;
  if (!d.mount) {
    const r = await run('udisksctl', ['mount', '-b', d.device, '--no-user-interaction'], { timeout: 30000 });
    const m = r.out.match(/ at (.+?)\.?\s*$/m);
    if (!r.ok || !m) return { ...d, error: 'The backup drive couldn’t be opened: ' + (r.err.trim() || 'mount failed') };
    d.mount = m[1];
  }
  return d;
}
const rootOn = (mount) => path.join(mount, BASE, MACHINE);

/** Get a drive ready: the backup folder, owned by you (on a freshly formatted drive only the administrator can write). */
async function prepare(uuid) {
  const c = loadCfg();
  const old = c.dest;
  // a drive that can't hold backups is turned away before anything is mounted
  const pre = (await drives()).find((x) => x.uuid === uuid);
  if (!pre) throw new Error('That drive isn’t connected.');
  if (!pre.ok) throw new Error(pre.reason);
  c.dest = { uuid };
  const d = await mountDest().catch(() => null);
  if (!d) { c.dest = old; throw new Error('That drive isn’t connected.'); }
  if (d.error) { c.dest = old; throw new Error(d.error); }
  if (!d.ok) { c.dest = old; throw new Error(d.reason); }
  const base = path.join(d.mount, BASE);
  try { await fsp.mkdir(rootOn(d.mount), { recursive: true }); } catch (e) {
    if (e.code !== 'EACCES' && e.code !== 'EPERM') throw e;
    // needs the administrator once: make the folder and give it to you (the password was asked for just before)
    const { sudoScript } = require('./appstore');
    const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
    const r = await sudoScript(`set -e\nmkdir -p ${q(base)}\nchown ${q(USER)}: ${q(base)}\nchmod 755 ${q(base)}`);
    if (!r.ok) { c.dest = old; throw new Error(/password/i.test(r.out) ? 'NEEDS_PASSWORD' : r.out || 'The backup folder couldn’t be made.'); }
    await fsp.mkdir(rootOn(d.mount), { recursive: true });
  }
  c.dest = { uuid, label: d.label, fstype: d.fstype, added: Date.now() };
  await saveCfg(); changed();
  return status();
}
async function forget() { const c = loadCfg(); c.dest = null; await saveCfg(); changed(); return status(); }

/* ------------------------------------------------ backups on the drive */
const STAMP_RE = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)(\d\d)(\d\d)$/;
const stampOf = (t = new Date()) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}-${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}${String(t.getSeconds()).padStart(2, '0')}`;
const timeOf = (s) => { const m = s.match(STAMP_RE); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : 0; };
async function driveBackups(root) {
  const names = await fsp.readdir(root).catch(() => []);
  return names.filter((n) => STAMP_RE.test(n)).sort().map((n) => ({ id: 'drive:' + n, source: 'drive', name: n, time: timeOf(n), path: path.join(root, n) }));
}

let job = null;   // the backup that's running: { proc, progress, started }
let lastFail = null;
async function backupNow({ auto = false } = {}) {
  if (job) return { running: true };
  const c = loadCfg();
  const d = await mountDest();
  if (!d) { if (!auto) throw new Error('The backup drive isn’t connected.'); return { skipped: 'not connected' }; }
  if (d.error) throw new Error(d.error);
  const root = rootOn(d.mount);
  await fsp.mkdir(root, { recursive: true });
  // one backup at a time, even from two LiquidDesktops (a session and a test window)
  const lock = path.join(root, '.lock');
  try {
    const held = JSON.parse(await fsp.readFile(lock, 'utf8'));
    if (held.pid && held.host === os.hostname()) { try { process.kill(held.pid, 0); return { running: true }; } catch { /* stale */ } }
  } catch { /* no lock */ }
  await fsp.writeFile(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }));
  // a backup that was stopped part way: start over (its files would be linked from anyway)
  for (const n of await fsp.readdir(root).catch(() => [])) if (n.endsWith('.inprogress')) await rmTree(path.join(root, n)).catch(() => {});
  await thin(root, d);
  const list = await driveBackups(root);
  const prev = list[list.length - 1]?.path || null;
  const stamp = stampOf();
  const excludes = [...c.excludes, d.mount].filter(Boolean);   // (a backup drive mounted inside your home isn't backed up onto itself)
  const proc = spawn(process.execPath, [path.join(__dirname, 'backup-worker.js'), JSON.stringify({ src: HOME, root, stamp, prev, excludes })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  job = { proc, progress: null, started: Date.now(), drive: d.label };
  changed();
  let buf = '', result = null;
  proc.stdout.on('data', (b) => {
    buf += b;
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      let m; try { m = JSON.parse(l); } catch { continue; }
      if (m.progress) { job.progress = m.progress; broadcast('tm:progress', m.progress); }
      if (m.done || m.failed) result = m;
    }
  });
  proc.stderr.on('data', (b) => console.warn('[timemachine]', String(b).trim()));
  return new Promise((resolve) => {
    proc.on('exit', async () => {
      await fsp.rm(lock, { force: true }).catch(() => {});
      job = null;
      if (result?.done) {
        c.last = { time: Date.now(), stamp, files: result.done.files, copiedBytes: result.done.copiedBytes, errors: result.done.errors, drive: d.label };
        lastFail = null;
        await thin(root, await mountDest().catch(() => d) || d).catch(() => {});
      } else {
        lastFail = { time: Date.now(), why: result?.failed === 'full' ? 'The backup drive is full.' : result?.failed === 'stopped' ? null : (result?.failed || 'The backup stopped.') };
        if (lastFail.why) c.lastError = lastFail;
        if (result?.failed === 'full') await thin(root, d, true).catch(() => {});
      }
      await saveCfg().catch(() => {});
      changed();
      broadcast('tm:finished', result?.done ? { ok: true } : { ok: false, why: lastFail?.why });
      resolve(result?.done ? { ok: true, stamp } : { ok: false, why: lastFail?.why });
    });
  });
}
function stop() { if (job) { try { job.proc.kill('SIGTERM'); } catch { /* gone */ } } return true; }

// deleting an old backup: its folders are writable (the copier keeps them so), its files are just links
async function rmTree(p) { await fsp.rm(p, { recursive: true, force: true }); }
/** Keep hourly backups for 24 hours, daily ones for a month, weekly ones after that; when space is short, the oldest go. */
async function thin(root, d, aggressive = false) {
  const list = await driveBackups(root);
  if (list.length < 2) return;
  const now = Date.now(), keep = new Set([list[list.length - 1].name]);
  const bucket = new Map();
  for (const b of list) {
    const age = now - b.time;
    // the last 24 hours: every backup (hourly ones, and any you made in between); then one a day; then one a week
    const key = age < 864e5 ? b.name : age < 30 * 864e5 ? 'd' + b.name.slice(0, 10) : 'w' + Math.floor(b.time / (7 * 864e5));
    bucket.set(key, b.name);   // the newest in each hour / day / week
  }
  for (const n of bucket.values()) keep.add(n);
  for (const b of list) if (!keep.has(b.name)) await rmTree(b.path).catch(() => {});
  // space: under 5% free (or full), delete the oldest until there's room — never the newest
  const free = async () => { const s = await fsp.statfs?.(root).catch(() => null); return s ? (s.bavail * s.bsize) / (s.blocks * s.bsize) : 1; };
  let left = await driveBackups(root);
  while (left.length > 1 && (aggressive || (await free()) < 0.05)) {
    await rmTree(left[0].path).catch(() => {});
    left = left.slice(1);
    aggressive = false;
  }
}

/* ------------------------------------------------ local snapshots (snapper, Btrfs /home) */
async function snapperHome() {
  if (!which('snapper')) return { available: false, reason: 'snapper' };
  const fst = (await run('findmnt', ['-no', 'FSTYPE', '/home'], { timeout: 3000 })).out.trim();
  if (fst !== 'btrfs') return { available: false, reason: 'not-btrfs' };
  const r = await run('snapper', ['-c', 'home', '--jsonout', 'list'], { timeout: 10000 });
  if (!r.ok) return { available: true, enabled: false, reason: /does not exist|Unknown config/i.test(r.err + r.out) ? 'off' : 'no-access', err: (r.err || r.out).trim() };
  let list = [];
  try { list = (JSON.parse(r.out).home || []).filter((s) => s.number > 0); } catch { /* none */ }
  return { available: true, enabled: true, snapshots: list.map((s) => ({ id: 'local:' + s.number, source: 'local', number: s.number, time: Date.parse(s.date.replace(' ', 'T')) || 0, label: s.description || (s.cleanup === 'timeline' ? 'Hourly snapshot' : ''), path: path.join('/home/.snapshots', String(s.number), 'snapshot', path.relative('/home', HOME)) })) };
}
async function localStatus() {
  const homeFs = (await run('findmnt', ['-no', 'FSTYPE', '/home'], { timeout: 3000 })).out.trim() || (await run('findmnt', ['-no', 'FSTYPE', '/'], { timeout: 3000 })).out.trim();
  const s = await snapperHome();
  return { btrfs: homeFs === 'btrfs', snapper: !!which('snapper'), enabled: !!s.enabled, count: s.snapshots?.length || 0, reason: s.reason || null };
}
/** Turn local snapshots on: a snapper configuration for /home you can use without a password, taking one every hour. */
async function localSetup(on) {
  if (on) {
    if (!which('snapper')) await installPackages({ pacman: ['snapper'], apt: ['snapper'], dnf: ['snapper'] }, 'Snapper');
    const { sudoScript } = require('./appstore');
    const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
    const r = await sudoScript(`set -e
[ -f /etc/snapper/configs/home ] || snapper -c home create-config /home
snapper -c home set-config ALLOW_USERS=${q(USER)} SYNC_ACL=yes TIMELINE_CREATE=yes TIMELINE_CLEANUP=yes TIMELINE_LIMIT_HOURLY=24 TIMELINE_LIMIT_DAILY=7 TIMELINE_LIMIT_WEEKLY=4 TIMELINE_LIMIT_MONTHLY=3 TIMELINE_LIMIT_YEARLY=0
systemctl enable --now snapper-timeline.timer snapper-cleanup.timer
snapper -c home create -d 'Local snapshots turned on' -c timeline`);
    if (!r.ok) throw new Error(/password/i.test(r.out) ? 'Your password wasn’t accepted.' : r.out.split('\n').slice(-3).join('\n') || 'Local snapshots couldn’t be turned on.');
  } else {
    // off: no new hourly snapshots (the ones there are stay until snapper cleans them up)
    const { sudoScript } = require('./appstore');
    const r = await sudoScript('set -e\n[ -f /etc/snapper/configs/home ] && snapper -c home set-config TIMELINE_CREATE=no || true');
    if (!r.ok) throw new Error(r.out || 'Couldn’t turn local snapshots off.');
  }
  changed();
  return localStatus();
}
async function snapNow(desc = 'Snapshot') {
  const r = await run('snapper', ['-c', 'home', 'create', '-d', String(desc).slice(0, 80), '-c', 'timeline'], { timeout: 30000 });
  if (!r.ok) throw new Error((r.err || r.out).trim() || 'The snapshot couldn’t be taken.');
  changed();
  return true;
}

/* ------------------------------------------------ system snapshots (Lumen) */
async function systemSnapshots() {
  if (!which('lumen-snapshots') || !which('snapper')) return { available: false, list: [] };
  const r = await run('snapper', ['-c', 'root', '--jsonout', 'list'], { timeout: 10000 });
  let list = [];
  try { list = (JSON.parse(r.out).root || []).filter((s) => s.number > 0); } catch { /* none */ }
  const live = (await run('findmnt', ['-no', 'FSTYPE', '/'], { timeout: 3000 })).out.trim() === 'overlay';
  return { available: true, readable: r.ok, live, list: list.map((s) => ({ id: 'system:' + s.number, source: 'system', number: s.number, time: Date.parse(s.date.replace(' ', 'T')) || 0, label: s.description || '', kind: s.type, path: path.join('/.snapshots', String(s.number), 'snapshot') })).reverse() };
}
async function systemRollback(n) {
  if (!/^\d+$/.test(String(n))) throw new Error('bad snapshot');
  const { sudoScript } = require('./appstore');
  const r = await sudoScript(`lumen-snapshots rollback ${n}`);
  if (!r.ok) throw new Error(/password/i.test(r.out) ? 'Your password wasn’t accepted.' : r.out.split('\n').slice(-4).join('\n'));
  return { ok: true, out: r.out };
}

/* ------------------------------------------------ points in time, browsing, restoring */
async function points() {
  const out = [];
  const c = loadCfg();
  let dest = null;
  if (c.dest?.uuid) {
    dest = (await drives()).find((x) => x.uuid === c.dest.uuid) || null;
    if (dest?.mount) out.push(...await driveBackups(rootOn(dest.mount)));
  }
  const loc = await snapperHome().catch(() => ({}));
  if (loc.snapshots) out.push(...loc.snapshots);
  return out.sort((a, b) => a.time - b.time);
}
/** The folder in a point in time that holds what was at `rel` (relative to your home). */
async function resolvePoint(id, rel = '') {
  if (String(rel).split('/').includes('..')) throw new Error('bad path');
  const p = (await points()).find((x) => x.id === id);
  if (!p) throw new Error('That backup isn’t available (is the backup drive connected?).');
  return { point: p, abs: path.join(p.path, rel || '') };
}
async function list(id, rel = '') {
  const { abs } = await resolvePoint(id, rel);
  const names = await fsp.readdir(abs).catch((e) => { throw new Error(e.code === 'ENOENT' ? 'This folder didn’t exist yet then.' : e.message); });
  const out = [];
  for (const n of names) {
    if (n === '.liquid-backup.json') continue;
    const st = await fsp.lstat(path.join(abs, n)).catch(() => null);
    if (!st) continue;
    const now = await fsp.lstat(path.join(HOME, rel || '', n)).catch(() => null);
    out.push({ name: n, rel: path.join(rel || '', n), isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, ext: st.isDirectory() ? '' : path.extname(n).slice(1).toLowerCase(), hidden: n.startsWith('.'),
      state: !now ? 'gone' : (now.isDirectory() !== st.isDirectory() || (!st.isDirectory() && (now.size !== st.size || Math.abs(now.mtimeMs - st.mtimeMs) >= 2))) ? 'changed' : 'same', abs: path.join(abs, n) });
  }
  return out;
}
/** Which of these items are in the way now (restoring would replace them). */
async function conflicts(id, rels) { const out = []; for (const r of rels) if (fs.existsSync(path.join(HOME, r))) out.push(r); void id; return out; }
/** Put items back where they were: replacing what's there, or next to it ("name (original).ext"). */
async function restore(id, rels, { mode = 'keepBoth', to } = {}) {
  const done = [];
  for (const rel of rels) {
    const { abs } = await resolvePoint(id, rel);
    let dest = to ? path.join(to, path.basename(rel)) : path.join(HOME, rel);
    if (fs.existsSync(dest)) {
      // replacing: what's there now goes to the Trash (so it can still be got back), not gone for good
      if (mode === 'replace') { const t = which('gio') ? await run('gio', ['trash', dest], { timeout: 30000 }) : { ok: false }; if (!t.ok) await fsp.rm(dest, { recursive: true, force: true }); }
      else {
        const ext = path.extname(dest), stem = dest.slice(0, dest.length - ext.length);
        let n = `${stem} (original)${ext}`;
        for (let i = 2; fs.existsSync(n); i++) n = `${stem} (original ${i})${ext}`;
        dest = n;
      }
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.cp(abs, dest, { recursive: true, preserveTimestamps: true, force: true, errorOnExist: false, verbatimSymlinks: true });
    done.push(dest);
  }
  return done;
}
async function deletePoint(id) {
  const { point } = await resolvePoint(id, '');
  if (point.source === 'drive') { await rmTree(point.path); }
  else if (point.source === 'local') { const r = await run('snapper', ['-c', 'home', 'delete', String(point.number)], { timeout: 60000 }); if (!r.ok) throw new Error((r.err || r.out).trim()); }
  changed();
  return true;
}

/* ------------------------------------------------ status, settings, the schedule */
async function onBattery() {
  for (const n of await fsp.readdir('/sys/class/power_supply').catch(() => [])) {
    const t = await fsp.readFile(`/sys/class/power_supply/${n}/type`, 'utf8').catch(() => '');
    if (t.trim() === 'Mains') return (await fsp.readFile(`/sys/class/power_supply/${n}/online`, 'utf8').catch(() => '1')).trim() === '0';
  }
  return false;
}
async function status() {
  const c = loadCfg();
  const all = await drives().catch(() => []);
  const dest = c.dest?.uuid ? all.find((x) => x.uuid === c.dest.uuid) : null;
  let backups = [], space = null;
  if (dest?.mount) {
    backups = await driveBackups(rootOn(dest.mount));
    const s = await fsp.statfs?.(dest.mount).catch(() => null);
    if (s) space = { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  }
  const last = c.last || null;
  const next = c.auto && c.dest ? Math.max(Date.now(), (last?.time || 0) + c.interval) : null;
  return {
    dest: c.dest ? { ...c.dest, connected: !!dest, mounted: !!dest?.mount, mount: dest?.mount || null, ok: dest ? dest.ok : true, space, count: backups.length, oldest: backups[0]?.time || null, newest: backups[backups.length - 1]?.time || null } : null,
    auto: c.auto, interval: c.interval, onBattery: c.onBattery, excludes: c.excludes, last, lastError: c.lastError || null, next,
    running: job ? { started: job.started, progress: job.progress, drive: job.drive } : null,
    local: await localStatus().catch(() => ({})),
    system: which('lumen-snapshots') ? { available: true } : { available: false },
    home: HOME, machine: MACHINE,
  };
}
async function setOptions(o = {}) {
  const c = loadCfg();
  if (o.auto != null) c.auto = !!o.auto;
  if (o.interval) c.interval = Math.max(15 * 60e3, +o.interval);
  if (o.onBattery != null) c.onBattery = !!o.onBattery;
  if (Array.isArray(o.excludes)) c.excludes = o.excludes.filter((e) => typeof e === 'string' && e.startsWith('/'));
  if (o.clearError) c.lastError = null;
  await saveCfg(); changed();
  return status();
}
// the schedule: every few minutes, back up when it's time and the drive is there
let timer = null;
function schedule() {
  clearInterval(timer);
  timer = setInterval(async () => {
    const c = loadCfg();
    if (!c.auto || !c.dest || job) return;
    if (Date.now() - (c.last?.time || 0) < c.interval) return;
    if (!c.onBattery && (await onBattery())) return;
    // a failed attempt waits a while before the next
    if (lastFail && Date.now() - lastFail.time < 15 * 60e3) return;
    const d = (await drives().catch(() => [])).find((x) => x.uuid === c.dest.uuid);
    if (!d || !d.ok) return;
    backupNow({ auto: true }).catch((e) => { lastFail = { time: Date.now(), why: e.message }; });
  }, 5 * 60e3);
}

function register({ mode } = {}) {
  const h = handler(ipcMain);
  h('tm:status', status);
  h('tm:drives', drives);
  h('tm:prepare', prepare);
  h('tm:forget', forget);
  h('tm:options', setOptions);
  h('tm:backupNow', () => backupNow());
  h('tm:stop', stop);
  h('tm:points', points);
  h('tm:list', list);
  h('tm:conflicts', conflicts);
  h('tm:restore', restore);
  h('tm:delete', deletePoint);
  h('tm:localSetup', localSetup);
  h('tm:snapNow', snapNow);
  h('tm:system', systemSnapshots);
  h('tm:systemRollback', systemRollback);
  // backups run on their own only in a real session (a test window must never write to your backup drive)
  if (mode === 'session' && !process.env.LIQUID_NO_BACKUPS) schedule();
  app.on('will-quit', () => { clearInterval(timer); stop(); });
}
module.exports = { register, status };
