// The Dock: pinned + running apps, magnification, bounce, minimized windows, Trash, drag-to-reorder.
import { h, $, $$, bus, clamp } from './util.js';
import { appIcon, sym } from './icons.js';
import { store } from './store.js';
import { wm } from './wm.js';
import { catalog } from './catalog.js';
import { showMenu } from './menus.js';
import { attachLens } from './theme.js';
import { api } from './sys.js';
import { shell } from './shell.js';

let wrap, dock, items, tip;
const launching = new Set();

function label(id) { return catalog.find(id)?.name || id; }

function render() {
  const pinned = store.get('dockPinned').filter((id) => catalog.find(id));
  const running = wm.runningApps().filter((id) => !pinned.includes(id));
  const minimized = wm.windows.filter((w) => w.minimized);
  items.innerHTML = '';
  items.append(dockItem('launchpad', { special: true }));
  for (const id of pinned) items.append(dockItem(id));
  for (const id of running) items.append(dockItem(id));
  items.append(h('div.dock-sep'));
  for (const w of minimized) items.append(minimizedItem(w));
  items.append(trashItem());
  applySizes();
}

function dockItem(id, { special } = {}) {
  const app = special ? { id: 'launchpad', builtin: true, name: 'Apps' } : catalog.find(id);
  const el = h('div.dock-item', { 'data-app': id, draggable: !special }, appIcon(app, 'icon'), h('i.dot'));
  if (wm.appWindows(id).length) el.classList.add('running');
  if (launching.has(id)) el.classList.add('bounce');
  el.addEventListener('mouseenter', () => showTip(el, special ? 'Apps' : app.name));
  el.addEventListener('mouseleave', hideTip);
  el.addEventListener('click', () => {
    hideTip();
    if (special) return shell.launchpad();
    if (!wm.appWindows(id).length) bounce(id, el);
    catalog.launch(app);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault(); hideTip();
    if (special) return;
    const pinned = store.get('dockPinned');
    const wins = wm.appWindows(id);
    const r = el.getBoundingClientRect();
    showMenu([
      ...wins.map((w) => ({ label: w.title, checked: w === wm.focused, action: () => w.focus() })),
      wins.length ? '-' : null,
      app.builtin ? { label: 'New Window', action: () => wm.open(id) } : app.exec ? { label: 'New Window', action: () => api.apps.launch(app.exec, app.terminal) } : null,
      { label: 'Options', submenu: [
        pinned.includes(id) ? { label: 'Remove from Dock', action: () => store.set('dockPinned', pinned.filter((p) => p !== id)) }
          : { label: 'Keep in Dock', action: () => store.set('dockPinned', [...pinned, id]) },
        app.file ? { label: 'Show in Files', action: () => wm.open('files', { path: app.file.replace(/\/[^/]+$/, ''), select: app.file }) } : null,
      ].filter(Boolean) },
      wins.length ? '-' : null,
      wins.length ? { label: 'Show All Windows', action: () => wm.mission() } : null,
      wins.length ? { label: 'Hide', action: () => wins.forEach((w) => w.minimize()) } : null,
      wins.length ? { label: 'Quit', action: () => wm.quitApp(id) } : null,
    ].filter(Boolean), r.left, r.top - 8, { minWidth: 200 });
    // open the menu above the icon
    const m = $('.menu:last-of-type');
    if (m) m.style.top = r.top - m.offsetHeight - 10 + 'px';
  });
  // drag to reorder pinned items, or out of the dock to remove
  el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/dock-app', id); e.dataTransfer.effectAllowed = 'move'; setTimeout(() => el.classList.add('dragging')); hideTip(); });
  el.addEventListener('dragend', (e) => {
    el.classList.remove('dragging');
    const r = dock.getBoundingClientRect();
    if (e.clientY < r.top - 80 && store.get('dockPinned').includes(id) && !wm.appWindows(id).length) {
      el.classList.add('poof');
      setTimeout(() => store.set('dockPinned', store.get('dockPinned').filter((p) => p !== id)), 300);
    }
  });
  el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/dock-app')) e.preventDefault(); });
  el.addEventListener('drop', (e) => {
    const src = e.dataTransfer.getData('text/dock-app');
    if (!src || src === id) return;
    e.preventDefault();
    const list = store.get('dockPinned').filter((p) => p !== src);
    const r = el.getBoundingClientRect();
    let i = list.indexOf(id);
    if (i < 0) i = list.length; else if (e.clientX > r.left + r.width / 2) i++;
    list.splice(i, 0, src);
    store.set('dockPinned', list);
  });
  return el;
}

function minimizedItem(w) {
  const thumb = h('div.mini-thumb', h('div', { style: { position: 'absolute', inset: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '8px', color: 'var(--text-2)' } }, w.title));
  const el = h('div.dock-item.minimized-win', { 'data-win': w.id }, h('div.icon', thumb, h('div.mini-badge', appIcon(w.app))));
  el.addEventListener('mouseenter', () => showTip(el, w.title));
  el.addEventListener('mouseleave', hideTip);
  el.addEventListener('click', () => { hideTip(); w.restore(); });
  return el;
}

