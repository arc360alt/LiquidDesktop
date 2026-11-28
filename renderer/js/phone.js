// Your phone (KDE Connect, main/kdeconnect.js): one copy of its state per page, kept current by the back end,
// plus the bits the Settings pane, Control Center and widgets share (icons, the signal bars, actions).
import { h, bus } from './util.js';
import { api } from './sys.js';
import { sym } from './icons.js';
import { registry } from './wm.js';
import { appData } from './store.js';

let state = { available: false, installed: false, devices: [], requests: [] }, hooked = false, loaded = null;
export const phoneState = () => state;
const set = (s) => { if (s) { state = s; bus.emit('phone', s); } };
function hook() {
  if (hooked || !api.kdc) return;
  hooked = true;
  api.kdc.onChanged?.(set);
  loaded = api.kdc.state().then(set).catch(() => {});
}
hook();
export const phoneReady = () => loaded || Promise.resolve();
export const refreshPhone = () => api.kdc?.state().then(set).catch(() => {});

/** Calls fn(state) now and whenever the phone changes, as long as `el` is on the page. */
export function onPhone(el, fn) {
  hook();
  const off = bus.on('phone', (s) => { if (!el.isConnected) { off(); return; } fn(s); });
  return off;
}

/** The phone to show: the first paired one that's connected, else the first paired one. */
export function mainPhone(s = state) {
  const mine = s.devices.filter((d) => d.paired);
  return mine.find((d) => d.reachable && d.type === 'phone') || mine.find((d) => d.reachable) || mine[0] || null;
}
export const pairedDevices = (s = state) => s.devices.filter((d) => d.paired);
export const has = (d, plugin) => !!d?.plugins?.includes(plugin);

