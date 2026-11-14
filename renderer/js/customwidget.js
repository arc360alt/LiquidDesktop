// Custom widgets: the .ldwidget format, its renderer, and storage. A widget is one JSON file (pictures are
// embedded), so it can be shared as-is. It only describes what to show, never code:
//
// {
//   "format": "liquiddesktop-widget", "version": 1,
//   "id": "…", "name": "Bitcoin", "author": "…", "size": "s" | "m" | "l",
//   "background": { "type": "glass" | "color" | "gradient" | "image", "color": "#1c1c1e",
//                   "from": "#0a84ff", "to": "#5e5ce6", "angle": 135, "image": "data:image/…", "dim": 0.3 },
//   "textColor": "#ffffff",
//   "sources": [ { "id": "btc", "url": "https://api.example.com/price", "every": 300, "type": "json" } ],
//   "elements": [                           (x, y, w, h are percentages of the widget)
//     { "type": "text", "x": 8, "y": 10, "w": 84, "h": 20, "text": "{{btc.price|fixed:0}} USD", "size": 22, "weight": 700, "color": "#fff", "align": "left", "font": "system" },
//     { "type": "image", "src": "data:… | https://…", "fit": "cover", "radius": 12 },
//     { "type": "shape", "shape": "rect" | "circle", "fill": "#ffffff33", "radius": 12 },
//     { "type": "progress", "style": "bar" | "ring", "value": "{{battery}}", "max": 100, "color": "#30d158", "track": "#ffffff33" },
//     { "type": "icon", "name": "sun", "color": "#ffd60a" }
//   ]
// }
//
// Text can use {{placeholders}}: time, time24, date, weekday, day, month, year, battery, cpu, mem,
// weather.temp / .condition / .high / .low / .city, and data from sources ({{btc.data.price}}, {{list[0].name}}).
// Filters: |round, |fixed:N, |upper, |lower, |default:text.
import { h } from './util.js';
import { store } from './store.js';
import { api } from './sys.js';
import { sym } from './icons.js';
import { getWeather, describe } from './weatherdata.js';

export const FORMAT = 'liquiddesktop-widget';
export const SIZES = { s: [164, 164], m: [340, 164], l: [340, 340] };
export const ICONS = { sun: sym.sun, moon: sym.moon, bolt: sym.bolt, clock: sym.clock, star: sym.star, music: sym.music, bell: sym.bell, globe: sym.globe, home: sym.home,
  heart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.6-9.6-9.3C.9 8.3 3.2 4.5 6.9 4.5c2 0 3.6 1.1 5.1 2.9 1.5-1.8 3.1-2.9 5.1-2.9 3.7 0 6 3.8 4.5 7.2C19.5 16.4 12 21 12 21z"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 19h10.5a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 6.6 9.1 5 5 0 0 0 7 19z"/></svg>',
  battery: sym.battery, cpu: sym.cpu, calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  location: sym.location, camera: sym.camera, photo: sym.photo, terminal: sym.terminal };

