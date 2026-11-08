// Notifications: banners + Notification Center (history and widgets).
import { h, $, bus, timeAgo } from './util.js';
import { appIcon, sym } from './icons.js';
import { store } from './store.js';
import { buildWidget } from './widgets.js';
import { catalog } from './catalog.js';
import { attachLens } from './theme.js';

const history = [];

function card(n, cls, onClose) {
  const app = catalog.find(n.app) || { id: n.app || 'about', builtin: true, name: n.appName || 'System' };
  const el = h(`div.${cls}.glass.panel.sheen`,
    h('button.x', { html: sym.close, onclick: (e) => { e.stopPropagation(); onClose(); } }),
    h('div.ic', appIcon(app)),
    h('div.body', h('div.top', h('b', n.title), h('time', cls === 'toast' ? 'now' : timeAgo(n.time))), n.body ? h('p', n.body) : null));
  el.addEventListener('click', () => { n.action?.(); onClose(); });
  return el;
}

export function notify(n) {
  n = { time: Date.now(), ...n };
  history.unshift(n);
  if (history.length > 50) history.pop();
  bus.emit('notifications');
  if (store.get('dnd')) return;
  const host = $('#toasts');
  const t = card(n, 'toast', () => dismiss());
  const dismiss = () => { if (!t.isConnected) return; t.classList.add('out'); setTimeout(() => t.remove(), 350); };
  host.prepend(t);
  let timer = setTimeout(dismiss, n.timeout || 5500);
  t.addEventListener('mouseenter', () => clearTimeout(timer));
  t.addEventListener('mouseleave', () => (timer = setTimeout(dismiss, 2500)));
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
