// Session bridge: in session mode the real windows live in the X11 window manager (main/wm.js).
// This swaps the in-page window manager for proxies, so the Dock, menu bar, App Switcher and Mission Control
// work exactly as in the testing window — just on real windows, native Linux apps included.
import { wm, registry } from './wm.js';
import { h, $, $$, bus } from './util.js';
import { api } from './sys.js';
import { session as S, layer } from './layer.js';
import { catalog } from './catalog.js';
import { store, dockReserve } from './store.js';
import { appIcon, sym } from './icons.js';
import { showMenu } from './menus.js';
import { wallpaperFor } from './theme.js';

/* ------------------------------------------------------------------ app identity of a native window */
const synth = new Map();
function nativeApp(info) {
  const [inst = '', cls = ''] = info.wmClass || [];
  const keys = [cls, inst].filter(Boolean).map((s) => s.toLowerCase());
  const found = catalog.native.find((a) => {
    const base = a.id.replace(/^desktop:/, '').replace(/\.desktop$/, '').toLowerCase();
    const exe = (a.exec || '').split(/\s+/)[0].split('/').pop().toLowerCase();
    return keys.some((k) => k === (a.wmClass || '').toLowerCase() || k === base || base.endsWith('.' + k) || k === exe || k === a.name.toLowerCase());
  });
  if (found) return found;
  const id = 'x11:' + (keys[0] || 'window');
  if (!synth.has(id)) {
    const name = (cls || inst || info.title || 'App').replace(/[-_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const app = { id, name, builtin: false, icon: null, exec: null, categories: [], keywords: [] };
    synth.set(id, app);
    catalog.extra.set(id, app);
    // a launcher entry named after the window's class that isn't in the app list (hidden ones, like Android's
    // Clock): its real name and icon; otherwise an icon from the theme
    (api.apps.byId ? api.apps.byId(cls || inst) : Promise.resolve(null)).then((e) => {
      if (e) { Object.assign(app, { name: e.name, icon: e.icon, exec: e.exec, terminal: e.terminal }); bus.emit('catalog'); return; }
      return api.apps.iconFor(inst || cls).then((icon) => { if (icon) { app.icon = icon; bus.emit('catalog'); } });
    }).catch(() => {});
  }
  return synth.get(id);
}

function remoteMenus(info) {
  if (!info.menus) return undefined;
  const conv = (items) => items.map((it) => (it === '-' || it.sep ? '-' : it.header ? it : {
    label: it.label, shortcut: it.shortcut, checked: it.checked, disabled: it.disabled,
    submenu: it.submenu ? conv(it.submenu) : undefined, action: () => S.send('wm:menuAction', info.id, it.id),
  }));
  return () => info.menus.map((m) => ({ title: m.title, items: conv(m.items) }));
}

/* ------------------------------------------------------------------ window proxies */
class RemoteWin {
  constructor(info) { this.update(info); }
  update(info) {
    Object.assign(this, info);
    if (info.kind === 'app') {
      const def = registry.get(info.appId) || { id: info.appId, name: info.appId, builtin: true };
      const menus = remoteMenus(info);
      this.app = menus ? { ...def, menus } : { ...def, menus: undefined };
    } else this.app = nativeApp(info);
  }
  focus() { S.send('wm:activate', this.id); }
  blur() {}
  close() { S.send('wm:close', this.id); }
  minimize() { S.send('wm:minimize', this.id); }
  restore() { S.send('wm:restore', this.id); }
  toggleMaximize() { S.send('wm:toggleMaximize', this.id); }
  tileTo(kind) { S.send('wm:tile', this.id, kind); }
  toggleFullscreen() { S.send('wm:fullscreen', this.id); }
  zoom(mode = store.get('zoomAction') || 'fill') { S.send('wm:zoom', this.id, mode); }
}

let state = { windows: [], space: 0, spaces: store.get('spaces') || 2 };
const proxies = new Map();

function apply(st) {
  state = st;
  const seen = new Set();
  for (const info of st.windows) {
    seen.add(info.id);
    if (proxies.has(info.id)) proxies.get(info.id).update(info); else proxies.set(info.id, new RemoteWin(info));
  }
  for (const id of [...proxies.keys()]) if (!seen.has(id)) proxies.delete(id);
  const list = [...proxies.values()];
  const prevFocus = wm.focused;
  wm.windows = list.sort((a, b) => a.id - b.id);
  wm.mru = [...list].sort((a, b) => b.z - a.z);
  wm.focused = list.find((w) => w.focused) || null;
  wm.currentSpace = st.space;
  bus.emit('windows');
  if (prevFocus !== wm.focused) bus.emit('focus', wm.focused);
}

/* ------------------------------------------------------------------ Mission Control on real windows */
async function mission() {
  if (wm.missionOpen) return closeMission();
  wm.missionOpen = true;
  const layerEl = h('div#mission');
  const bar = h('div.spaces-bar');
  layerEl.append(bar);
  document.body.append(layerEl);
  const draw = (thumbs) => {
    bar.innerHTML = '';
    for (let i = 0; i < state.spaces; i++) {
      const t = h('div.space-thumb' + (i === state.space ? '.cur' : ''), h('div.pv', { style: { backgroundImage: `url("${wallpaperFor(300, 168)}")` } }), h('span', `Desktop ${i + 1}`));
      t.addEventListener('click', (e) => { e.stopPropagation(); S.send('wm:switchSpace', i); setTimeout(() => refresh(), 150); });
      bar.append(t);
    }
    bar.append(h('button.space-add', { onclick: (e) => { e.stopPropagation(); wm.addSpace(); setTimeout(refresh, 100); } }, '+'));
    $$('.mc-win', layerEl).forEach((x) => x.remove());
    const wins = wm.windows.filter((w) => w.space === state.space && !w.minimized);
    const top = 140, pad = 40, W = innerWidth - pad * 2, H = innerHeight - top - 60, n = wins.length;
    if (!n) return;
    const cols = Math.ceil(Math.sqrt(n * (W / H) / 1.4)), rows = Math.ceil(n / cols), cw = W / cols, ch = H / rows;
    wins.forEach((w, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      const inRow = r === rows - 1 ? n - r * cols : cols;
      const s = Math.min(1, (cw - 40) / w.w, (ch - 60) / w.h);
      const el = h('div.mc-win', { style: { position: 'absolute', width: w.w * s + 'px', height: w.h * s + 'px', borderRadius: '12px', overflow: 'hidden',
        left: pad + (cols - inRow) * cw / 2 + c * cw + (cw - w.w * s) / 2 + 'px', top: top + r * ch + (ch - w.h * s) / 2 + 'px',
        boxShadow: '0 12px 40px rgba(0,0,0,.45)', background: thumbs[w.id] ? `center/cover url("${thumbs[w.id]}")` : 'var(--win-bg)', transition: 'transform .2s var(--spring)' } },
        h('div.mc-label.glass.panel', { style: { left: '50%', top: 'calc(100% + 8px)', opacity: 1 } }, appIcon(w.app, 'icon'), w.title));
      el.querySelector('.mc-label').style.position = 'absolute';
      el.style.overflow = 'visible';
      el.addEventListener('mouseenter', () => (el.style.transform = 'scale(1.03)'));
      el.addEventListener('mouseleave', () => (el.style.transform = ''));
      el.addEventListener('click', (e) => { e.stopPropagation(); closeMission(); w.focus(); });
      layerEl.append(el);
    });
  };
  const refresh = async () => { let th = {}; try { th = await S.invoke('wm:thumbnails'); } catch { /* no capture */ } if (wm.missionOpen) draw(th); };
  layerEl.addEventListener('click', () => closeMission());
  draw({});
  refresh();
  bus.emit('mission', true);
}
function closeMission() {
  if (!wm.missionOpen) return;
  wm.missionOpen = false;
  const l = $('#mission');
  if (l) { l.classList.add('closing'); setTimeout(() => l.remove(), 280); }
  bus.emit('mission', false);
}

/* ------------------------------------------------------------------ window menu / tile menu (from native frames) */
export function windowMenu(id, x, y, kind) {
  const w = proxies.get(id);
  if (!w) return;
  const tiles = [['Fill', 'fill'], ['Center', 'center'], '-', ['Left', 'left'], ['Right', 'right'], ['Top Left', 'tl'], ['Top Right', 'tr'], ['Bottom Left', 'bl'], ['Bottom Right', 'br']]
    .map((t) => (t === '-' ? '-' : { label: t[0], action: () => w.tileTo(t[1]) }));
  const spaces = Array.from({ length: state.spaces }, (_, i) => ({ label: `Desktop ${i + 1}`, checked: i === w.space, action: () => S.send('wm:moveToSpace', w.id, i) }));
  showMenu(kind === 'tile' ? [{ header: 'Move & Resize' }, ...tiles, '-', { label: w.fullscreen ? 'Exit Full Screen' : 'Enter Full Screen', action: () => w.toggleFullscreen() }, { label: 'Move to Desktop', submenu: spaces }]
    : [{ label: 'Minimize', action: () => w.minimize() }, { label: w.maximized ? 'Restore' : 'Zoom', action: () => w.toggleMaximize() },
      { label: 'Move & Resize', submenu: tiles.filter((t) => t !== '-') }, { label: 'Move to Desktop', submenu: spaces }, '-', { label: 'Close', action: () => w.close() }], x, y);
}

/* ------------------------------------------------------------------ install */
export async function installSessionWM() {
  Object.defineProperty(wm, 'spaceEls', { get: () => Array.from({ length: state.spaces }), configurable: true });
  Object.assign(wm, {
    windows: [], mru: [], focused: null, currentSpace: 0, missionOpen: false,
    init() {},
    open(appId, args = {}) {
      const app = registry.get(appId);
      if (!app) return null;
      if (app.singleton) {
        const existing = wm.windows.find((w) => w.kind === 'app' && w.appId === appId);
        if (existing) { S.send('wm:reopen', existing.id, args); existing.focus(); return existing; }
      }
      S.send('wm:openApp', appId, args, { size: app.size, minSize: app.minSize, resizable: app.resizable, name: app.name });
      bus.emit('app-launched', appId);
      return null;
    },
    activate(appId, args) {
      const ws = wm.mru.filter((w) => w.app.id === appId);
      if (!ws.length) return wm.open(appId, args);
      const w = ws.find((x) => !x.minimized && x.space === state.space) || ws.find((x) => !x.minimized) || ws[0];
      w.focus();
      return w;
    },
    quitApp(appId) { for (const w of wm.windows.filter((x) => x.app.id === appId)) w.close(); },
    appWindows(appId) { return wm.windows.filter((w) => w.app.id === appId); },
    runningApps() { const ids = []; for (const w of wm.windows) if (!ids.includes(w.app.id)) ids.push(w.app.id); return ids; },
    focusNext() {},
    hideOthers() { for (const w of wm.windows) if (wm.focused && w.app.id !== wm.focused.app.id) w.minimize(); },
    toggleDesktop() { S.send('wm:toggleDesktop'); },
    switchSpace(i) { S.send('wm:switchSpace', i); },
    addSpace() { const n = state.spaces + 1; store.set('spaces', n); S.send('wm:setSpaces', n); },
    removeSpace() { const n = Math.max(1, state.spaces - 1); store.set('spaces', n); S.send('wm:setSpaces', n); },
    moveToSpace(w, i) { S.send('wm:moveToSpace', w.id, i); },
    spaceNames() { return Array.from({ length: state.spaces }, (_, i) => `Desktop ${i + 1}`); },
    workArea() { return { x: 0, y: 30, w: innerWidth, h: innerHeight - 30 - dockReserve() }; },
    mission, closeMission,
  });
  S.on('session:windows', apply);
  if (layer === 'shell' || layer === 'desktop') {
    S.send('wm:setSpaces', store.get('spaces') || 2);
    try { apply(await S.invoke('wm:state')); } catch { /* WM not ready yet */ }
  }
}
