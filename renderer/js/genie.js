// Minimizing into the Dock, like a Mac: the Genie effect (the window pours into its Dock tile through a
// narrowing curve) or the Scale effect (it shrinks straight into it). Settings › Desktop & Dock picks one.
// Session mode only: the window manager hands the shell a picture of the window (main/session.js), the shell
// draws it on a canvas over everything, and the real window disappears (or comes back) underneath.
import { $, bus } from './util.js';
import { store } from './store.js';
import { session as S } from './layer.js';
import { wm } from './wm.js';

const pictures = new Map();   // window id → { canvas, thumb } kept while it's minimized (restore, Dock thumbnail)
let cv = null, ctx = null, running = 0;

/** A small picture of a minimized window, for its Dock tile (or null). */
export const minimizedThumb = (id) => pictures.get(id)?.thumb || null;

function canvas() {
  if (cv) return cv;
  cv = document.createElement('canvas');
  cv.id = 'genie';
  Object.assign(cv.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 9500 });
  document.body.append(cv);
  ctx = cv.getContext('2d');
  return cv;
}
function sizeCanvas() {
  const dpr = devicePixelRatio || 1;
  const W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingQuality = 'high';   // (resizing the canvas resets it)
}

// where the window goes: its own tile in the Dock, else its app's icon, else the middle of the Dock
function target(id) {
  const el = document.querySelector(`.dock-item[data-win="${id}"] .icon`) || document.querySelector(`.dock-item[data-win="${id}"]`);
  const dock = $('#dock');
  const r = el?.getBoundingClientRect();
  if (r && r.width) return { x: r.left, y: r.top, w: r.width, h: r.height };
  const d = dock?.getBoundingClientRect();
  if (d && d.width && d.top < innerHeight) return { x: d.left + d.width / 2 - 24, y: d.top + 6, w: 48, h: 48 };
  return { x: innerWidth / 2 - 24, y: innerHeight - 4, w: 48, h: 48 };
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * One frame of the Genie effect. p goes 0 → 1 (minimizing). The window first bends: its bottom stretches down to
 * the Dock while its sides curve in toward the tile; then it slides down the curve into the tile.
 */
function drawGenie(img, from, to, p) {
  const p1 = smooth(p / 0.45), p2 = ease(Math.max(0, (p - 0.3) / 0.7));
  const y0 = from.y, yEnd = to.y + to.h;
  const top = lerp(from.y, to.y, p2), bottom = lerp(from.y + from.h, yEnd, Math.max(p1, p2));
  // the curve the sides follow, from the window's top (full width) to the bottom of the tile (tile width)
  const span = Math.max(1, yEnd - y0);
  const edges = (y) => {
    const s = smooth((y - y0) / span) * p1;
    return [lerp(from.x, to.x, s), lerp(from.x + from.w, to.x + to.w, s)];
  };
  // strips about 2 px tall: thin enough that the curved sides look smooth
  const N = Math.max(24, Math.min(420, Math.round((bottom - top) / 2)));
  const sh = img.height / N, dh = (bottom - top) / N;
  if (dh <= 0.01) return;
  for (let i = 0; i < N; i++) {
    const y = top + i * dh;
    const [l, r] = edges(y + dh / 2);
    if (r - l < 0.5) continue;
    // a hair taller than its share, so the strips meet without hairline gaps
    ctx.drawImage(img, 0, i * sh, img.width, sh, l, y, r - l, dh + 0.6);
  }
}
function drawScale(img, from, to, p) {
  const e = ease(p);
  ctx.drawImage(img, lerp(from.x, to.x, e), lerp(from.y, to.y, e), lerp(from.w, to.w, e), lerp(from.h, to.h, e));
}

function animate(pic, from, id, effect, reverse, onFirstFrame) {
  const D = effect === 'scale' ? 280 : 520;
  return new Promise((done) => {
    canvas(); running++;
    const t0 = performance.now();
    let first = true;
    const frame = (now) => {
      sizeCanvas();
      const k = Math.min(1, (now - t0) / D);
      const p = reverse ? 1 - k : k;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      ctx.globalAlpha = p > 0.85 ? Math.max(0, 1 - (p - 0.85) / 0.15 * 0.7) : 1;
      const to = target(id);
      (effect === 'scale' ? drawScale : drawGenie)(pic.canvas, from, to, p);
      ctx.globalAlpha = 1;
      if (first) { first = false; requestAnimationFrame(() => onFirstFrame?.()); }
      if (k < 1) { requestAnimationFrame(frame); return; }
      // the last frame stays a moment, so there's no gap before the real window is shown
      setTimeout(() => { if (--running === 0) ctx.clearRect(0, 0, innerWidth, innerHeight); }, reverse ? 120 : 0);
      done();
    };
    requestAnimationFrame(frame);
  });
}

/** From the window manager: { req, id, rect, img: { w, h, data }, restore, effect }. */
async function play(m) {
  const ack = () => S.send('shell:genie', m.req);
  const effect = m.effect || store.get('minimizeEffect') || 'genie';
  if (!m.restore) {
    if (!m.img) return ack();
    // the picture, from the window manager's raw BGRA pixels
    const c = document.createElement('canvas');
    c.width = m.img.w; c.height = m.img.h;
    const src = new Uint8ClampedArray(m.img.data.buffer || m.img.data, m.img.data.byteOffset || 0, m.img.w * m.img.h * 4);
    const rgba = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i += 4) { rgba[i] = src[i + 2]; rgba[i + 1] = src[i + 1]; rgba[i + 2] = src[i]; rgba[i + 3] = src[i + 3]; }
    c.getContext('2d').putImageData(new ImageData(rgba, m.img.w, m.img.h), 0, 0);
    // a small copy for the Dock tile
    const t = document.createElement('canvas'), tw = 160, th = Math.max(1, Math.round(160 * m.img.h / m.img.w));
    t.width = tw; t.height = th;
    t.getContext('2d').drawImage(c, 0, 0, tw, th);
    const pic = { canvas: c, thumb: t.toDataURL('image/png'), rect: m.rect };
    pictures.set(m.id, pic);
    await animate(pic, m.rect, m.id, effect, false, ack);
    return;
  }
  const pic = pictures.get(m.id);
  if (!pic) return ack();
  pictures.delete(m.id);
  await animate(pic, m.rect, m.id, effect, true, null);
  ack();
}

export function initGenie() {
  if (!S) return;
  S.on('session:genie', (m) => { play(m).catch(() => S.send('shell:genie', m.req)); });
  // Accessibility › Reduce motion: windows just go, without flying into the Dock
  const tell = () => S.send('wm:setMinimizeEffect', store.get('reduceMotion') ? 'none' : store.get('minimizeEffect') || 'genie');
  tell();
  store.on('change', (k) => { if (k === 'minimizeEffect' || k === 'reduceMotion') tell(); });
  // pictures of windows that were closed while minimized
  bus.on('windows', () => { for (const id of pictures.keys()) if (!wm.windows.some((w) => w.id === id && w.minimized)) pictures.delete(id); });
}
