// Your phone, through KDE Connect: battery, signal, what's playing, notifications, find my phone, files and
// clipboard — drawn by LiquidDesktop (Settings › Phone, Control Center, widgets). It only talks to KDE Connect's
// background service (kdeconnectd) over D-Bus: none of KDE Connect's own windows are opened.
//   service org.kde.kdeconnect, daemon at /modules/kdeconnect, devices at /modules/kdeconnect/devices/<id>,
//   plugins below them (…/<id>/battery, …/<id>/mprisremote …). Checked against KDE Connect 26.08.
const { ipcMain, webContents } = require('electron');
const fs = require('fs');
const path = require('path');
let dbus = null;
try { dbus = require('dbus-next'); } catch { dbus = null; }

const SVC = 'org.kde.kdeconnect', ROOT = '/modules/kdeconnect', DAEMON = 'org.kde.kdeconnect.daemon', DEV = 'org.kde.kdeconnect.device';
const PI = (p) => `org.kde.kdeconnect.device.${p}`;
// the features Settings lets you turn on and off, in the order shown (plugin id → label)
const FEATURES = [
  ['battery', 'Battery', 'Show the phone’s battery in widgets and Control Center'],
  ['notifications', 'Notifications', 'Show the phone’s notifications on this computer'],
  ['sms', 'Text Messages', 'Read and send the phone’s texts in Messages'],
  ['contacts', 'Contacts', 'Copy the phone’s contacts to this computer (Contacts, and names in Messages)'],
  ['clipboard', 'Clipboard', 'Share what you copy between the phone and this computer'],
  ['share', 'Send Files', 'Send files and links in both directions'],
  ['mprisremote', 'Media Controls', 'Control what’s playing on the phone'],
  ['findmyphone', 'Find My Phone', 'Make the phone ring'],
  ['sftp', 'Browse Files', 'Open the phone’s storage in Files'],
  ['connectivity_report', 'Cellular Signal', 'Show the phone’s signal strength'],
  ['telephony', 'Calls', 'Tell you when the phone rings'],
  ['remotekeyboard', 'Type on Phone', 'Type on the phone with this computer’s keyboard (needs KDE Connect’s keyboard on the phone)'],
  ['ping', 'Ping', 'Send a ping to check the connection'],
];

let bus = null, state = { available: false, installed: false, devices: [], requests: [] }, pushTimer = null, pending = null;
const notifCache = new Map();   // "<device>/<publicId>" → notification (they don't change once posted, apart from updates)

const unwrap = (v) => (v instanceof (dbus?.Variant || class {}) ? unwrap(v.value) : Array.isArray(v) ? v.map(unwrap) : v);
// raw calls: KDE Connect's introspection data is rejected by strict parsers (duplicate overloads)
const call = (objPath, iface, member, signature = '', body = []) =>
  bus.call(new dbus.Message({ destination: SVC, path: objPath, interface: iface, member, signature, body })).then((r) => (r?.body?.length ? unwrap(r.body[0]) : undefined));
const props = (objPath, iface) => call(objPath, 'org.freedesktop.DBus.Properties', 'GetAll', 's', [iface]).then((p) => Object.fromEntries(Object.entries(p || {}).map(([k, v]) => [k, unwrap(v)]))).catch(() => ({}));
const busCall = (member, signature = '', body = []) =>
  bus.call(new dbus.Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member, signature, body })).then((r) => r?.body?.[0]);

function broadcast() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.getType() !== 'webview') wc.send('kdc:changed', state); }, 80);
}

