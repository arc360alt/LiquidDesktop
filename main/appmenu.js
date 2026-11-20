// Global menu bar: Linux apps' own menus (File, Edit, View…) shown in LiquidDesktop's menu bar, like on a Mac.
// Apps publish their menu bar over D-Bus (com.canonical.dbusmenu) and tell the "AppMenu registrar" which window
// it belongs to. LiquidDesktop is that registrar in its session, so they do it for us:
//   • Qt / KDE apps (built into Qt), Chromium and Electron apps (built in), GTK 2/3 apps with appmenu-gtk-module
//   • KDE apps that only set _KDE_NET_WM_APPMENU_SERVICE_NAME / _OBJECT_PATH on their window are read too
// An app that finds a registrar hides its own menu bar, so this can be turned off (Settings › Menu Bar); apps
// started after that keep their menus in their windows again.
const { ipcMain, webContents, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
let dbus = null;
try { dbus = require('dbus-next'); } catch { dbus = null; }

const REG = 'com.canonical.AppMenu.Registrar', REG_PATH = '/com/canonical/AppMenu/Registrar', MENU = 'com.canonical.dbusmenu';
const menus = new Map();   // X window id → { service, path }
let bus = null, wm = null, owned = false, resolveIcon = () => null;

const cfgDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(require('os').homedir(), '.config'), 'LiquidDesktop');
// a file, so the session script can see it too (it loads appmenu-gtk-module for GTK apps only when this is on)
const OFF = () => path.join(cfgDir(), 'global-menu-off');
const enabled = () => !fs.existsSync(OFF());

const unwrap = (v) => (v instanceof dbus.Variant ? unwrap(v.value) : v);
const call = (dest, objPath, iface, member, signature = '', body = []) =>
  bus.call(new dbus.Message({ destination: dest, path: objPath, interface: iface, member, signature, body })).then((r) => r?.body || []);
const busCall = (member, signature = '', body = []) => call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', member, signature, body);
const send = (ch, ...a) => { for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.getType() !== 'webview') wc.send(ch, ...a); };

function windowOf(xid) { return wm?.byXid?.get(xid) || [...(wm?.windows?.values() || [])].find((w) => w.client === xid) || null; }
function changed(xid) {
  const w = windowOf(xid);
  if (w) { wm.changed(w); send('appmenu:changed', w.id); }
}

/* ------------------------------------------------------------------ the registrar */
function makeRegistrar() {
  const { Interface } = dbus.interface;
  class Registrar extends Interface {
    RegisterWindow(windowId, menuPath) {
      const service = this.__sender;
      if (!service) return;
      menus.set(windowId, { service, path: menuPath });
      watch(service);
      this.WindowRegistered(windowId, service, menuPath);
      changed(windowId);
    }
    UnregisterWindow(windowId) { if (menus.delete(windowId)) { this.WindowUnregistered(windowId); changed(windowId); } }
    GetMenuForWindow(windowId) { const m = menus.get(windowId); return m ? [m.service, m.path] : ['', '/']; }
    GetMenus() { return [...menus.entries()].map(([id, m]) => [id, m.service, m.path]); }
    WindowRegistered(id, service, p) { return [id, service, p]; }
    WindowUnregistered(id) { return id; }
  }
  Registrar.configureMembers({
    methods: {
      RegisterWindow: { inSignature: 'uo', outSignature: '' }, UnregisterWindow: { inSignature: 'u', outSignature: '' },
      GetMenuForWindow: { inSignature: 'u', outSignature: 'so' }, GetMenus: { inSignature: '', outSignature: 'a(uso)' },
    },
    signals: { WindowRegistered: { signature: 'uso' }, WindowUnregistered: { signature: 'u' } },
  });
  return new Registrar(REG);
}

// live updates from an app's menu (items added, enabled, checked…)
const watched = new Set();
function watch(service) {
  if (watched.has(service)) return;
  watched.add(service);
  busCall('AddMatch', 's', [`type='signal',sender='${service}',interface='${MENU}'`]).catch(() => {});
}

