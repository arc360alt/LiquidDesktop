// Time Machine's copier: one backup of a folder (your home) into a new dated folder on the backup drive, the way the
// Mac's Time Machine does it on a plain disk — a file that hasn't changed since the last backup isn't copied again but
// hard-linked to the copy already there, so every backup looks complete while only the changes take space.
// Runs as its own process (ELECTRON_RUN_AS_NODE), started by main/backups.js:
//   argv[2] = JSON { src, root, stamp, prev, excludes }   — root: the folder backups go in; prev: the last backup
// Progress and the result are JSON lines on stdout. The backup is made as "<stamp>.inprogress" and only renamed to
// "<stamp>" when it's complete, so a stopped or failed backup never looks like a good one.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const job = JSON.parse(process.argv[2]);
const { src, root, stamp, prev, excludes = [] } = job;
const dest = path.join(root, stamp + '.inprogress');
const stats = { files: 0, dirs: 0, bytes: 0, copied: 0, copiedBytes: 0, linked: 0, errors: 0, current: '' };
const errors = [];
let stopped = false;
process.on('SIGTERM', () => { stopped = true; });
const ex = excludes.map((e) => path.resolve(e));
const excluded = (p) => ex.some((e) => p === e || p.startsWith(e + '/'));

let lastReport = 0;
const report = (force) => {
  const now = Date.now();
  if (!force && now - lastReport < 250) return;
  lastReport = now;
  process.stdout.write(JSON.stringify({ progress: stats }) + '\n');
};
const fail = (p, e) => { stats.errors++; if (errors.length < 200) errors.push(`${p}: ${e.code || e.message}`); };

async function copyFile(s, d, st) {
  // unchanged since the last backup (same size and time): a hard link to that copy
  if (prev) {
    const old = path.join(prev, path.relative(src, s));
    const ost = await fsp.lstat(old).catch(() => null);
    // (times are compared to within 2 ms: copies get their time set a hair off, file systems round differently)
    if (ost && ost.isFile() && ost.size === st.size && Math.abs(ost.mtimeMs - st.mtimeMs) < 2) {
      try { await fsp.link(old, d); stats.linked++; return; } catch (e) { if (e.code === 'ENOSPC') throw e; /* too many links, other fs: copy it */ }
    }
  }
  await fsp.copyFile(s, d);
  await fsp.utimes(d, st.atimeMs / 1000, st.mtimeMs / 1000).catch(() => {});
  await fsp.chmod(d, st.mode & 0o7777).catch(() => {});
  stats.copied++; stats.copiedBytes += st.size;
}

async function walk(s, d) {
  if (stopped) throw Object.assign(new Error('stopped'), { code: 'STOPPED' });
  let names;
  try { names = await fsp.readdir(s); } catch (e) { fail(s, e); return; }
  for (const n of names) {
    const sp = path.join(s, n), dp = path.join(d, n);
    if (excluded(sp)) continue;
    let st;
    try { st = await fsp.lstat(sp); } catch (e) { fail(sp, e); continue; }
    try {
      if (st.isDirectory()) {
        await fsp.mkdir(dp);
        stats.dirs++;
        await walk(sp, dp);
        // the folder's own time and permissions (it stays writable for you, so old backups can be deleted)
        await fsp.chmod(dp, (st.mode & 0o7777) | 0o700).catch(() => {});
        await fsp.utimes(dp, st.atimeMs / 1000, st.mtimeMs / 1000).catch(() => {});
      } else if (st.isSymbolicLink()) {
        await fsp.symlink(await fsp.readlink(sp), dp);
        stats.files++;
      } else if (st.isFile()) {
        stats.current = sp; stats.files++; stats.bytes += st.size;
        await copyFile(sp, dp, st);
        report();
      }
      // sockets, pipes and devices aren't backed up
    } catch (e) {
      if (e.code === 'ENOSPC' || e.code === 'STOPPED' || e.code === 'EROFS' || e.code === 'EIO') throw e;
      fail(sp, e);
    }
  }
}

(async () => {
  const started = Date.now();
  try {
    await fsp.mkdir(dest, { recursive: true });
    await walk(src, dest);
    const info = { stamp, started, finished: Date.now(), src, ...stats, current: undefined, errorList: errors.slice(0, 50) };
    await fsp.writeFile(path.join(dest, '.liquid-backup.json'), JSON.stringify(info, null, 1));
    await fsp.rename(dest, path.join(root, stamp));
    // "Latest": the newest complete backup (a link where the drive can have one, a small file where not)
    const latest = path.join(root, 'Latest');
    await fsp.rm(latest, { force: true }).catch(() => {});
    await fsp.symlink(stamp, latest).catch(() => fsp.writeFile(latest, stamp).catch(() => {}));
    report(true);
    process.stdout.write(JSON.stringify({ done: info }) + '\n');
    process.exit(0);
  } catch (e) {
    report(true);
    const why = e.code === 'STOPPED' ? 'stopped' : e.code === 'ENOSPC' ? 'full' : e.message;
    process.stdout.write(JSON.stringify({ failed: why, code: e.code || null, stats }) + '\n');
    process.exit(e.code === 'STOPPED' ? 3 : 2);
  }
})();