/* ------------------------------------------------------------------ reading the state */
function iconFile(p) {
  if (!p) return null;
  const f = p.replace(/^file:\/\//, '');
  try {
    if (fs.statSync(f).size > 2e6) return null;
    const ext = path.extname(f).toLowerCase();
    return `data:${ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png'};base64,${fs.readFileSync(f).toString('base64')}`;
  } catch { return null; }
}

async function readNotifications(id, base) {
  const ids = await call(base + '/notifications', PI('notifications'), 'activeNotifications').catch(() => []) || [];
  const out = [];
  for (const nid of ids) {
    const key = id + '/' + nid;
    let n = notifCache.get(key);
    if (!n) {
      const p = await props(`${base}/notifications/${nid}`, PI('notifications.notification'));
      if (!p || !Object.keys(p).length) continue;
      n = { id: nid, app: p.appName || '', title: p.title || '', text: p.text || p.ticker || '', icon: p.hasIcon ? iconFile(p.iconPath) : null,
        dismissable: !!p.dismissable, replyId: p.replyId || '', silent: !!p.silent, time: Date.now() };
      notifCache.set(key, n);
    }
    out.push(n);
  }
  for (const k of [...notifCache.keys()]) if (k.startsWith(id + '/') && !ids.includes(k.slice(id.length + 1))) notifCache.delete(k);
  return out.sort((a, b) => b.time - a.time);
}

async function readDevice(id) {
  const base = `${ROOT}/devices/${id}`;
  const p = await props(base, DEV);
  if (!p || !p.name) return null;
  const loaded = p.isReachable ? await call(base, DEV, 'loadedPlugins').catch(() => []) || [] : [];
  const has = (pl) => loaded.includes('kdeconnect_' + pl);
  const d = {
    id, name: p.name, type: p.type || 'phone', reachable: !!p.isReachable, paired: p.pairState === 3 || (p.pairState == null && !!p.isPaired),
    pairState: p.pairState ?? (p.isPaired ? 3 : 0), requestedByPeer: p.pairState === 2 || !!p.isPairRequestedByPeer, requested: p.pairState === 1 || !!p.isPairRequested,
    verificationKey: p.verificationKey || '', address: (p.reachableAddresses || [])[0] || '',
    plugins: loaded.map((x) => x.replace(/^kdeconnect_/, '')), supported: (p.supportedPlugins || []).map((x) => x.replace(/^kdeconnect_/, '')),
    battery: null, signal: null, media: null, notifications: [], mounted: false,
  };
  if (!d.reachable || !d.paired) return d;
  const work = [];
  if (has('battery')) work.push(props(base + '/battery', PI('battery')).then((b) => { if (b.hasBattery !== false && b.charge >= 0 && b.charge != null) d.battery = { percent: b.charge, charging: !!b.isCharging }; }));
  if (has('connectivity_report')) work.push(props(base + '/connectivity_report', PI('connectivity_report')).then((c) => { if (c.cellularNetworkType) d.signal = { type: c.cellularNetworkType, strength: c.cellularNetworkStrength ?? -1 }; }));
  if (has('mprisremote')) work.push(props(base + '/mprisremote', PI('mprisremote')).then((m) => {
    if (m.playerList?.length || m.title) d.media = { title: m.title || '', artist: m.artist || '', album: m.album || '', playing: !!m.isPlaying, player: m.player || '', players: m.playerList || [],
      length: m.length || 0, position: m.position || 0, volume: m.volume ?? null, art: m.localAlbumArtUrl ? iconFile(m.localAlbumArtUrl) : null };
  }));
  if (has('notifications')) work.push(readNotifications(id, base).then((n) => { d.notifications = n; }));
  if (has('sftp')) work.push(call(base + '/sftp', PI('sftp'), 'isMounted').then((m) => { d.mounted = !!m; }).catch(() => {}));
  await Promise.all(work.map((w) => w.catch(() => {})));
  return d;
}

async function readAll() {
  if (!bus) return state;
  const owner = await busCall('NameHasOwner', 's', [SVC]).catch(() => false);
  if (!owner) {
    const names = await busCall('ListActivatableNames').catch(() => []) || [];
    state = { available: false, installed: names.includes(SVC), running: false, devices: [], requests: [], features: FEATURES };
    return state;
  }
  const [ids, name, requests] = await Promise.all([
    call(ROOT, DAEMON, 'devices', 'bb', [false, false]).catch(() => []),
    call(ROOT, DAEMON, 'announcedName').catch(() => ''),
    call(ROOT, 'org.freedesktop.DBus.Properties', 'Get', 'ss', [DAEMON, 'pairingRequests']).catch(() => []),
  ]);
  const devices = (await Promise.all((ids || []).map((id) => readDevice(id).catch(() => null)))).filter(Boolean)
    // your phone first: paired and connected, then paired, then nearby ones
    .sort((a, b) => (b.paired - a.paired) || (b.reachable - a.reachable) || a.name.localeCompare(b.name));
  state = { available: true, installed: true, running: true, name, devices, requests: requests || [], features: FEATURES, receiveDir: receiveDir() };
  for (const d of devices) setupReceiving(d);
  return state;
}

// signals come in bursts (a device connecting sends a dozen): read once they settle
function refreshSoon(ms = 150) {
  if (pending) return;
  pending = setTimeout(async () => {
    pending = null;
    try { await readAll(); } catch { /* daemon went away mid-read */ }
    broadcast();
  }, ms);
}

/* ------------------------------------------------------------------ text messages (the SMS plugin) */
// KDE Connect keeps the phone's messages it has been sent; it hands them out as D-Bus signals, one per
// message (conversationUpdated), when a thread is asked for. They're collected here, per device and thread,
// so Messages can ask "what's in this thread" and get an answer.
//   a message: (event i, body s, addresses a(s), date x, type i (1 received, 2 sent), read i, thread x,
//              id i, SIM x, attachments a(partID x, mime s, thumbnail base64 s, uniqueIdentifier s))
const convs = new Map();          // device id → Map(thread → Map(message id → message))
const loaded = new Map();         // "device/thread" → resolve functions waiting for conversationLoaded
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
function parseMessage(v) {
  const a = unwrap(v);
  if (!Array.isArray(a) || a.length < 8) return null;
  return { event: a[0], body: a[1] || '', addresses: (a[2] || []).map((x) => (Array.isArray(x) ? x[0] : x)), date: num(a[3]), type: a[4], read: !!a[5],
    thread: num(a[6]), id: num(a[7]), sim: num(a[8]),
    attachments: (a[9] || []).map((t) => ({ part: num(t[0]), mime: t[1], thumb: t[2] ? `data:${/^image\//.test(t[1]) ? t[1] : 'image/jpeg'};base64,${t[2]}` : null, uid: t[3] })) };
}
// Messages are kept by message id *and* time: phones don't always give texts sent through KDE Connect an id of
// their own (several can share one), and keeping them by id alone made each new one replace the last.
const msgKey = (m) => `${m.id}|${m.date}`;
// Kept on disk too (~/.cache/LiquidDesktop/messages-<device>.json), so Messages opens with everything it had
// and only asks the phone what changed since.
const cacheFile = (dev) => path.join(process.env.XDG_CACHE_HOME || path.join(require('os').homedir(), '.cache'), 'LiquidDesktop', `messages-${dev.replace(/[^\w-]/g, '')}.json`);
function loadCache(dev) {
  if (convs.has(dev)) return convs.get(dev);
  const threads = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile(dev), 'utf8'));
    for (const [thread, list] of Object.entries(data.threads || {})) threads.set(Number(thread), new Map(list.map((m) => [msgKey(m), m])));
  } catch { /* nothing kept yet */ }
  convs.set(dev, threads);
  return threads;
}
const saveTimers = new Map();
function saveCache(dev) {
  clearTimeout(saveTimers.get(dev));
  saveTimers.set(dev, setTimeout(() => {
    const out = {};
    // the newest 400 of each conversation (older ones come back from the phone when asked for)
    for (const [thread, msgs] of convs.get(dev) || []) out[thread] = [...msgs.values()].sort((a, b) => b.date - a.date).slice(0, 400);
    try {
      fs.mkdirSync(path.dirname(cacheFile(dev)), { recursive: true });
      fs.writeFileSync(cacheFile(dev) + '.tmp', JSON.stringify({ version: 1, threads: out }));
      fs.renameSync(cacheFile(dev) + '.tmp', cacheFile(dev));
    } catch { /* read-only home: it just isn't kept */ }
  }, 1500));
}
const newest = (dev, thread) => { let d = 0; for (const m of loadCache(dev).get(thread)?.values() || []) if (m.date > d) d = m.date; return d; };
// a message newer than anything kept for its thread: something happened while we weren't looking, so the
// thread's newest messages are asked for (once per burst) to fill any gap
const gapCheck = new Map();
function storeMessage(dev, m) {
  if (!m) return false;
  const threads = loadCache(dev);
  const wasNewest = newest(dev, m.thread);
  if (!threads.has(m.thread)) threads.set(m.thread, new Map());
  const msgs = threads.get(m.thread), key = msgKey(m), old = msgs.get(key);
  if (old && JSON.stringify(old) === JSON.stringify(m)) return false;
  // the phone's copy of a text sent from this computer replaces the one kept for it here
  if (!m.local && m.type === 2) for (const [k, x] of msgs) if (x.local && x.body === m.body && Math.abs(x.date - m.date) < 5 * 60_000) { msgs.delete(k); break; }
  msgs.set(key, m);
  saveCache(dev);
  if (wasNewest && m.date > wasNewest && !gapCheck.has(dev + '/' + m.thread)) {
    gapCheck.set(dev + '/' + m.thread, setTimeout(() => { gapCheck.delete(dev + '/' + m.thread); fetchLatest(dev, m.thread); }, 800));
  }
  return true;
}
let smsPush = null, smsQueue = [];
function smsChanged(dev, thread) {
  smsQueue.push([dev, thread]);
  clearTimeout(smsPush);
  smsPush = setTimeout(() => {
    const seen = new Set(), out = [];
    for (const [d, t] of smsQueue) { const k = d + '/' + t; if (!seen.has(k)) { seen.add(k); out.push({ device: d, thread: t }); } }
    smsQueue = [];
    for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.getType() !== 'webview') wc.send('kdc:sms', out);
  }, 120);
}
const CONV = 'org.kde.kdeconnect.device.conversations';
const summary = (dev) => [...loadCache(dev).entries()].filter(([, msgs]) => msgs.size).map(([thread, msgs]) => {
  const list = [...msgs.values()].sort((a, b) => b.date - a.date);
  const last = list[0];
  return { thread, addresses: last.addresses, last: { body: last.body, date: last.date, type: last.type, attachments: last.attachments.length }, unread: list.filter((m) => m.type === 1 && !m.read).length };
}).sort((a, b) => b.last.date - a.last.date);
// The list: what's kept, right away. refresh: also ask the phone for each thread's newest message (they arrive
// as signals; only threads that changed are then read again, see storeMessage).
async function conversations(dev, refresh) {
  const base = dev_(dev);
  loadCache(dev);
  const list = await call(base, CONV, 'activeConversations').catch(() => []) || [];
  for (const v of list) storeMessage(dev, parseMessage(v));
  if (refresh) call(base, CONV, 'requestAllConversationThreads').catch(() => {});
  return summary(dev);
}
// One conversation: what's kept comes back at once (and the phone is asked for anything newer); only when
// there's little or nothing kept, or older messages are wanted, does it wait for KDE Connect.
async function conversation(dev, thread, count = 60) {
  const have = loadCache(dev).get(thread)?.size || 0;
  if (have >= Math.min(count, 20) && count <= 60) {
    fetchLatest(dev, thread);
    return [...loadCache(dev).get(thread).values()].sort((a, b) => a.date - b.date);
  }
  const key = dev + '/' + thread;
  const done = new Promise((res) => { loaded.set(key, res); setTimeout(res, have ? 1500 : 3000); });
  await call(dev_(dev), CONV, 'requestConversation', 'xii', [BigInt(thread), 0, count]).catch(() => {});
  if (!have) fetchLatest(dev, thread);
  await done;
  loaded.delete(key);
  return [...(loadCache(dev).get(thread)?.values() || [])].sort((a, b) => a.date - b.date);
}
const fileUrl_ = (p) => (/^[a-z]+:\/\//.test(p) ? p : 'file://' + encodeURI(p));
async function sendText(dev, { thread, addresses, text, files = [] }) {
  const att = files.map((f) => new dbus.Variant('s', fileUrl_(f)));
  if (thread != null) {
    await call(dev_(dev), CONV, 'replyToConversation', 'xsav', [BigInt(thread), String(text), att]);
    // kept here as sent: KDE Connect ignores a phone's report of a message whose id it has seen before, and
    // some phones give texts sent for KDE Connect ids they've already used — those would never show up
    const any = [...(loadCache(dev).get(Number(thread))?.values() || [])][0];
    const body = String(text) || files.map((f) => '📎 ' + path.basename(f)).join(' ');
    if (storeMessage(dev, { event: 1, body, addresses: any?.addresses || [], date: Date.now(), type: 2, read: true, thread: Number(thread), id: -Date.now(), sim: 0, attachments: [], local: true })) smsChanged(dev, Number(thread));
    return;
  }
  return call(dev_(dev), CONV, 'sendWithoutConversation', 'avsav', [addresses.map((a) => new dbus.Variant('(s)', [String(a)])), String(text), att]);
}
// ask the phone itself for a thread's newest messages (KDE Connect's own cache only grows backwards, and a
// phone doesn't always report texts it sent for us): they arrive as conversationUpdated signals
const fetchLatest = (dev, thread) => call(dev_(dev) + '/sms', PI('sms'), 'requestConversation', 'x', [BigInt(thread)]).catch(() => {});
const attachmentWait = new Map();
async function attachment(dev, part, uid) {
  const got = new Promise((res) => { attachmentWait.set(uid, res); setTimeout(() => res(null), 20000); });
  await call(dev_(dev), CONV, 'requestAttachmentFile', 'xs', [BigInt(part), String(uid)]);
  const p = await got;
  attachmentWait.delete(uid);
  if (!p) throw new Error('The phone didn’t send the attachment.');
  return p;
}

/* ------------------------------------------------------------------ contacts (the phone's, as vCards) */
// The contacts plugin saves them in ~/.local/share/kpeoplevcard/kdeconnect-<device>/ (one .vcf each)
// read again only when the folder changed (a contact added, edited or removed): the parsed list is kept
const vcardCache = new Map();   // device → { sig, list }
function vcards(dev) {
  const dir = path.join(process.env.XDG_DATA_HOME || path.join(require('os').homedir(), '.local', 'share'), 'kpeoplevcard', 'kdeconnect-' + dev.replace(/[^\w-]/g, ''));
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.vcf')); } catch { return []; }
  let sig = '';
  try { sig = files.length + ':' + files.reduce((a, f) => Math.max(a, fs.statSync(path.join(dir, f)).mtimeMs), fs.statSync(dir).mtimeMs); } catch { sig = String(Math.random()); }
  const kept = vcardCache.get(dev);
  if (kept && kept.sig === sig) return kept.list;
  const out = [];
  for (const f of files) {
    let t;
    try { t = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    // unfold continuation lines, then read the fields we use
    const lines = t.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
    const c = { uid: f.replace(/\.vcf$/, ''), name: '', phones: [], emails: [], photo: null, org: '', birthday: '', note: '' };
    for (const line of lines) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const head = line.slice(0, i), key = head.split(';')[0].toUpperCase(), params = head.slice(key.length).toUpperCase();
      let val = line.slice(i + 1);
      if (/ENCODING=QUOTED-PRINTABLE/.test(params)) val = Buffer.from(val.replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
      val = val.replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, '\n');
      if (key === 'FN') c.name = val;
      else if (key === 'N' && !c.name) c.name = val.split(';').slice(0, 2).reverse().join(' ').trim();
      else if (key === 'TEL') c.phones.push({ number: val, label: /CELL|MOBILE/.test(params) ? 'mobile' : /HOME/.test(params) ? 'home' : /WORK/.test(params) ? 'work' : 'phone' });
      else if (key === 'EMAIL') c.emails.push(val);
      else if (key === 'ORG') c.org = val.replace(/;+$/, '').replace(/;/g, ', ');
      else if (key === 'BDAY') c.birthday = val;
      else if (key === 'NOTE') c.note = val;
      else if (key === 'PHOTO') {
        const type = (params.match(/TYPE=(\w+)/) || [])[1] || 'JPEG';
        if (/ENCODING=(B|BASE64)/.test(params)) c.photo = `data:image/${type.toLowerCase()};base64,${val}`;
        else if (/^data:/.test(val)) c.photo = val;
      }
    }
    if (c.name || c.phones.length) out.push(c);
  }
  out.sort((a, b) => (a.name || '~').localeCompare(b.name || '~'));
  vcardCache.set(dev, { sig, list: out });
  return out;
}
const lastSync = new Map(), syncWait = new Map();
function contacts(dev) {
  // ask the phone for changes now and then (it answers in the background; contactsChanged follows)
  if (Date.now() - (lastSync.get(dev) || 0) > 5 * 60_000) {
    lastSync.set(dev, Date.now());
    call(dev_(dev) + '/contacts', PI('contacts'), 'synchronizeRemoteWithLocal').catch(() => {});
  }
  return vcards(dev);
}
/**
 * Sync Now: ask the phone for its contacts and wait for the answer (or 20 s). The phone only answers when
 * KDE Connect there has its Contacts plugin on *and* Android's contacts permission.
 */
async function syncContacts(dev) {
  const d = state.devices.find((x) => x.id === dev);
  if (!d?.reachable) throw new Error(`${d?.name || 'The phone'} isn’t connected.`);
  // a plugin just turned on (on the phone or here) only loads after its plugins are reloaded
  if (!d.plugins.includes('contacts')) {
    await call(dev_(dev), DEV, 'reloadPlugins').catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    await readAll().catch(() => {});
    const again = state.devices.find((x) => x.id === dev);
    if (!again?.plugins.includes('contacts')) {
      return { ok: false, reason: again?.supported.includes('contacts') ? 'off-here' : 'off-phone', contacts: vcards(dev) };
    }
  }
  lastSync.set(dev, Date.now());
  const answered = new Promise((res) => { syncWait.set(dev, res); setTimeout(() => res(false), 20_000); });
  await call(dev_(dev) + '/contacts', PI('contacts'), 'synchronizeRemoteWithLocal');
  const ok = await answered;
  syncWait.delete(dev);
  const list = vcards(dev);
  return { ok: !!ok || list.length > 0, reason: ok || list.length ? null : 'no-answer', contacts: list };
}

/* ------------------------------------------------------------------ calls (the telephony plugin) */
// KDE Connect only tells about calls as they happen: they're kept (the last 100) so Phone can list them
const callsFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(require('os').homedir(), '.config'), 'LiquidDesktop', 'phone-calls.json');
let calls = null;
const loadCalls = () => { if (!calls) { try { calls = JSON.parse(fs.readFileSync(callsFile(), 'utf8')); } catch { calls = []; } } return calls; };
function addCall(dev, event, number, name) {
  loadCalls();
  const last = calls[0];
  // one call sends several events (ringing, then talking or missed): keep one entry, updated
  if (last && last.number === number && Date.now() - last.time < 3 * 60_000 && last.device === dev) { last.event = event; last.updated = Date.now(); }
  else calls.unshift({ device: dev, event, number, name: name && name !== number ? name : '', time: Date.now() });
  calls = calls.slice(0, 100);
  try { fs.mkdirSync(path.dirname(callsFile()), { recursive: true }); fs.writeFileSync(callsFile(), JSON.stringify(calls)); } catch { /* read-only */ }
  for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.getType() !== 'webview') wc.send('kdc:call', { device: dev, event, number, name });
}