/* ------------------------------------------------------------------ storage */
export const customWidgets = () => store.get('customWidgets') || {};
export function saveCustom(spec) { const all = { ...customWidgets(), [spec.id]: spec }; store.set('customWidgets', all); return spec.id; }
export function deleteCustom(id) {
  const all = { ...customWidgets() }; delete all[id]; store.set('customWidgets', all);
  store.set('widgets', (store.get('widgets') || []).filter((w) => w.type !== 'custom:' + id));
}
export const newId = () => 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Checks and tidies a widget file; throws with a readable message when it isn't one. */
export function validate(raw) {
  const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!s || s.format !== FORMAT) throw new Error('This isn’t a LiquidDesktop widget file.');
  if ((s.version || 1) > 1) throw new Error('This widget was made with a newer LiquidDesktop. Update to use it.');
  const safeUrl = (u) => (typeof u === 'string' && /^(https:\/\/|data:image\/)/.test(u) ? u : '');
  const color = (c, d) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$|^rgba?\([\d\s.,%]+\)$/i.test(c.trim()) ? c.trim() : d);
  const num = (v, d, a = -1e9, b = 1e9) => (Number.isFinite(+v) ? Math.max(a, Math.min(b, +v)) : d);
  return {
    format: FORMAT, version: 1, id: typeof s.id === 'string' && /^[\w-]{1,40}$/.test(s.id) ? s.id : newId(),
    name: String(s.name || 'Widget').slice(0, 60), author: String(s.author || '').slice(0, 60), size: SIZES[s.size] ? s.size : 's',
    background: { type: ['glass', 'color', 'gradient', 'image'].includes(s.background?.type) ? s.background.type : 'glass', color: color(s.background?.color, '#1c1c1e'),
      from: color(s.background?.from, '#0a84ff'), to: color(s.background?.to, '#5e5ce6'), angle: num(s.background?.angle, 135, 0, 360), image: safeUrl(s.background?.image), dim: num(s.background?.dim, 0, 0, 0.9) },
    textColor: color(s.textColor, ''),
    sources: (Array.isArray(s.sources) ? s.sources : []).slice(0, 6).filter((x) => /^https?:\/\//.test(x?.url || '') && /^[a-zA-Z_]\w{0,30}$/.test(x?.id || ''))
      .map((x) => ({ id: x.id, url: String(x.url).slice(0, 2000), every: num(x.every, 300, 60, 86400), type: x.type === 'text' ? 'text' : 'json' })),
    elements: (Array.isArray(s.elements) ? s.elements : []).slice(0, 60).filter((e) => ['text', 'image', 'shape', 'progress', 'icon'].includes(e?.type)).map((e) => ({
      ...e, x: num(e.x, 0, -50, 150), y: num(e.y, 0, -50, 150), w: num(e.w, 30, 1, 200), h: num(e.h, 20, 1, 200),
      text: e.text != null ? String(e.text).slice(0, 500) : undefined, src: e.src != null ? safeUrl(e.src) : undefined,
      color: color(e.color, undefined), fill: color(e.fill, undefined), track: color(e.track, undefined),
    })),
  };
}
export const toFile = (spec) => JSON.stringify({ ...spec, format: FORMAT, version: 1 }, null, 2);

/* ------------------------------------------------------------------ data */
const srcCache = new Map();   // url → { t, data, err }
async function loadSource(src) {
  const c = srcCache.get(src.url);
  if (c && Date.now() - c.t < src.every * 1000 - 500) return c;
  const entry = { t: Date.now(), data: null, err: null };
  try {
    const text = api.net?.fetch ? await api.net.fetch(src.url) : await (await fetch(src.url)).text();
    entry.data = src.type === 'text' ? text : JSON.parse(text);
  } catch (e) { entry.err = e.message; entry.data = c?.data ?? null; }
  srcCache.set(src.url, entry);
  return entry;
}
let sysCache = { t: 0, v: {} };
async function systemVars() {
  if (Date.now() - sysCache.t < 5000) return sysCache.v;
  const v = {};
  try { const s = await api.sys.stats(); v.cpu = Math.round(s.cpu); v.mem = Math.round(100 * (1 - s.memFree / s.memTotal)); if (s.battery) v.battery = s.battery.percent; } catch { /* no backend */ }
  try { const w = await getWeather(); const t = w.daily; v.weather = { temp: Math.round(w.current.temperature_2m), condition: describe(w.current.weather_code, w.current.is_day).label, high: Math.round(t.temperature_2m_max[0]), low: Math.round(t.temperature_2m_min[0]), city: w.city?.name || '' }; } catch { /* offline */ }
  sysCache = { t: Date.now(), v };
  return v;
}
function lookup(obj, path) {
  let cur = obj;
  for (const part of path.match(/[^.[\]]+/g) || []) { if (cur == null) return undefined; cur = cur[part]; }
  return cur;
}
function applyFilter(v, f) {
  const [name, arg] = f.split(':');
  if (name === 'default') return v == null || v === '' ? arg ?? '' : v;
  if (v == null) return v;
  if (name === 'round') return Math.round(+v);
  if (name === 'fixed') return (+v).toFixed(Math.min(6, +arg || 0));
  if (name === 'upper') return String(v).toUpperCase();
  if (name === 'lower') return String(v).toLowerCase();
  return v;
}
export function fill(template, vars) {
  return String(template ?? '').replace(/\{\{\s*([^}|]+?)\s*((?:\|[^}]+)?)\}\}/g, (_, path, filters) => {
    let v = lookup(vars, path.trim());
    for (const f of filters.split('|').map((x) => x.trim()).filter(Boolean)) v = applyFilter(v, f);
    return v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}
function clockVars() {
  const d = new Date();
  return { time: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), time24: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
    date: d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }), weekday: d.toLocaleDateString([], { weekday: 'long' }),
    day: d.getDate(), month: d.toLocaleDateString([], { month: 'long' }), year: d.getFullYear(), seconds: d.getSeconds() };
}

