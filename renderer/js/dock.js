// The Dock: pinned + running apps, magnification, bounce, minimized windows, Trash, drag-to-reorder.
import { h, $, $$, bus, clamp } from './util.js';
import { appIcon, sym } from './icons.js';
import { store, dockHideMode } from './store.js';
import { wm } from './wm.js';
import { catalog } from './catalog.js';
import { showMenu } from './menus.js';
import { attachLens } from './theme.js';
import { api } from './sys.js';
import { shell } from './shell.js';
import { isSession } from './layer.js';

let wrap, dock, items, tip;
const launching = new Map();   // id → { start, had }

function label(id) { return catalog.find(id)?.name || id; }

// The Dock keeps its icon elements and only touches the DOM when something actually changed.
// (Rebuilding on every window update — titles change all the time — swallowed clicks that landed
// between mouse-down and mouse-up, and restarted the launch bounce mid-hop.)
const cache = new Map();   // key → { el, sig }
function render(full) {
  if (dragActive) return;   // an icon is being dragged: the drop renders
  if (full) cache.clear();
  const pinned = store.get('dockPinned').filter((id) => catalog.find(id));
  const running = wm.runningApps().filter((id) => !pinned.includes(id) && catalog.find(id));
  const minimized = wm.windows.filter((w) => w.minimized);
  const appSig = (id) => { const a = catalog.find(id); return a ? `${a.name}|${typeof a.icon === 'string' ? a.icon.length + a.icon.slice(-40) : a.icon ? 'obj' : ''}` : ''; };
  const want = [['launchpad', '', () => dockItem('launchpad', { special: true })]];
  for (const id of [...pinned, ...running]) want.push(['app:' + id, appSig(id), () => dockItem(id)]);
  want.push(['sep', '', () => h('div.dock-sep')]);
  for (const w of minimized) want.push(['win:' + w.id, w.title + '|' + w.app?.id, () => minimizedItem(w)]);
  want.push(['trash', String(trashFull), trashItem]);
  const keys = new Set(want.map((x) => x[0]));
  for (const k of [...cache.keys()]) if (!keys.has(k)) cache.delete(k);
  const els = want.map(([k, sig, build]) => {
    let c = cache.get(k);
    if (!c || c.sig !== sig) { c = { el: build(), sig }; cache.set(k, c); }
    return c.el;
  });
  for (const el of els) {
    const id = el.dataset.app;
    if (id && id !== 'launchpad' && id !== 'trash') el.classList.toggle('running', wm.appWindows(id).length > 0);
  }
  const cur = [...items.children];
  if (cur.length !== els.length || cur.some((c, i) => c !== els[i])) items.replaceChildren(...els);
  applySizes();
}

