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

/**
 * cfg: { width, height, refresh, scale, rotation, x, y, enabled, primary }
 */
async function apply(name, cfg) {
  const b = backend();
  if (b === 'x11') {
    const args = ['--output', name];
    if (cfg.enabled === false) args.push('--off');
    else {
      args.push('--mode', `${cfg.width}x${cfg.height}`);
      if (cfg.refresh) args.push('--rate', String(cfg.refresh));
      args.push('--rotate', { 0: 'normal', 90: 'left', 180: 'inverted', 270: 'right' }[cfg.rotation || 0]);
      args.push('--pos', `${Math.round(cfg.x)}x${Math.round(cfg.y)}`);
      if (cfg.primary) args.push('--primary');
    }
    const r = await run('xrandr', args);
    if (r.ok) {
      const saved = readSaved(); saved[name] = cfg; fs.mkdirSync(path.dirname(SAVED()), { recursive: true }); fs.writeFileSync(SAVED(), JSON.stringify(saved, null, 2));
    }
    return r;
  }
  return { ok: false, err: 'Display changes are made in the LiquidDesktop session. In a testing window your own desktop keeps control of its monitors.' };
}
const readSaved = () => { try { return JSON.parse(fs.readFileSync(SAVED(), 'utf8')); } catch { return {}; } };

/** Session start: put back what the user chose last time (X11 only). */
async function restoreSaved() {
  if (backend() !== 'x11') return;
  const saved = readSaved();
  const { displays } = await list();
  for (const d of displays) if (saved[d.name]) await apply(d.name, saved[d.name]);
}

module.exports = { list, apply, restoreSaved, backend };
