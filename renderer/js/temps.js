// Temperatures, shared by the Temperature widgets and the menu bar's Temperature item: the readings (main/sensors.js),
// shown in °C or °F the way Weather shows them, and how worried to be (green, orange when it's getting warm, red when
// it's close to too hot).
import { api } from './sys.js';
import { useF as weatherF } from './weatherdata.js';
import { store } from './store.js';

export const THERMO = '<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M14.5 13.9V5a2.5 2.5 0 0 0-5 0v8.9a4.5 4.5 0 1 0 5 0z"/><path d="M12 9v7.2"/><circle cx="12" cy="17.6" r="1.6" fill="currentColor" stroke="none"/></svg>';

// store 'tempUnit': 'c', 'f', or unset (= whatever Weather uses). One setting for every widget and the menu bar.
const useF = () => { const u = store.get('tempUnit'); return u === 'f' ? true : u === 'c' ? false : weatherF(); };
/** Right-click items to pick the unit. */
export const unitItems = () => {
  const u = store.get('tempUnit');
  const set = (v) => store.set('tempUnit', v);
  return [{ header: 'Unit' }, { label: 'Automatic (Same as Weather)', checked: u !== 'c' && u !== 'f', action: () => set(null) },
    { label: 'Celsius (°C)', checked: u === 'c', action: () => set('c') }, { label: 'Fahrenheit (°F)', checked: u === 'f', action: () => set('f') }];
};
/** A part's key that stays the same between restarts (hwmon numbers don't). */
export const partKey = (d) => `${d.kind}:${d.name}`;
/** A short name for the menu bar: CPU, GPU, SSD (SSD 1, SSD 2 when there are several)… */
export function shortName(d, r) {
  const same = r ? r.devices.filter((x) => x.kind === d.kind) : [d];
  return (SHORT[d.kind] || d.name) + (same.length > 1 ? ' ' + (same.indexOf(same.find((x) => partKey(x) === partKey(d))) + 1) : '');
}

/* The menu bar's temperature gauges: there can be several ("temperature", "temperature#2"…), each showing a different
   part. store 'tempMenubarSensors' = { [gauge id]: partKey | 'hottest' }. */
export const gaugeSensors = () => {
  const m = { ...(store.get('tempMenubarSensors') || {}) };
  const old = store.get('tempMenubarSensor');   // (from when there was only one)
  if (old && !('temperature' in m)) m.temperature = old;
  return m;
};
export const setGaugeSensor = (id, key) => { const m = gaugeSensors(); if (key == null) delete m[id]; else m[id] = key; store.set('tempMenubarSensors', m); };
/** Which part each gauge shows — no two the same: the ones chosen keep theirs, and a gauge that hasn't chosen (or whose
 *  part has gone, an unplugged drive) takes the first part nobody's using, the processor first. { [id]: key } */
export function resolveGauges(r, ids) {
  const m = gaugeSensors(), keys = r ? [...(r.cpu ? [partKey(r.cpu)] : []), ...r.devices.map(partKey)] : [];
  const valid = (k) => k === 'hottest' || keys.includes(k);
  const out = {}, used = new Set();
  for (const id of ids) if (m[id] && valid(m[id]) && !used.has(m[id])) { out[id] = m[id]; used.add(m[id]); }
  for (const id of ids) {
    if (out[id]) continue;
    const k = [...keys, 'hottest'].find((x) => !used.has(x));
    if (k) { out[id] = k; used.add(k); }
  }
  return out;
}

export const readTemps = () => api.sensors?.read().catch(() => null) ?? Promise.resolve(null);
/** 78° (or 172° in Fahrenheit); '—' for no reading. */
export const fmtTemp = (c, unit) => (c == null ? '—' : Math.round(useF() ? c * 9 / 5 + 32 : c) + '°' + (unit ? (useF() ? 'F' : 'C') : ''));
/** 'ok' | 'warm' | 'hot' */
export const level = (d) => (!d || d.temp == null ? 'ok' : d.temp >= d.hot - 8 ? 'hot' : d.temp >= d.hot - 20 ? 'warm' : 'ok');
export const COLOR = { ok: '#30d158', warm: '#ff9f0a', hot: '#ff453a' };
export const SHORT = { cpu: 'CPU', gpu: 'GPU', disk: 'SSD', memory: 'RAM', wifi: 'Wi-Fi', battery: 'Battery', board: 'System' };

/** The parts worth a gauge, most important first: processor, graphics, the hottest drive, memory. */
export function mainParts(r) {
  if (!r) return [];
  const hottest = (kind) => r.devices.filter((d) => d.kind === kind && d.temp != null).sort((a, b) => b.temp - a.temp)[0];
  return [r.cpu, r.gpu, hottest('disk'), hottest('memory') || hottest('board')].filter(Boolean);
}

/** A 270° gauge: how far it is from cool (25°C) to too hot, coloured by level. size in px. */
export function gaugeSvg(d, size) {
  const r = 40, c = 2 * Math.PI * r, len = c * 0.75;
  const f = !d || d.temp == null ? 0 : Math.max(0.03, Math.min(1, (d.temp - 25) / Math.max(10, d.hot - 25)));
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}"><circle cx="50" cy="50" r="${r}" fill="none" stroke="rgba(128,128,128,.25)" stroke-width="9" stroke-linecap="round" stroke-dasharray="${len.toFixed(1)} ${c.toFixed(1)}" transform="rotate(135 50 50)"/>` +
    `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${COLOR[level(d)]}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${(len * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(135 50 50)" style="transition:stroke-dasharray .6s ease,stroke .6s"/></svg>`;
}
/** "Intel Core i9 — 78°C (hottest core 82°C)" */
export function describePart(d) {
  if (d.asleep) return `${d.name} — asleep (not in use)`;
  const core = d.kind === 'cpu' && d.detail.length ? Math.max(...d.detail.map((x) => x.temp)) : null;
  return `${d.name} — ${fmtTemp(d.temp, true)}${core != null ? ` (hottest core ${fmtTemp(core, true)})` : ''}`;
}
