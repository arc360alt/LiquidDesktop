// Notifications: banners + Notification Center (history and widgets).
import { h, $, bus, timeAgo } from './util.js';
import { appIcon, sym } from './icons.js';
import { api } from './sys.js';
import { store } from './store.js';
import { buildWidget, WIDGETS, SIZE_GROUPS, sizeItems } from './widgets.js';
import { showMenu } from './menus.js';
import { customWidgets } from './customwidget.js';
import { catalog } from './catalog.js';
import { attachLens } from './theme.js';

const history = [];

function card(n, cls, onClose) {
  const app = catalog.find(n.app) || { id: n.app || 'about', builtin: true, name: n.appName || 'System' };
  const icon = n.icon ? h('img.notif-img', { src: n.icon, draggable: false }) : appIcon(app);
  const el = h(`div.${cls}.glass.panel.sheen`,
    h('button.x', { html: sym.close, onclick: (e) => { e.stopPropagation(); onClose('x'); } }),
    h('div.ic', icon),
    h('div.body', h('div.top', h('b', n.title), h('time', cls === 'toast' ? 'now' : timeAgo(n.time))), n.body ? h('p', n.body) : null,
      n.actions?.length ? h('div.notif-acts', ...n.actions.map((a) => h('button', { onclick: (e) => { e.stopPropagation(); n.onAction?.(a.key); onClose('action'); } }, a.label))) : null));
  el.addEventListener('click', () => { n.action?.(); onClose('click'); });
  return el;
}

/** A notification from a Linux app (org.freedesktop.Notifications, see main/notifications.js). */
const remoteToasts = new Map();   // remote id → dismiss()
export function notifyRemote(r) {
  if (r.replaces) { const i = history.findIndex((x) => x.rid === r.rid); if (i >= 0) history.splice(i, 1); remoteToasts.get(r.rid)?.(true); }
  const app = catalog.native.find((a) => r.desktop && a.id.replace(/^desktop:|\.desktop$/g, '').toLowerCase() === r.desktop.toLowerCase());
  notify({ rid: r.rid, app: app?.id, appName: r.appName, title: r.title, body: r.body, icon: r.icon || (app?.icon ? 'file://' + app.icon : null), actions: r.actions, timeout: r.timeout,
    onAction: (key) => api.notif.action(r.rid, key),
    action: () => (r.hasDefault ? api.notif.action(r.rid, 'default') : app && catalog.launch(app)),
    onDismiss: (how) => { if (how !== 'replace' && how !== 'action' && how !== 'click') api.notif.closed(r.rid, how === 'timeout' ? 1 : 2); } });
}
export function closeRemote(rid) { remoteToasts.get(rid)?.(true); const i = history.findIndex((x) => x.rid === rid); if (i >= 0) { history.splice(i, 1); bus.emit('notifications'); } }

export function notify(n) {
  n = { time: Date.now(), ...n };
  history.unshift(n);
  if (history.length > 50) history.pop();
  bus.emit('notifications');
  if (store.get('dnd')) return;
  const host = $('#toasts');
  const t = card(n, 'toast', (how) => dismiss(how));
  const dismiss = (how) => {
    if (!t.isConnected) return;
    if (n.rid) remoteToasts.delete(n.rid);
    n.onDismiss?.(how === true ? 'replace' : how);
    t.classList.add('out'); setTimeout(() => t.remove(), 350);
  };
  if (n.rid) remoteToasts.set(n.rid, dismiss);
  host.prepend(t);
  const ms = n.timeout === 0 ? 0 : n.timeout || 5500;   // 0: stays until dismissed (urgent ones)
  let timer = ms ? setTimeout(() => dismiss('timeout'), ms) : null;
  t.addEventListener('mouseenter', () => clearTimeout(timer));
  t.addEventListener('mouseleave', () => { if (ms) timer = setTimeout(() => dismiss('timeout'), 2500); });
}

