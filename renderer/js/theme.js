// Appearance: light/dark, accent, glass material, refraction lenses, wallpaper, Night Shift.
import { store } from './store.js';
import { rgb, bus, $ } from './util.js';
import { wallpaperUrl } from './wallpapers.js';
import { layer } from './layer.js';

const root = document.documentElement;
export const theme = { dark: false };

export function isNightTime(d = new Date()) { const h = d.getHours(); return h < 7 || h >= 19; }

function computeDark() {
  const t = store.get('theme');
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return isNightTime();
}

export function applyTheme() {
  const dark = computeDark();
  const changed = dark !== theme.dark;
  theme.dark = dark;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.glass = store.get('glass');
  root.dataset.refraction = String(store.get('refraction'));
  root.dataset.reduceTransparency = String(store.get('reduceTransparency'));
  root.dataset.iconStyle = store.get('iconStyle');
  const a = store.get('accent');
  root.style.setProperty('--accent', a);
  root.style.setProperty('--accent-rgb', rgb(a));
  // for tinting Linux app icons: sepia lands at ~38° hue, rotate from there to the accent's hue
  const [hh, ss] = hueSat(a);
  root.style.setProperty('--accent-shift', Math.round(hh - 38) + 'deg');
  root.style.setProperty('--accent-sat', ss < 0.15 ? '0' : (2.5 + ss * 3).toFixed(2));
  $('#night-shift')?.classList.toggle('on', !!store.get('nightShift'));
  applyCursors();
  if (changed) bus.emit('theme', dark);
  applyWallpaper();
}

/* ------------------------------------------------------------------ wallpaper */
let currentWall = '';
export function wallpaperFor(w = innerWidth, h = innerHeight) {
  const custom = store.get('customWallpaper');
  if (custom) return custom;
  const night = store.get('dynamicWallpaper') ? theme.dark : false;
  const dpr = Math.min(2, devicePixelRatio || 1);
  return wallpaperUrl(store.get('wallpaper'), Math.round(w * dpr), Math.round(h * dpr), night);
}

export function applyWallpaper() {
  if (layer === 'shell') {
    // the shell has no wallpaper of its own; it only needs to know how bright the top of it is
    const small = wallpaperFor(320, 200);
    if (small !== currentWall) { currentWall = small; measureWallpaper(small); }
    return;
  }
  if (layer !== 'full' && layer !== 'desktop') return;
  const url = wallpaperFor();
  if (url === currentWall) return;
  const first = !currentWall;
  currentWall = url;
  const wp = $('#wallpaper'), next = $('#wallpaper-next');
  const css = `url("${url.startsWith('data:') ? url : url.replace(/"/g, '%22')}")`;
  if (first || !next) { wp.style.backgroundImage = css; }
  else {
    next.style.backgroundImage = css;
    next.style.opacity = '1';
    setTimeout(() => { wp.style.backgroundImage = css; next.style.transition = 'none'; next.style.opacity = '0'; requestAnimationFrame(() => (next.style.transition = '')); }, 950);
  }
  measureWallpaper(url);
  bus.emit('wallpaper', url);
}

// Menu bar text color follows the brightness of the top of the wallpaper, like macOS 26.
function measureWallpaper(url) {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 8;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, img.width, img.height * 0.05, 0, 0, 64, 8);
    let d; try { d = x.getImageData(0, 0, 64, 8).data; } catch { return; }
    let l = 0;
    for (let i = 0; i < d.length; i += 4) l += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    l /= d.length / 4;
    bus.emit('wallpaper-luma', l / 255);
  };
  img.src = url;
}

/* ------------------------------------------------------------------ refraction lenses */
// Each glass surface with .lens gets its own SVG displacement map sized to it, so the edges of the
// glass bend what's behind them. Maps are rebuilt (cheaply, at half resolution) when the element resizes.
const NS = 'http://www.w3.org/2000/svg';
let defs = null, lensSeq = 0;
function ensureDefs() {
  if (defs) return defs;
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('width', '0'); s.setAttribute('height', '0');
  s.style.position = 'absolute';
  defs = document.createElementNS(NS, 'defs');
  s.append(defs);
  document.body.append(s);
  return defs;
}

