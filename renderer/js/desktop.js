// The desktop surface: icons from ~/Desktop, rubber-band selection, context menu, widgets, hot corners.
import { h, $, $$, bus, basename } from './util.js';
import { folderIcon, docIcon, sym, IMAGE_EXT, appIcon } from './icons.js';
import { store } from './store.js';
import { api } from './sys.js';
import { contextMenu, prompt } from './menus.js';
import { wm } from './wm.js';
import { buildWidget, WIDGETS } from './widgets.js';
import { shell } from './shell.js';
import { fileUrl } from './util.js';
import { layer } from './layer.js';

let iconsEl, places, lastSig = '';

async function renderIcons(force = true) {
  if (!store.get('showDesktopIcons') || !places) { iconsEl.innerHTML = ''; lastSig = ''; return; }
  let items = [];
  try { items = (await api.fs.list(places.desktop)).filter((f) => !f.hidden).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
  const sig = items.map((f) => f.name + f.mtime).join('|');
  if (!force && sig === lastSig) return;   // nothing changed: keep the selection
  lastSig = sig;
  iconsEl.innerHTML = '';
  for (const f of items) {
    const ic = h('div.fi');
    if (f.isDir) ic.innerHTML = folderIcon(f.name);
    else if (IMAGE_EXT.has(f.ext)) ic.append(h('img', { src: fileUrl(f.path), style: { width: '100%', height: '100%', objectFit: 'contain', borderRadius: '4px' } }));
    else if (f.ext === 'desktop') {
      // launchers on the desktop show their app's own icon
      const app = await api.apps.info?.(f.path).catch(() => null);
      if (app?.icon) ic.append(appIcon(app)); else ic.innerHTML = docIcon('app');
    }
    else ic.innerHTML = docIcon(f.ext);
    const el = h('div.desk-icon', { draggable: true }, ic, h('span', f.name.replace(/\.desktop$/, '')));
    el.dataset.path = f.path;
    el.addEventListener('mousedown', (e) => { e.stopPropagation(); if (!e.shiftKey && !e.ctrlKey) $$('.desk-icon.sel').forEach((x) => x.classList.remove('sel')); el.classList.add('sel'); });
    el.addEventListener('dblclick', () => shell.openPath(f.path, f.isDir));
    el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/liquid-paths', JSON.stringify($$('.desk-icon.sel').map((x) => x.dataset.path))));
    el.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Open', action: () => shell.openPath(f.path, f.isDir) },
      { label: 'Open With System App', action: () => api.fs.open(f.path) }, '-',
      { label: 'Rename…', action: async () => { const n = await prompt('Rename', f.name, { select: 'stem' }); if (n && n !== f.name) { await api.fs.rename(f.path, n).catch((err) => shell.notify({ title: 'Rename failed', body: err.message })); renderIcons(); } } },
      { label: 'Copy Path', action: () => api.clip.write(f.path) },
      { label: 'Show in Files', action: () => wm.open('files', { path: places.desktop, select: f.path }) }, '-',
      { label: 'Move to Trash', danger: true, action: async () => { await api.fs.trash(f.path); renderIcons(); bus.emit('fs-changed'); } },
    ]));
    iconsEl.append(el);
  }
}