/* ------------------------------------------------------------------ files from the phone */
// Files the phone shares (Send files, or Share › KDE Connect) are saved in ~/Received from Phone — set as each
// paired device's download folder in KDE Connect, unless you picked another one (Settings › Phone). KDE Connect
// itself doesn't say anything when a file arrives, so LiquidDesktop does: received (Open / Show in Files), and
// failed — read from KDE Connect's log, which LiquidDesktop keeps when it starts KDE Connect itself.
const home = require('os').homedir();
const kdcConfigDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'kdeconnect');
const receiveDir = () => settings().receiveDir || path.join(home, 'Received from Phone');
const shareConfig = (dev) => path.join(kdcConfigDir(), dev.replace(/[^\w-]/g, ''), 'kdeconnect_share', 'config');
const downloads = () => { try { return require('child_process').execFileSync('xdg-user-dir', ['DOWNLOAD'], { encoding: 'utf8', timeout: 2000 }).trim(); } catch { return path.join(home, 'Downloads'); } };
const configured = new Set();
function setupReceiving(d, force) {
  if (!d.paired || (configured.has(d.id) && !force)) return;
  configured.add(d.id);
  const want = receiveDir();
  try { fs.mkdirSync(want, { recursive: true }); } catch { /* made when the first file comes */ }
  const file = shareConfig(d.id);
  let cur = '';
  try { cur = (fs.readFileSync(file, 'utf8').match(/^incoming_path=(.*)$/m) || [])[1] || ''; } catch { /* no setting yet */ }
  cur = cur.replace(/^file:\/\//, '');
  // somebody chose a folder in KDE Connect's own settings: theirs stays (unless Settings › Phone changes it)
  if (!force && cur && cur !== want && cur !== downloads()) return;
  if (cur === want) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = '[General]\n'; }
    text = /^incoming_path=/m.test(text) ? text.replace(/^incoming_path=.*$/m, 'incoming_path=' + want) : text.replace(/\[General\]\n?/, '[General]\nincoming_path=' + want + '\n');
    if (!/\[General\]/.test(text)) text = '[General]\nincoming_path=' + want + '\n' + text;
    fs.writeFileSync(file, text);
    // KDE Connect reads the setting when the plugin is (re)loaded
    if (d.reachable) call(dev_(d.id), DEV, 'reloadPlugins').catch(() => {});
  } catch (e) { console.error('[kdeconnect] could not set the download folder:', e.message); }
}
const toAll = (ch, data) => { for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.getType() !== 'webview') wc.send(ch, data); };
const deviceName = (id) => state.devices.find((x) => x.id === id)?.name || 'Your phone';
function received(devId, url) {
  let file = String(url);
  try { file = decodeURIComponent(new URL(file).pathname); } catch { /* a plain path */ }
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* moved already */ }
  toAll('kdc:file', { device: devId, deviceName: deviceName(devId), event: 'received', path: file, name: path.basename(file), size });
}

