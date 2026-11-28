// Files' extras: colored tags, and searching — by name, by what's inside files (Spotlight and Smart Folders), by
// kind, date and tag.
//  Tags are kept in ~/.local/share/LiquidDesktop/tags.json (so they're fast to show) and also written to the file's
//  "user.xdg.tags" extended attribute, where KDE's Dolphin and other file managers read them. They follow a file
//  when Files renames or moves it.
//  Searching inside files uses the system's search index when there is one — KDE's Baloo, GNOME's localsearch
//  (Tracker) or Recoll — and ripgrep (a quick search through text files) when there isn't.
const { ipcMain } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { which, run, broadcast, handler, HOME, dataDir } = require('./common');

/* ------------------------------------------------ tags */
const TAG_FILE = dataDir('tags.json');
const DEFAULT_TAGS = [['Red', '#ff3b30'], ['Orange', '#ff9500'], ['Yellow', '#ffcc00'], ['Green', '#34c759'], ['Blue', '#0a84ff'], ['Purple', '#af52de'], ['Gray', '#8e8e93']].map(([name, color]) => ({ name, color }));
let db = null;
function load() {
  if (db) return db;
  try { db = JSON.parse(fs.readFileSync(TAG_FILE, 'utf8')); } catch { db = {}; }
  db.tags ||= DEFAULT_TAGS; db.files ||= {};
  return db;
}
let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    try { await fsp.mkdir(path.dirname(TAG_FILE), { recursive: true }); await fsp.writeFile(TAG_FILE + '.tmp', JSON.stringify(db)); await fsp.rename(TAG_FILE + '.tmp', TAG_FILE); } catch (e) { console.warn('[tags]', e.message); }
  }, 200);
  broadcast('tags:changed');
}
// the extended attribute other file managers read (Node can't set xattrs itself; Python can)
function writeXattr(p, names) {
  if (!which('python3')) return;
  const code = 'import os,sys\np,v=sys.argv[1],sys.argv[2]\ntry:\n  os.setxattr(p,"user.xdg.tags",v.encode()) if v else os.removexattr(p,"user.xdg.tags")\nexcept OSError: pass';
  run('python3', ['-c', code, p, names.join(',')], { timeout: 5000 }).catch(() => {});
}
function setTags(paths, names) {
  load();
  for (const p of paths) {
    const clean = [...new Set(names)].filter((n) => db.tags.some((t) => t.name === n));
    if (clean.length) db.files[p] = clean; else delete db.files[p];
    writeXattr(p, clean);
  }
  save();
  return db.files;
}
function toggleTag(paths, name, on) {
  load();
  for (const p of paths) {
    const cur = new Set(db.files[p] || []);
    if (on ?? !cur.has(name)) cur.add(name); else cur.delete(name);
    if (cur.size) db.files[p] = [...cur]; else delete db.files[p];
    writeXattr(p, [...cur]);
  }
  save();
  return db.files;
}
/** A file (or folder) moved: its tags, and those of everything in it, go along. */
function moved(from, to) {
  load();
  let changed = false;
  for (const p of Object.keys(db.files)) {
    if (p === from || p.startsWith(from + '/')) { db.files[to + p.slice(from.length)] = db.files[p]; delete db.files[p]; changed = true; }
  }
  if (changed) save();
}
function defineTag({ name, color, oldName, remove }) {
  load();
  if (remove) {
    db.tags = db.tags.filter((t) => t.name !== remove);
    for (const [p, l] of Object.entries(db.files)) { const n = l.filter((x) => x !== remove); if (n.length) db.files[p] = n; else delete db.files[p]; }
  } else if (oldName) {
    const t = db.tags.find((x) => x.name === oldName);
    if (t) { if (name && name !== oldName && db.tags.some((x) => x.name === name)) throw new Error('There’s already a tag with that name.'); t.name = name || t.name; t.color = color || t.color; }
    if (name && name !== oldName) for (const l of Object.values(db.files)) { const i = l.indexOf(oldName); if (i >= 0) l[i] = name; }
  } else if (name) {
    if (db.tags.some((x) => x.name === name)) throw new Error('There’s already a tag with that name.');
    db.tags.push({ name, color: color || '#8e8e93' });
  }
  save();
  return { tags: db.tags, files: db.files };
}
async function entry(p) {
  const st = await fsp.stat(p).catch(() => null);
  if (!st) return null;
  const name = path.basename(p);
  return { name, path: p, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, ext: st.isDirectory() ? '' : path.extname(name).slice(1).toLowerCase(), hidden: name.startsWith('.') };
}
/** Everything with a tag (files that are gone are forgotten). */
async function tagged(name) {
  load();
  const out = [];
  let pruned = false;
  for (const [p, l] of Object.entries(db.files)) {
    if (!l.includes(name)) continue;
    const e = await entry(p);
    if (e) out.push(e); else { delete db.files[p]; pruned = true; }
  }
  if (pruned) save();
  return out;
}

/* ------------------------------------------------ searching */
const KINDS = {
  folders: null,
  images: /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|tiff?)$/i,
  video: /\.(mp4|m4v|mov|webm|mkv|avi)$/i,
  audio: /\.(mp3|flac|ogg|opus|m4a|aac|wav)$/i,
  documents: /\.(pdf|docx?|odt|rtf|txt|md|pages|xlsx?|ods|csv|pptx?|odp|epub)$/i,
  pdf: /\.pdf$/i,
  text: /\.(txt|md|json|js|ts|py|sh|c|h|cpp|rs|go|java|css|html|xml|ya?ml|toml|ini|conf|log)$/i,
  archives: /\.(zip|tar|gz|tgz|xz|bz2|zst|7z|rar)$/i,
};
const SKIP_DIRS = ['node_modules', '.git', '.cache', '.local', '.npm', '.cargo', '.rustup', '.var', 'snap', '.mozilla', '.config', '.nvm', 'target', 'build', 'dist', '__pycache__', 'venv', '.venv'];