/* ---------------------------------------------- widgets */
let widgetLayer, gallery = null;
const WSIZE = { s: [164, 164], m: [340, 164] };
const wsize = (type) => WSIZE[WIDGETS[type]?.size || 's'];
// The free spot for a widget nearest to (px, py) — or the first one from the top left — keeping a gap
// around the others and clear of the menu bar, the Dock and the desktop icons on the right.
function freeSpot(type, px, py, skipId) {
  const [w, h] = wsize(type), gap = 12;
  const others = store.get('widgets').filter((x) => x.id !== skipId && WIDGETS[x.type]).map((x) => [x.x, x.y, ...wsize(x.type)]);
  const fits = (x, y) => !others.some(([rx, ry, rw, rh]) => x < rx + rw + gap && x + w + gap > rx && y < ry + rh + gap && y + h + gap > ry);
  const maxX = innerWidth - w - 130, maxY = innerHeight - h - 110;
  let best = null, bestD = Infinity;
  for (let y = 48; y <= maxY; y += 12) {
    for (let x = 36; x <= maxX; x += 12) {
      if (!fits(x, y)) continue;
      if (px == null) return [x, y];                      // first free spot, reading order
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < bestD) { bestD = d; best = [x, y]; }
    }
  }
  return best || [px ?? 36, py ?? 48];
}
function renderWidgets() {
  widgetLayer.innerHTML = '';
  for (const w of store.get('widgets')) {
    if (!WIDGETS[w.type]) continue;
    const el = buildWidget(w.type);
    el.classList.add('desk-widget');
    el.style.left = w.x + 'px'; el.style.top = w.y + 'px';
    el.append(h('button.remove', { onclick: (e) => { e.stopPropagation(); store.set('widgets', store.get('widgets').filter((x) => x.id !== w.id)); } }, '−'));
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('textarea, button')) return;
      e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, ox = w.x, oy = w.y;
      let moved = false;
      const mv = (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        moved = true; el.classList.add('dragging');
        // snap to a 12px grid as you drag
        w.x = Math.round((ox + ev.clientX - sx) / 12) * 12; w.y = Math.max(36, Math.round((oy + ev.clientY - sy) / 12) * 12);
        el.style.left = w.x + 'px'; el.style.top = w.y + 'px';
      };
      const up = () => {
        removeEventListener('mousemove', mv); removeEventListener('mouseup', up); el.classList.remove('dragging');
        if (!moved) return;
        // dropped on top of another widget: slide to the nearest free spot
        [w.x, w.y] = freeSpot(w.type, w.x, w.y, w.id);
        store.set('widgets', store.get('widgets').map((x) => (x.id === w.id ? { ...x, x: w.x, y: w.y } : x)));
      };
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
    });
    el.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Remove Widget', action: () => store.set('widgets', store.get('widgets').filter((x) => x.id !== w.id)) },
      { label: 'Edit Widgets…', action: () => editWidgets() },
    ]));
    widgetLayer.append(el);
  }
}

// Edit mode is shared through settings, so in a session the gallery (in the top layer) and the widgets
// (in the desktop layer) stay in sync.
export function editWidgets(force) {
  store.set('widgetEditing', force ?? !store.get('widgetEditing'));
}
function applyEditing(on) {
  if (layer === 'full' || layer === 'desktop') $('#desktop')?.classList.toggle('editing-widgets', on);
  if (layer !== 'full' && layer !== 'shell') return;
  if (!on) { gallery?.remove(); gallery = null; return; }
  if (gallery) return;
  gallery = h('div#widget-gallery.glass.panel.sheen', h('div.wg-hint', 'Drag widgets on the desktop to move them · click one below to add it · − removes'));
  for (const [type, def] of Object.entries(WIDGETS)) {
    const item = h('div.wg-item', buildWidget(type), h('span', def.name));
    item.addEventListener('click', () => {
      const list = store.get('widgets');
      const [x, y] = freeSpot(type);
      store.set('widgets', [...list, { id: 'w' + Date.now(), type, x, y }]);
    });
    gallery.append(item);
  }
  gallery.append(h('button.btn.primary', { style: { alignSelf: 'center', marginLeft: '8px' }, onclick: () => editWidgets(false) }, 'Done'));
  document.body.append(gallery);
}
store.on('change:widgetEditing', applyEditing);
if (layer === 'shell' || layer === 'full') store.s.widgetEditing = false;

