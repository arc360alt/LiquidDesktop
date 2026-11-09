// Notifications: banners + Notification Center (history and widgets).
import { h, $, bus, timeAgo } from './util.js';
import { appIcon, sym } from './icons.js';
import { api } from './sys.js';
import { store } from './store.js';
import { buildWidget } from './widgets.js';
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
  nc.innerHTML = '';
  nc.append(h('div.nc-head', h('span', 'Notifications'), history.length ? h('button.glass.panel', { onclick: () => { history.length = 0; renderNC(); } }, 'Clear All') : null));
  if (!history.length) nc.append(h('div.nc-empty', 'No Notifications'));
  history.forEach((n, i) => nc.append(card(n, 'notif', () => { history.splice(i, 1); renderNC(); })));
  nc.append(h('div.nc-head', { style: { marginTop: '6px' } }, h('span', 'Widgets')));
  const grid = h('div.nc-widgets', buildWidget('upcoming'), buildWidget('calendar'), buildWidget('weather'), buildWidget('system'), buildWidget('clock'));
  nc.append(grid);
  nc.append(h('button.nc-edit.glass.panel', { onclick: () => { toggleNotificationCenter(false); import('./desktop.js').then((m) => m.editWidgets()); } }, 'Edit Widgets'));
}

export function toggleNotificationCenter(force) {
  const open = force ?? !nc.classList.contains('open');
  if (open) renderNC();
  nc.classList.toggle('open', open);
}

export function initNotifications() {
  nc = h('div#nc');
  nc.addEventListener('mousedown', (e) => e.stopPropagation());
  document.body.append(nc);
  document.addEventListener('mousedown', (e) => { if (nc.classList.contains('open') && !e.target.closest('#menubar')) toggleNotificationCenter(false); });
}
