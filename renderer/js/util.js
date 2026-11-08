// Small DOM + formatting helpers shared by the whole shell.
export function h(sel, attrs, ...kids) {
  const m = sel.match(/^([a-z0-9-]*)((?:[.#][\w-]+)*)$/i);
  const el = document.createElement(m && m[1] ? m[1] : 'div');
  if (m && m[2]) for (const part of m[2].match(/[.#][\w-]+/g)) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'class') el.className += ' ' + v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const svg = (markup) => { const t = document.createElement('template'); t.innerHTML = markup.trim(); return t.content.firstChild; };
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const basename = (p) => p.replace(/\/+$/, '').split('/').pop() || '/';
export const dirname = (p) => { const d = p.replace(/\/+$/, '').split('/').slice(0, -1).join('/'); return d || '/'; };
export const extOf = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
export const fileUrl = (p) => 'file://' + p.split('/').map(encodeURIComponent).join('/');

export function fmtSize(b) {
  if (b == null) return '--';
  const u = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
  return i === 0 ? `${b} bytes` : `${b.toFixed(b < 10 ? 1 : 0)} ${u[i]}`;
}
export function fmtDate(ms) {
  const d = new Date(ms), now = new Date();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today at ${t}`;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday at ${t}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + ` at ${t}`;
}
export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export class Emitter {
  constructor() { this._l = {}; }
  on(ev, fn) { (this._l[ev] ||= new Set()).add(fn); return () => this._l[ev].delete(fn); }
  emit(ev, ...a) { for (const fn of this._l[ev] || []) fn(...a); }
}
export const bus = new Emitter();

// Hex -> "r, g, b"
export const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`; };

// Cmd on a Mac is Super/Meta here; Alt works too, since compositors often swallow Super in windowed mode.
export const isCmd = (e) => e.metaKey || e.altKey;
