// The Photos and Music libraries: what's in your Pictures (and Videos) and Music folders, read once and kept in a
// cache, so opening the apps is quick and only new or changed files are looked at again.
//  Photos: when each picture was taken (the camera's EXIF date, else a date in the file name like
//    "Screenshot_20261115_235023", else the file's date), and small thumbnails, cached on disk.
//  Music: each song's tags (title, artist, album, track, length) with ffprobe, and album artwork (the picture
//    inside the file, or a cover.jpg next to it).
const { ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { which, run, broadcast, handler, HOME, cacheDir } = require('./common');

const IMG = /\.(jpe?g|png|gif|webp|avif|bmp|heic|heif|tiff?)$/i;
const VID = /\.(mp4|m4v|mov|webm|mkv|avi|3gp|wmv|flv|mpe?g|m2ts|mts)$/i;
const AUD = /\.(mp3|flac|ogg|oga|opus|m4a|aac|wav|wma|aiff?|alac)$/i;
const SKIP = new Set(['node_modules', '.git', '.cache', '.thumbnails', '@eaDir', '.Trash-1000']);

function xdgDir(key, fallback) {
  try {
    const t = fs.readFileSync(path.join(HOME, '.config/user-dirs.dirs'), 'utf8');
    const m = t.match(new RegExp(`XDG_${key}_DIR="([^"]+)"`));
    if (m) return m[1].replace('$HOME', HOME);
  } catch { /* default */ }
  return path.join(HOME, fallback);
}

/** Every matching file under the folders (not hidden ones, not too deep). */
async function walk(folders, re, max = 50000) {
  const out = [];
  const queue = folders.map((d) => ({ d, depth: 0 }));
  while (queue.length && out.length < max) {
    const { d, depth } = queue.shift();
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 10) queue.push({ d: p, depth: depth + 1 }); }
      else if (e.isFile() && re.test(e.name)) out.push(p);
    }
  }
  return out;
}

/* ------------------------------------------------ cache files */
function loadJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
async function saveJson(f, v) { await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f + '.tmp', JSON.stringify(v)); await fsp.rename(f + '.tmp', f); }

/* ------------------------------------------------ EXIF: the date a photo was taken */
function exifDate(buf) {
  // JPEG: find the APP1 "Exif" segment
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (marker === 0xe1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') return tiffDate(buf.subarray(i + 10, i + 2 + len));
    if (marker === 0xda) return null;
    i += 2 + len;
  }
  return null;
}
function tiffDate(t) {
  if (t.length < 8) return null;
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o)), u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const readIfd = (off) => {
    const tags = {};
    if (off + 2 > t.length) return tags;
    const n = u16(off);
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12;
      if (e + 12 > t.length) break;
      tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), val: u32(e + 8), at: e + 8 };
    }
    return tags;
  };
  const str = (tag) => { if (!tag || tag.type !== 2) return null; const o = tag.count > 4 ? tag.val : tag.at; return t.toString('latin1', o, o + tag.count - 1); };
  const ifd0 = readIfd(u32(4));
  const exif = ifd0[0x8769] ? readIfd(ifd0[0x8769].val) : {};
  const s = str(exif[0x9003]) || str(exif[0x9004]) || str(ifd0[0x0132]);
  const m = s && s.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
  if (!m || m[1] === '0000') return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}