const svg = (d, extra = '') => `<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"${extra}>${d}</svg>`;
export const PHONE_ICONS = {
  phone: svg('<rect x="6.5" y="2" width="11" height="20" rx="2.6"/><path d="M10.5 4.6h3"/>'),
  tablet: svg('<rect x="3.5" y="2.5" width="17" height="19" rx="2.4"/><path d="M11 18.6h2"/>'),
  desktop: svg('<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8.5 21h7M12 17v4"/>'),
  laptop: svg('<rect x="4" y="4.5" width="16" height="11" rx="1.6"/><path d="M2 19h20"/>'),
  tv: svg('<rect x="2.5" y="4.5" width="19" height="12.5" rx="2"/><path d="M8 20.5h8"/>'),
  ring: svg('<rect x="8" y="3" width="8" height="18" rx="2"/><path d="M4.5 8.5a6 6 0 0 0 0 7M19.5 8.5a6 6 0 0 1 0 7M2 6a10 10 0 0 0 0 12M22 6a10 10 0 0 1 0 12"/>'),
  ping: svg('<circle cx="12" cy="12" r="2.4"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>'),
  clipboard: svg('<rect x="5.5" y="4" width="13" height="17" rx="2.2"/><path d="M9 4V3h6v1M9 10h6M9 14h4"/>'),
  send: svg('<path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z"/>'),
  folder: svg('<path d="M3 7.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  link: svg('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>'),
};
export const deviceIcon = (d) => PHONE_ICONS[d?.type] || PHONE_ICONS.phone;

/** Cellular signal as four bars (strength 0–4; -1 = no signal). */
export function signalBars(sig, cls = '') {
  const n = sig ? Math.max(0, Math.min(4, sig.strength)) : 0;
  return h('span.ph-bars' + cls, { title: sig ? `${sig.type || 'Cellular'} · ${n} of 4 bars` : 'No signal' },
    ...[1, 2, 3, 4].map((i) => h('i' + (i <= n ? '.on' : ''), { style: { height: 3 + i * 2.2 + 'px' } })), sig?.type ? h('small', sig.type) : null);
}

/** A battery ring (the Batteries widget's look). */
export function batteryRing(b, icon) {
  const col = !b ? 'rgba(128,128,128,.5)' : b.charging ? '#30d158' : b.percent <= 20 ? '#ff453a' : '#30d158';
  const off = b ? (94.25 * (1 - b.percent / 100)).toFixed(1) : 94.25;
  return h('div.w-batt', { html: `<svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="none" stroke="rgba(128,128,128,.25)" stroke-width="3.5"/><circle cx="18" cy="18" r="15" fill="none" stroke="${col}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="94.25" stroke-dashoffset="${off}" transform="rotate(-90 18 18)"/></svg>` },
    h('span', { html: b?.charging ? sym.bolt : icon || PHONE_ICONS.phone }));
}

/** Run an action on a device; errors come back as a notification. */
export async function phoneAct(d, what, arg, notify) {
  try { return await api.kdc.act(d.id, what, arg); }
  catch (e) { notify?.({ app: 'settings', title: d.name, body: e.message }); return null; }
}

/** Send Files…: pick some, they go to the phone (it saves them in Downloads). */
export async function sendFiles(d, notify) {
  const files = await api.dialog?.open({ title: `Send to ${d.name}`, multiple: true }).catch(() => null);
  if (!files?.length) return;
  if (await phoneAct(d, 'share', files, notify)) notify?.({ app: 'files', title: `Sending to ${d.name}`, body: files.length === 1 ? files[0].split('/').pop() : `${files.length} files` });
}

/**
 * The "Send to Phone" item for a right-click menu on files (Files, the desktop): one item for one phone, a submenu
 * for several. null when no paired device takes files (Phone off, nothing paired, sharing off), so the menu stays
 * as it was. Folders can't be sent (KDE Connect sends files), so they're left out.
 */
export function sendToPhoneItem(paths, isDir = () => false, notify) {
  const devs = state.running === false ? [] : pairedDevices().filter((d) => d.supported?.includes('share') || has(d, 'share'));
  if (!devs.length) return null;
  const files = paths.filter((p) => !isDir(p));
  const send = async (d) => {
    if (await phoneAct(d, 'share', files, notify)) notify?.({ app: 'phone', title: `Sending to ${d.name}`, body: files.length === 1 ? files[0].split('/').pop() : `${files.length} files` });
  };
  const usable = (d) => d.reachable && has(d, 'share') && files.length > 0;
  const label = (d) => `${d.name}${d.reachable ? '' : ' (not connected)'}`;
  if (devs.length === 1) return { label: `Send to ${devs[0].name}`, icon: PHONE_ICONS.send, disabled: !usable(devs[0]), action: () => send(devs[0]) };
  return { label: 'Send to Device', icon: PHONE_ICONS.send, disabled: !files.length, submenu: devs.map((d) => ({ label: label(d), icon: deviceIcon(d), disabled: !usable(d), action: () => send(d) })) };
}

/** Browse Files: mount the phone's storage and open it in Files. */
export async function browsePhone(d, notify, openFiles) {
  notify?.({ app: 'files', title: d.name, body: 'Opening the phone’s files… Unlock the phone if it asks.' });
  const where = await phoneAct(d, 'browse', null, notify);
  if (typeof where === 'string') openFiles(where);
}

export const pairText = (d) => (d.requestedByPeer ? 'Wants to pair' : d.requested ? 'Waiting for the phone…' : d.reachable ? (d.paired ? 'Connected' : 'Available') : 'Not connected');

/* ------------------------------------------------------------------ the phone's contacts */
// Read from the vCards KDE Connect keeps (main/kdeconnect.js); numbers are matched on their last 9 digits, so
// "+1 555 0101", "(555) 0101" and "5550101" are the same person.
const contactCache = new Map();   // device id → [contacts]
export const digits = (n) => String(n || '').replace(/\D/g, '');
const tail = (n) => digits(n).slice(-9);
export async function phoneContacts(d, fresh) {
  if (!d || !api.kdc?.contacts) return [];
  if (!fresh && contactCache.has(d.id)) return contactCache.get(d.id);
  const list = await api.kdc.contacts(d.id).catch(() => []);
  contactCache.set(d.id, list || []);
  return contactCache.get(d.id);
}
api.kdc?.onContacts?.((devId) => { contactCache.delete(devId); bus.emit('phone-contacts', devId); });
/** The contact with this number (from the cache: call phoneContacts first), or null. */
export function contactFor(d, number) {
  const t = tail(number);
  if (!t || !d) return null;
  return (contactCache.get(d.id) || []).find((c) => c.phones.some((p) => tail(p.number) === t)) || null;
}
export const displayName = (d, number) => contactFor(d, number)?.name || number;

// a round picture: the contact's photo, or their initials on a colour picked from the name
const AVATAR_COLORS = [['#ff9f0a', '#ff6b00'], ['#34c759', '#1f9d45'], ['#0a84ff', '#0060df'], ['#bf5af2', '#8e3fd1'], ['#ff375f', '#d1214a'], ['#5ac8fa', '#2a9fd6'], ['#a2845e', '#7b6043'], ['#8e8e93', '#636366']];
export function avatar(name, photo, size = 40, group = false) {
  const el = h('div.ph-avatar', { style: { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.4) + 'px' } });
  if (photo) { el.append(h('img', { src: photo, draggable: false })); return el; }
  const words = String(name || '').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).filter(Boolean);
  const isNumber = !/\p{L}/u.test(name || '');
  let n = 0;
  for (const ch of String(name || '?')) n = (n * 31 + ch.codePointAt(0)) >>> 0;
  const [a, b] = AVATAR_COLORS[n % AVATAR_COLORS.length];
  el.style.background = isNumber && !group ? 'linear-gradient(#a8a8ad, #86868b)' : `linear-gradient(${a}, ${b})`;
  if (group) el.innerHTML = '<svg viewBox="0 0 24 24" fill="#fff" width="58%" height="58%"><circle cx="9" cy="8" r="3.4"/><circle cx="16.5" cy="9" r="2.7" opacity=".8"/><path d="M2.5 19c.6-3.6 3.3-5.6 6.5-5.6s5.9 2 6.5 5.6z"/><path d="M14.6 13.6c3 0 5.4 1.7 6 5H16.8c-.3-2-1.1-3.6-2.2-5z" opacity=".8"/></svg>';
  else if (isNumber || !words.length) el.innerHTML = '<svg viewBox="0 0 24 24" fill="#fff" width="62%" height="62%"><circle cx="12" cy="8.3" r="4"/><path d="M4 20.5c.8-4.4 4-6.6 8-6.6s7.2 2.2 8 6.6z"/></svg>';
  else el.textContent = (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  return el;
}