let nc;
function renderNC() {
  // rebuilt on every change (a new notification, an edit): keep the scroll position
  const top = nc.scrollTop;
  queueMicrotask(() => { nc.scrollTop = top; });
  nc.innerHTML = '';
  nc.append(h('div.nc-head', h('span', 'Notifications'), history.length ? h('button.glass.panel', { onclick: () => { history.length = 0; renderNC(); } }, 'Clear All') : null));
  if (!history.length) nc.append(h('div.nc-empty', 'No Notifications'));
  history.forEach((n, i) => nc.append(card(n, 'notif', () => { history.splice(i, 1); renderNC(); })));
  nc.append(h('div.nc-head', { style: { marginTop: '6px' } }, h('span', 'Widgets')));
  const list = ncList();
  const grid = h('div.nc-widgets');
  list.forEach((type, i) => {
    const el = buildWidget(type);
    if (ncEditing) {
      el.classList.add('nc-editing');
      el.dataset.nc = i;
      el.append(h('button.nc-remove', { title: 'Remove', html: '−', onclick: (e) => { e.stopPropagation(); store.set('ncWidgets', ncList().filter((_, j) => j !== i)); renderNC(); } }));
      el.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest('.nc-remove')) dragNC(el, e); }, true);
    }
    // right-click › Size (widgets that come in two sizes)
    const sz = sizeItems(type, (t) => { store.set('ncWidgets', ncList().map((x, j) => (j === i ? t : x))); renderNC(); });
    if (sz.length) el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showMenu(sz.slice(0, -1), e.clientX, e.clientY); });
    grid.append(el);
  });
  nc.append(grid);
  if (!ncEditing) {
    nc.append(h('button.nc-edit.glass.panel', { onclick: (e) => { e.stopPropagation(); ncEditing = true; renderNC(); } }, 'Edit Widgets'));
    return;
  }
  // edit mode: every widget, drawn as it is, to add (desktop ones and your own desktop-sized ones)
  const types = [...Object.entries(WIDGETS).filter(([t]) => !SIZE_GROUPS.some((g) => g.m === t)).map(([t, d]) => [t, d.name]), ...Object.values(customWidgets()).filter((c) => !/^c/.test(c.size)).map((c) => ['custom:' + c.id, c.name])];
  nc.append(h('div.nc-head', { style: { marginTop: '6px' } }, h('span', 'Add Widgets'), h('button.glass.panel', { onclick: (e) => { e.stopPropagation(); ncEditing = false; renderNC(); } }, 'Done')));
  const gallery = h('div.nc-widgets.nc-gallery');
  for (const [type, name] of types) {
    const el = buildWidget(type);
    el.classList.add('nc-preview');
    el.title = 'Add ' + name;
    el.append(h('span.nc-add', '+'));
    el.addEventListener('click', (e) => { e.stopPropagation(); store.set('ncWidgets', [...ncList(), type]); renderNC(); }, true);
    gallery.append(el);
  }
  nc.append(gallery, h('button.nc-reset', { onclick: (e) => { e.stopPropagation(); store.set('ncWidgets', null); renderNC(); } }, 'Reset to Default'));
}

// the Notification Center's widgets (Edit Widgets there): your list, in order
const NC_DEFAULT = ['upcoming', 'calendar', 'weather', 'system', 'clock'];
let ncEditing = false;
const ncList = () => { const l = store.get('ncWidgets'); return Array.isArray(l) ? l : NC_DEFAULT; };
// drag a widget to move it; the others make way, and the order is saved on release
function dragNC(el, e) {
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY, r0 = el.getBoundingClientRect(), gx = sx - r0.left, gy = sy - r0.top;
  let moving = false;
  const mv = (ev) => {
    if (!moving && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
    moving = true; el.classList.add('nc-dragging');
    const over = document.elementsFromPoint(ev.clientX, ev.clientY).map((x) => x.closest?.('[data-nc]')).find((x) => x && x !== el);
    if (over && over.parentNode === el.parentNode) { const kids = [...el.parentNode.children]; el.parentNode.insertBefore(el, kids.indexOf(el) < kids.indexOf(over) ? over.nextSibling : over); }
    el.style.transform = ''; const r = el.getBoundingClientRect();
    el.style.transform = `translate(${ev.clientX - gx - r.left}px, ${ev.clientY - gy - r.top}px)`;
  };
  const up = () => {
    removeEventListener('mousemove', mv, true); removeEventListener('mouseup', up, true);
    el.classList.remove('nc-dragging'); el.style.transform = '';
    if (!moving) return;
    const old = ncList();
    store.set('ncWidgets', [...el.parentNode.querySelectorAll('[data-nc]')].map((x) => old[+x.dataset.nc]));
    renderNC();
  };
  addEventListener('mousemove', mv, true); addEventListener('mouseup', up, true);
}

export function toggleNotificationCenter(force) {
  const open = force ?? !nc.classList.contains('open');
  if (!open) ncEditing = false;
  if (open) renderNC();
  nc.classList.toggle('open', open);
}

export function initNotifications() {
  nc = h('div#nc');
  nc.addEventListener('mousedown', (e) => e.stopPropagation());
  document.body.append(nc);
  document.addEventListener('mousedown', (e) => { if (nc.classList.contains('open') && !e.target.closest('#menubar') && !e.target.closest('.menu')) toggleNotificationCenter(false); });
}