function dockItem(id, { special } = {}) {
  const app = special ? { id: 'launchpad', builtin: true, name: 'Apps' } : catalog.find(id);
  const el = h('div.dock-item', { 'data-app': id }, appIcon(app, 'icon'), h('i.dot'));
  if (wm.appWindows(id).length) el.classList.add('running');
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
  // Drag to reorder pinned items, or up out of the Dock to remove one. Done by hand rather than with
  // HTML drag-and-drop: a native drag starts after ~4px, so a click with a slightly moving finger or
  // mouse turned into a drag and the click was lost. Here a drag needs a deliberate 12px.
  let suppressClick = false;
  el.addEventListener('pointerdown', (e) => {
    if (special || e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    const grab = sx - el.getBoundingClientRect().left;
    let dragging = false;
    el.setPointerCapture?.(e.pointerId);
    const zone = () => [...items.children].filter((x) => x.dataset.app && x.dataset.app !== 'launchpad' && x.dataset.app !== 'trash' && x.classList.contains('dock-item') && !x.classList.contains('minimized-win'));
    const follow = (ev) => {
      el.style.transform = '';
      const left = el.getBoundingClientRect().left;
      el.style.transform = `translate(${ev.clientX - grab - left}px, ${Math.min(0, ev.clientY - sy)}px) scale(1.06)`;
    };
    const move = (ev) => {
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 12) return;
      if (!dragging) { dragging = true; dragActive = true; mouseX = null; hideTip(); el.classList.add('dock-drag'); applySizes(); }
      const out = ev.clientY < dock.getBoundingClientRect().top - 80 && store.get('dockPinned').includes(id) && !wm.appWindows(id).length;
      if (out !== el.classList.contains('dock-drag-out')) { el.classList.toggle('dock-drag-out', out); out ? showTip(el, 'Remove') : hideTip(); }
      if (!out) {
        // live reorder: once the pointer passes the middle of a neighbour, swap places (the others slide)
        const list = zone(), i = list.indexOf(el);
        const next = list[i + 1], prev = list[i - 1];
        const mid = (x) => { const r = x.getBoundingClientRect(); return r.left + r.width / 2; };
        let moveTo = null;
        if (next && ev.clientX > mid(next)) moveTo = next.nextSibling;
        else if (prev && ev.clientX < mid(prev)) moveTo = prev;
        if (moveTo !== null) {
          const before = new Map(list.map((x) => [x, x.getBoundingClientRect().left]));
          items.insertBefore(el, moveTo);
          for (const x of list) {
            if (x === el) continue;
            const dx = before.get(x) - x.getBoundingClientRect().left;
            if (!dx) continue;
            x.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
          }
        }
      }
      follow(ev);
      if (out) el.style.transform = `translate(${ev.clientX - sx}px, ${ev.clientY - sy}px)`;
    };
    const up = (ev) => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      if (!dragging) return;
      dragActive = false;
      suppressClick = true; setTimeout(() => (suppressClick = false), 0);
      const wasOut = el.classList.contains('dock-drag-out');
      el.style.transform = ''; el.classList.remove('dock-drag', 'dock-drag-out'); hideTip();
      const pinned = store.get('dockPinned');
      if (ev.type === 'pointerup' && wasOut) {
        el.classList.add('poof');
        setTimeout(() => store.set('dockPinned', store.get('dockPinned').filter((p) => p !== id)), 300);
        return;
      }
      // the new order is what the Dock shows now; dropped among pinned apps, a running app becomes pinned
      const order = zone().map((x) => x.dataset.app);
      const lastPinned = Math.max(...order.map((a, i) => (pinned.includes(a) && a !== id ? i : -1)));
      const keep = pinned.includes(id) || order.indexOf(id) <= lastPinned;
      const next = order.filter((a) => pinned.includes(a) || (a === id && keep));
      for (const p of pinned) if (!next.includes(p)) next.push(p);   // pinned apps not in view (shouldn't happen)
      if (JSON.stringify(next) !== JSON.stringify(pinned)) store.set('dockPinned', next); else render();
      applySizes();
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
  el.addEventListener('click', (e) => { if (suppressClick) { e.stopImmediatePropagation(); suppressClick = false; } }, true);
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

// Launch bounce: hops until the app's first window shows up (or a timeout), then always lands —
// it stops at the end of a hop, never mid-air.
function bounce(id, el) {
  if (!el) return;
  launching.set(id, { start: performance.now(), had: wm.appWindows(id).length });
  const icon = el.querySelector('.icon');
  if (!el.classList.contains('bounce')) {
    el.classList.add('bounce');
    icon?.addEventListener('animationiteration', function onIter() {
      if (!shouldLand(id)) return;
      icon.removeEventListener('animationiteration', onIter);
      el.classList.remove('bounce');
      launching.delete(id);
    });
  }
}
function shouldLand(id) {
  const l = launching.get(id);
  if (!l) return true;
  const t = performance.now() - l.start;
  if (t > 9000) return true;                                         // gave up waiting for a window
  if (wm.appWindows(id).length > l.had) return t > 500;              // the window is up
  if (!isSession && !catalog.find(id)?.builtin) return t > 1800;     // testing window: native apps open outside it
  return false;
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
let mouseX = null, dragActive = false;
function applySizes() {
  const base = store.get('dockSize'), max = store.get('dockMagnify') && !dragActive ? store.get('dockMagSize') : base;
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
// The Dock hides when auto-hide is on, or while the focused window covers it (full screen, or the
// "fill and hide the Dock" zoom). Resting the pointer at the bottom edge reveals it.
let hideTimer, revealed = false, lastCovered = false, edgeTimer;
const covered = () => { const w = wm.focused; return !!w && !w.minimized && (w.fullscreen || w.tile === 'fill-nodock') && (w.space ?? wm.currentSpace) === wm.currentSpace; };
export function dockHidden() { return wrap?.classList.contains('hidden') || wrap?.classList.contains('hidden-full'); }
// smart hide: is a window on this desktop in the Dock's space? (window geometry comes in screen pixels in a session)
function overlapped() {
  if (!dock) return false;
  const k = isSession ? devicePixelRatio || 1 : 1;
  const r = dock.getBoundingClientRect();
  const top = innerHeight - (store.get('dockSize') + 22), left = r.left - 4, right = r.right + 4;
  return wm.windows.some((w) => !w.minimized && (w.space ?? wm.currentSpace) === wm.currentSpace && w.w && w.h
    && w.x / k < right && (w.x + w.w) / k > left && (w.y + w.h) / k > top);
}
function applyHidden() {
  const cov = covered();
  if (cov !== lastCovered) { lastCovered = cov; if (cov) revealed = false; }
  const mode = dockHideMode();
  const hide = (mode === 'always' || cov || (mode === 'smart' && overlapped())) && !revealed;
  wrap.classList.toggle('hidden', hide && !cov);
  wrap.classList.toggle('hidden-full', hide && cov);
}
export function revealDock() {
  revealed = true; clearTimeout(hideTimer); applyHidden();
  // if the pointer never makes it onto the Dock, tuck it away again
  hideTimer = setTimeout(() => concealDock(), 1600);
}
function concealDock(delay = 0) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (dock.matches(':hover') || document.querySelector('.menu')) return concealDock(400);
    revealed = false; applyHidden();
  }, delay);
}
function updateHidden(forceShow) { if (forceShow) { revealed = true; clearTimeout(hideTimer); applyHidden(); } else concealDock(600); }

export function initDock() {
  wrap = $('#dock-wrap');
  dock = h('div#dock.glass.sheen');
  items = h('div.dock-items');
  dock.append(items);
  wrap.append(dock);
  attachLens(dock, { strength: 46, edge: 20 });
  dock.addEventListener('mousemove', (e) => { mouseX = e.clientX; dock.classList.add('hovering'); requestAnimationFrame(applySizes); });
  dock.addEventListener('mouseleave', () => { mouseX = null; dock.classList.remove('hovering'); applySizes(); updateHidden(); });
  dock.addEventListener('mouseenter', () => { if (!dockHidden()) updateHidden(true); });
  // in a window (no window manager): watch the pointer reach the bottom edge — but never while a page or
  // game has locked the pointer, and only after it rests there a moment
  addEventListener('mousemove', (e) => {
    clearTimeout(edgeTimer);
    if (!dockHidden() || document.pointerLockElement || e.clientY < innerHeight - 3) return;
    edgeTimer = setTimeout(() => revealDock(), 250);
  });
  render();
  applyHidden();
  bus.on('windows', () => { render(); applyHidden(); });
  bus.on('focus', applyHidden);
  bus.on('catalog', () => render());
  bus.on('icons-changed', () => render(true));
  bus.on('fs-changed', checkTrash);
  bus.on('native-launched', (id) => { const el = $(`.dock-item[data-app="${CSS.escape(id)}"]`); bounce(id, el); });
  store.on('change', (k) => {
    if (['dockPinned', 'dockSize', 'dockMagnify', 'dockMagSize'].includes(k)) render();
    if (k === 'dockAutohide' || k === 'dockHideMode') { revealed = false; applyHidden(); }
  });
  checkTrash();
  setInterval(checkTrash, 15000);
  setInterval(() => { if (dockHideMode() === 'smart' && !dock.matches(':hover')) applyHidden(); }, 400);
}
