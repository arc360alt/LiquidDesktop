// Screen sleep, auto-lock and the lid (Settings › Lock Screen), in the LiquidDesktop session:
//  - after a while without keyboard or mouse the display turns off (X DPMS), and the screen locks once the display
//    has been off for the "require password after" time; optionally the computer sleeps after longer
//  - apps that play video or present keep the display on: the standard org.freedesktop.ScreenSaver Inhibit service
//    (browsers, mpv, VLC, Steam… call it), plus anything holding a logind "idle" inhibitor
//  - before the computer sleeps (lid, menu, idle) the screen is locked first (logind delay inhibitor), so it never
//    wakes up unlocked
//  - closing the lid: Sleep (logind does it, as before), Lock and turn off the display, or Do nothing (we hold
//    logind's handle-lid-switch inhibitor and act on UPower's LidIsClosed instead)
// The X server's own blanking (on by default, after 10 minutes) is turned off: this does it instead.
const { ipcMain, powerMonitor, app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = () => path.join(app.getPath('userData'), 'power.json');
const DEFAULTS = { displayOffBattery: 2, displayOffAC: 10, sleepBattery: 15, sleepAC: 0, lockAfter: 0, lid: 'sleep', lidAC: 'sleep' };
// minutes (0 = never); lockAfter: seconds after the display turns off (-1 = don't lock)
let cfg = { ...DEFAULTS };
try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE(), 'utf8')) }; } catch { /* first run */ }
const save = () => { try { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(cfg, null, 2)); } catch { /* read-only */ } };

let dbus, sys, wm, lockScreen, dpms = null;
const inhibits = new Map();   // cookie → { sender, app, reason }
let displayOff = false, offAt = 0, lidClosed = false, lidFd = null, sleepFd = null, lockedForSleep = false;

const onBattery = () => { try { return powerMonitor.isOnBatteryPower(); } catch { return false; } };
const minutes = (k) => (cfg[k] || 0) * 60;

function setDisplay(on) {
  if (!dpms) return;
  try { if (on) dpms.ForceLevel(0); else { dpms.Enable(); dpms.ForceLevel(3); } wm.X.pack_stream.flush?.(); } catch { /* no DPMS */ }
}

/* ------------------------------------------------------------------ idle */
let lastIdle = 0;
function tick() {
  if (wm.locked === undefined) { /* the shell tells the WM when it locks */ }
  const idle = powerMonitor.getSystemIdleTime();
  const active = idle < lastIdle;   // someone touched the keyboard or mouse since the last tick
  lastIdle = idle;
  if (active && displayOff) { displayOff = false; offAt = 0; }
  // something wants the screen on (a video, a presentation): nothing happens, whatever the idle time
  if (inhibits.size) return;
  const offAfter = minutes(onBattery() ? 'displayOffBattery' : 'displayOffAC');
  const sleepAfter = minutes(onBattery() ? 'sleepBattery' : 'sleepAC');
  if (offAfter && idle >= offAfter && !displayOff) { displayOff = true; offAt = Date.now(); setDisplay(false); }
  if (displayOff && cfg.lockAfter >= 0 && !wm.locked && Date.now() - offAt >= cfg.lockAfter * 1000) lockScreen();
  if (sleepAfter && idle >= sleepAfter) { lastIdle = 0; suspend(); }
}

/* ------------------------------------------------------------------ logind / UPower */
const login1 = (member, signature = '', body = []) => sys.call(new dbus.Message({ destination: 'org.freedesktop.login1', path: '/org/freedesktop/login1', interface: 'org.freedesktop.login1.Manager', member, signature, body }));
// A logind inhibitor is a file descriptor held open; dbus-next can't receive one here (no fd passing without its
// native socket module), so systemd-inhibit holds it for us: running = held, killed = released.
function inhibit(what, mode, why) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const c = spawn('systemd-inhibit', [`--what=${what}`, '--who=LiquidDesktop', `--why=${why}`, `--mode=${mode}`, 'sleep', 'infinity'], { stdio: 'ignore' });
    c.on('error', reject);
    c.on('exit', (code) => reject(new Error(`systemd-inhibit exited (${code})`)));
    setTimeout(() => resolve(c), 300);   // still running: it holds the inhibitor
  });
}
const closeFd = (c) => { try { c?.kill(); } catch { /* gone */ } };
app.on('will-quit', () => { closeFd(lidFd); closeFd(sleepFd); });
function suspend() { login1('Suspend', 'b', [true]).catch((e) => console.log('[idle] suspend:', e.message)); }

/** Lid choice: 'sleep' leaves it to logind; anything else holds its handle-lid-switch inhibitor and acts here. */
async function applyLid() {
  const want = onBattery() ? cfg.lid : cfg.lidAC;
  if (want === 'sleep') { closeFd(lidFd); lidFd = null; return; }
  if (lidFd == null) lidFd = await inhibit('handle-lid-switch', 'block', 'Lid behaviour is set in Settings › Lock Screen').catch((e) => { console.log('[idle] lid inhibitor:', e.message); return null; });
}
function onLid(closed) {
  if (closed === lidClosed) return;
  lidClosed = closed;
  const want = onBattery() ? cfg.lid : cfg.lidAC;
  if (want === 'sleep') return;   // logind suspends; PrepareForSleep locks first
  if (closed && want === 'lock') { lockScreen(); setTimeout(() => setDisplay(false), 400); displayOff = true; offAt = Date.now(); }
  if (!closed) { setDisplay(true); displayOff = false; }
}

