// Accessibility: the screen reader (Orca), the keyboard's AccessX controls (Sticky, Slow and Bounce Keys — set by
// the window manager, main/wm.js), and what the Zoom lens needs (where the pointer is, which screen to magnify).
// Reduce motion, Increase contrast and the pointer size are applied by the web side and the cursor code.
const { ipcMain, app, screen, desktopCapturer } = require('electron');
const { spawn } = require('child_process');
const { which, run, installPackages, handler, pkgManager } = require('./common');

let orca = null;
let wmRef = null;
let lastKeys = null;

async function orcaRunning() { const r = await run('pgrep', ['-x', 'orca'], { timeout: 3000 }); return r.ok; }
async function status() {
  return { orca: !!which('orca'), orcaRunning: await orcaRunning(), keys: !!wmRef, pm: pkgManager()?.name || null, session: !!wmRef };
}
// The accessibility bus has to say a screen reader is on, or apps (GTK, Qt, Chromium) don't expose their contents
async function a11yBus(on) {
  if (!which('gdbus')) return;
  for (const prop of ['IsEnabled', 'ScreenReaderEnabled']) {
    await run('gdbus', ['call', '--session', '--dest', 'org.a11y.Bus', '--object-path', '/org/a11y/bus', '--method', 'org.freedesktop.DBus.Properties.Set', 'org.a11y.Status', prop, `<${on ? 'true' : 'false'}>`], { timeout: 3000 });
  }
}
async function screenReader(on) {
  if (on) {
    if (!which('orca')) throw new Error('not installed');
    app.setAccessibilitySupportEnabled(true);   // LiquidDesktop's own windows describe themselves to Orca
    await a11yBus(true);
    if (!(await orcaRunning())) {
      orca = spawn('orca', ['--replace'], { detached: true, stdio: 'ignore', env: { ...process.env, GTK_MODULES: [process.env.GTK_MODULES, 'gail:atk-bridge'].filter(Boolean).join(':') } });
      orca.unref();
    }
  } else {
    if (which('orca')) await run('orca', ['--quit'], { timeout: 4000 });
    if (await orcaRunning()) await run('pkill', ['-x', 'orca'], { timeout: 3000 });
    orca = null;
    await a11yBus(false);
    app.setAccessibilitySupportEnabled(false);
  }
  return status();
}
async function installOrca() {
  await installPackages({ pacman: ['orca'], apt: ['orca'], dnf: ['orca'] }, 'The screen reader');
  return status();
}
/** Sticky / Slow / Bounce Keys: only in a LiquidDesktop session (the window manager owns the X connection). */
async function keys(o) {
  lastKeys = o;
  if (!wmRef?.setAccessX) return false;
  return wmRef.setAccessX(o);
}

/** Zoom: where the pointer is, and the display it's on (DIP coordinates, like the shell's). */
function cursor() {
  const p = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(p);
  return { x: p.x, y: p.y, display: { id: d.id, x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height, scale: d.scaleFactor } };
}
/** Zoom: the capture source of every screen (the shell plays it as a video and shows a magnified part of it). */
async function sources() {
  const s = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const displays = screen.getAllDisplays();
  return s.map((x, i) => {
    const d = displays.find((dd) => String(dd.id) === String(x.display_id)) || displays[i] || screen.getPrimaryDisplay();
    return { id: x.id, displayId: d.id, x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height, scale: d.scaleFactor };
  });
}

function register({ wm } = {}) {
  wmRef = wm || null;
  const h = handler(ipcMain);
  h('a11y:status', status);
  h('a11y:screenReader', screenReader);
  h('a11y:installOrca', installOrca);
  h('a11y:keys', keys);
  h('a11y:cursor', cursor);
  h('a11y:sources', sources);
  // the X server forgets AccessX when it restarts; the shell sends the settings again at start-up (a11y:keys)
  void lastKeys;
}
module.exports = { register };