/** "10:42 AM", "Yesterday", "Tuesday", "3/14/26" — like Messages on a Mac. */
export function shortTime(ms) {
  const d = new Date(ms), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 864e5);
  if (diff === 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
}

/* ------------------------------------------------------------------ the phone apps come and go */
// Messages, Contacts and Phone are only in the Dock, Launchpad and Spotlight while Phone is turned on (Settings
// › Phone) and a device that can do what the app needs is paired.
const appRules = new Map();
export function phoneApp(id, needs) {
  appRules.set(id, needs);
  const apply = () => {
    let changed = false;
    for (const [appId, rule] of appRules) {
      const def = registry.get(appId);
      if (!def) continue;
      const on = !!state.running && state.devices.some((d) => d.paired && (!rule || rule(d)));
      if (def.hidden !== !on) { def.hidden = !on; changed = true; }
    }
    if (changed) bus.emit('catalog');
  };
  if (!phoneApp.hooked) { phoneApp.hooked = true; bus.on('phone', apply); }
  queueMicrotask(apply);
}
/** The device an app uses: the main phone if it can do this, else the first paired one that can. */
export function phoneFor(rule) {
  const mine = state.devices.filter((d) => d.paired && (!rule || rule(d)));
  const m = mainPhone();
  return (m && mine.includes(m) ? m : null) || mine.find((d) => d.reachable) || mine[0] || null;
}
export const canText = (d) => d.supported.includes('sms') || d.plugins.includes('sms');

