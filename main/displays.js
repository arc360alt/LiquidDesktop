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
        refresh: 0, scale: 1, rotation: { normal: 0, left: 90, inverted: 180, right: 270 }[head[8] || 'normal'], raw: [],
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
        if (tok.includes('*')) cur.refresh = Math.round(rate * 100) / 100;
      }
    }
  }
  for (const d of out) {
    d.modes = groupModes(d.raw); delete d.raw;
    if (d.rotation === 90 || d.rotation === 270) [d.width, d.height] = [d.height, d.width];   // report the mode size, not the rotated extent
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

const KEYS = ['width', 'height', 'refresh', 'rotation', 'x', 'y', 'enabled', 'primary'];
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
    if (o.enabled !== false) { o.x = Math.round(o.x - minX); o.y = Math.round(o.y - minY); o.primary = !!o.primary && !seen; if (o.primary) seen = true; } else o.primary = false;
    return o;
  });
  // Only what changed is sent (NVIDIA's driver re-programs every output it's told about, and a full mode set
  // of all monitors at once hung its display engine), and never two at a time.
  if (busy) return { ok: false, err: 'Still applying the previous display change. Try again in a few seconds.' };
  busy = true;
  try {
    const now = (await listX11()).reduce((m, d) => (m[d.name] = d, m), {});
    const args = [];
    const off = fixed.filter((c) => c.enabled === false && now[c.name]?.enabled);
    for (const c of off) args.push('--output', c.name, '--off');
    for (const c of fixed.filter((x) => x.enabled !== false)) {
      const d = now[c.name] || {};
      const modeChanged = !d.enabled || d.width !== c.width || d.height !== c.height || (c.refresh && Math.abs((d.refresh || 0) - c.refresh) > 0.05) || (d.rotation || 0) !== (c.rotation || 0);
      const posChanged = d.x !== c.x || d.y !== c.y;
      const primChanged = !!d.primary !== !!c.primary && c.primary;
      if (!modeChanged && !posChanged && !primChanged) continue;
      const a = ['--output', c.name];
      if (modeChanged) {
        a.push('--mode', `${c.width}x${c.height}`);
        if (c.refresh) a.push('--rate', String(c.refresh));
        a.push('--rotate', { 0: 'normal', 90: 'left', 180: 'inverted', 270: 'right' }[c.rotation || 0]);
      }
      a.push('--pos', `${c.x}x${c.y}`);
      if (c.primary) a.push('--primary');
      args.push(...a);
    }
    if (!args.length) { save(fixed); return { ok: true, unchanged: true }; }
    const r = await run('xrandr', args);
    if (r.ok) save(fixed);
    // give the driver time to finish before anything else touches the screens
    await new Promise((res) => setTimeout(res, 1500));
    return r;
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
    && a.rotation === b.rotation && !!a.primary === !!b.primary && (!a.refresh || !b.refresh || Math.abs(a.refresh - b.refresh) < 0.05)));
  if (want.every((w, i) => same(w, displays[i]))) return;   // already like that: no mode set (no blank screens at login)
  await applyAll(want);
}

module.exports = { list, apply, applyAll, restoreSaved, backend };