/* ---------------------------------------------- rubber band + desktop menu */
function initSurface() {
  const surface = $('#desktop');
  surface.addEventListener('mousedown', (e) => {
    if (e.target !== surface && e.target.id !== 'wallpaper' && e.target !== iconsEl && e.target.id !== 'widget-layer' && e.target.id !== 'spaces' && !e.target.classList.contains('space')) return;
    if (e.button !== 0) return;
    wm.focused?.blur();
    $$('.desk-icon.sel').forEach((x) => x.classList.remove('sel'));
    const sx = e.clientX, sy = e.clientY;
    const band = h('div#rubber');
    surface.append(band);
    const mv = (ev) => {
      const x = Math.min(sx, ev.clientX), y = Math.min(sy, ev.clientY), w = Math.abs(ev.clientX - sx), hh = Math.abs(ev.clientY - sy);
      Object.assign(band.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: hh + 'px' });
      for (const ic of $$('.desk-icon')) {
        const r = ic.getBoundingClientRect();
        ic.classList.toggle('sel', r.right > x && r.left < x + w && r.bottom > y && r.top < y + hh);
      }
    };
    const up = () => { band.remove(); removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  });
  surface.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.win, #dock, #menubar, .desk-icon, .desk-widget, .menu')) return;
    contextMenu(e, [
      { label: 'New Folder', action: async () => { await api.fs.mkdir(places.desktop, 'untitled folder'); renderIcons(); } },
      { label: 'New Text File', action: async () => { await api.fs.newFile(places.desktop, 'untitled.txt'); renderIcons(); } }, '-',
      { label: 'Open Terminal Here', icon: sym.terminal, action: () => wm.open('terminal', { cwd: places.desktop }) },
      { label: 'Open Desktop in Files', icon: sym.folder, action: () => wm.open('files', { path: places.desktop }) }, '-',
      { label: 'Change Wallpaper…', icon: sym.photo, action: () => shell.openSettings('wallpaper') },
      { label: 'Edit Widgets…', icon: sym.widgets, action: () => editWidgets() },
      { label: store.get('showDesktopIcons') ? 'Hide Desktop Icons' : 'Show Desktop Icons', action: () => store.set('showDesktopIcons', !store.get('showDesktopIcons')) },
      '-', { label: 'Use Dark Mode', checked: document.documentElement.dataset.theme === 'dark', action: () => store.set('theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') },
    ]);
  });
  // dropping files from Files onto the desktop moves them to ~/Desktop
  surface.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/liquid-paths') && !e.target.closest('.win, #dock')) e.preventDefault(); });
  surface.addEventListener('drop', async (e) => {
    if (e.target.closest('.win, #dock')) return;
    e.preventDefault();
    const paths = JSON.parse(e.dataTransfer.getData('text/liquid-paths') || '[]');
    for (const p of paths) if (!p.startsWith(places.desktop + '/') || p.slice(places.desktop.length + 1).includes('/')) await api.fs.move(p, places.desktop).catch(() => {});
    renderIcons(); bus.emit('fs-changed');
  });
}

/* ---------------------------------------------- hot corners */
function initHotCorners() {
  let armed = null, t;
  addEventListener('mousemove', (e) => {
    const W = innerWidth, H = innerHeight, m = 2;
    const c = e.clientX <= m && e.clientY <= m ? 'tl' : e.clientX >= W - m && e.clientY <= m ? 'tr' : e.clientX <= m && e.clientY >= H - m ? 'bl' : e.clientX >= W - m && e.clientY >= H - m ? 'br' : null;
    if (c === armed) return;
    armed = c; clearTimeout(t);
    if (!c) return;
    const action = store.get('hotCorners')[c];
    if (!action || action === 'none') return;
    t = setTimeout(() => {
      if (armed !== c) return;
      ({ mission: () => wm.mission(), desktop: () => wm.toggleDesktop(), launchpad: () => shell.launchpad(), lock: () => shell.lock(),
        notifications: () => shell.toggleNotificationCenter(), spotlight: () => shell.spotlight(), screensaver: () => shell.lock() })[action]?.();
    }, 180);
  });
}

export async function initDesktop() {
  iconsEl = $('#desk-icons');
  widgetLayer = $('#widget-layer');
  places = await api.fs.places().catch(() => null);
  renderIcons(); renderWidgets(); initSurface(); initHotCorners();
  bus.on('fs-changed', renderIcons);
  store.on('change', (k) => { if (k === 'showDesktopIcons') renderIcons(); if (k === 'widgets') renderWidgets(); });
  setInterval(() => renderIcons(false), 5000);
}