/* ------------------------------------------------------------------ KDE's window properties */
const atoms = {};
const intern = (name) => atoms[name] || (atoms[name] = new Promise((res) => wm.X.InternAtom(false, name, (e, a) => res(e ? 0 : a))));
async function kdeProps(xid) {
  if (!wm?.X) return null;
  const [sa, pa] = await Promise.all([intern('_KDE_NET_WM_APPMENU_SERVICE_NAME'), intern('_KDE_NET_WM_APPMENU_OBJECT_PATH')]);
  if (!sa || !pa) return null;
  const [s, p] = await Promise.all([wm.getProp(xid, sa), wm.getProp(xid, pa)]);
  const service = s?.data?.toString('utf8').replace(/\0+$/, ''), objPath = p?.data?.toString('utf8').replace(/\0+$/, '');
  return service && objPath ? { service, path: objPath } : null;
}
// read once per window (the properties are set before the window is shown)
function checkKde(w) {
  if (!w.kdeMenuP) w.kdeMenuP = kdeProps(w.client).catch(() => null).then((m) => { w.kdeMenu = m; if (m) { watch(m.service); wm.changed(w); } return m; });
  return w.kdeMenuP;
}
/** The menu of a window: registered with us, or announced on the window itself. */
async function menuFor(id) {
  const w = wm?.windows?.get(id);
  if (!w || w.kind !== 'native' || !enabled()) return null;
  const m = menus.get(w.client);
  if (m) return m;
  return checkKde(w);
}

/* ------------------------------------------------------------------ reading a menu */
const KEY = { Control: '⌃', Shift: '⇧', Alt: '⌥', Super: '⌘', Meta: '⌘' };
const KEYNAME = { Return: '↩', Enter: '↩', Delete: '⌦', BackSpace: '⌫', Backspace: '⌫', Escape: '⎋', Tab: '⇥', Left: '←', Right: '→', Up: '↑', Down: '↓', space: 'Space', plus: '+', minus: '-', equal: '=', comma: ',', period: '.', slash: '/', Page_Up: '⇞', Page_Down: '⇟', Home: '↖', End: '↘' };
function shortcut(sc) {
  const first = Array.isArray(sc) ? sc[0] : null;
  if (!Array.isArray(first) || !first.length) return undefined;
  return first.map((k) => KEY[k] || KEYNAME[k] || (k.length === 1 ? k.toUpperCase() : k)).join('');
}
const iconCache = new Map();
function icon(p) {
  if (p['icon-data']?.length) {
    try { return nativeImage.createFromBuffer(Buffer.from(p['icon-data'])).resize({ width: 16, height: 16 }).toDataURL(); } catch { /* bad image */ }
  }
  const name = p['icon-name'];
  if (!name) return undefined;
  if (!iconCache.has(name)) {
    let url = null;
    const f = resolveIcon(name);
    try { if (f) url = `data:${f.endsWith('.svg') ? 'image/svg+xml' : 'image/png'};base64,${fs.readFileSync(f).toString('base64')}`; } catch { url = null; }
    iconCache.set(name, url);
  }
  return iconCache.get(name) || undefined;
}
function convert(node, depth = 0) {
  const [id, raw, children] = node;
  const p = Object.fromEntries(Object.entries(raw || {}).map(([k, v]) => [k, unwrap(v)]));
  if (p.visible === false) return null;
  if (p.type === 'separator') return { sep: true };
  const kids = (children || []).map((c) => convert(unwrap(c), depth + 1)).filter(Boolean);
  // trailing / doubled separators make empty-looking gaps
  const tidy = kids.filter((k, i, a) => !(k.sep && (i === 0 || i === a.length - 1 || a[i - 1]?.sep)));
  return {
    id, label: String(p.label ?? '').replace(/_(?!_)/g, '').replace(/__/g, '_'), enabled: p.enabled !== false,
    toggle: p['toggle-type'] || null, checked: p['toggle-state'] === 1, shortcut: shortcut(p.shortcut),
    icon: depth > 1 ? icon(p) : undefined, submenu: p['children-display'] === 'submenu' || tidy.length > 0, children: tidy,
  };
}
async function layout(id, parent = 0) {
  const m = await menuFor(id);
  if (!m) return null;
  // a menu about to open fills itself in (Qt and GTK build submenus lazily)
  await call(m.service, m.path, MENU, 'AboutToShow', 'i', [parent]).catch(() => {});
  const [, tree] = await call(m.service, m.path, MENU, 'GetLayout', 'iias', [parent, -1, []]);
  const root = convert(tree);
  return root?.children || [];
}
async function event(id, itemId, kind = 'clicked') {
  const m = await menuFor(id);
  if (!m) return false;
  await call(m.service, m.path, MENU, 'Event', 'isvu', [itemId, kind, new dbus.Variant('s', ''), Math.floor(Date.now() / 1000)]);
  return true;
}