/** What engine searches file contents here. */
function contentEngine() {
  if (which('baloosearch6') || which('baloosearch')) return 'baloo';
  if (which('localsearch') || which('tracker3')) return 'localsearch';
  if (which('recollq')) return 'recoll';
  if (which('rg')) return 'ripgrep';
  return null;
}
/** Paths of files whose contents (or names, for the indexes) match the text. */
async function contentSearch(text, dir = HOME, limit = 200) {
  text = String(text || '').trim();
  if (text.length < 2) return [];
  const eng = contentEngine();
  let paths = [];
  if (eng === 'baloo') {
    const b = which('baloosearch6') || which('baloosearch');
    const r = await run(b, ['-l', String(limit), ...(dir && dir !== HOME ? ['-d', dir] : []), text], { timeout: 8000 });
    paths = r.out.split('\n').filter((l) => l.startsWith('/'));
  } else if (eng === 'localsearch') {
    const r = which('localsearch') ? await run('localsearch', ['search', '--disable-color', '-l', String(limit), text], { timeout: 8000 }) : await run('tracker3', ['search', '--disable-color', '-l', String(limit), text], { timeout: 8000 });
    paths = [...r.out.matchAll(/file:\/\/(\S+)/g)].map((m) => decodeURIComponent(m[1]));
  } else if (eng === 'recoll') {
    const r = await run('recollq', ['-b', '-n', String(limit), text], { timeout: 8000 });
    paths = r.out.split('\n').filter((l) => l.startsWith('file://')).map((l) => decodeURIComponent(l.slice(7)));
  } else if (eng === 'ripgrep') {
    const args = ['-l', '-i', '-F', '-m', '1', '--max-filesize', '2M', '--max-depth', '10', '--no-messages', ...SKIP_DIRS.flatMap((d) => ['-g', `!${d}`]), '--', text, dir || HOME];
    const r = await run('rg', args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    paths = r.out.split('\n').filter(Boolean).slice(0, limit);
  }
  if (dir && dir !== HOME) paths = paths.filter((p) => p.startsWith(dir + '/'));
  return paths.filter((p) => !p.split('/').some((s) => s.startsWith('.') && s.length > 1) || dir.includes('/.'));
}
/** Files whose names match (a walk through the folder, skipping hidden and build folders). */
async function nameSearch(text, dir = HOME, limit = 400, deadline = Date.now() + 2500) {
  const q = String(text || '').toLowerCase();
  const out = [];
  const queue = [{ d: dir, depth: 0 }];
  while (queue.length && out.length < limit && Date.now() < deadline) {
    const { d, depth } = queue.shift();
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.name.startsWith('.') || SKIP_DIRS.includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (!q || e.name.toLowerCase().includes(q)) out.push(p);
      if (e.isDirectory() && depth < 8) queue.push({ d: p, depth: depth + 1 });
    }
  }
  return out;
}
/**
 * A search (Spotlight, Files' search, Smart Folders): { text, contents (search inside files too), kind, tag,
 * days (modified within), dir, limit } → file entries, best matches (name matches) first.
 */
async function query(o = {}) {
  const dir = o.dir && fs.existsSync(o.dir) ? o.dir : HOME;
  const limit = Math.min(o.limit || 200, 1000);
  const text = String(o.text || '').trim();
  let byName = [], byContent = [];
  if (o.tag) { byName = (await tagged(o.tag)).map((e) => e.path).filter((p) => p.startsWith(dir === '/' ? '/' : dir + '/') || p === dir); }
  else if (text || o.kind || o.days) byName = await nameSearch(text, dir, o.kind || o.days ? 3000 : limit);
  if (o.tag && text) byName = byName.filter((p) => path.basename(p).toLowerCase().includes(text.toLowerCase()));
  if (o.contents && text.length >= 2 && !o.tag) byContent = await contentSearch(text, dir, limit);
  const seen = new Set(), out = [];
  const since = o.days ? Date.now() - o.days * 86400000 : 0;
  for (const [p, why] of [...byName.map((p) => [p, 'name']), ...byContent.map((p) => [p, 'contents'])]) {
    if (seen.has(p)) continue;
    seen.add(p);
    const e = await entry(p);
    if (!e) continue;
    if (o.kind === 'folders' ? !e.isDir : o.kind && (e.isDir || !KINDS[o.kind]?.test(e.name))) continue;
    if (since && e.mtime < since) continue;
    e.match = why;
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

function register() {
  const h = handler(ipcMain);
  h('tags:all', () => { load(); return { tags: db.tags, files: db.files }; });
  h('tags:set', setTags);
  h('tags:toggle', toggleTag);
  h('tags:define', defineTag);
  h('tags:files', tagged);
  h('tags:moved', moved);
  h('search:query', query);
  h('search:contents', (text, dir, limit) => contentSearch(text, dir, limit).then(async (l) => (await Promise.all(l.slice(0, limit || 30).map(entry))).filter(Boolean)));
  h('search:engine', contentEngine);
}
module.exports = { register, moved };
