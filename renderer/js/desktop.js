// The desktop surface: icons from ~/Desktop, rubber-band selection, context menu, widgets, hot corners.
import { h, $, $$, bus, basename } from './util.js';
import { folderIcon, docIcon, sym, IMAGE_EXT, appIcon } from './icons.js';
import { store } from './store.js';
import { api } from './sys.js';
import { contextMenu, prompt } from './menus.js';
import { wm } from './wm.js';
import { buildWidget, WIDGETS, widgetDef, CATEGORIES, SIZE_PX } from './widgets.js';
import { customWidgets, validate, saveCustom, deleteCustom, toFile } from './customwidget.js';
import { shell } from './shell.js';
import { fileUrl } from './util.js';
import { layer } from './layer.js';

let iconsEl, places, lastSig = '', renderGen = 0;

// Several things can ask for a redraw at once (a Trash action and the "files changed" event, the timer…).
// Each draw builds its icons off to the side and only the newest one is put on the desktop, so two
// overlapping draws can't both add their icons (which showed every icon twice).
async function renderIcons(force = true) {
  const gen = ++renderGen;
  if (!store.get('showDesktopIcons') || !places) { iconsEl.innerHTML = ''; lastSig = ''; return; }
  let items = [];
  try { items = (await api.fs.list(places.desktop)).filter((f) => !f.hidden).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
  if (gen !== renderGen) return;
  const sig = items.map((f) => f.name + f.mtime).join('|');
  if (!force && sig === lastSig) return;   // nothing changed: keep the selection
  const selected = new Set($$('.desk-icon.sel', iconsEl).map((x) => x.dataset.path));
  const out = [];
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
    if (selected.has(f.path)) el.classList.add('sel');
    out.push(el);
  }
  if (gen !== renderGen) return;   // a newer draw is on its way
  lastSig = sig;
  iconsEl.replaceChildren(...out);
}

/* ---------------------------------------------- widgets */
let widgetLayer, gallery = null;
const WSIZE = { s: [164, 164], m: [340, 164] };
const wsize = (type) => SIZE_PX[widgetDef(type)?.size || 's'] || WSIZE.s;
// The free spot for a widget nearest to (px, py) — or the first one from the top left — keeping a gap
// around the others and clear of the menu bar, the Dock and the desktop icons on the right.
function freeSpot(type, px, py, skipId) {
  const [w, h] = wsize(type), gap = 12;
  const others = store.get('widgets').filter((x) => x.id !== skipId && widgetDef(x.type)).map((x) => [x.x, x.y, ...wsize(x.type)]);
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
    if (!widgetDef(w.type)) continue;
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
  gallery = h('div#widget-gallery.glass.panel.sheen');
  drawGallery();
  document.body.append(gallery);
}
// the gallery: categories along the top, the widgets of the chosen one, Import / Create, Done
let galleryCat = 'all';
function addWidget(type) {
  const [x, y] = freeSpot(type);
  store.set('widgets', [...store.get('widgets'), { id: 'w' + Date.now(), type, x, y }]);
}
async function importWidget() {
  const files = await api.dialog?.open({ title: 'Import Widget', filters: [{ name: 'LiquidDesktop widgets', patterns: ['*.ldwidget', '*.json'] }] }).catch(() => null);
  if (!files?.length) return;
  try {
    const spec = validate(await api.fs.read(files[0]));
    if (customWidgets()[spec.id]) spec.id = spec.id + Math.random().toString(36).slice(2, 5);
    saveCustom(spec);
    galleryCat = 'mine'; drawGallery();
    notifyWidget(`“${spec.name}” was added to My Widgets`);
  } catch (e) { const { alertDialog } = await import('./menus.js'); alertDialog({ title: 'Couldn’t import the widget', message: e.message }); }
}
function notifyWidget(body) { import('./notifications.js').then(({ notify }) => notify({ app: 'widgetcreator', title: 'Widgets', body })); }
function drawGallery() {
  if (!gallery) return;
  gallery.innerHTML = '';
  const tabs = h('div.wg-tabs', ...CATEGORIES.map(([id, name]) => h('button' + (galleryCat === id ? '.on' : ''), { onclick: () => { galleryCat = id; drawGallery(); } }, name)));
  const row = h('div.wg-row');
  const types = [...Object.entries(WIDGETS).map(([t, d]) => [t, d]), ...Object.values(customWidgets()).map((c) => ['custom:' + c.id, { name: c.name, cat: 'mine', size: c.size }])]
    .filter(([, d]) => galleryCat === 'all' || d.cat === galleryCat);
  for (const [type, def] of types) {
    const item = h('div.wg-item.' + (def.size || 's'), buildWidget(type), h('span', def.name));
    item.addEventListener('click', () => addWidget(type));
    if (type.startsWith('custom:')) {
      const id = type.slice(7);
      item.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Add to Desktop', action: () => addWidget(type) },
        { label: 'Edit in Widget Creator', action: () => wm.open('widgetcreator', { id }) },
        { label: 'Export…', action: async () => {
          const spec = customWidgets()[id];
          const p = await api.dialog?.save({ title: 'Export Widget', name: `${spec.name.replace(/[/\\]/g, '-')}.ldwidget`, filters: [{ name: 'LiquidDesktop widget', patterns: ['*.ldwidget'] }] }).catch(() => null);
          if (p?.[0]) { await api.fs.write(p[0], toFile(spec)); notifyWidget(`Exported to ${p[0]}`); }
        } },
        '-',
        { label: 'Delete', action: () => { deleteCustom(id); drawGallery(); } },
      ]));
    }
    row.append(item);
  }
  if (!types.length) row.append(h('div.wg-empty', galleryCat === 'mine' ? 'No widgets of your own yet. Create one, or import a .ldwidget file someone shared.' : 'No widgets here.'));
  gallery.append(
    h('div.wg-top', tabs, h('div.wg-actions',
      h('button.btn', { onclick: importWidget }, 'Import…'),
      h('button.btn', { onclick: () => wm.open('widgetcreator') }, 'Create Widget…'),
      h('button.btn.primary', { onclick: () => editWidgets(false) }, 'Done'))),
    h('div.wg-hint', 'Click a widget to add it · drag widgets on the desktop to move them · − removes'),
    row);
}
store.on('change', (k) => { if (k === 'customWidgets') { drawGallery(); if (widgetLayer) renderWidgets(); } });
store.on('change:widgetEditing', applyEditing);
if (layer === 'shell' || layer === 'full') store.s.widgetEditing = false;

/* ---------------------------------------------- rubber band + desktop menu */
function initSurface() {
  const surface = $('#desktop');
  surface.addEventListener('mousedown', (e) => {
    // anywhere on the bare desktop (the wallpaper layers, the empty icon area…), not on things on it
    if (e.target.closest('.desk-icon, .desk-widget, .widget, .win, #dock-wrap, #menubar, .menu, #widget-gallery, button, input, select, textarea, a')) return;
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
