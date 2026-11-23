// Display configuration: lists every connected monitor with its modes, and changes resolution,
// refresh rate, scale, rotation, position, primary and on/off per monitor.
//   • X11 session  → xrandr (settings are saved and re-applied at the next login)
//   • Testing window → monitors are only listed (preview); the host desktop's displays are never changed
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { timeout: 6000 }, (err, out, errOut) => res({ ok: !err, out: String(out || ''), err: String(errOut || (err && err.message) || '') })));
const has = (bin) => (process.env.PATH || '').split(':').some((d) => { try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { return false; } });
const SAVED = () => path.join(app.getPath('userData'), 'displays.json');
// Per-display scale on X11 (like Cinnamon's fractional scaling): X has one scale for everything, so LiquidDesktop
// and the apps draw at the biggest scale any display wants (G, the ui-scale file: main/main.js, the session
// script's Xft.dpi), and a display set lower is rendered bigger and shrunk to fit (xrandr --scale G/its scale).
// The arrangement is in logical points (a 3840-wide display at 200% is 1920 wide), like macOS; the framebuffer is
// logical × G. With every display at 100% nothing is transformed, exactly as before.
const UI_SCALE = () => path.join(process.env.XDG_CONFIG_HOME || path.join(require('os').homedir(), '.config'), 'LiquidDesktop', 'ui-scale');
function currentG() { try { const v = parseInt(fs.readFileSync(UI_SCALE(), 'utf8'), 10); return v >= 75 && v <= 300 ? v / 100 : 1; } catch { return 1; } }
function writeG(g) {
  const pct = Math.round(g * 100);
  fs.mkdirSync(path.dirname(UI_SCALE()), { recursive: true });
  if (pct === 100) fs.rmSync(UI_SCALE(), { force: true }); else fs.writeFileSync(UI_SCALE(), pct + '\n');
}
const quarter = (v) => Math.round(v * 4) / 4;

function backend() {
  if (process.argv.includes('--session') && has('xrandr')) return 'x11';   // our own X11 session
  return 'preview';   // running in a window on another desktop: show the monitors, change nothing
}

function groupModes(list) {
  // [{w,h,r}] → [{width,height,rates:[…]}] biggest first
  const map = new Map();
  for (const m of list) {
    const k = `${m.w}x${m.h}`;
    if (!map.has(k)) map.set(k, { width: m.w, height: m.h, rates: [] });
    const r = Math.round(m.r * 100) / 100;
    if (!map.get(k).rates.includes(r)) map.get(k).rates.push(r);
  }
  const out = [...map.values()];
  out.forEach((m) => m.rates.sort((a, b) => b - a));
  return out.sort((a, b) => b.width * b.height - a.width * a.height || b.width - a.width);
}

async function listHyprland() {
  const r = await run('hyprctl', ['monitors', 'all', '-j']);
  const mons = JSON.parse(r.out || '[]');
  return mons.map((m) => ({
    name: m.name, label: [m.make, m.model].filter(Boolean).join(' ') || m.description || m.name, enabled: !m.disabled, primary: !!m.focused,
    x: m.x, y: m.y, width: m.width, height: m.height, refresh: Math.round(m.refreshRate * 100) / 100, scale: m.scale, rotation: [0, 90, 180, 270][m.transform % 4] || 0,
    modes: groupModes((m.availableModes || []).map((s) => { const x = s.match(/(\d+)x(\d+)@([\d.]+)/); return x ? { w: +x[1], h: +x[2], r: +x[3] } : null; }).filter(Boolean)),
  }));
}