// KDE Connect's log (when LiquidDesktop started it): transfers starting and failing
const logFile = () => path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'LiquidDesktop', 'kdeconnect.log');
let logPos = 0, logWatching = false, lastLines = [];
// KDE Connect never gives up on a transfer whose connection doesn't come (the file just never appears), so it's
// watched: a file that doesn't grow for 25 s, or a transfer that never gets as far as a file, has failed
const watchdogs = new Map();   // path → timer
let startedAt = 0, startTimer = null;
function watchTransfer(file, size) {
  clearTimeout(startTimer);
  let last = -1, still = 0;
  clearInterval(watchdogs.get(file));
  watchdogs.set(file, setInterval(() => {
    let now = -1;
    try { now = fs.statSync(file).size; } catch { /* not there yet */ }
    if (now >= size && size > 0) return stopWatch(file);
    still = now === last ? still + 2 : 0;
    last = now;
    if (still >= 25) {
      stopWatch(file);
      toAll('kdc:file', { event: 'failed', log: logFile(), name: path.basename(file), reason: `${path.basename(file)} stopped arriving.` });
    }
  }, 2000));
}
const stopWatch = (file) => { clearInterval(watchdogs.get(file)); watchdogs.delete(file); };
function watchLog() {
  if (logWatching) return;
  logWatching = true;
  try { logPos = fs.statSync(logFile()).size; } catch { logPos = 0; }
  fs.watchFile(logFile(), { interval: 1000 }, (st) => {
    if (st.size < logPos) logPos = 0;
    if (st.size === logPos) return;
    let text = '';
    try {
      const fd = fs.openSync(logFile(), 'r');
      const buf = Buffer.alloc(Math.min(st.size - logPos, 256 * 1024));
      fs.readSync(fd, buf, 0, buf.length, logPos);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch { return; }
    logPos = st.size;
    // KDE Connect writes to it in append mode: emptying it now and then keeps it small
    if (st.size > 6e6) { try { fs.truncateSync(logFile(), 0); logPos = 0; } catch { /* leave it */ } }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      lastLines.push(line); if (lastLines.length > 30) lastLines.shift();
      const m = line.match(/Downloading payload to QUrl\("([^"]+)"\)\s*size:\s*(-?\d+)/);
      if (m) {
        let f = m[1]; try { f = decodeURIComponent(new URL(f).pathname); } catch { /* path */ }
        toAll('kdc:file', { event: 'receiving', path: f, name: path.basename(f), size: Number(m[2]) });
        watchTransfer(f, Number(m[2]));
      }
      if (/kdeconnect\.plugin\.share: File transfer$/.test(line.trim())) {
        // started: it should get to "Downloading payload" right away
        clearTimeout(startTimer);
        startTimer = setTimeout(() => toAll('kdc:file', { event: 'failed', log: logFile(), reason: 'The phone started sending a file, but it never came.' }), 15000);
      }
      const done = line.match(/File transfer finished\. QUrl\("([^"]+)"\)/);
      if (done) { clearTimeout(startTimer); let f = done[1]; try { f = decodeURIComponent(new URL(f).pathname); } catch { /* path */ } stopWatch(f); }
      if (/File transfer failed|Failed to (open|write) |Payload.*(error|fail)|Could not .*(payload|file)/i.test(line)) {
        clearTimeout(startTimer); for (const f of [...watchdogs.keys()]) stopWatch(f);
        const why = lastLines.slice(-6).reverse().find((l) => /error|fail|denied|refused|timed out|could not|no such/i.test(l) && !/File transfer failed/.test(l));
        toAll('kdc:file', { event: 'failed', log: logFile(), reason: (why || line).replace(/^.*?:\s*/, '').slice(0, 300) });
      }
    }
  });
}
// Start KDE Connect's background service ourselves (rather than letting D-Bus do it) so its log is kept;
// D-Bus starting it is the fallback
async function startDaemon() {
  const bin = ['/usr/bin/kdeconnectd', '/usr/lib/kdeconnectd', '/usr/libexec/kdeconnectd', '/usr/lib/x86_64-linux-gnu/libexec/kdeconnectd'].find((f) => fs.existsSync(f));
  if (bin) {
    try {
      fs.mkdirSync(path.dirname(logFile()), { recursive: true });
      try { if (fs.statSync(logFile()).size > 4e6) fs.renameSync(logFile(), logFile() + '.old'); } catch { /* new log */ }
      const out = fs.openSync(logFile(), 'a');
      fs.writeSync(out, `\n--- ${new Date().toISOString()} started by LiquidDesktop ---\n`);
      const env = { ...process.env, QT_FORCE_STDERR_LOGGING: '1', QT_LOGGING_RULES: 'kdeconnect.plugin.share.debug=true;kdeconnect.core.debug=true;kdeconnect.core.info=true;kdeconnect.core.warning=true' };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = require('child_process').spawn(bin, [], { detached: true, stdio: ['ignore', out, out], env });
      child.unref();
      fs.closeSync(out);
      watchLog();
      for (let i = 0; i < 30; i++) { if (await busCall('NameHasOwner', 's', [SVC]).catch(() => false)) return; await new Promise((r) => setTimeout(r, 200)); }
    } catch (e) { console.error('[kdeconnect] could not start kdeconnectd:', e.message); }
  }
  await busCall('StartServiceByName', 'su', [SVC, 0]).catch(() => {});
}

