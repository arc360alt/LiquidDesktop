// Power mode (Settings › Battery): Power Saver / Balanced / Performance, through power-profiles-daemon
// (the service GNOME and KDE use; tuned-ppd provides the same interface). Switching needs no password for the
// person at the computer (the daemon's polkit rule allows the active session).
const { ipcMain, webContents } = require('electron');
let dbus = null;
try { dbus = require('dbus-next'); } catch { dbus = null; }

const NAMES = [['org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles'], ['net.hadess.PowerProfiles', '/net/hadess/PowerProfiles']];
let bus = null, svc = null, watching = false;
const plain = (v) => (v instanceof dbus.Variant ? plain(v.value) : Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);
const call = (iface, member, signature = '', body = []) => bus.call(new dbus.Message({ destination: svc[0], path: svc[1], interface: iface, member, signature, body })).then((r) => r.body);

async function connect() {
  if (svc) return true;
  if (!dbus) return false;
  try { bus ||= dbus.systemBus(); bus.on('error', () => {}); } catch { return false; }
  for (const n of NAMES) {
    try { await bus.call(new dbus.Message({ destination: n[0], path: n[1], interface: 'org.freedesktop.DBus.Peer', member: 'Ping' })); svc = n; break; } catch { /* not this one */ }
  }
  if (svc && !watching) {
    watching = true;
    // another app (or the battery running low) changed it: tell the pages
    bus.call(new dbus.Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's',
      body: [`type='signal',interface='org.freedesktop.DBus.Properties',path='${svc[1]}'`] })).catch(() => {});
    bus.on('message', (m) => {
      if (m.type !== 4 || m.path !== svc?.[1] || m.member !== 'PropertiesChanged') return;
      for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.getType() !== 'webview') wc.send('power:changed');
    });
  }
  return !!svc;
}

async function state() {
  if (!(await connect())) return { available: false };
  const iface = svc[0];
  const [props] = await call('org.freedesktop.DBus.Properties', 'GetAll', 's', [iface]);
  const p = plain(props);
  return {
    available: true,
    active: p.ActiveProfile,
    profiles: (p.Profiles || []).map((x) => x.Profile).filter(Boolean),
    // "lap-detected", "high-operating-temperature"…: why Performance is held back right now
    degraded: p.PerformanceDegraded || '',
    inhibited: p.PerformanceInhibited || '',
  };
}

async function set(profile) {
  if (!(await connect())) throw new Error('Power modes need power-profiles-daemon (sudo pacman -S power-profiles-daemon).');
  const st = await state();
  if (!st.profiles.includes(profile)) throw new Error('This computer doesn’t have that power mode.');
  await call('org.freedesktop.DBus.Properties', 'Set', 'ssv', [svc[0], 'ActiveProfile', new dbus.Variant('s', profile)]);
  return state();
}

function register() {
  const h = (n, fn) => ipcMain.handle(n, async (_e, ...a) => { try { return await fn(...a); } catch (e) { return { __error: e.message.replace(/^.*AccessDenied:?\s*/, 'Not allowed: ') }; } });
  h('power:state', () => state());
  h('power:set', (p) => set(String(p)));
}

module.exports = { register, state };
