// Screenshot tool (Super+Shift+S): freezes the screen, then lets you take an area, a window or the whole
// screen. The picture is saved to a folder and/or copied to the clipboard (Settings › General › Screenshots).
// Its Record mode (Super+Shift+R) records that area instead, with the microphone and/or the computer's sound:
// the menu bar shows how long it's been recording, and clicking that stops it (recording.js).
import { h, $ } from './util.js';
import { api } from './sys.js';
import { store } from './store.js';
import { wm } from './wm.js';
import { isSession } from './layer.js';
import { showMenu, closeMenu } from './menus.js';

const ICONS = {
  area: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/></svg>',
  window: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 9h18"/></svg>',
  capture: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.5-2.2h5.4L16.2 7h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.6" r="3.4"/></svg>',
  record: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
  sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3l4.5-4v13L7 14.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
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

// the recording settings, kept between uses
const recOpts = () => ({ mic: store.get('recMic') === true, desktop: store.get('recDesktop') !== false, format: store.get('recFormat') || 'mp4',
  fps: store.get('recFps') || 60, pointer: store.get('recPointer') !== false, dir: store.get('recDir') || '' });

/** Start recording r (CSS px of this page; null = the whole screen); k = image px per CSS px. */
async function record(r, k) {
  const R = r || { x: 0, y: 0, w: innerWidth, h: innerHeight };
  // let the tool's own overlay disappear from the screen first
  await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(ok, 120))));
  try {
    await api.rec.start({ x: R.x * k, y: R.y * k, w: R.w * k, h: R.h * k, ...recOpts() });
  } catch (e) {
    const { shell } = await import('./shell.js');
    shell.notify({ app: 'preview', title: 'Screen Recording', body: e.message });
  }
}

/** opts.kind: 'capture' (a picture) or 'record' (a video); the last one used otherwise. */
export async function screenshotTool(opts = {}) {
  if (open) return;
  const recStatus = await api.rec?.status?.().catch(() => null);
  if (recStatus?.recording) return api.rec.stop();   // the shortcut again while recording: stop
  open = true;
  const canRecord = !!recStatus?.supported;
  let kind = canRecord ? opts.kind || store.get('shotKind') || 'capture' : 'capture';
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

  const close = () => { open = false; closeMenu(); layer.remove(); removeEventListener('keydown', key, true); };
  const take = (r) => {
    if (kind === 'record') { close(); record(r, sx); return; }
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

  // Capture / Record
  const kindBtn = (k, label) => h('button.shot-kind' + (kind === k ? '.on' : ''), { 'data-k': k, html: ICONS[k] + `<span>${label}</span>`, onclick: (e) => { e.stopPropagation(); setKind(k); } });
  // the recording options, above the bar
  const opt = (key, icon, label, def) => {
    const on = () => (def ? store.get(key) !== false : store.get(key) === true);
    const b = h('button.shot-opt' + (on() ? '.on' : ''), { html: ICONS[icon] + `<span>${label}</span>`, title: label,
      onclick: (e) => { e.stopPropagation(); store.set(key, !on()); b.classList.toggle('on', on()); } });
    return b;
  };
  // a little pop-up menu (a native <select> pop-up is a window of its own, which the session can't layer over this)
  const pick = (key, def, choices, title) => {
    const label = () => (choices.find(([v]) => String(v) === String(store.get(key) || def)) || choices[0])[1];
    const b = h('button.shot-select', { title, onclick: (e) => {
      e.stopPropagation();
      const r = b.getBoundingClientRect();
      showMenu(choices.map(([v, l]) => ({ label: l, checked: String(v) === String(store.get(key) || def), action: () => { store.set(key, v); b.firstChild.textContent = label(); } })),
        r.left, r.top - 8 - choices.length * 30, { anchor: b, className: 'shot-menu' });
    } }, h('span', label()), h('i', '⌄'));
    return b;
  };
  const opts2 = h('div.shot-opts.glass.panel.sheen',
    opt('recMic', 'mic', 'Microphone', false), opt('recDesktop', 'sound', 'Desktop Audio', true), h('i.shot-sep'),
    pick('recFormat', 'mp4', [['mp4', 'MP4'], ['mkv', 'MKV'], ['webm', 'WebM'], ['mov', 'MOV']], 'File format'),
    pick('recFps', 60, [[60, '60 fps'], [30, '30 fps'], [24, '24 fps']], 'Frame rate'),
    h('label.shot-check', h('input', { type: 'checkbox', checked: store.get('recPointer') !== false, onchange: (e) => store.set('recPointer', e.target.checked) }), 'Show pointer'));
  opts2.addEventListener('mousedown', (e) => e.stopPropagation());
  const setKind = (k) => {
    kind = k; store.set('shotKind', k);
    bar.querySelectorAll('[data-k]').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
    layer.dataset.kind = k;
    opts2.hidden = k !== 'record';
    setMode(mode);
  };
  const btn = (m, label) => h('button' + (mode === m ? '.on' : ''), { 'data-m': m, html: ICONS[m] + `<span>${label}</span>`, onclick: (e) => { e.stopPropagation(); setMode(m); } });
  const setMode = (m) => {
    mode = m; store.set('shotMode', m);
    bar.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    layer.dataset.mode = m;
    show(null);
    hint.textContent = kind === 'record'
      ? { area: 'Drag to select an area to record', window: 'Click a window to record it', screen: 'Click anywhere or press Return to record' }[m]
      : { area: 'Drag to select an area', window: 'Click a window', screen: 'Click anywhere or press Return' }[m];
  };
  const hint = h('span.shot-hint');
  if (canRecord) bar.append(kindBtn('capture', 'Capture'), kindBtn('record', 'Record'), h('i.shot-sep'));
  bar.append(btn('area', 'Area'), btn('window', 'Window'), btn('screen', 'Screen'), h('i.shot-sep'), hint,
    h('button.shot-x', { onclick: (e) => { e.stopPropagation(); close(); }, title: 'Cancel (Esc)' }, '✕'));
  bar.addEventListener('mousedown', (e) => e.stopPropagation());
  layer.append(opts2);
  setKind(kind);

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
