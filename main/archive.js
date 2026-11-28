// Archive Utility: expanding archives (zip, tar.*, 7z, rar, iso, cpio… — whatever libarchive's bsdtar reads) and
// single compressed files (.gz, .xz, .bz2, .zst, .lz4), and compressing files into a .zip. Like the Mac's, it expands
// next to the archive: one item inside comes out as itself, several come out in a folder named after the archive.
// It works in a hidden folder first, so a cancelled or failed expansion leaves nothing half-done behind.
const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { which, run, broadcast, handler } = require('./common');

const RAW = { gz: 'gzip', xz: 'xz', bz2: 'bzip2', zst: 'zstd', lz4: 'lz4', lzma: 'xz', z: 'gzip' };   // single compressed files
const TAR_LIKE = /\.(tar\.(gz|xz|bz2|zst|lz4|lzma|z)|tgz|txz|tbz2?|tzst)$/i;
const jobs = new Map();   // id → { proc, cancelled }

const bsdtar = () => which('bsdtar');
/** A name in dir that isn't taken: "name", "name 2", "name 3"… */
async function freeName(dir, name) {
  const ext = name.includes('.') && !name.startsWith('.') ? name.slice(name.lastIndexOf('.')) : '';
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 10000; i++) {
    const n = i === 1 ? name : `${stem} ${i}${ext}`;
    try { await fsp.lstat(path.join(dir, n)); } catch { return path.join(dir, n); }
  }
  throw new Error('No free name');
}
/** "photos.tar.gz" → "photos" */
const baseOf = (p) => path.basename(p).replace(/\.(tar\.(gz|xz|bz2|zst|lz4|lzma|z)|tgz|txz|tbz2?|tzst|zip|7z|rar|tar|iso|cpio|xar|cab|lha|lzh|jar|apk|deb|rpm|gz|xz|bz2|zst|lz4|lzma|z)$/i, '') || 'Archive';
const rawKind = (p) => (TAR_LIKE.test(p) ? null : RAW[(path.extname(p).slice(1) || '').toLowerCase()] || null);

