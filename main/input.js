// Mouse & trackpad settings for every pointing device: tracking speed, acceleration, scrolling,
// button swap, middle-click emulation, tap to click, disable while typing.
//   • X11 session → xinput (libinput properties); saved and re-applied at login and when devices appear
//   • Testing window → settings are only saved; the host desktop's own mouse settings are never touched
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { timeout: 6000, env: { ...process.env, LC_ALL: 'C' } }, (err, out, errOut) => res({ ok: !err, out: String(out || ''), err: String(errOut || '') })));
const has = (bin) => (process.env.PATH || '').split(':').some((d) => { try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { return false; } });
const SAVED = () => path.join(app.getPath('userData'), 'input.json');

const DEFAULTS = { speed: 0, accel: true, natural: false, scroll: 1, leftHanded: false, middleEmu: false, tap: true, dwt: true, touchNatural: false };

function backend() {
  if (process.argv.includes('--session') && has('xinput')) return 'x11';
  return 'saved';   // running in a window on another desktop: remember, apply at the next LiquidDesktop login
}

/* ------------------------------------------------------------------ X11 (xinput / libinput) */
async function x11Devices() {
  const r = await run('xinput', ['list']);
  const out = [];
  for (const line of r.out.split('\n')) {
    const m = line.match(/↳\s+(.+?)\s+id=(\d+)\s+\[slave\s+pointer/);
    if (!m || /XTEST|Virtual core/i.test(m[1])) continue;
    const props = (await run('xinput', ['list-props', m[2]])).out;
    if (!/libinput Accel Speed/.test(props)) continue;   // not a real pointer (keyboards with media keys etc.)
    const touchpad = /libinput Tapping Enabled \(/.test(props);
    out.push({ id: m[2], key: m[1].trim(), name: m[1].trim(), type: touchpad ? 'touchpad' : 'mouse', props });
  }
  return out;
}
const propValue = (props, name) => { const m = props.match(new RegExp(name.replace(/[()]/g, '\\$&') + ' \\(\\d+\\):\\s*([^\\n]+)')); return m ? m[1].split(',').map((s) => s.trim()) : null; };

async function x11Apply(dev, s) {
  const set = (prop, ...vals) => (propValue(dev.props, prop) ? run('xinput', ['--set-prop', dev.id, prop, ...vals.map(String)]) : null);
  await set('libinput Accel Speed', Math.max(-1, Math.min(1, s.speed)).toFixed(2));
  const prof = propValue(dev.props, 'libinput Accel Profile Enabled');
  if (prof) { const v = prof.map(() => 0); v[s.accel ? 0 : 1] = 1; await set('libinput Accel Profile Enabled', ...v); }
  await set('libinput Natural Scrolling Enabled', (dev.type === 'touchpad' ? s.touchNatural : s.natural) ? 1 : 0);
  await set('libinput Left Handed Enabled', s.leftHanded ? 1 : 0);
  await set('libinput Middle Emulation Enabled', s.middleEmu ? 1 : 0);
  if (dev.type === 'touchpad') { await set('libinput Tapping Enabled', s.tap ? 1 : 0); await set('libinput Disable While Typing Enabled', s.dwt ? 1 : 0); }
  // libinput scrolls one "click" per 15px by default; a smaller distance means faster scrolling
  await set('libinput Scrolling Pixel Distance', Math.round(Math.max(10, Math.min(50, 15 / (s.scroll || 1)))));
}

/* ------------------------------------------------------------------ public */
const readSaved = () => { try { return JSON.parse(fs.readFileSync(SAVED(), 'utf8')); } catch { return { all: { ...DEFAULTS }, devices: {} }; } };

async function devices() {
  const b = backend();
  const list = b === 'x11' ? await x11Devices() : [];
  return { backend: b, devices: list.map(({ props, ...d }) => d), config: readSaved(), defaults: DEFAULTS };
}

async function applyConfig(cfg) {
  fs.mkdirSync(path.dirname(SAVED()), { recursive: true });
  fs.writeFileSync(SAVED(), JSON.stringify(cfg, null, 2));
  const b = backend();
  if (b !== 'x11') return;
  for (const dev of await x11Devices()) await x11Apply(dev, { ...DEFAULTS, ...(cfg.all || {}), ...((cfg.devices || {})[dev.name] || {}) });
}

/** Session: apply saved settings now and to devices plugged in later. */
let known = '';
async function watchDevices() {
  if (backend() !== 'x11') return;
  const tick = async () => {
    const list = await x11Devices();
    const key = list.map((d) => d.id + d.name).join('|');
    if (key === known) return;
    known = key;
    const cfg = readSaved();
    for (const dev of list) await x11Apply(dev, { ...DEFAULTS, ...(cfg.all || {}), ...((cfg.devices || {})[dev.name] || {}) });
  };
  await tick();
  setInterval(tick, 4000);
}

module.exports = { devices, applyConfig, watchDevices, backend };