/* ------------------------------------------------------------------ start */
async function start() {
  if (!dbus || !process.env.DBUS_SESSION_BUS_ADDRESS) return;
  try { bus = dbus.sessionBus(); } catch { bus = null; return; }
  bus.on('error', () => {});
  try {
    await busCall('AddMatch', 's', [`type='signal',sender='${SVC}'`]);
    await busCall('AddMatch', 's', [`type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${SVC}'`]);
  } catch { /* no live updates */ }
  bus.on('message', (msg) => {
    if (msg.type !== dbus.MessageType.SIGNAL) return;
    if (msg.member === 'NameOwnerChanged') { if (msg.body?.[0] === SVC) refreshSoon(400); return; }
    if (!msg.path?.startsWith(ROOT)) return;
    const devId = (msg.path.match(/devices\/([^/]+)/) || [])[1];
    // messages, calls and contacts are handled on their own: they don't change the phone's state
    if (msg.interface === CONV) {
      if (msg.member === 'conversationCreated' || msg.member === 'conversationUpdated') { const m = parseMessage(msg.body[0]); if (storeMessage(devId, m)) smsChanged(devId, m.thread); }
      else if (msg.member === 'conversationRemoved') { loadCache(devId).delete(num(msg.body[0])); saveCache(devId); smsChanged(devId, num(msg.body[0])); }
      else if (msg.member === 'conversationLoaded') loaded.get(devId + '/' + num(msg.body[0]))?.();
      else if (msg.member === 'attachmentReceived') { for (const [uid, res] of attachmentWait) if (String(msg.body[1]).includes(uid) || attachmentWait.size === 1) { res(msg.body[0]); break; } }
      return;
    }
    if (msg.member === 'shareReceived') { received(devId, msg.body?.[0]); return; }
    if (msg.member === 'callReceived') { addCall(devId, msg.body[0], msg.body[1], msg.body[2]); return; }
    if (msg.member === 'localCacheSynchronized') { syncWait.get(devId)?.(true); for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.getType() !== 'webview') wc.send('kdc:contacts', devId); return; }
    // the phone can update its media position every second: that alone doesn't need a redraw
    if (msg.member === 'PropertiesChanged' && /mprisremote$/.test(msg.path) && Object.keys(unwrap(msg.body?.[1]) || {}).every((k) => k === 'position')) return;
    refreshSoon();
  });
  // start the background service (it's D-Bus activated, like on Plasma) — only if the user wants their phone
  const owner = await busCall('NameHasOwner', 's', [SVC]).catch(() => false);
  if (!owner && settings().enabled !== false) await startDaemon();
  else if (owner) watchLog();   // started earlier by LiquidDesktop (this is a restart): its log is still being written
  await readAll().catch(() => {});
  broadcast();
  // battery and signal changes arrive as signals; a slow look now and then catches anything missed
  setInterval(() => { if (state.running) refreshSoon(0); }, 60_000);
}