/** What's inside: the number of entries, and whether everything sits in one top-level folder or file. */
async function list(p, passphrase) {
  if (rawKind(p)) return { entries: 1, top: [baseOf(p)], single: true };
  if (!bsdtar()) throw new Error('bsdtar (libarchive) isn’t installed.');
  const r = await run(bsdtar(), ['-tf', p, ...(passphrase ? ['--passphrase', passphrase] : [])], { timeout: 60000, env: { LC_ALL: 'C' } });
  if (!r.ok) {
    if (/passphrase|encrypt/i.test(r.err)) return { needsPassword: true };
    throw new Error(r.err.trim().split('\n').pop() || 'This archive can’t be read.');
  }
  const names = r.out.split('\n').filter(Boolean);
  const top = [...new Set(names.map((n) => n.replace(/^\.\//, '').split('/')[0]).filter((n) => n && n !== '.'))];
  return { entries: names.length, top, single: top.length === 1 };
}

function progress(id, o) { broadcast('archive:progress', { id, ...o }); }

/** Expand an archive next to itself (or into dest). Returns the path of what came out. */
async function extract(id, p, { dest, passphrase } = {}) {
  dest = dest || path.dirname(p);
  await fsp.access(dest, fs.constants.W_OK).catch(() => { throw new Error('You can’t write to the folder this archive is in. Move it somewhere else (like Downloads) first.'); });
  const job = { cancelled: false };
  jobs.set(id, job);
  const tmp = await fsp.mkdtemp(path.join(dest, '.expanding-'));
  try {
    const raw = rawKind(p);
    let total = 1;
    if (raw) {
      // one compressed file: decompress it to a file without the last extension
      if (!which(raw)) throw new Error(`${raw} isn’t installed, so this file can’t be expanded.`);
      const out = path.join(tmp, path.basename(p).replace(/\.[^.]+$/, '') || 'file');
      const size = (await fsp.stat(p)).size;
      await new Promise((resolve, reject) => {
        const c = spawn(raw, ['-dc', p]); job.proc = c;
        const ws = fs.createWriteStream(out);
        let read = 0;
        // progress by how much of the input has gone in is not visible here; count output against a guess
        c.stdout.on('data', (d) => { read += d.length; progress(id, { done: Math.min(0.95, read / (size * 3)), name: path.basename(p) }); });
        c.stdout.pipe(ws);
        let err = ''; c.stderr.on('data', (d) => (err += d));
        c.on('error', reject);
        c.on('close', (code) => ws.end(() => (code === 0 ? resolve() : reject(new Error(job.cancelled ? 'Cancelled' : err.trim() || 'It couldn’t be expanded.')))));
      });
    } else {
      if (!bsdtar()) throw new Error('bsdtar (libarchive) isn’t installed.');
      const info = await list(p, passphrase);
      if (info.needsPassword) return { needsPassword: true };
      total = Math.max(1, info.entries);
      await new Promise((resolve, reject) => {
        // -v lists each entry as it's written (on stderr): that's the progress
        const c = spawn(bsdtar(), ['-xvf', p, '-C', tmp, '--no-same-owner', ...(passphrase ? ['--passphrase', passphrase] : [])], { env: { ...process.env, LC_ALL: 'C' } });
        job.proc = c;
        let n = 0, err = '', last = 0;
        c.stderr.on('data', (d) => {
          const s = String(d);
          for (const line of s.split('\n')) if (/^x /.test(line)) n++; else if (line.trim()) err += line + '\n';
          const now = Date.now();
          if (now - last > 120) { last = now; progress(id, { done: n / total, name: path.basename(p) }); }
        });
        c.on('error', reject);
        c.on('close', (code) => {
          if (job.cancelled) return reject(new Error('Cancelled'));
          if (code === 0) return resolve();
          if (/passphrase|encrypt/i.test(err)) return reject(Object.assign(new Error('needs password'), { needsPassword: true }));
          reject(new Error(err.trim().split('\n').pop() || 'This archive couldn’t be expanded.'));
        });
      });
    }
    // one item inside: it comes out as itself; several: in a folder named after the archive
    const inside = await fsp.readdir(tmp);
    let result;
    if (inside.length === 1) { result = await freeName(dest, inside[0]); await fsp.rename(path.join(tmp, inside[0]), result); await fsp.rmdir(tmp); }
    else { result = await freeName(dest, baseOf(p)); await fsp.rename(tmp, result); }
    progress(id, { done: 1, finished: true, result });
    return { result };
  } catch (e) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    if (e.needsPassword) return { needsPassword: true, wrong: !!passphrase };
    progress(id, { failed: true, error: e.message });
    if (e.message === 'Cancelled') return { cancelled: true };
    throw e;
  } finally { jobs.delete(id); }
}

/** Compress files and folders into a .zip next to the first one. Returns the archive's path. */
async function compress(id, paths, { dest, name } = {}) {
  if (!paths?.length) throw new Error('Nothing to compress');
  if (!bsdtar()) throw new Error('bsdtar (libarchive) isn’t installed.');
  const dir = path.dirname(paths[0]);
  dest = dest || dir;
  const zip = await freeName(dest, name || (paths.length === 1 ? path.basename(paths[0]) + '.zip' : 'Archive.zip'));
  const job = { cancelled: false };
  jobs.set(id, job);
  // count what goes in, for the progress bar (stopping at a large number: it's only a progress bar)
  let total = 0;
  const count = async (p) => { if (total > 200000) return; total++; const st = await fsp.lstat(p).catch(() => null); if (st?.isDirectory()) for (const n of await fsp.readdir(p).catch(() => [])) await count(path.join(p, n)); };
  for (const p of paths) await count(p);
  try {
    await new Promise((resolve, reject) => {
      // relative names (-C the folder they're in), so the zip doesn't hold the whole path
      const groups = new Map();
      for (const p of paths) { const d = path.dirname(p); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(path.basename(p)); }
      const args = ['--format', 'zip', '-cvf', zip];
      for (const [d, names] of groups) args.push('-C', d, ...names);
      const c = spawn(bsdtar(), args, { env: { ...process.env, LC_ALL: 'C' } });
      job.proc = c;
      let n = 0, err = '', last = 0;
      c.stderr.on('data', (d) => {
        for (const line of String(d).split('\n')) if (/^a /.test(line)) n++; else if (line.trim()) err += line + '\n';
        if (Date.now() - last > 120) { last = Date.now(); progress(id, { done: Math.min(0.99, n / Math.max(1, total)), name: path.basename(zip) }); }
      });
      c.on('error', reject);
      c.on('close', (code) => (job.cancelled ? reject(new Error('Cancelled')) : code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || 'The archive couldn’t be made.'))));
    });
    progress(id, { done: 1, finished: true, result: zip });
    return { result: zip };
  } catch (e) {
    await fsp.rm(zip, { force: true }).catch(() => {});
    progress(id, { failed: true, error: e.message });
    if (e.message === 'Cancelled') return { cancelled: true };
    throw e;
  } finally { jobs.delete(id); }
}

function cancel(id) { const j = jobs.get(id); if (j) { j.cancelled = true; try { j.proc?.kill(); } catch { /* gone */ } } return true; }

function register() {
  const h = handler(ipcMain);
  h('archive:list', list);
  h('archive:extract', extract);
  h('archive:compress', compress);
  h('archive:cancel', cancel);
  h('archive:available', () => !!bsdtar());
}
module.exports = { register, extract, compress, list };
