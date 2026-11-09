// System tray: icons of apps running in the background (Discord, OBS, Steam, Nextcloud…) in the menu bar,
// like Plasma's system tray. Uses the StatusNotifierItem protocol on the D-Bus session bus:
//   • if nobody else does, LiquidDesktop is the StatusNotifierWatcher (apps register their icons with it)
//   • otherwise (testing in a window on another desktop) it joins the existing watcher as a host
// Menus come over com.canonical.dbusmenu. Everything reaches the web UI as plain data.
const { ipcMain, webContents, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

let dbus;
try { dbus = require('dbus-next'); } catch { dbus = null; }

const WATCHER = 'org.kde.StatusNotifierWatcher', W_PATH = '/StatusNotifierWatcher';
const ITEM_IFACES = ['org.kde.StatusNotifierItem', 'org.freedesktop.StatusNotifierItem'];
const items = new Map();   // key "busName/path" → { key, bus, path, iface, props, icon, … }
let bus = null, resolveIcon = () => null, pushTimer = null;

function broadcast() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    const list = [...items.values()].filter((i) => i.status !== 'Passive').map((i) => ({ key: i.key, id: i.id, title: i.title, tooltip: i.tooltip, icon: i.icon, status: i.status, hasMenu: !!i.menuPath, itemIsMenu: i.itemIsMenu }));
    for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.getType() !== 'webview') wc.send('tray:items', list);
  }, 60);
}