async function listX11() {
  const r = await run('xrandr', ['--query']);
  const out = [];
  let cur = null;
  for (const line of r.out.split('\n')) {
    const head = line.match(/^(\S+) (connected|disconnected)( primary)?\s*(?:(\d+)x(\d+)\+(\d+)\+(\d+))?\s*(normal|left|inverted|right)?/);
    if (head) {
      cur = head[2] === 'connected' ? {
        name: head[1], label: head[1], enabled: !!head[4], primary: !!head[3], x: +head[6] || 0, y: +head[7] || 0, width: +head[4] || 0, height: +head[5] || 0,
        refresh: 0, scale: 1, rotation: { normal: 0, left: 90, inverted: 180, right: 270 }[head[8] || 'normal'], raw: [], fbW: +head[4] || 0, fbH: +head[5] || 0, modeW: 0, modeH: 0,
      } : null;
      if (cur) out.push(cur);
      continue;
    }
    const mode = cur && line.match(/^\s+(\d+)x(\d+)i?\s+(.*)$/);
    if (mode) {
      for (const tok of mode[3].trim().split(/\s+/)) {
        const rate = parseFloat(tok);
        if (!rate) continue;
        cur.raw.push({ w: +mode[1], h: +mode[2], r: rate });
        if (tok.includes('*')) { cur.refresh = Math.round(rate * 100) / 100; cur.modeW = +mode[1]; cur.modeH = +mode[2]; }
      }
    }
  }
  const G = currentG();
  for (const d of out) {
    d.modes = groupModes(d.raw); delete d.raw;
    if (d.enabled && d.modeW) {
      // the mode it runs at, and its scale: G over how much it's being supersampled (framebuffer extent / mode)
      const [rw] = d.rotation % 180 ? [d.modeH, d.modeW] : [d.modeW, d.modeH];
      const k = rw ? d.fbW / rw : 1;
      d.width = d.modeW; d.height = d.modeH;
      d.scale = Math.max(1, quarter(G / (k || 1)));
      d.x = Math.round((d.x / G) * 100) / 100; d.y = Math.round((d.y / G) * 100) / 100;   // logical points (kept exact enough that × G lands on the pixel)
    } else if (d.rotation === 90 || d.rotation === 270) [d.width, d.height] = [d.height, d.width];
    delete d.fbW; delete d.fbH; delete d.modeW; delete d.modeH;
  }
  return out;
}

async function list() {
  const b = backend();
  let displays = [];
  try {
    if (b === 'x11') displays = await listX11();
    else if (process.env.HYPRLAND_INSTANCE_SIGNATURE && has('hyprctl')) displays = await listHyprland();   // read-only
    else if (process.env.DISPLAY && has('xrandr')) displays = await listX11();                             // read-only
  } catch { displays = []; }
  return { backend: b, displays };
}

const KEYS = ['width', 'height', 'refresh', 'rotation', 'x', 'y', 'enabled', 'primary', 'scale'];
const slim = (cfg) => Object.fromEntries(KEYS.map((k) => [k, cfg[k]]));
const save = (list) => {
  const saved = readSaved();
  for (const c of list) saved[c.name] = slim(c);
  fs.mkdirSync(path.dirname(SAVED()), { recursive: true });
  fs.writeFileSync(SAVED(), JSON.stringify(saved, null, 2));
};

/**
 * Every monitor at once, in ONE xrandr call: one mode set for the whole layout (one call per monitor made the
 * screen blank and re-light several times, and could fail half way with monitors left overlapping).
 * list: [{ name, width, height, refresh, rotation, x, y, enabled, primary }]
 */