async function watchSystem() {
  sys = dbus.systemBus();
  sys.on('error', () => {});
  const match = (rule) => sys.call(new dbus.Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: [rule] })).catch(() => {});
  await match("type='signal',interface='org.freedesktop.login1.Manager',member='PrepareForSleep'");
  await match("type='signal',interface='org.freedesktop.DBus.Properties',path='/org/freedesktop/UPower'");
  sys.on('message', (m) => {
    if (m.member === 'PrepareForSleep') {
      if (m.body[0]) {
        // going to sleep: lock first (the delay inhibitor gives us a moment), then let it go
        if (!wm.locked) { lockScreen(); lockedForSleep = true; }
        setTimeout(() => { closeFd(sleepFd); sleepFd = null; }, 600);
      } else {
        // awake again: hold the delay inhibitor for the next time, and light the screen
        lockedForSleep = false;
        setDisplay(true); displayOff = false;
        inhibit('sleep', 'delay', 'Lock the screen before sleeping').then((fd) => { sleepFd = fd; }).catch(() => {});
      }
    }
    if (m.member === 'PropertiesChanged' && m.path === '/org/freedesktop/UPower' && m.body?.[1]?.LidIsClosed) onLid(!!m.body[1].LidIsClosed.value);
    if (m.member === 'PropertiesChanged' && m.path === '/org/freedesktop/UPower' && m.body?.[1]?.OnBattery) applyLid();
  });
  sleepFd = await inhibit('sleep', 'delay', 'Lock the screen before sleeping').catch(() => null);
  try {
    const r = await sys.call(new dbus.Message({ destination: 'org.freedesktop.UPower', path: '/org/freedesktop/UPower', interface: 'org.freedesktop.DBus.Properties', member: 'Get', signature: 'ss', body: ['org.freedesktop.UPower', 'LidIsClosed'] }));
    lidClosed = !!r.body[0].value;
  } catch { /* no UPower */ }
  await applyLid();
}

/* ------------------------------------------------------------------ org.freedesktop.ScreenSaver (session bus) */
async function screenSaverService() {
  const sess = dbus.sessionBus();
  sess.on('error', () => {});
  let next = 1;
  const { Interface } = dbus.interface;
  class SS extends Interface {
    Inhibit(appName, reason) { const c = next++; inhibits.set(c, { sender: this.__sender, app: appName, reason }); return c; }
    UnInhibit(cookie) { inhibits.delete(cookie); }
    GetActive() { return !!wm.locked; }
    SetActive(on) { if (on) { lockScreen(); return true; } return false; }
    Lock() { lockScreen(); }
    GetActiveTime() { return 0; }
    SimulateUserActivity() { if (displayOff) { setDisplay(true); displayOff = false; } }
  }
  SS.configureMembers({ methods: {
    Inhibit: { inSignature: 'ss', outSignature: 'u' }, UnInhibit: { inSignature: 'u', outSignature: '' }, GetActive: { inSignature: '', outSignature: 'b' },
    SetActive: { inSignature: 'b', outSignature: 'b' }, Lock: { inSignature: '', outSignature: '' }, GetActiveTime: { inSignature: '', outSignature: 'u' },
    SimulateUserActivity: { inSignature: '', outSignature: '' } } });
  // which app asked: dbus-next doesn't pass the sender to methods, so note it from the incoming message
  sess.addMethodHandler((msg) => { if (msg.interface === 'org.freedesktop.ScreenSaver' && msg.member === 'Inhibit') lastSender = msg.sender; return false; });
  const iface = new SS('org.freedesktop.ScreenSaver');
  Object.defineProperty(iface, '__sender', { get: () => lastSender });
  sess.export('/org/freedesktop/ScreenSaver', iface);
  sess.export('/ScreenSaver', iface);
  const r = await sess.requestName('org.freedesktop.ScreenSaver', 4 /* do not queue */);
  if (r !== 1) { console.log('[idle] another screen saver service is running'); return; }
  // an app that quits (or crashes) without UnInhibit: its inhibits go with it
  await sess.call(new dbus.Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's',
    body: ["type='signal',sender='org.freedesktop.DBus',member='NameOwnerChanged'"] })).catch(() => {});
  sess.on('message', (m) => {
    if (m.member !== 'NameOwnerChanged' || m.body[2]) return;
    for (const [c, x] of inhibits) if (x.sender === m.body[0]) inhibits.delete(c);
  });
}
let lastSender = null;

/** Session only. lockFn locks the screen (the shell's lock screen). */
async function register({ wm: theWm, lock }) {
  wm = theWm; lockScreen = () => { if (!wm.locked) lock(); };
  try { dbus = require('dbus-next'); } catch { return; }
  // the X server's own blanking off: we decide when the display sleeps
  try { wm.X.SetScreenSaver?.(0, 0, 0, 0); } catch { /* */ }
  await new Promise((res) => wm.X.require('dpms', (err, D) => { dpms = err ? null : D; try { dpms?.SetTimeouts(0, 0, 0); dpms?.Enable(); } catch { /* */ } res(); }));
  setInterval(() => { try { tick(); } catch (e) { console.error('[idle]', e.message); } }, 5000);
  powerMonitor.on('on-battery', () => applyLid().catch(() => {}));
  powerMonitor.on('on-ac', () => applyLid().catch(() => {}));
  watchSystem().catch((e) => console.log('[idle] logind/UPower:', e.message));
  screenSaverService().catch((e) => console.log('[idle] screen saver service:', e.message));
}

function registerIpc() {
  ipcMain.handle('power:idleSettings', (_e, patch) => {
    if (patch && typeof patch === 'object') { for (const k of Object.keys(DEFAULTS)) if (k in patch) cfg[k] = patch[k]; save(); applyLid().catch(() => {}); }
    return { ...cfg, inhibitors: [...inhibits.values()].map((x) => ({ app: x.app, reason: x.reason })), hasLid: lidClosed != null, session: !!wm };
  });
}

module.exports = { register, registerIpc };