/* ------------------------------------------------------------------ start */
async function own() {
  if (owned || !enabled()) return;
  const r = await bus.requestName(REG, 4 /* DO_NOT_QUEUE */).catch(() => 0);
  if (r !== 1) { console.log('[appmenu] another app menu registrar is running: not taking over'); return; }
  owned = true;
  const reg = makeRegistrar();
  bus.export(REG_PATH, reg);
  bus.on('message', (msg) => { if (msg.member === 'RegisterWindow' && msg.path === REG_PATH) reg.__sender = msg.sender; });
}

async function start() {
  if (!dbus || !process.env.DBUS_SESSION_BUS_ADDRESS) return;
  try { bus = dbus.sessionBus(); } catch { return; }
  bus.on('error', () => {});
  await busCall('AddMatch', 's', ["type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged'"]).catch(() => {});
  bus.on('message', (msg) => {
    if (msg.type !== dbus.MessageType.SIGNAL) return;
    if (msg.member === 'NameOwnerChanged') {
      const [name, , now] = msg.body || [];
      if (now || !name?.startsWith(':')) return;
      for (const [xid, m] of [...menus]) if (m.service === name) { menus.delete(xid); changed(xid); }
      watched.delete(name);
      return;
    }
    if (msg.interface !== MENU || !['LayoutUpdated', 'ItemsPropertiesUpdated'].includes(msg.member)) return;
    // which window's menu changed
    for (const w of wm?.windows?.values() || []) {
      const m = menus.get(w.client) || w.kdeMenu;
      if (m && m.service === msg.sender && m.path === msg.path) send('appmenu:changed', w.id);
    }
  });
  await own();
}

/** Called by the window manager's snapshot: does this window have its own menus to show? */
function hasMenu(w) { return w.kind === 'native' && owned && (menus.has(w.client) || !!w.kdeMenu); }

function register(opts = {}) {
  wm = opts.wm || null;
  if (opts.resolveIcon) resolveIcon = opts.resolveIcon;
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (err) { return { __error: String(err.message || err) }; } });
  h('appmenu:layout', (id, parent) => layout(id, parent || 0));
  h('appmenu:event', (id, itemId, kind) => event(id, itemId, kind));
  h('appmenu:enabled', () => enabled());
  h('appmenu:setEnabled', async (on) => {
    fs.mkdirSync(cfgDir(), { recursive: true });
    if (on) { fs.rmSync(OFF(), { force: true }); if (bus) await own(); }
    else {
      fs.writeFileSync(OFF(), 'LiquidDesktop: apps keep their menus in their own windows\n');
      if (owned) { await bus.releaseName(REG).catch(() => {}); bus.unexport(REG_PATH); owned = false; }
    }
    return true;
  });
  if (!wm) return;   // testing window: nothing to register for
  wm.hasAppMenu = hasMenu;
  // a window that's new to the WM: check its own properties (KDE apps)
  wm.on('changed', () => { for (const w of wm.windows.values()) if (w.kind === 'native' && !w.kdeMenuP && enabled()) checkKde(w); });
  start().catch((e) => console.error('[appmenu]', e.message));
}

module.exports = { register };
