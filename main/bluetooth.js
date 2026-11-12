// Bluetooth through BlueZ's D-Bus API (the system bus): the controller, known and nearby devices, scanning,
// pairing, connecting and forgetting. A pairing agent answers BlueZ's questions while pairing: it accepts
// the devices you chose to pair and shows a code when the device needs one typed in (keyboards).
const { ipcMain, webContents } = require('electron');
let dbus = null;
try { dbus = require('dbus-next'); } catch { dbus = null; }

const AGENT_PATH = '/org/liquiddesktop/bluetooth/agent';
let bus = null, agentReady = null, scanTimer = null;
const pairing = new Set();   // device object paths we asked to pair: only these get auto-confirmed

function getBus() {
  if (bus || !dbus) return bus;
  try { bus = dbus.systemBus(); bus.on('error', () => {}); } catch { bus = null; }
  return bus;
}
const call = (path, iface, member, signature = '', body = []) =>
  getBus().call(new dbus.Message({ destination: 'org.bluez', path, interface: iface, member, signature, body })).then((r) => r.body);
const plain = (v) => (v instanceof dbus.Variant ? plain(v.value) : Array.isArray(v) ? v.map(plain) : v);
const setProp = (path, iface, name, sig, value) => call(path, 'org.freedesktop.DBus.Properties', 'Set', 'ssv', [iface, name, new dbus.Variant(sig, value)]);
const broadcast = (ch, ...a) => { for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.getType() !== 'webview') wc.send(ch, ...a); };

async function objects() {
  const [objs] = await call('/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects');
  return Object.entries(objs).map(([path, ifaces]) => [path, Object.fromEntries(Object.entries(ifaces).map(([k, props]) => [k, Object.fromEntries(Object.entries(props).map(([p, v]) => [p, plain(v)]))]))]);
}
async function adapterPath() {
  const a = (await objects()).find(([, i]) => i['org.bluez.Adapter1']);
  return a?.[0] || null;
}

// devices for Settings / Control Center: paired ones first, then nearby ones that have a name
async function state() {
  if (!getBus()) return { available: false };
  let objs;
  try { objs = await objects(); } catch { return { available: false }; }
  const ad = objs.find(([, i]) => i['org.bluez.Adapter1']);
  if (!ad) return { available: false };
  const a = ad[1]['org.bluez.Adapter1'];
  const devices = objs.filter(([p, i]) => i['org.bluez.Device1'] && p.startsWith(ad[0] + '/')).map(([path, i]) => {
    const d = i['org.bluez.Device1'];
    const battery = i['org.bluez.Battery1']?.Percentage;
    return { path, address: d.Address, name: d.Alias || d.Name || d.Address, named: !!d.Name, icon: d.Icon || '', paired: !!d.Paired, trusted: !!d.Trusted,
      connected: !!d.Connected, rssi: d.RSSI ?? null, battery: battery ?? null, pairing: pairing.has(path) };
  }).filter((d) => d.paired || d.connected || d.named)
    .sort((x, y) => (y.paired - x.paired) || (y.connected - x.connected) || ((y.rssi ?? -999) - (x.rssi ?? -999)) || x.name.localeCompare(y.name));
  return { available: true, powered: !!a.Powered, discovering: !!a.Discovering, name: a.Alias || a.Name || 'Bluetooth', address: a.Address, devices };
}

/* ------------------------------------------------------------------ pairing agent */
function agentInterface() {
  const { Interface } = dbus.interface;
  const { DBusError } = dbus;
  const ours = (dev) => { if (!pairing.has(dev)) throw new DBusError('org.bluez.Error.Rejected', 'Not pairing this device'); };
  class Agent extends Interface {
    Release() {}
    Cancel() { broadcast('bt:code', null); }
    RequestPinCode(dev) { ours(dev); return '0000'; }
    RequestPasskey(dev) { ours(dev); return 0; }
    DisplayPinCode(dev, code) { broadcast('bt:code', { path: dev, code: String(code) }); }
    DisplayPasskey(dev, key) { broadcast('bt:code', { path: dev, code: String(key).padStart(6, '0') }); }
    // "do these numbers match?": shown, and accepted because you started this pairing
    RequestConfirmation(dev, key) { ours(dev); broadcast('bt:code', { path: dev, code: String(key).padStart(6, '0'), confirm: true }); }
    RequestAuthorization(dev) { ours(dev); }
    // a device asking to use a service: only devices already paired with this computer
    async AuthorizeService(dev) {
      const [v] = await call(dev, 'org.freedesktop.DBus.Properties', 'Get', 'ss', ['org.bluez.Device1', 'Paired']).catch(() => [null]);
      if (!plain(v)) throw new DBusError('org.bluez.Error.Rejected', 'Not paired');
    }
  }
  Agent.configureMembers({ methods: {
    Release: { inSignature: '', outSignature: '' }, Cancel: { inSignature: '', outSignature: '' },
    RequestPinCode: { inSignature: 'o', outSignature: 's' }, RequestPasskey: { inSignature: 'o', outSignature: 'u' },
    DisplayPinCode: { inSignature: 'os', outSignature: '' }, DisplayPasskey: { inSignature: 'ouq', outSignature: '' },
    RequestConfirmation: { inSignature: 'ou', outSignature: '' }, RequestAuthorization: { inSignature: 'o', outSignature: '' },
    AuthorizeService: { inSignature: 'os', outSignature: '' },
  } });
  return new Agent('org.bluez.Agent1');
}
function ensureAgent() {
  if (agentReady) return agentReady;
  agentReady = (async () => {
    getBus().export(AGENT_PATH, agentInterface());
    await call('/org/bluez', 'org.bluez.AgentManager1', 'RegisterAgent', 'os', [AGENT_PATH, 'KeyboardDisplay']);
    await call('/org/bluez', 'org.bluez.AgentManager1', 'RequestDefaultAgent', 'o', [AGENT_PATH]).catch(() => {});
  })().catch((e) => { agentReady = null; throw e; });
  return agentReady;
}

