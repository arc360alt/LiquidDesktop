// Accessibility, the shell's part: Zoom (a lens that follows the pointer and shows what's under it magnified —
// Super+Alt+8 on and off, Super+Alt+= / − to zoom), the screen reader and the keyboard's AccessX settings sent again
// at start-up (the X server forgets them), and the Settings pane's switches.
import { store } from './store.js';
import { api } from './sys.js';
import { h } from './util.js';

const LEVELS = [1.5, 2, 3, 4, 6, 8];
let lens = null, canvas = null, ctx = null, video = null, stream = null, raf = 0, srcId = null, badgeT = 0, busy = false;

export const keySettings = () => ({ sticky: !!store.get('stickyKeys'), slow: !!store.get('slowKeys'), bounce: !!store.get('bounceKeys'), slowDelay: store.get('slowKeysDelay') || 300, bounceDelay: store.get('bounceKeysDelay') || 300 });

export function initA11y() {
  if (!api.a11y) return;
  // what was on before: on again
  const any = (k) => !!store.get(k);
  if (any('stickyKeys') || any('slowKeys') || any('bounceKeys')) api.a11y.keys(keySettings()).catch(() => {});
  if (any('screenReader')) api.a11y.screenReader(true).catch(() => store.set('screenReader', false));
  if (any('zoomOn')) setTimeout(() => startZoom(), 1500);
  store.on('change', (k) => {
    if (['stickyKeys', 'slowKeys', 'bounceKeys', 'slowKeysDelay', 'bounceKeysDelay'].includes(k)) api.a11y.keys(keySettings()).catch(() => {});
    if (k === 'zoomOn') store.get('zoomOn') ? startZoom() : stopZoom();
    if ((k === 'zoomW' || k === 'zoomH') && lens) sizeLens();
  });
}

/** Super+Alt+8 / = / − */
export function zoomKey(name) {
  if (name === 'zoom-toggle') return store.set('zoomOn', !store.get('zoomOn'));
  if (!store.get('zoomOn')) { if (name === 'zoom-in') store.set('zoomOn', true); return; }
  const cur = store.get('zoomLevel') || 2;
  const i = LEVELS.findIndex((l) => l >= cur);
  const next = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, (i < 0 ? LEVELS.length - 1 : i) + (name === 'zoom-in' ? 1 : -1)))];
  store.set('zoomLevel', next);
  showBadge();
}

function showBadge() {
  const b = lens?.querySelector('.zl-badge');
  if (!b) return;
  b.textContent = `${store.get('zoomLevel') || 2}×`;
  b.hidden = false;
  clearTimeout(badgeT); badgeT = setTimeout(() => { b.hidden = true; }, 1200);
}
function sizeLens() {
  const W = store.get('zoomW') || 520, H = store.get('zoomH') || 320;
  Object.assign(lens.style, { width: W + 'px', height: H + 'px' });
  canvas.width = Math.round(W * devicePixelRatio); canvas.height = Math.round(H * devicePixelRatio);
}

async function capture(src) {
  stream?.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id, maxWidth: Math.round(src.w * src.scale), maxHeight: Math.round(src.h * src.scale), maxFrameRate: 30 } } });
  video.srcObject = stream;
  await video.play().catch(() => {});
  srcId = src.id;
}

export async function startZoom() {
  if (lens || busy || !api.a11y?.sources) return;
  busy = true;
  try {
    lens = h('div#zoom-lens', canvas = h('canvas'), h('span.zl-badge', { hidden: true }));
    ctx = canvas.getContext('2d', { alpha: false });
    video = document.createElement('video'); video.muted = true;
    sizeLens();
    lens.hidden = true;
    document.body.append(lens);
    let sources = await api.a11y.sources();
    let src = sources[0];
    await capture(src);
    showBadge();
    let pending = false, lastSrcCheck = 0;
    const frame = async () => {
      raf = requestAnimationFrame(frame);
      if (pending || !video.videoWidth) return;
      pending = true;
      const c = await api.a11y.cursor().catch(() => null);
      pending = false;
      if (!c || !lens) return;
      // the screen the pointer is on (a new capture when it moves to another one)
      if (c.display.id !== src.displayId && Date.now() - lastSrcCheck > 500) {
        lastSrcCheck = Date.now();
        sources = await api.a11y.sources().catch(() => sources);
        const s2 = sources.find((s) => s.displayId === c.display.id);
        if (s2 && s2.id !== srcId) { src = s2; await capture(src).catch(() => {}); }
      }
      // the lens is drawn in this (shell) window: only on the screen it covers
      const lx = c.x - window.screenX, ly = c.y - window.screenY;
      if (lx < 0 || ly < 0 || lx > innerWidth || ly > innerHeight) { lens.hidden = true; return; }
      const level = store.get('zoomLevel') || 2;
      const W = lens.offsetWidth || 520, H = lens.offsetHeight || 320;
      const sw = W / level, sh = H / level;
      // the part of the screen around the pointer, in the captured picture's pixels
      const kx = video.videoWidth / src.w, ky = video.videoHeight / src.h;
      let sx = c.x - src.x - sw / 2, sy = c.y - src.y - sh / 2;
      sx = Math.max(0, Math.min(src.w - sw, sx)); sy = Math.max(0, Math.min(src.h - sh, sy));
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(video, sx * kx, sy * ky, sw * kx, sh * ky, 0, 0, canvas.width, canvas.height);
      // the lens sits beside the pointer, never over the part it magnifies (it would show itself)
      const gapX = sw / 2 + 18, gapY = sh / 2 + 18;
      let x = lx + gapX, y = ly + gapY;
      if (x + W > innerWidth - 6) x = lx - gapX - W;
      if (y + H > innerHeight - 6) y = ly - gapY - H;
      if (x < 6) x = Math.min(innerWidth - W - 6, lx + gapX);
      if (y < 6) y = 6;
      lens.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      lens.hidden = false;
    };
    raf = requestAnimationFrame(frame);
  } catch (e) {
    console.warn('[zoom]', e.message);
    stopZoom();
    store.set('zoomOn', false);
    import('./notifications.js').then(({ notify }) => notify({ app: 'settings', title: 'Zoom couldn’t start', body: e.message }));
  } finally { busy = false; }
}
export function stopZoom() {
  cancelAnimationFrame(raf);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null; srcId = null;
  lens?.remove(); lens = null; video = null; ctx = null; canvas = null;
}
