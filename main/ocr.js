// Live Text: the words in a picture, found with tesseract, with where each line sits — Preview lays selectable
// text over the picture with them, so you can select and copy text in screenshots and photos.
const { ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { which, run, pkgManager, installPackages, handler } = require('./common');

const cache = new Map();   // path|mtime → result (a few, the pictures you're flipping through)

async function langs() {
  if (!which('tesseract')) return [];
  const r = await run('tesseract', ['--list-langs'], { timeout: 8000 });
  return (r.out + r.err).split('\n').slice(1).map((l) => l.trim()).filter((l) => l && !/\s/.test(l) && l !== 'osd' && l !== 'equ');
}
async function status() {
  const l = await langs();
  // ready: it can read English or your own language (another language only reads your text badly)
  const mine = LOCALE_TO_TESS[(process.env.LANG || 'en').slice(0, 2)];
  return { tesseract: !!which('tesseract'), langs: l, ready: l.includes('eng') || (!!mine && l.includes(mine)), hasEnglish: l.includes('eng'), pm: pkgManager()?.name || null };
}
async function install() {
  await installPackages({ pacman: ['tesseract', 'tesseract-data-eng'], apt: ['tesseract-ocr', 'tesseract-ocr-eng'], dnf: ['tesseract', 'tesseract-langpack-eng'] }, 'Live Text');
  return status();
}

// the languages to read with: English and your own language, when installed (more languages read slower)
const LOCALE_TO_TESS = { de: 'deu', fr: 'fra', es: 'spa', it: 'ita', pt: 'por', nl: 'nld', sv: 'swe', da: 'dan', fi: 'fin', nb: 'nor', pl: 'pol', cs: 'ces', ru: 'rus', uk: 'ukr', tr: 'tur', ja: 'jpn', zh: 'chi_sim', ko: 'kor', af: 'afr', el: 'ell', hu: 'hun', ro: 'ron' };
async function pickLangs() {
  const have = await langs();
  const mine = LOCALE_TO_TESS[(process.env.LANG || 'en').slice(0, 2)];
  const want = ['eng', mine].filter((l) => l && have.includes(l));
  return (want.length ? want : have.slice(0, 1)).join('+');
}

/** The lines of text in a picture: { width, height, lines: [{ text, x, y, w, h, words: [{ text, x, y, w, h }] }] } (pixels). */
async function recognize(p) {
  const st = await fsp.stat(p);
  const key = `${p}|${st.mtimeMs}`;
  if (cache.has(key)) return cache.get(key);
  if (!which('tesseract')) throw new Error('not installed');
  const lang = await pickLangs();
  if (!lang) throw new Error('not installed');
  // tesseract reads PNG, JPEG and TIFF well; anything else (WebP, AVIF, SVG, GIF…) goes in as a PNG
  let src = p, tmp = null;
  if (!/\.(png|jpe?g|tiff?)$/i.test(p)) {
    const img = nativeImage.createFromPath(p);
    if (img.isEmpty()) throw new Error('Not a picture');
    tmp = path.join(os.tmpdir(), `liquid-ocr-${process.pid}-${Date.now()}.png`);
    await fsp.writeFile(tmp, img.toPNG());
    src = tmp;
  }
  try {
    // TSV (each word with its box) asked for with -c: the "tsv" config file isn't in every tessdata folder
    const r = await run('tesseract', [src, 'stdout', '-l', lang, '--psm', '3', '-c', 'tessedit_create_tsv=1', '-c', 'tessedit_create_txt=0'], { timeout: 60000, env: { OMP_THREAD_LIMIT: '2' } });
    if (!r.ok && !r.out) throw new Error(r.err.trim().split('\n').pop() || 'tesseract failed');
    const rows = r.out.split('\n').slice(1).map((l) => l.split('\t')).filter((c) => c.length >= 12);
    let width = 0, height = 0;
    const lines = new Map();
    for (const c of rows) {
      const [level, , block, par, line, , left, top, w, hh, conf, ...rest] = c;
      const text = rest.join('\t').trim();
      if (level === '1') { width = +w; height = +hh; continue; }
      if (level !== '5' || !text || +conf < 25) continue;
      const k = `${block}.${par}.${line}`;
      if (!lines.has(k)) lines.set(k, []);
      lines.get(k).push({ text, x: +left, y: +top, w: +w, h: +hh });
    }
    const out = [];
    for (const words of lines.values()) {
      const x = Math.min(...words.map((q) => q.x)), y = Math.min(...words.map((q) => q.y));
      const x2 = Math.max(...words.map((q) => q.x + q.w)), y2 = Math.max(...words.map((q) => q.y + q.h));
      out.push({ text: words.map((q) => q.text).join(' '), x, y, w: x2 - x, h: y2 - y, words });
    }
    const res = { width, height, lines: out };
    if (cache.size > 12) cache.delete(cache.keys().next().value);
    cache.set(key, res);
    return res;
  } finally { if (tmp) fsp.rm(tmp, { force: true }).catch(() => {}); }
}

function register() {
  const h = handler(ipcMain);
  h('ocr:status', status);
  h('ocr:install', install);
  h('ocr:recognize', recognize);
}
module.exports = { register, recognize };
