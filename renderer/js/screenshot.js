// Screenshot tool (Super+Shift+S): freezes the screen, then lets you take an area, a window or the whole
// screen. The picture is saved to a folder and/or copied to the clipboard (Settings › General › Screenshots).
import { h, $ } from './util.js';
import { api } from './sys.js';
import { store } from './store.js';
import { wm } from './wm.js';
import { isSession } from './layer.js';

const ICONS = {
  area: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/></svg>',
  window: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 9h18"/></svg>',
  screen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M9 20h6M12 17v3"/></svg>',
};

let open = false;
const opts = () => ({ save: store.get('shotSave') !== false, copy: store.get('shotCopy') !== false, dir: store.get('shotDir') || '' });

/** Save/copy a captured image (data URL) and tell the user where it went. */
async function finish(dataUrl) {
  const flash = $('#flash');
  if (flash) { flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go'); }
  const o = opts();
  try {
    const r = await api.sys.saveScreenshot(dataUrl, o);
    const { shell } = await import('./shell.js');
    const where = [r.file ? r.file.replace(shell.home, '~') : null, r.copied ? 'copied to the clipboard' : null].filter(Boolean).join(' · ');
    shell.notify({ app: 'preview', title: 'Screenshot', body: where || 'Taken', icon: dataUrl, action: r.file ? () => wm.open('preview', { path: r.file }) : undefined });
  } catch (e) {
    const { shell } = await import('./shell.js');
    shell.notify({ app: 'preview', title: 'Screenshot failed', body: e.message });
  }
}

export async function screenshotTool() {
  if (open) return;
  open = true;
  let shot;
  try { shot = await api.sys.capture(); } catch (e) { open = false; return; }
  const img = new Image();
  img.src = shot;
  await img.decode().catch(() => {});
  const sx = img.naturalWidth / innerWidth, sy = img.naturalHeight / innerHeight;   // CSS px → image px

  let mode = store.get('shotMode') || 'area';
  const layer = h('div#shot-layer', { style: { backgroundImage: `url("${shot}")` } });
  const shade = h('div.shot-shade');        // darkens everything outside the selection
  const box = h('div.shot-box', h('span.shot-size'));
  const bar = h('div.shot-bar.glass.panel.sheen');
  layer.append(shade, box, bar);
  document.body.append(layer);

  let rect = null;   // {x,y,w,h} in CSS px
  const show = (r) => {
    rect = r;
    if (!r) { box.hidden = true; shade.style.clipPath = ''; return; }
    box.hidden = false;
    Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    box.firstChild.textContent = `${Math.round(r.w * sx)} × ${Math.round(r.h * sy)}`;
    // a hole in the shade where the selection is
    shade.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${r.x}px ${r.y}px, ${r.x}px ${r.y + r.h}px, ${r.x + r.w}px ${r.y + r.h}px, ${r.x + r.w}px ${r.y}px, ${r.x}px ${r.y}px)`;
  };
  show(null);

  const close = () => { open = false; layer.remove(); removeEventListener('keydown', key, true); };
  const take = (r) => {
    const c = document.createElement('canvas');
    const R = r || { x: 0, y: 0, w: innerWidth, h: innerHeight };
    c.width = Math.max(1, Math.round(R.w * sx)); c.height = Math.max(1, Math.round(R.h * sy));
    c.getContext('2d').drawImage(img, Math.round(R.x * sx), Math.round(R.y * sy), c.width, c.height, 0, 0, c.width, c.height);
    close();
    finish(c.toDataURL('image/png'));
  };

  // windows under the pointer, front to back (session geometry is in screen pixels)
  const k = isSession ? devicePixelRatio || 1 : 1;
  const windows = () => [...(wm.mru || wm.windows || [])].filter((w) => !w.minimized && (w.space ?? wm.currentSpace) === wm.currentSpace && w.w)
    .map((w) => ({ x: w.x / k, y: w.y / k, w: w.w / k, h: w.h / k }));
  const winAt = (x, y) => windows().find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) || null;

  const btn = (m, label) => h('button' + (mode === m ? '.on' : ''), { 'data-m': m, html: ICONS[m] + `<span>${label}</span>`, onclick: (e) => { e.stopPropagation(); setMode(m); } });
  const setMode = (m) => {
    mode = m; store.set('shotMode', m);
    bar.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    layer.dataset.mode = m;
    show(null);
    hint.textContent = { area: 'Drag to select an area', window: 'Click a window', screen: 'Click anywhere or press Return' }[m];
  };
  const hint = h('span.shot-hint');
  bar.append(btn('area', 'Area'), btn('window', 'Window'), btn('screen', 'Screen'), h('i.shot-sep'), hint,
    h('button.shot-x', { onclick: (e) => { e.stopPropagation(); close(); }, title: 'Cancel (Esc)' }, '✕'));
  bar.addEventListener('mousedown', (e) => e.stopPropagation());
  setMode(mode);

  layer.addEventListener('mousemove', (e) => { if (mode === 'window' && !dragging) show(winAt(e.clientX, e.clientY)); });
  let dragging = false;
  layer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) { close(); return; }
    if (mode === 'screen') return take(null);
    if (mode === 'window') { const r = winAt(e.clientX, e.clientY); if (r) take(r); return; }
    dragging = true;
    const x0 = e.clientX, y0 = e.clientY;
    const mv = (ev) => show({ x: Math.min(x0, ev.clientX), y: Math.min(y0, ev.clientY), w: Math.abs(ev.clientX - x0), h: Math.abs(ev.clientY - y0) });
    const up = () => {
      removeEventListener('mousemove', mv); removeEventListener('mouseup', up); dragging = false;
      if (rect && rect.w > 3 && rect.h > 3) take(rect); else show(null);
    };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  });
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); take(mode === 'screen' ? null : rect); }
  };
  addEventListener('keydown', key, true);
}

/** Print Screen: the whole screen right away. */
export async function screenshotNow() {
  try { finish(await api.sys.capture()); } catch (e) { /* nothing to capture */ }
}