/* ------------------------------------------------------------------ read on this computer */
// KDE Connect can't mark a text as read on the phone, so what you've opened here is remembered here
export const markSeen = (d, thread) => { const s = appData.get('msgSeen', {}); s[d.id + '/' + thread] = Date.now(); appData.set('msgSeen', s); };
export const isUnread = (d, t) => !!t.unread && t.last.type === 1 && t.last.date > (appData.get('msgSeen', {})[d.id + '/' + t.thread] || 0);

/* ------------------------------------------------------------------ files from the phone: notifications */
// KDE Connect saves them (in ~/Received from Phone) without a word; these say what arrived, with Open and Show in
// Files. Several files sent together become one notification. Only the main shell (or the testing window) shows them.
let noticesOn = false;
export function initPhoneNotices() {
  if (noticesOn || !api.kdc?.onFile) return;
  noticesOn = true;
  let batch = [], batchTimer = null;
  const isImage = (n) => /\.(png|jpe?g|gif|webp|bmp|avif|heic)$/i.test(n);
  const fmtSize = (b) => (b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b >= 1e3 ? Math.round(b / 1e3) + ' KB' : b + ' bytes');
  const fileUrl = (p) => 'file://' + p.split('/').map(encodeURIComponent).join('/');
  const show = async () => {
    const files = batch; batch = [];
    const { notify, closeRemote } = await import('./notifications.js');
    const { wm } = await import('./wm.js');
    for (const f of files) closeRemote('phone-file:' + f.name);
    const from = files[0].deviceName || mainPhone()?.name || 'your phone';
    const dir = files[0].path.replace(/\/[^/]+$/, '');
    const reveal = () => wm.open('files', { path: dir, select: files[0].path });
    if (files.length === 1) {
      const f = files[0];
      notify({ app: 'phone', title: `Received from ${from}`, body: `${f.name}${f.size ? ' · ' + fmtSize(f.size) : ''}`, icon: isImage(f.name) ? fileUrl(f.path) : null,
        actions: [{ key: 'open', label: 'Open' }, { key: 'show', label: 'Show in Files' }],
        onAction: (k) => (k === 'open' ? api.fs.open(f.path) : reveal()), action: () => api.fs.open(f.path), timeout: 9000 });
    } else {
      notify({ app: 'phone', title: `${files.length} files received from ${from}`, body: files.map((f) => f.name).slice(0, 4).join(', ') + (files.length > 4 ? '…' : ''),
        icon: files.find((f) => isImage(f.name)) ? fileUrl(files.find((f) => isImage(f.name)).path) : null,
        actions: [{ key: 'show', label: 'Show in Files' }], onAction: reveal, action: reveal, timeout: 9000 });
    }
  };
  api.kdc.onFile(async (f) => {
    const { notify } = await import('./notifications.js');
    if (f.event === 'receiving') {
      // a big file takes a while: say it's coming (replaced by "Received" when it's done)
      if (f.size > 2e6) notify({ rid: 'phone-file:' + f.name, app: 'phone', title: `Receiving from ${mainPhone()?.name || 'your phone'}…`, body: `${f.name} · ${fmtSize(f.size)}`, timeout: 0 });
    } else if (f.event === 'received') {
      batch.push(f);
      clearTimeout(batchTimer);
      batchTimer = setTimeout(show, 1200);
    } else if (f.event === 'failed') {
      notify({ app: 'phone', title: 'A file from your phone didn’t arrive', body: `${f.reason || 'The transfer stopped.'} Try sending it again; the phone and this computer need to be on the same network.`, timeout: 12000,
        actions: [{ key: 'log', label: 'Show Details' }], onAction: () => import('./wm.js').then(({ wm }) => f.log && wm.open('texteditor', { path: f.log })) });
    }
  });
}