/* ------------------------------------------------------------------ rendering */
const FONTS = { system: 'inherit', rounded: '"SF Pro Rounded", "Nunito", "Inter Variable", sans-serif', mono: 'ui-monospace, "JetBrains Mono", monospace', serif: 'Georgia, "Times New Roman", serif' };
/** Draws a custom widget into `el` (a .widget), and keeps it up to date while it's on screen. */
export function renderCustom(el, spec, { preview = false } = {}) {
  const bg = spec.background || {};
  el.classList.add('w-custom');
  if (bg.type !== 'glass') el.classList.remove('glass');
  el.style.background = bg.type === 'color' ? bg.color : bg.type === 'gradient' ? `linear-gradient(${bg.angle}deg, ${bg.from}, ${bg.to})` : bg.type === 'image' && bg.image ? `center/cover url("${bg.image}")` : '';
  if (spec.textColor) el.style.color = spec.textColor;
  const stage = h('div.w-stage');
  if (bg.type === 'image' && bg.dim) stage.append(h('div.w-dim', { style: { background: `rgba(0,0,0,${bg.dim})` } }));
  el.append(stage);
  const nodes = [];
  for (const e of spec.elements || []) {
    const n = h('div.w-el', { style: { left: e.x + '%', top: e.y + '%', width: e.w + '%', height: e.h + '%' } });
    n.dataset.type = e.type;
    if (e.type === 'text') Object.assign(n.style, { fontSize: (e.size || 14) + 'px', fontWeight: e.weight || 500, color: e.color || '', textAlign: e.align || 'left', fontFamily: FONTS[e.font] || 'inherit',
      justifyContent: { left: 'flex-start', center: 'center', right: 'flex-end' }[e.align || 'left'], lineHeight: 1.15 });
    if (e.type === 'image' && e.src) n.append(h('img', { src: e.src, draggable: false, style: { objectFit: e.fit || 'cover', borderRadius: (e.radius || 0) + 'px' } }));
    if (e.type === 'shape') Object.assign(n.style, { background: e.fill || 'rgba(255,255,255,.25)', borderRadius: e.shape === 'circle' ? '50%' : (e.radius || 0) + 'px', opacity: e.opacity ?? 1 });
    if (e.type === 'icon') { n.innerHTML = ICONS[e.name] || ICONS.star; n.style.color = e.color || ''; }
    stage.append(n);
    nodes.push([e, n]);
  }
  const vars = { ...clockVars() };
  const draw = () => {
    Object.assign(vars, clockVars());
    for (const [e, n] of nodes) {
      if (e.type === 'text') n.textContent = fill(e.text, vars);
      if (e.type === 'progress') {
        const v = Math.max(0, Math.min(1, (parseFloat(fill(e.value, vars)) || 0) / (e.max || 100))), col = e.color || '#30d158', tr = e.track || 'rgba(128,128,128,.3)';
        n.innerHTML = e.style === 'ring'
          ? `<svg viewBox="0 0 36 36" style="width:100%;height:100%"><circle cx="18" cy="18" r="15" fill="none" stroke="${tr}" stroke-width="4"/><circle cx="18" cy="18" r="15" fill="none" stroke="${col}" stroke-width="4" stroke-linecap="round" stroke-dasharray="94.25" stroke-dashoffset="${(94.25 * (1 - v)).toFixed(2)}" transform="rotate(-90 18 18)"/></svg>`
          : `<div style="width:100%;height:100%;border-radius:99px;background:${tr};overflow:hidden"><div style="width:${(v * 100).toFixed(1)}%;height:100%;border-radius:99px;background:${col}"></div></div>`;
      }
    }
  };
  draw();
  let alive = true;
  const refresh = async () => {
    if (!el.isConnected && !preview) { alive = false; return; }
    Object.assign(vars, await systemVars());
    await Promise.all((spec.sources || []).map(async (s) => { const r = await loadSource(s); vars[s.id] = r.data; }));
    draw();
  };
  refresh();
  const tick = setInterval(() => { if (!alive || (!el.isConnected && !preview)) return clearInterval(tick); draw(); }, 1000);
  const slow = setInterval(() => { if (!alive || (!el.isConnected && !preview)) return clearInterval(slow); refresh(); }, 30_000);
  el.stopCustom = () => { alive = false; clearInterval(tick); clearInterval(slow); };
  return el;
}