/* ------------------------------------------------------------------ icons */
// IconPixmap: [w, h, ARGB32 bytes in network order]. Pick the size closest to 44px and make a PNG.
function pixmapToDataUrl(pixmaps) {
  if (!Array.isArray(pixmaps) || !pixmaps.length) return null;
  const best = [...pixmaps].filter((p) => p[0] > 0 && p[1] > 0).sort((a, b) => Math.abs(a[0] - 44) - Math.abs(b[0] - 44))[0];
  if (!best) return null;
  const [w, h, argb] = best;
  const bgra = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = argb[i * 4], r = argb[i * 4 + 1], g = argb[i * 4 + 2], b = argb[i * 4 + 3];
    bgra[i * 4] = b; bgra[i * 4 + 1] = g; bgra[i * 4 + 2] = r; bgra[i * 4 + 3] = a;
  }
  return nativeImage.createFromBitmap(bgra, { width: w, height: h }).toDataURL();
}
function nameToDataUrl(name, themePath) {
  if (!name) return null;
  let file = null;
  if (name.startsWith('/')) file = name;
  else if (themePath) {
    for (const ext of ['.svg', '.png']) {
      for (const sub of ['', 'hicolor/scalable/apps', 'hicolor/48x48/apps', 'hicolor/32x32/apps', 'hicolor/24x24/apps', 'hicolor/22x22/apps']) {
        const f = path.join(themePath, sub, name + ext);
        if (fs.existsSync(f)) { file = f; break; }
      }
      if (file) break;
    }
  }
  file = file || resolveIcon(name);
  if (!file) return null;
  try {
    const buf = fs.readFileSync(file);
    return `data:${file.endsWith('.svg') ? 'image/svg+xml' : 'image/png'};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

/* ------------------------------------------------------------------ items */
// Many apps (Chromium/Electron ones included) don't answer Introspect, so items and menus are called with
// raw messages rather than proxy objects.
function call(destination, objPath, iface, member, signature = '', body = []) {
  return bus.call(new dbus.Message({ destination, path: objPath, interface: iface, member, signature, body })).then((r) => r?.body || []);
}
const unwrap = (v) => (v && typeof v === 'object' && 'value' in v && 'signature' in v ? v.value : v);
async function refresh(item) {
  let props = {};
  try { [props] = await call(item.bus, item.path, 'org.freedesktop.DBus.Properties', 'GetAll', 's', [item.iface]); } catch { return; }
  props = props || {};
  const p = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, unwrap(v)]));
  item.id = p.Id || item.bus;
  item.status = p.Status || 'Active';
  const tip = p.ToolTip;   // (icon name, icon pixmaps, title, text)
  item.title = p.Title || (Array.isArray(tip) ? tip[2] : '') || item.id;
  item.tooltip = Array.isArray(tip) ? [tip[2], tip[3]].filter(Boolean).join(' — ').replace(/<[^>]+>/g, '') : item.title;
  item.menuPath = p.Menu && p.Menu !== '/' ? p.Menu : null;
  item.itemIsMenu = !!p.ItemIsMenu;
  const attention = item.status === 'NeedsAttention';
  item.icon = (attention && (pixmapToDataUrl(p.AttentionIconPixmap) || nameToDataUrl(p.AttentionIconName, p.IconThemePath)))
    || nameToDataUrl(p.IconName, p.IconThemePath) || pixmapToDataUrl(p.IconPixmap) || null;
  broadcast();
}

async function addItem(service, sender) {
  // apps register "busname", "busname/path" or just "/path" (meaning: on the sender's connection)
  let busName = service, objPath = '/StatusNotifierItem';
  if (service.startsWith('/')) { busName = sender; objPath = service; }
  else if (service.includes('/')) { const i = service.indexOf('/'); busName = service.slice(0, i); objPath = service.slice(i); }
  const key = busName + objPath;
  if (items.has(key)) return key;
  // which flavour of the interface does it speak?
  let iface = null;
  for (const n of ITEM_IFACES) {
    try { await call(busName, objPath, 'org.freedesktop.DBus.Properties', 'Get', 'ss', [n, 'Id']); iface = n; break; } catch { /* try the next */ }
  }
  if (!iface) return null;
  let owner = busName;
  if (!busName.startsWith(':')) { try { [owner] = await call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner', 's', [busName]); } catch { /* keep the name */ } }
  const item = { key, bus: busName, owner, path: objPath, iface };
  items.set(key, item);
  // its signals (NewIcon, NewTitle, NewStatus…) tell us to read the properties again
  try { await call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'AddMatch', 's', [`type='signal',sender='${busName}',path='${objPath}'`]); } catch { /* no live updates */ }
  await refresh(item);
  return key;
}
function removeOwner(name) {
  let changed = false;
  for (const [k, it] of items) if (it.bus === name || it.owner === name) { items.delete(k); changed = true; watcherIface?.emitUnregistered(k); }
  if (changed) broadcast();
}

/* ------------------------------------------------------------------ the watcher (when nobody else is) */
let watcherIface = null;
function makeWatcher() {
  const { Interface, method, property, signal } = dbus.interface;
  class Watcher extends Interface {
    get RegisteredStatusNotifierItems() { return [...items.keys()]; }
    get IsStatusNotifierHostRegistered() { return true; }
    get ProtocolVersion() { return 0; }
    async RegisterStatusNotifierItem(service) {
      const sender = this.__sender || '';
      const key = await addItem(service, sender);
      if (key) this.StatusNotifierItemRegistered(key);
    }
    RegisterStatusNotifierHost() { this.StatusNotifierHostRegistered(); }
    StatusNotifierItemRegistered(s) { return s; }
    StatusNotifierItemUnregistered(s) { return s; }
    StatusNotifierHostRegistered() {}
    emitUnregistered(k) { this.StatusNotifierItemUnregistered(k); }
  }
  Watcher.configureMembers({
    properties: { RegisteredStatusNotifierItems: { signature: 'as', access: 'read' }, IsStatusNotifierHostRegistered: { signature: 'b', access: 'read' }, ProtocolVersion: { signature: 'i', access: 'read' } },
    methods: { RegisterStatusNotifierItem: { inSignature: 's', outSignature: '' }, RegisterStatusNotifierHost: { inSignature: 's', outSignature: '' } },
    signals: { StatusNotifierItemRegistered: { signature: 's' }, StatusNotifierItemUnregistered: { signature: 's' }, StatusNotifierHostRegistered: { signature: '' } },
  });
  void method; void property; void signal;
  return new Watcher(WATCHER);
}

/* ------------------------------------------------------------------ menus (com.canonical.dbusmenu) */
function convertLayout(node) {
  const [id, props, children] = node;
  const p = Object.fromEntries(Object.entries(props || {}).map(([k, v]) => [k, unwrap(v)]));
  if (p.visible === false) return null;
  if (p.type === 'separator') return { sep: true };
  return { id, label: String(p.label || '').replace(/_(?!_)/g, '').replace(/__/g, '_'), enabled: p.enabled !== false,
    toggle: p['toggle-type'] || null, checked: p['toggle-state'] === 1,
    children: (children || []).map((c) => convertLayout(unwrap(c))).filter(Boolean) };
}
async function getMenu(key) {
  const it = items.get(key);
  if (!it?.menuPath) return null;
  try { await call(it.bus, it.menuPath, 'com.canonical.dbusmenu', 'AboutToShow', 'i', [0]); } catch { /* optional */ }
  const [, layout] = await call(it.bus, it.menuPath, 'com.canonical.dbusmenu', 'GetLayout', 'iias', [0, -1, []]);
  return convertLayout(layout)?.children || [];
}
async function menuEvent(key, id) {
  const it = items.get(key);
  if (!it?.menuPath) return;
  await call(it.bus, it.menuPath, 'com.canonical.dbusmenu', 'Event', 'isvu', [id, 'clicked', new dbus.Variant('s', ''), Math.floor(Date.now() / 1000)]);
}

/* ------------------------------------------------------------------ start */
async function start(opts = {}) {
  if (!dbus || !process.env.DBUS_SESSION_BUS_ADDRESS) return;
  if (opts.resolveIcon) resolveIcon = opts.resolveIcon;
  try { bus = dbus.sessionBus(); } catch { return; }
  bus.on('error', () => {});

  const dbusObj = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
  const DBus = dbusObj.getInterface('org.freedesktop.DBus');
  DBus.on('NameOwnerChanged', (name, oldOwner, newOwner) => { if (oldOwner && !newOwner) removeOwner(name); });

  bus.on('message', (msg) => {
    if (msg.type !== dbus.MessageType.SIGNAL || !/^New/.test(msg.member || '')) return;
    for (const it of items.values()) if (it.path === msg.path && (it.bus === msg.sender || it.owner === msg.sender)) refresh(it);
  });
  // the watcher needs to know who is calling RegisterStatusNotifierItem("/path")
  bus.on('message', (msg) => { if (watcherIface && msg.member === 'RegisterStatusNotifierItem') watcherIface.__sender = msg.sender; });

  let own = 0;
  try { own = await bus.requestName(WATCHER, 4 /* DO_NOT_QUEUE */); } catch { own = 0; }
  if (own === 1) {
    watcherIface = makeWatcher();
    bus.export(W_PATH, watcherIface);
  } else {
    // join the existing watcher as a host
    try {
      const hostName = `org.kde.StatusNotifierHost-${process.pid}-1`;
      await bus.requestName(hostName, 4);
      const wObj = await bus.getProxyObject(WATCHER, W_PATH);
      const w = wObj.getInterface(WATCHER);
      w.on('StatusNotifierItemRegistered', (s) => addItem(s, ''));
      w.on('StatusNotifierItemUnregistered', (s) => { for (const [k, it] of items) if (k === s || it.bus + it.path === s || it.bus === s.split('/')[0]) items.delete(k); broadcast(); });
      try { await w.RegisterStatusNotifierHost(hostName); } catch { /* fine */ }
      const props = wObj.getInterface('org.freedesktop.DBus.Properties');
      const reg = unwrap(await props.Get(WATCHER, 'RegisteredStatusNotifierItems')) || [];
      for (const s of reg) await addItem(s, '');
    } catch { /* no watcher after all */ }
  }
}

function register(opts) {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (err) { return { __error: String(err.message || err) }; } });
  h('tray:list', () => [...items.values()].filter((i) => i.status !== 'Passive').map((i) => ({ key: i.key, id: i.id, title: i.title, tooltip: i.tooltip, icon: i.icon, status: i.status, hasMenu: !!i.menuPath, itemIsMenu: i.itemIsMenu })));
  h('tray:activate', async (key, x, y, secondary) => { const it = items.get(key); if (it) await call(it.bus, it.path, it.iface, secondary ? 'SecondaryActivate' : 'Activate', 'ii', [Math.round(x), Math.round(y)]); return true; });
  h('tray:contextMenu', async (key, x, y) => { const it = items.get(key); if (it) await call(it.bus, it.path, it.iface, 'ContextMenu', 'ii', [Math.round(x), Math.round(y)]); return true; });
  h('tray:menu', (key) => getMenu(key));
  h('tray:event', (key, id) => menuEvent(key, id));
  start(opts).catch((e) => console.error('[tray]', e.message));
}

module.exports = { register };
