// Desktop notifications from Linux apps (notify-send, Discord, Firefox, Steam…): LiquidDesktop is the
// org.freedesktop.Notifications service on the session bus and shows them as its own banners and in
// Notification Center. If another notification daemon already runs (testing in a window on another
// desktop), that one keeps showing them.
const { ipcMain, webContents, nativeImage } = require('electron');
const fs = require('fs');

let dbus;
try { dbus = require('dbus-next'); } catch { dbus = null; }

let iface = null, nextId = 1, resolveIcon = () => null;
const live = new Map();   // id → { actions }

function toUi(channel, payload) {
  for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.getType() !== 'webview') wc.send(channel, payload);
}

const unwrap = (v) => (v && typeof v === 'object' && 'value' in v && 'signature' in v ? v.value : v);
function fileToDataUrl(file) {
  try {
    if (file.startsWith('file://')) file = decodeURIComponent(file.slice(7));
    if (!fs.existsSync(file)) return null;
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return img.resize({ width: Math.min(96, img.getSize().width) }).toDataURL();
    if (file.endsWith('.svg')) return 'data:image/svg+xml;base64,' + fs.readFileSync(file).toString('base64');
  } catch { /* unreadable */ }
  return null;
}
// image-data hint: (width, height, rowstride, has_alpha, bits per sample, channels, bytes) as RGB(A)
function imageDataToUrl(d) {
  try {
    const [w, h, stride, alpha, , ch, bytes] = d;
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * stride + x * ch, o = (y * w + x) * 4;
      out[o] = bytes[i + 2]; out[o + 1] = bytes[i + 1]; out[o + 2] = bytes[i]; out[o + 3] = alpha ? bytes[i + 3] : 255;
    }
    return nativeImage.createFromBitmap(out, { width: w, height: h }).resize({ width: Math.min(96, w) }).toDataURL();
  } catch { return null; }
}
const plain = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

function show(appName, replacesId, appIcon, summary, body, actions, hints, timeout) {
  const id = replacesId || nextId++;
  const h = Object.fromEntries(Object.entries(hints || {}).map(([k, v]) => [k, unwrap(v)]));
  const icon = (h['image-data'] && imageDataToUrl(h['image-data'])) || (h['image_data'] && imageDataToUrl(h['image_data']))
    || (h['image-path'] && (fileToDataUrl(h['image-path']) || fileToDataUrl(resolveIcon(h['image-path']) || '')))
    || (appIcon && (fileToDataUrl(appIcon) || fileToDataUrl(resolveIcon(appIcon) || '')))
    || (h['desktop-entry'] && fileToDataUrl(resolveIcon(h['desktop-entry']) || '')) || null;
  const acts = [];
  for (let i = 0; i + 1 < (actions || []).length; i += 2) acts.push({ key: actions[i], label: actions[i + 1] });
  live.set(id, { actions: acts });
  const critical = Number(h.urgency) === 2;
  toUi('notif:show', {
    rid: id, appName: appName || 'Notification', desktop: h['desktop-entry'] || '', title: plain(summary) || appName || 'Notification', body: plain(body), icon,
    actions: acts.filter((a) => a.key !== 'default'), hasDefault: acts.some((a) => a.key === 'default'),
    timeout: critical || timeout === 0 ? 0 : timeout > 0 ? Math.min(60000, timeout) : 5500, replaces: !!replacesId,
  });
  return id;
}
function closed(id, reason) {
  if (!live.has(id)) return;
  live.delete(id);
  try { iface?.NotificationClosed(id, reason); } catch { /* bus gone */ }
}

function makeInterface() {
  const { Interface } = dbus.interface;
  class Notifications extends Interface {
    GetCapabilities() { return ['body', 'body-markup', 'actions', 'icon-static', 'persistence']; }
    Notify(appName, replacesId, appIcon, summary, body, actions, hints, timeout) { return show(appName, replacesId, appIcon, summary, body, actions, hints, timeout); }
    CloseNotification(id) { toUi('notif:close', id); closed(id, 3); }
    GetServerInformation() { return ['LiquidDesktop', 'arc360alt', '1.0', '1.2']; }
    NotificationClosed(id, reason) { return [id, reason]; }
    ActionInvoked(id, key) { return [id, key]; }
  }
  Notifications.configureMembers({
    methods: {
      GetCapabilities: { inSignature: '', outSignature: 'as' },
      Notify: { inSignature: 'susssasa{sv}i', outSignature: 'u' },
      CloseNotification: { inSignature: 'u', outSignature: '' },
      GetServerInformation: { inSignature: '', outSignature: 'ssss' },
    },
    signals: { NotificationClosed: { signature: 'uu' }, ActionInvoked: { signature: 'us' } },
  });
  return new Notifications('org.freedesktop.Notifications');
}

async function start(opts = {}) {
  if (!dbus || !process.env.DBUS_SESSION_BUS_ADDRESS) return;
  if (opts.resolveIcon) resolveIcon = opts.resolveIcon;
  let bus;
  try { bus = dbus.sessionBus(); } catch { return; }
  bus.on('error', () => {});
  let r = 0;
  try { r = await bus.requestName('org.freedesktop.Notifications', 4 /* DO_NOT_QUEUE */); } catch { r = 0; }
  if (r !== 1) { bus.disconnect(); return; }   // another notification daemon is running
  iface = makeInterface();
  bus.export('/org/freedesktop/Notifications', iface);
}

function register(opts) {
  ipcMain.on('notif:action', (_e, id, key) => { if (!live.has(id)) return; try { iface?.ActionInvoked(id, key); } catch { /* gone */ } closed(id, 2); });
  ipcMain.on('notif:closed', (_e, id, reason) => closed(id, reason || 2));
  start(opts).catch((e) => console.error('[notifications]', e.message));
}

module.exports = { register };