function lensMap(w, h, radius, edge) {
  const sw = Math.max(2, Math.ceil(w / 2)), sh = Math.max(2, Math.ceil(h / 2));
  const c = document.createElement('canvas'); c.width = sw; c.height = sh;
  const x = c.getContext('2d');
  const img = x.createImageData(sw, sh), d = img.data;
  const r = Math.min(radius, w / 2, h / 2), hw = w / 2, hh = h / 2;
  for (let j = 0; j < sh; j++) {
    for (let i = 0; i < sw; i++) {
      const px = (i + 0.5) * (w / sw) - hw, py = (j + 0.5) * (h / sh) - hh;
      const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
      const dist = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;     // signed distance, <0 inside
      const t = Math.min(1, Math.max(0, -dist / edge));
      const s = (1 - t) * (1 - t);
      let nx, ny;
      if (ox > 0 || oy > 0) { const l = Math.hypot(ox, oy) || 1; nx = Math.sign(px) * ox / l; ny = Math.sign(py) * oy / l; }
      else if (qx > qy) { nx = Math.sign(px); ny = 0; } else { nx = 0; ny = Math.sign(py); }
      const k = (j * sw + i) * 4;
      d[k] = 128 - nx * s * 127; d[k + 1] = 128 - ny * s * 127; d[k + 2] = 128; d[k + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
  return c.toDataURL();
}

export function attachLens(el, { strength = 40, edge = 22, blur = null } = {}) {
  // in the session's shell layer the compositor blurs what's behind the glass, so there is nothing to bend
  if (!store.get('refraction') || layer === 'shell' || layer === 'frame') return;
  const id = 'lens-' + ++lensSeq;
  const f = document.createElementNS(NS, 'filter');
  f.id = id;
  f.setAttribute('filterUnits', 'userSpaceOnUse');
  f.setAttribute('color-interpolation-filters', 'sRGB');
  const im = document.createElementNS(NS, 'feImage');
  im.setAttribute('preserveAspectRatio', 'none'); im.setAttribute('result', 'map');
  const dm = document.createElementNS(NS, 'feDisplacementMap');
  dm.setAttribute('in', 'SourceGraphic'); dm.setAttribute('in2', 'map');
  dm.setAttribute('scale', String(strength)); dm.setAttribute('xChannelSelector', 'R'); dm.setAttribute('yChannelSelector', 'G');
  f.append(im, dm);
  ensureDefs().append(f);
  let lastKey = '', pending = false;
  const update = () => {
    pending = false;
    const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
    if (!w || !h) return;
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    const key = `${w}x${h}x${radius}`;
    if (key === lastKey) return;
    lastKey = key;
    for (const n of [f, im]) { n.setAttribute('x', '0'); n.setAttribute('y', '0'); n.setAttribute('width', w); n.setAttribute('height', h); }
    im.setAttribute('href', lensMap(w, h, radius, edge));
    const b = blur || 'var(--glass-blur)';
    el.style.backdropFilter = `url(#${id}) blur(${b}) saturate(var(--glass-sat))`;
  };
  const ro = new ResizeObserver(() => { if (!pending) { pending = true; requestAnimationFrame(update); } });
  ro.observe(el);
  update();
  const off = store.on('change:refraction', (on) => { if (!on) { el.style.backdropFilter = ''; } else { lastKey = ''; update(); } });
  lenses.add({ el, cleanup: () => { ro.disconnect(); off(); f.remove(); } });
  watchLenses();
}

// One shared observer detaches lenses whose element has left the DOM.
const lenses = new Set();
let lensObserver = null, sweepQueued = false;
function watchLenses() {
  if (lensObserver) return;
  lensObserver = new MutationObserver(() => {
    if (sweepQueued) return;
    sweepQueued = true;
    requestAnimationFrame(() => {
      sweepQueued = false;
      for (const l of lenses) if (!l.el.isConnected) { l.cleanup(); lenses.delete(l); }
    });
  });
  lensObserver.observe(document.body, { childList: true, subtree: true });
}

export function initTheme() {
  applyTheme();
  store.on('change', (k) => {
    if (['theme', 'accent', 'glass', 'refraction', 'reduceTransparency', 'iconStyle', 'nightShift', 'wallpaper', 'customWallpaper', 'dynamicWallpaper'].includes(k)) applyTheme();
    if (k === 'cursorTheme' || k === 'cursorSize') applyCursors();
    if (['iconStyle', 'accent', 'uniformIcons'].includes(k)) bus.emit('icons-changed');
  });
  setInterval(applyTheme, 60_000);
  switchToTahoeCursors();
  let t;
  addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { currentWall = ''; applyWallpaper(); }, 300); });
}

function hueSat(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const l = (max + min) / 2;
  return [(h * 60 + 360) % 360, d ? d / (1 - Math.abs(2 * l - 1)) : 0];
}

/* ------------------------------------------------------------------ cursor theme (Settings › Mouse) */
// The web UI draws its own cursors; any installed theme is turned into CSS cursors by the back end.
let cursorKey = '';
export function applyCursors() {
  const theme = store.get('cursorTheme') || 'MacOS-Tahoe-Cursor', size = store.get('cursorSize') || 24;
  const key = theme + ':' + size;
  if (key === cursorKey || !window.sys?.sys?.cursorCss) return;
  cursorKey = key;
  window.sys.sys.cursorCss(theme, size).then((css) => {
    if (cursorKey !== key) return;
    for (const [k, v] of Object.entries(css || {})) root.style.setProperty('--cur-' + k, v);
  }).catch(() => { /* keep the built-in cursors */ });
}

// One-time switch: the macOS Tahoe cursors (by MOYASH) replaced the generated LiquidCursor as the default.
// Anyone still on LiquidCursor moves over once the theme is installed; picking LiquidCursor again later sticks.
function switchToTahoeCursors() {
  if (store.get('cursorTahoeSwitched') || !(layer === 'full' || layer === 'shell') || !window.sys?.sys?.cursorThemes) return;
  window.sys.sys.cursorThemes().then((list) => {
    if (!list.some((t) => t.id === 'MacOS-Tahoe-Cursor')) return;   // not downloaded (yet): try again next start
    store.set('cursorTahoeSwitched', true);
    if (store.get('cursorTheme') !== 'LiquidCursor') return;
    store.set('cursorTheme', 'MacOS-Tahoe-Cursor');
    window.sys.sys.cursorApply?.('MacOS-Tahoe-Cursor', store.get('cursorSize') || 24).catch(() => {});
  }).catch(() => {});
}