async function applyAll(list) {
  if (backend() !== 'x11') return { ok: false, err: 'Display changes are made in the LiquidDesktop session. In a testing window your own desktop keeps control of its monitors.' };
  const on = list.filter((c) => c.enabled !== false);
  if (!on.length) return { ok: false, err: 'At least one display has to stay on.' };
  // the layout starts at 0,0 and exactly one display is the main one
  const minX = Math.min(...on.map((c) => c.x)), minY = Math.min(...on.map((c) => c.y));
  if (!on.some((c) => c.primary)) on[0].primary = true;
  let seen = false;
  const fixed = list.map((c) => {
    const o = { ...c };
    if (o.enabled !== false) { o.x = Math.round((o.x - minX) * 100) / 100; o.y = Math.round((o.y - minY) * 100) / 100; o.primary = !!o.primary && !seen; if (o.primary) seen = true; } else o.primary = false;
    return o;
  });
  // Only what changed is sent (NVIDIA's driver re-programs every output it's told about, and a full mode set
  // of all monitors at once hung its display engine), and never two at a time.
  if (busy) return { ok: false, err: 'Still applying the previous display change. Try again in a few seconds.' };
  busy = true;
  try {
    const now = (await listX11()).reduce((m, d) => (m[d.name] = d, m), {});
    const args = [];
    // the scale everything draws at, and how much each display is supersampled to look like its own scale
    const G = Math.max(1, ...fixed.filter((c) => c.enabled !== false).map((c) => +c.scale || 1));
    const Gnow = currentG();
    const scaling = G !== 1 || Gnow !== 1 || Object.values(now).some((d) => d.enabled && (d.scale || 1) !== Gnow);
    const scaleChanged = G !== Gnow || fixed.some((c) => c.enabled !== false && now[c.name] && (+c.scale || 1) !== (now[c.name].scale || 1));
    const off = fixed.filter((c) => c.enabled === false && now[c.name]?.enabled);
    for (const c of off) args.push('--output', c.name, '--off');
    for (const c of fixed.filter((x) => x.enabled !== false)) {
      const d = now[c.name] || {};
      const modeChanged = !d.enabled || d.width !== c.width || d.height !== c.height || (c.refresh && Math.abs((d.refresh || 0) - c.refresh) > 0.05) || (d.rotation || 0) !== (c.rotation || 0);
      const posChanged = Math.abs(d.x - c.x) > 0.02 || Math.abs(d.y - c.y) > 0.02;
      const primChanged = !!d.primary !== !!c.primary && c.primary;
      if (!modeChanged && !posChanged && !primChanged && !scaleChanged) continue;
      const a = ['--output', c.name];
      if (modeChanged) {
        a.push('--mode', `${c.width}x${c.height}`);
        if (c.refresh) a.push('--rate', String(c.refresh));
        a.push('--rotate', { 0: 'normal', 90: 'left', 180: 'inverted', 270: 'right' }[c.rotation || 0]);
      }
      if (scaling) { const k = G / (+c.scale || 1); a.push('--scale', `${k}x${k}`); }
      a.push('--pos', `${Math.round(c.x * G)}x${Math.round(c.y * G)}`);
      if (c.primary) a.push('--primary');
      args.push(...a);
    }
    if (!args.length) { save(fixed); return { ok: true, unchanged: true }; }
    const r = await run('xrandr', args);
    if (r.ok) save(fixed);
    // a new overall scale: LiquidDesktop and apps pick it up at the next login (the displays are already right)
    let relogin = false;
    if (r.ok && G !== Gnow) { writeG(G); relogin = true; }
    // give the driver time to finish before anything else touches the screens
    await new Promise((res) => setTimeout(res, 1500));
    return { ...r, relogin, scale: G };
  } finally { busy = false; }
}
let busy = false;

/** One monitor (older callers): the rest of the layout is kept as it is. */
async function apply(name, cfg) {
  const { displays } = await list();
  return applyAll(displays.map((d) => (d.name === name ? { ...d, ...cfg } : d)));
}
const readSaved = () => { try { return JSON.parse(fs.readFileSync(SAVED(), 'utf8')); } catch { return {}; } };

/** Session start: put back what the user chose last time (X11 only) — in one go, and only if it differs. */
async function restoreSaved() {
  if (backend() !== 'x11') return;
  const saved = readSaved();
  const { displays } = await list();
  if (!displays.some((d) => saved[d.name])) return;
  const want = displays.map((d) => ({ ...d, ...(saved[d.name] ? slim(saved[d.name]) : {}) }));
  const same = (a, b) => a.enabled === b.enabled && (!a.enabled || (a.width === b.width && a.height === b.height && a.x === b.x && a.y === b.y
    && a.rotation === b.rotation && !!a.primary === !!b.primary && (!a.refresh || !b.refresh || Math.abs(a.refresh - b.refresh) < 0.05) && (a.scale || 1) === (b.scale || 1)));
  if (want.every((w, i) => same(w, displays[i]))) return;   // already like that: no mode set (no blank screens at login)
  await applyAll(want);
}

/* ------------------------------------------------------------------ plugging monitors in and out */
// Every output, connected or not, with where it is if it's on (a monitor that was unplugged keeps its CRTC — and
// the screen keeps its size — until someone turns it off; a bare X server doesn't do that, nor turn a new one on).
async function outputs() {
  const r = await run('xrandr', ['--query']);
  const out = [];
  for (const line of r.out.split('\n')) {
    const m = line.match(/^(\S+) (connected|disconnected)( primary)?\s*(?:(\d+)x(\d+)\+(\d+)\+(\d+))?/);
    if (m) out.push({ name: m[1], connected: m[2] === 'connected', primary: !!m[3], enabled: !!m[4], w: +m[4] || 0, h: +m[5] || 0, x: +m[6] || 0, y: +m[7] || 0, hasModes: false });
    else if (out.length && /^\s+\d+x\d+/.test(line)) out[out.length - 1].hasModes = true;
  }
  return out;
}
const OPTS_KEY = '__options';
const options = () => ({ connect: 'extend', ...(readSaved()[OPTS_KEY] || {}) });
function setOptions(o) {
  const saved = readSaved();
  saved[OPTS_KEY] = { ...options(), ...o };
  fs.mkdirSync(path.dirname(SAVED()), { recursive: true });
  fs.writeFileSync(SAVED(), JSON.stringify(saved, null, 2));
  return saved[OPTS_KEY];
}