// "IMG_20250101_123456", "Screenshot_20261115_235023", "Screenshot 2026-11-19 at 20.25.47", "PXL_20240203_101112345"
function nameDate(n) {
  let m = n.match(/(20\d\d|19\d\d)[-_.]?([01]\d)[-_.]?([0-3]\d)[ _T-]?(?:at )?([0-2]\d)[-_.:]?([0-5]\d)[-_.:]?([0-5]\d)/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  m = n.match(/(20\d\d)[-_]([01]\d)[-_]([0-3]\d)/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12).getTime();
  return null;
}
async function takenAt(p, st) {
  if (/\.jpe?g$/i.test(p)) {
    try {
      const fh = await fsp.open(p, 'r');
      const b = Buffer.alloc(Math.min(st.size, 256 * 1024));
      await fh.read(b, 0, b.length, 0); await fh.close();
      const d = exifDate(b);
      if (d && d > 0) return d;
    } catch { /* unreadable */ }
  }
  return nameDate(path.basename(p)) || st.mtimeMs;
}

/* ------------------------------------------------ Photos */
const PHOTO_CACHE = cacheDir('photos-index.json');
let photoScan = null;
async function photos(opts = {}) {
  if (photoScan && !opts.force) return photoScan;
  photoScan = (async () => {
    const folders = (opts.folders?.length ? opts.folders : [xdgDir('PICTURES', 'Pictures'), xdgDir('VIDEOS', 'Videos')]).filter((d) => fs.existsSync(d));
    const cache = loadJson(PHOTO_CACHE, {});
    const files = await walk(folders, new RegExp(IMG.source + '|' + VID.source, 'i'));
    const out = [], next = {};
    let n = 0;
    for (const p of files) {
      const st = await fsp.stat(p).catch(() => null);
      if (!st || st.size < 512) continue;
      const c = cache[p];
      const taken = c && c.m === st.mtimeMs ? c.t : await takenAt(p, st);
      next[p] = { m: st.mtimeMs, t: taken };
      out.push({ path: p, name: path.basename(p), size: st.size, mtime: st.mtimeMs, taken, video: VID.test(p), folder: path.dirname(p) });
      if (++n % 500 === 0) broadcast('photos:progress', n, files.length);
    }
    saveJson(PHOTO_CACHE, next).catch(() => {});
    out.sort((a, b) => a.taken - b.taken);
    return { items: out, folders };
  })();
  photoScan.catch(() => (photoScan = null));
  setTimeout(() => { photoScan = null; }, 30000);   // looked at again after a while (new screenshots…)
  return photoScan;
}

/* ------------------------------------------------ thumbnails (both apps) */
const THUMBS = cacheDir('thumbs');
const queue = [];
let active = 0;
function limited(fn) {
  return new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject).finally(() => { active--; queue.length && (active++, queue.shift()()); }));
    if (active < 3) { active++; queue.shift()(); }
  });
}
/** A cached JPEG thumbnail (its path), size px on the short side. */
async function thumb(p, size = 360) {
  const st = await fsp.stat(p);
  const key = crypto.createHash('sha1').update(`${p}|${st.mtimeMs}|${size}`).digest('hex');
  const out = path.join(THUMBS, key.slice(0, 2), key + '.jpg');
  if (fs.existsSync(out)) return out;
  return limited(async () => {
    if (fs.existsSync(out)) return out;
    await fsp.mkdir(path.dirname(out), { recursive: true });
    if (VID.test(p)) {
      if (!which('ffmpeg')) throw new Error('no ffmpeg');
      const r = await run('ffmpeg', ['-v', 'error', '-ss', '1', '-i', p, '-frames:v', '1', '-vf', `scale='if(gt(iw,ih),-2,${size})':'if(gt(iw,ih),${size},-2)'`, '-q:v', '4', '-y', out], { timeout: 20000 });
      if (!r.ok || !fs.existsSync(out)) { const r2 = await run('ffmpeg', ['-v', 'error', '-i', p, '-frames:v', '1', '-vf', `scale=-2:${size}`, '-y', out], { timeout: 20000 }); if (!r2.ok) throw new Error('no frame'); }
      return out;
    }
    let img = nativeImage.createFromPath(p);
    if (img.isEmpty() && which('ffmpeg')) {   // HEIC, TIFF… that Chromium can't decode
      const r = await run('ffmpeg', ['-v', 'error', '-i', p, '-frames:v', '1', '-vf', `scale=-2:${size}`, '-y', out], { timeout: 20000 });
      if (r.ok && fs.existsSync(out)) return out;
    }
    if (img.isEmpty()) throw new Error('Not a picture');
    const s = img.getSize(), k = size / Math.min(s.width, s.height);
    if (k < 1) img = img.resize({ width: Math.round(s.width * k), height: Math.round(s.height * k), quality: 'good' });
    await fsp.writeFile(out, img.toJPEG(80));
    return out;
  });
}

