// Journal's storage: ~/.local/share/LiquidDesktop/journal — index.json (the pages: id, title, color, times),
// <id>.json (a page: its items and drawing), and assets/ (pictures you put on pages, copied in so pages don't
// break when the original moves).
const { ipcMain } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'LiquidDesktop', 'journal');
const ASSETS = path.join(DIR, 'assets');
const safe = (id) => { if (!/^[\w-]{1,64}$/.test(String(id))) throw new Error('bad page id'); return String(id); };
const ensure = () => fsp.mkdir(ASSETS, { recursive: true });
async function writeAtomic(file, text) { await ensure(); await fsp.writeFile(file + '.tmp', text); await fsp.rename(file + '.tmp', file); }

async function index() { try { return JSON.parse(await fsp.readFile(path.join(DIR, 'index.json'), 'utf8')); } catch { return { pages: [] }; } }
async function setIndex(ix) { await writeAtomic(path.join(DIR, 'index.json'), JSON.stringify(ix)); return true; }
async function read(id) { try { return JSON.parse(await fsp.readFile(path.join(DIR, safe(id) + '.json'), 'utf8')); } catch { return null; } }
async function write(id, page) { await writeAtomic(path.join(DIR, safe(id) + '.json'), JSON.stringify(page)); return true; }
async function remove(id) {
  const page = await read(id);
  await fsp.rm(path.join(DIR, safe(id) + '.json'), { force: true });
  // its pictures, unless another page uses them too
  const ix = await index();
  const used = new Set();
  for (const p of ix.pages) if (p.id !== id) for (const it of (await read(p.id))?.items || []) if (it.type === 'image') used.add(it.data?.src);
  for (const it of page?.items || []) if (it.type === 'image' && it.data?.src?.startsWith(ASSETS) && !used.has(it.data.src)) await fsp.rm(it.data.src, { force: true });
  return true;
}
/** A picture from a file: copied into the journal. */
async function addImage(src) {
  await ensure();
  const ext = (path.extname(src) || '.png').toLowerCase();
  if (!/^\.(png|jpe?g|gif|webp|bmp|svg|avif)$/.test(ext)) throw new Error('That isn’t a picture.');
  const dest = path.join(ASSETS, crypto.randomBytes(8).toString('hex') + ext);
  await fsp.copyFile(src, dest);
  return dest;
}
/** A pasted picture (a data: URL): saved as a file. */
async function addImageData(dataUrl) {
  const m = /^data:image\/(png|jpeg|gif|webp);base64,(.+)$/.exec(String(dataUrl));
  if (!m) throw new Error('Not a picture.');
  await ensure();
  const dest = path.join(ASSETS, crypto.randomBytes(8).toString('hex') + '.' + m[1].replace('jpeg', 'jpg'));
  await fsp.writeFile(dest, Buffer.from(m[2], 'base64'));
  return dest;
}

function register() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (err) { return { __error: String(err.message || err) }; } });
  h('journal:index', index);
  h('journal:setIndex', setIndex);
  h('journal:read', read);
  h('journal:write', write);
  h('journal:remove', remove);
  h('journal:addImage', addImage);
  h('journal:addImageData', addImageData);
  h('journal:dir', () => DIR);
}
module.exports = { register };