/**
 * A monitor was plugged in or out (main/session.js, on the X server's RandR events, once they've settled):
 *  - unplugged but still switched on → switched off, so the screen shrinks back and nothing is drawn for it
 *  - plugged in and off → the layout you chose for it before (Settings › Displays), else, like a Mac, the desktop
 *    extends onto it, to the right (or it mirrors, or stays off: Settings › Displays › When a display is connected).
 *    One you turned off yourself stays off.
 * Everything in ONE xrandr call. Returns what was done (for the log), or null when nothing needed doing.
 */
let hotplugBusy = false;
async function hotplug() {
  if (backend() !== 'x11' || hotplugBusy || busy) return null;
  hotplugBusy = true;
  try {
    const outs = await outputs();
    const saved = readSaved(), opt = options();
    const G = currentG();
    const on = outs.filter((o) => o.connected && o.enabled);
    const args = [], did = [];
    for (const o of outs.filter((x) => !x.connected && x.enabled)) { args.push('--output', o.name, '--off'); did.push(`${o.name} unplugged: off`); }
    const fresh = outs.filter((o) => o.connected && !o.enabled && o.hasModes && saved[o.name]?.enabled !== false);
    if (fresh.length && opt.connect !== 'off') {
      const prim = on.find((o) => o.primary) || on[0];
      let right = on.reduce((m, o) => Math.max(m, o.x + o.w), 0);
      for (const o of fresh) {
        const sv = saved[o.name];
        if (sv && sv.enabled && sv.width && sv.height) {
          const k = G / (sv.scale || 1);
          args.push('--output', o.name, '--mode', `${sv.width}x${sv.height}`, ...(sv.refresh ? ['--rate', String(sv.refresh)] : []),
            '--rotate', { 0: 'normal', 90: 'left', 180: 'inverted', 270: 'right' }[sv.rotation || 0], ...(G !== 1 || k !== 1 ? ['--scale', `${k}x${k}`] : []), '--pos', `${Math.round(sv.x * G)}x${Math.round(sv.y * G)}`);
          did.push(`${o.name} plugged in: its saved layout`);
        } else if (opt.connect === 'mirror' && prim) {
          args.push('--output', o.name, '--auto', '--same-as', prim.name);
          did.push(`${o.name} plugged in: mirroring ${prim.name}`);
        } else {
          // to the right of everything that's on, at its best mode (--auto), lined up with the top
          args.push('--output', o.name, '--auto', ...(G !== 1 ? ['--scale', `${G}x${G}`] : []), '--pos', `${right}x0`);   // at 100%, among displays drawn at G
          did.push(`${o.name} plugged in: extended to the right`);
          right += 1;   // the next one goes after it: its width isn't known before the mode is set, so a second pass places it
        }
      }
      if (!on.length && !outs.some((o) => o.primary)) args.push('--output', fresh[0].name, '--primary');
    }
    if (!args.length) return null;
    const r = await run('xrandr', args);
    // a second fresh monitor was put at a placeholder spot: now that widths are known, line them up
    if (fresh.length > 1 && r.ok) {
      const now = await outputs();
      let x = 0; const fix = [];
      for (const o of now.filter((q) => q.connected && q.enabled).sort((a, b) => a.x - b.x)) { if (o.x !== x) fix.push('--output', o.name, '--pos', `${x}x${o.y}`); x += o.w; }
      if (fix.length) await run('xrandr', fix);
    }
    await new Promise((res) => setTimeout(res, 1500));   // let the driver finish before anything draws for the new layout
    return { ok: r.ok, did, args, err: r.ok ? null : r.err.trim() };
  } finally { hotplugBusy = false; }
}

module.exports = { list, apply, applyAll, restoreSaved, backend, hotplug, outputs, options, setOptions };