let trashFull = false;
async function checkTrash() {
  try {
    const p = await api.fs.places();
    const list = await api.fs.list(p.trash);
    const full = list.length > 0;
    if (full !== trashFull) { trashFull = full; render(); }
  } catch { /* no trash dir yet */ }
}
function trashItem() {
  const el = h('div.dock-item', { 'data-app': 'trash' }, appIcon(trashFull ? 'trash-full' : 'trash', 'icon'));
  el.addEventListener('mouseenter', () => showTip(el, 'Trash'));
  el.addEventListener('mouseleave', hideTip);
  el.addEventListener('click', async () => { hideTip(); const p = await api.fs.places(); wm.open('files', { path: p.trash, trash: true }); });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault(); hideTip();
    const r = el.getBoundingClientRect();
    showMenu([{ label: 'Open', action: () => el.click() }, { label: 'Empty Trash', disabled: !trashFull, action: () => shell.emptyTrash() }], r.left, r.top - 90);
  });
  // drop files from Files onto the Trash
  el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/liquid-paths')) { e.preventDefault(); el.classList.add('bounce'); } });
  el.addEventListener('dragleave', () => el.classList.remove('bounce'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault(); el.classList.remove('bounce');
    const paths = JSON.parse(e.dataTransfer.getData('text/liquid-paths') || '[]');
    for (const p of paths) await api.fs.trash(p).catch(() => {});
    bus.emit('fs-changed'); checkTrash();
  });
  return el;
}

function bounce(id, el) {
  launching.add(id);
  el?.classList.add('bounce');
  setTimeout(() => { launching.delete(id); $$(`.dock-item[data-app="${CSS.escape(id)}"]`).forEach((x) => x.classList.remove('bounce')); }, 1500);
}

function showTip(el, text) {
  hideTip();
  const r = el.getBoundingClientRect();
  tip = h('div.dock-tip.glass.panel', text);
  tip.style.left = r.left + r.width / 2 + 'px';
  tip.style.top = r.top - 38 + 'px';
  document.body.append(tip);
}
function hideTip() { tip?.remove(); tip = null; }

/* ---------------------------------------------- magnification */
let mouseX = null;
function applySizes() {
  const base = store.get('dockSize'), max = store.get('dockMagnify') ? store.get('dockMagSize') : base;
  dock.style.setProperty('--dock-size', base + 'px');
  const els = $$('.dock-item', items);
  const range = base * 2.6;
  // magnify from where icons sit at rest, so growing icons don't shift the focus point
  const kids = [...items.children];
  const restW = kids.reduce((t, k) => t + (k.classList.contains('dock-sep') ? 15 : base + 4), 0);
  let cursor = innerWidth / 2 - restW / 2;
  const centers = new Map();
  for (const k of kids) {
    const w = k.classList.contains('dock-sep') ? 15 : base + 4;
    centers.set(k, cursor + w / 2);
    cursor += w;
  }
  for (const el of els) {
    let s = base;
    if (mouseX != null && max > base) {
      const d = Math.abs(mouseX - centers.get(el));
      if (d < range) s = base + (max - base) * Math.cos((d / range) * (Math.PI / 2)) ** 2;
    }
    el.style.width = el.style.height = s + 'px';
  }
  if (tip) { const el = els.find((e) => e.matches(':hover')); if (el) { const r = el.getBoundingClientRect(); tip.style.left = r.left + r.width / 2 + 'px'; tip.style.top = r.top - 38 + 'px'; } }
}

/* ---------------------------------------------- autohide */
let hideTimer;
function updateHidden(forceShow) {
  const auto = store.get('dockAutohide');
  if (!auto) return wrap.classList.remove('hidden');
  if (forceShow) { clearTimeout(hideTimer); wrap.classList.remove('hidden'); }
  else { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!dock.matches(':hover') && !document.querySelector('.menu')) wrap.classList.add('hidden'); }, 600); }
}

export function initDock() {
  wrap = $('#dock-wrap');
  dock = h('div#dock.glass.sheen');
  items = h('div.dock-items');
  dock.append(items);
  wrap.append(dock);
  attachLens(dock, { strength: 46, edge: 20 });
  dock.addEventListener('mousemove', (e) => { mouseX = e.clientX; dock.classList.add('hovering'); requestAnimationFrame(applySizes); });
  dock.addEventListener('mouseleave', () => { mouseX = null; dock.classList.remove('hovering'); applySizes(); updateHidden(); });
  dock.addEventListener('mouseenter', () => updateHidden(true));
  addEventListener('mousemove', (e) => { if (store.get('dockAutohide') && e.clientY >= innerHeight - 4) updateHidden(true); });
  render();
  updateHidden();
  bus.on('windows', render);
  bus.on('catalog', render);
  bus.on('icons-changed', render);
  bus.on('fs-changed', checkTrash);
  bus.on('native-launched', (id) => { const el = $(`.dock-item[data-app="${CSS.escape(id)}"]`); bounce(id, el); });
  store.on('change', (k) => {
    if (['dockPinned', 'dockSize', 'dockMagnify', 'dockMagSize'].includes(k)) render();
    if (k === 'dockAutohide') updateHidden();
  });
  checkTrash();
  setInterval(checkTrash, 15000);
}