/* ------------------------------------------------ Music */
const MUSIC_CACHE = cacheDir('music-index.json');
let musicScan = null;
async function probe(p) {
  const r = await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', p], { timeout: 15000 });
  let j = {};
  try { j = JSON.parse(r.out); } catch { /* not readable */ }
  const tags = {};
  for (const src of [j.format?.tags, ...(j.streams || []).map((s) => s.tags)]) for (const [k, v] of Object.entries(src || {})) tags[k.toLowerCase()] ??= v;
  const num = (v) => (v ? parseInt(String(v).split('/')[0], 10) || null : null);
  return {
    title: tags.title || null, artist: tags.artist || tags.album_artist || null, albumArtist: tags.album_artist || tags.albumartist || null,
    album: tags.album || null, track: num(tags.track), disc: num(tags.disc), year: num(tags.date || tags.year), genre: tags.genre || null,
    duration: +j.format?.duration || 0, art: (j.streams || []).some((s) => s.codec_type === 'video' || s.disposition?.attached_pic),
  };
}
async function music(opts = {}) {
  if (musicScan && !opts.force) return musicScan;
  musicScan = (async () => {
    const folders = (opts.folders?.length ? opts.folders : [xdgDir('MUSIC', 'Music')]).filter((d) => fs.existsSync(d));
    const cache = loadJson(MUSIC_CACHE, {});
    const files = await walk(folders, AUD, 30000);
    const next = {}, out = [];
    const hasProbe = !!which('ffprobe');
    let done = 0;
    const work = files.map((p) => async () => {
      const st = await fsp.stat(p).catch(() => null);
      if (!st) return;
      let meta = cache[p]?.m === st.mtimeMs ? cache[p].d : null;
      if (!meta) meta = hasProbe ? await probe(p) : { duration: 0 };
      next[p] = { m: st.mtimeMs, d: meta };
      const stem = path.basename(p).replace(/\.[^.]+$/, '');
      // no tags: guess from "Artist - Title" names and Artist/Album/ folders
      const guess = stem.match(/^(?:\d+[\s.-]+)?(.+?) - (.+)$/);
      const dir = path.basename(path.dirname(p)), up = path.basename(path.dirname(path.dirname(p)));
      const inLib = folders.some((f) => path.dirname(path.dirname(p)).startsWith(f) && path.dirname(p) !== f);
      out.push({
        id: crypto.createHash('sha1').update(p).digest('hex').slice(0, 16), path: p, mtime: st.mtimeMs, added: st.ctimeMs || st.mtimeMs,
        title: meta.title || (guess ? guess[2] : stem.replace(/^\d+[\s.-]+/, '')),
        artist: meta.artist || (guess ? guess[1] : inLib && !folders.includes(path.dirname(path.dirname(p))) ? up : 'Unknown Artist'),
        albumArtist: meta.albumArtist || null,
        album: meta.album || (inLib ? dir : 'Unknown Album'),
        track: meta.track || (parseInt(stem, 10) || null), disc: meta.disc, year: meta.year, genre: meta.genre, duration: meta.duration, art: !!meta.art,
      });
      if (++done % 50 === 0) broadcast('music:progress', done, files.length);
    });
    // four at a time
    const runners = Array.from({ length: 4 }, async () => { while (work.length) await work.shift()(); });
    await Promise.all(runners);
    saveJson(MUSIC_CACHE, next).catch(() => {});
    return { tracks: out, folders, probe: hasProbe };
  })();
  musicScan.catch(() => (musicScan = null));
  setTimeout(() => { musicScan = null; }, 60000);
  return musicScan;
}

/** Album artwork for a song: a cached JPEG (path), or null. */
async function art(p, size = 500) {
  const st = await fsp.stat(p);
  const key = crypto.createHash('sha1').update(`art|${p}|${st.mtimeMs}|${size}`).digest('hex');
  const out = path.join(THUMBS, key.slice(0, 2), key + '.jpg');
  if (fs.existsSync(out)) return out;
  const none = out + '.none';
  if (fs.existsSync(none)) return null;
  return limited(async () => {
    await fsp.mkdir(path.dirname(out), { recursive: true });
    if (which('ffmpeg')) {
      const r = await run('ffmpeg', ['-v', 'error', '-i', p, '-an', '-frames:v', '1', '-vf', `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`, '-y', out], { timeout: 15000 });
      if (r.ok && fs.existsSync(out) && fs.statSync(out).size > 200) return out;
    }
    // a picture next to the song
    for (const n of ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'Cover.jpg', 'Folder.jpg', 'AlbumArt.jpg', 'album.jpg']) {
      const c = path.join(path.dirname(p), n);
      if (fs.existsSync(c)) return thumb(c, size).catch(() => null);
    }
    await fsp.writeFile(none, '').catch(() => {});
    return null;
  });
}

/** Copy pictures into Pictures/Imported/<date> (Photos › Import). */
async function importPhotos(paths) {
  const dir = path.join(xdgDir('PICTURES', 'Pictures'), 'Imported', new Date().toISOString().slice(0, 10));
  await fsp.mkdir(dir, { recursive: true });
  const out = [];
  for (const p of paths || []) {
    if (!IMG.test(p) && !VID.test(p)) continue;
    let dest = path.join(dir, path.basename(p));
    for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, path.basename(p).replace(/(\.[^.]+)$/, ` ${i}$1`));
    await fsp.copyFile(p, dest); out.push(dest);
  }
  photoScan = null;
  return out;
}