// stored next to the other main-process settings (main/system.js reads the same folder)
const cfgFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(require('os').homedir(), '.config'), 'LiquidDesktop', 'phone.json');
function settings() { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch { return {}; } }
function saveSettings(s) { fs.mkdirSync(path.dirname(cfgFile()), { recursive: true }); fs.writeFileSync(cfgFile(), JSON.stringify(s, null, 1)); }

/* ------------------------------------------------------------------ for other modules */
/** Batteries of connected phones and tablets, for the Batteries widget (main/system.js). */
function batteries() {
  return state.devices.filter((d) => d.paired && d.reachable && d.battery).map((d) => ({
    name: d.name, kind: d.type === 'tablet' ? 'tablet' : 'phone', percent: d.battery.percent, charging: d.battery.charging, phone: true, id: d.id }));
}

const dev = (id) => `${ROOT}/devices/${String(id).replace(/[^\w-]/g, '')}`;
const dev_ = dev;
const fileUrl = (p) => (/^[a-z]+:\/\//.test(p) ? p : 'file://' + encodeURI(p));
async function act(id, what, arg) {
  if (!bus) throw new Error('KDE Connect isn’t available');
  const base = dev(id);
  switch (what) {
    case 'pair': return call(base, DEV, 'requestPairing');
    case 'unpair': return call(base, DEV, 'unpair');
    case 'accept': return call(base, DEV, 'acceptPairing');
    case 'reject': return call(base, DEV, 'cancelPairing');
    case 'ring': return call(base + '/findmyphone', PI('findmyphone'), 'ring');
    case 'ping': return call(base + '/ping', PI('ping'), arg ? 'sendPing' : 'sendPing', arg ? 's' : '', arg ? [String(arg)] : []);
    case 'clipboard': return call(base + '/clipboard', PI('clipboard'), 'sendClipboard');
    case 'share': return call(base + '/share', PI('share'), 'shareUrls', 'as', [(Array.isArray(arg) ? arg : [arg]).map(fileUrl)]);
    case 'shareText': return call(base + '/share', PI('share'), 'shareText', 's', [String(arg)]);
    case 'shareUrl': return call(base + '/share', PI('share'), 'shareUrl', 's', [String(arg)]);
    case 'media': return call(base + '/mprisremote', PI('mprisremote'), 'sendAction', 's', [String(arg)]);
    case 'mediaVolume': return call(base + '/mprisremote', 'org.freedesktop.DBus.Properties', 'Set', 'ssv', [PI('mprisremote'), 'volume', new dbus.Variant('i', Math.round(arg))]);
    case 'mediaPlayer': return call(base + '/mprisremote', 'org.freedesktop.DBus.Properties', 'Set', 'ssv', [PI('mprisremote'), 'player', new dbus.Variant('s', String(arg))]);
    case 'dismiss': return call(`${base}/notifications/${String(arg).replace(/[^\w-]/g, '')}`, PI('notifications.notification'), 'dismiss');
    case 'reply': return call(base + '/notifications', PI('notifications'), 'sendReply', 'ss', [String(arg.replyId), String(arg.text)]);
    case 'notifAction': return call(base + '/notifications', PI('notifications'), 'sendAction', 'ss', [String(arg.key), String(arg.action)]);
    // typing on the phone (its KDE Connect keyboard has to be the active one): a character, or a special key
    // (1 backspace, 12 enter, 4–7 arrows left/up/right/down…)
    case 'key': return call(base + '/remotekeyboard', PI('remotekeyboard'), 'sendKeyPress', 'sibbbbb', [String(arg.key || ''), arg.special | 0, !!arg.shift, !!arg.ctrl, !!arg.alt, false, false]);
    case 'seek': return call(base + '/mprisremote', PI('mprisremote'), 'seek', 'i', [Math.round(arg)]);
    case 'position': return call(base + '/mprisremote', 'org.freedesktop.DBus.Properties', 'Set', 'ssv', [PI('mprisremote'), 'position', new dbus.Variant('i', Math.round(arg))]);
    case 'feature': return call(base, DEV, 'setPluginEnabled', 'sb', ['kdeconnect_' + arg.id, !!arg.on]);
    // the phone's storage: mounted over SFTP (takes a few seconds), then shown in Files
    case 'browse': {
      const ok = await call(base + '/sftp', PI('sftp'), 'mountAndWait');
      if (!ok) throw new Error(await call(base + '/sftp', PI('sftp'), 'getMountError').catch(() => '') || 'The phone didn’t allow it. Unlock it and try again.');
      const dirs = await call(base + '/sftp', PI('sftp'), 'getDirectories').catch(() => ({})) || {};
      const mount = await call(base + '/sftp', PI('sftp'), 'mountPoint');
      // the folder the phone suggests (its internal storage), else the mount itself
      const first = Object.keys(dirs).find((k) => fs.existsSync(k));
      refreshSoon();
      return first || mount;
    }
    case 'unmount': return call(base + '/sftp', PI('sftp'), 'unmount');
    default: throw new Error('Unknown action ' + what);
  }
}

function register() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (err) { return { __error: String(err.message || err).replace(/^.*?: /, '') }; } });
  h('kdc:state', async () => { if (bus && !pending) await readAll().catch(() => {}); return state; });
  h('kdc:act', async (id, what, arg) => { const r = await act(id, what, arg); refreshSoon(250); return r ?? true; });
  h('kdc:rename', async (name) => { await call(ROOT, DAEMON, 'setAnnouncedName', 's', [String(name).slice(0, 64)]); refreshSoon(); return true; });
  h('kdc:refresh', async () => { await call(ROOT, DAEMON, 'forceOnNetworkChange').catch(() => {}); refreshSoon(1500); return true; });
  // turn the whole thing on or off (off: the background service is stopped, and isn't started at login)
  h('kdc:setEnabled', async (on) => {
    saveSettings({ ...settings(), enabled: !!on });
    if (on) await startDaemon();
    else await bus?.call(new dbus.Message({ destination: SVC, path: '/MainApplication', interface: 'org.qtproject.Qt.QCoreApplication', member: 'quit' })).catch(() => {});
    refreshSoon(800);
    return true;
  });
  h('kdc:settings', () => settings());
  // Settings › Phone › Save received files in: every paired device gets the new folder
  h('kdc:setReceiveDir', (dir) => {
    saveSettings({ ...settings(), receiveDir: dir ? String(dir) : undefined });
    for (const d of state.devices) setupReceiving(d, true);
    refreshSoon();
    return receiveDir();
  });
  h('kdc:conversations', (d, refresh) => conversations(String(d), !!refresh));
  h('kdc:conversation', (d, thread, count) => conversation(String(d), Number(thread), Number(count) || 60));
  h('kdc:sendText', async (d, o) => { await sendText(String(d), o); return true; });
  h('kdc:fetchLatest', async (d, thread) => { if (thread == null) await call(dev_(String(d)) + '/sms', PI('sms'), 'requestAllConversations').catch(() => {}); else await fetchLatest(String(d), Number(thread)); return true; });
  h('kdc:attachment', (d, part, uid) => attachment(String(d), Number(part), String(uid)));
  h('kdc:contacts', (d) => contacts(String(d)));
  h('kdc:syncContacts', (d) => syncContacts(String(d)));
  h('kdc:calls', () => loadCalls());
  h('kdc:clearCalls', () => { calls = []; try { fs.writeFileSync(callsFile(), '[]'); } catch { /* fine */ } return true; });
  start().catch((e) => console.error('[kdeconnect]', e.message));
}

module.exports = { register, batteries, FEATURES };