/* ------------------------------------------------------------------ actions */
const errText = (e) => {
  const m = String(e?.message || e);
  if (/AuthenticationFailed|AuthenticationRejected/.test(m)) return 'The device refused to pair. Make sure it’s in pairing mode and try again.';
  if (/AuthenticationTimeout|Timeout|timed out/i.test(m)) return 'The device didn’t answer. Make sure it’s on, close by and in pairing mode.';
  if (/AlreadyExists/.test(m)) return 'This device is already paired.';
  if (/NotReady/.test(m)) return 'Turn Bluetooth on first.';
  if (/page-timeout|ConnectionAttemptFailed|br-connection/i.test(m)) return 'Couldn’t reach the device. Make sure it’s on and close by.';
  return m.replace(/^org\.bluez\.Error\.\w+:?\s*/, '') || 'Something went wrong.';
};
async function scan(on) {
  const ad = await adapterPath();
  if (!ad) throw new Error('No Bluetooth controller');
  clearTimeout(scanTimer);
  if (on) {
    await call(ad, 'org.bluez.Adapter1', 'StartDiscovery').catch((e) => { if (!/InProgress/.test(e.message)) throw e; });
    scanTimer = setTimeout(() => scan(false).catch(() => {}), 60_000);   // scanning drains batteries: stop after a minute
  } else await call(ad, 'org.bluez.Adapter1', 'StopDiscovery').catch(() => {});
  return true;
}
async function pair(path) {
  await ensureAgent().catch(() => {});   // without an agent, devices that need no code still pair
  pairing.add(path);
  broadcast('bt:changed');
  try {
    await call(path, 'org.bluez.Device1', 'Pair').catch((e) => { if (!/AlreadyExists/.test(e.message)) throw e; });
    await setProp(path, 'org.bluez.Device1', 'Trusted', 'b', true).catch(() => {});
    await call(path, 'org.bluez.Device1', 'Connect').catch(() => {});   // some devices only pair; that's fine
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errText(e) };
  } finally {
    pairing.delete(path);
    broadcast('bt:code', null);
    broadcast('bt:changed');
  }
}
async function connect(path, on) {
  try {
    await call(path, 'org.bluez.Device1', on ? 'Connect' : 'Disconnect');
    return { ok: true };
  } catch (e) { return { ok: false, error: errText(e) }; } finally { broadcast('bt:changed'); }
}
async function forget(path) {
  const ad = await adapterPath();
  try { await call(ad, 'org.bluez.Adapter1', 'RemoveDevice', 'o', [path]); return { ok: true }; } catch (e) { return { ok: false, error: errText(e) }; } finally { broadcast('bt:changed'); }
}
async function power(on) {
  const ad = await adapterPath();
  if (!ad) return false;
  if (on) {   // a soft-blocked controller can't be powered on: unblock it first
    await new Promise((res) => require('child_process').execFile('rfkill', ['unblock', 'bluetooth'], () => res()));
  }
  await setProp(ad, 'org.bluez.Adapter1', 'Powered', 'b', !!on);
  broadcast('bt:changed');
  return true;
}

// BlueZ announces every change (device found, connected, battery…): pass a debounced "changed" on
let watching = false, pendingChange = null;
function watch() {
  if (watching || !getBus()) return;
  watching = true;
  // AddMatch goes to the bus daemon, not BlueZ
  const add = (m) => getBus().call(new dbus.Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: [m] })).catch(() => {});
  add("type='signal',sender='org.bluez',interface='org.freedesktop.DBus.Properties'");
  add("type='signal',sender='org.bluez',interface='org.freedesktop.DBus.ObjectManager'");
  getBus().on('message', (m) => {
    if (m.type !== 4 || !/Properties|ObjectManager/.test(m.interface || '')) return;
    if (pendingChange) return;
    pendingChange = setTimeout(() => { pendingChange = null; broadcast('bt:changed'); }, 400);
  });
}

function register() {
  const h = (name, fn) => ipcMain.handle(name, async (_e, ...a) => { try { return await fn(...a); } catch (e) { return { __error: errText(e) }; } });
  h('bt:state', () => { watch(); return state(); });
  h('bt:scan', (on) => scan(on));
  h('bt:pair', (p) => pair(String(p)));
  h('bt:connect', (p, on) => connect(String(p), !!on));
  h('bt:forget', (p) => forget(String(p)));
  h('bt:power', (on) => power(on));
}

module.exports = { register, state, power };