/* -------------------------------------------- videos Chromium can't play */
// AVI, WMV, MPEG, FLV… (and MKVs with HEVC video): a copy it can play, made with FFmpeg and kept in the cache. When the
// video and sound inside are ones it can already play, they're only moved into a new container (seconds); otherwise
// they're converted (H.264 and AAC), with progress on 'media:progress' (path, 0–1).
const PLAY_V = new Set(['h264', 'vp8', 'vp9', 'av1']);
const PLAY_A = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const playJobs = new Map();   // path → the conversion under way (asking twice waits for the same one)
async function probe(p) {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', p], { timeout: 20000 });
  if (!r.ok) throw new Error('This file couldn’t be read — it may be damaged or not a video.');
  const j = JSON.parse(r.out);
  const v = j.streams?.find((s) => s.codec_type === 'video' && s.codec_name !== 'mjpeg' && s.codec_name !== 'png');   // (cover art isn't video)
  const a = j.streams?.find((s) => s.codec_type === 'audio');
  return { v: v?.codec_name || null, a: a?.codec_name || null, duration: +j.format?.duration || 0 };
}
async function playable(p) {
  if (!which('ffmpeg') || !which('ffprobe')) throw new Error('NEEDS_FFMPEG');
  const st = await fsp.stat(p);
  const dir = cacheDir('playable');
  await fsp.mkdir(dir, { recursive: true });
  const key = crypto.createHash('sha1').update(`${p}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20);
  for (const ext of ['.mp4', '.webm', '.m4a']) {
    const done = path.join(dir, key + ext);
    if (fs.existsSync(done)) { fsp.utimes(done, new Date(), new Date()).catch(() => {}); return { path: done }; }
  }
  if (playJobs.has(p)) return playJobs.get(p);
  const job = (async () => {
    const info = await probe(p);
    if (!info.v && !info.a) throw new Error('There’s no video or sound in this file that can be played.');
    const copyV = !info.v || PLAY_V.has(info.v), copyA = !info.a || PLAY_A.has(info.a);
    // the container: WebM for VP8/Vorbis (MP4 can't hold them), M4A for sound only, MP4 for everything else
    const webm = copyV && copyA && (info.v === 'vp8' || info.a === 'vorbis');
    const ext = !info.v ? '.m4a' : webm ? '.webm' : '.mp4';
    const out = path.join(dir, key + ext), part = out + '.part';
    const args = ['-v', 'error', '-nostdin', '-i', p, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn'];
    args.push(...(info.v ? (copyV ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p']) : ['-vn']));
    args.push(...(info.a ? (copyA && !(ext === '.m4a' && info.a === 'vorbis') ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']) : []));
    if (!webm) args.push('-movflags', '+faststart');
    args.push('-f', webm ? 'webm' : 'mp4', '-progress', 'pipe:1', '-y', part);
    await new Promise((resolve, reject) => {
      const c = require('child_process').spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '', last = 0;
      c.stdout.on('data', (b) => {
        const m = /out_time_us=(\d+)/.exec(String(b));
        if (m && info.duration && Date.now() - last > 300) { last = Date.now(); broadcast('media:progress', p, Math.min(0.99, +m[1] / 1e6 / info.duration)); }
      });
      c.stderr.on('data', (b) => { err += b; });
      c.on('error', reject);
      c.on('close', (code) => (code === 0 ? resolve() : reject(new Error('The video couldn’t be converted: ' + (err.trim().split('\n').pop() || 'FFmpeg failed')))));
    });
    await fsp.rename(part, out);
    broadcast('media:progress', p, 1);
    pruneCache(dir).catch(() => {});
    return { path: out, converted: !(copyV && copyA) };
  })().finally(() => playJobs.delete(p));
  playJobs.set(p, job);
  return job;
}
/** The converted copies stay under 4 GB: the ones not watched for longest go first. */
async function pruneCache(dir) {
  const files = [];
  for (const n of await fsp.readdir(dir)) { if (n.endsWith('.part')) continue; const st = await fsp.stat(path.join(dir, n)).catch(() => null); if (st) files.push({ p: path.join(dir, n), size: st.size, t: st.mtimeMs }); }
  let total = files.reduce((a, f) => a + f.size, 0);
  for (const f of files.sort((a, b) => a.t - b.t)) { if (total < 4e9) break; await fsp.rm(f.p, { force: true }); total -= f.size; }
}

function register() {
  const h = handler(ipcMain);
  h('media:playable', playable);
  h('photos:list', photos);
  h('photos:thumb', thumb);
  h('photos:import', importPhotos);
  h('music:list', music);
  h('music:art', art);
}
module.exports = { register };
