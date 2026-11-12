// Session mode, shell layer: this page covers the whole screen, transparently.
// It tells the window manager two things whenever they change:
//   • which rectangles take clicks (everything else passes through to the apps below)
//   • where its glass surfaces are, so the WM can put a blur window (blurred by picom) behind each one
import { $, $$, bus } from './util.js';
import { session as S } from './layer.js';
import { store, dockReserve } from './store.js';
import { closeMenu } from './menus.js';
import { dockHidden, revealDock } from './dock.js';
import { menubarHidden, revealMenubar } from './menubar.js';

const INTERACTIVE = ['#menubar', '#dock', '#dock .dock-floor', '.dock-item', '.menu', '.cc', '#nc.open', '#toasts > *', '#switcher', '#spotlight .bar',
  '#spotlight .chips > *', '#spotlight .results:not([hidden])', '#launcher', '#widget-gallery', '.global-alert-layer .alert', '#mission', '#lock', '#boot', '.quicklook', '#shot-layer'];
const MODAL = ['.menu', '.cc', '#nc.open', '#spotlight-layer', '#launcher-layer', '.global-alert-layer', '#mission', '#lock', '#boot', '#switcher', '.quicklook', '#shot-layer'];
const KEYBOARD = ['#spotlight-layer', '#launcher-layer', '#lock', '.global-alert-layer', '#shot-layer'];
// glass that gets a real blur behind it: these, plus anything the stylesheets give a backdrop blur (see glassSelectors)
const GLASS = ['.glass', '#menubar', '#mission', '#launchpad', '.snap-preview'];

// The shell page is transparent, so a CSS backdrop-filter in it has nothing to blur: it only shows a faint tint.
// Every rule that asks for one is collected here, so those elements get a real (compositor) blur too.
function glassSelectors() {
  const out = new Set(GLASS);
  const splitTop = (sel) => {
    const parts = []; let depth = 0, cur = '';
    for (const ch of sel) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { parts.push(cur); cur = ''; } else cur += ch; }
    parts.push(cur);
    return parts.map((x) => x.trim()).filter(Boolean);
  };
  const walk = (rules) => {
    for (const r of rules) {
      if (r.cssRules && !r.selectorText) { walk(r.cssRules); continue; }
      if (!r.selectorText || !r.style) continue;
      const bf = r.style.getPropertyValue('backdrop-filter') || r.style.getPropertyValue('-webkit-backdrop-filter');
      if (!bf || bf === 'none' || !/blur\(/.test(bf)) continue;
      for (const sel of splitTop(r.selectorText)) {
        if (sel.includes('::') || /#lock|#boot|data-layer='(app|desktop)'/.test(sel)) continue;
        try { document.querySelector(sel); out.add(sel); } catch { /* not a selector the DOM can match */ }
      }
    }
  };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch { /* cross-origin sheet */ } }
  return [...out].join(', ');
}
let glassSel = GLASS.join(', ');
const RADII = [0, 6, 10, 14, 18, 22, 26, 30, 36];   // must match the rules in session/picom.conf

const visible = (el) => {
  if (!el.isConnected || el.closest('[hidden]')) return null;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity < 0.05) return null;
  const b = el.getBoundingClientRect();
  if (b.width < 2 || b.height < 2 || b.bottom < 0 || b.top > innerHeight) return null;
  return { b, cs };
};

let lastKey = '', lastKb = null, lastWork = '', lastEdges = '';
function measure() {
  const dpr = devicePixelRatio || 1;
  const px = (b) => [Math.floor(b.left * dpr), Math.floor(b.top * dpr), Math.ceil(b.width * dpr), Math.ceil(b.height * dpr)];
  const input = [];
  for (const sel of INTERACTIVE) for (const el of $$(sel)) { const v = visible(el); if (v) input.push(px(v.b)); }
  const blur = [];
  const all = new Set($$(glassSel));
  for (const el of all) {
    {
      if (el.closest('#lock, #boot')) continue;
      // glass inside other glass (e.g. widget previews in the gallery) is already covered by the outer blur
      let inner = false;
      for (let p = el.parentElement; p && !inner; p = p.parentElement) inner = all.has(p) && !!visible(p);
      if (inner) continue;
      const v = visible(el);
      if (!v) continue;
      // only the part that's actually shown: clip to any scrolling / clipping container around it
      let b = { left: v.b.left, top: v.b.top, right: v.b.right, bottom: v.b.bottom };
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p);
        if (o.overflowX === 'visible' && o.overflowY === 'visible') continue;
        const r = p.getBoundingClientRect();
        b = { left: Math.max(b.left, r.left), top: Math.max(b.top, r.top), right: Math.min(b.right, r.right), bottom: Math.min(b.bottom, r.bottom) };
      }
      if (b.right - b.left < 2 || b.bottom - b.top < 2) continue;
      const [x, y, w, h] = px({ left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top });
      const want = Math.min((parseFloat(v.cs.borderTopLeftRadius) || 0) * dpr, h / 2, w / 2);
      const r = RADII.reduce((a, c) => (Math.abs(c - want) < Math.abs(a - want) ? c : a), 0);
      blur.push({ x, y, w, h, r });
    }
  }
  const modal = MODAL.some((s) => $(s));
  const key = JSON.stringify([input, modal, blur]);
  if (key !== lastKey) { lastKey = key; S.send('shell:regions', input, modal, blur); }
  window.__liquidRegions = { input, modal, blur };   // for debugging: what the window manager was told
  const kb = KEYBOARD.some((s) => $(s));
  if (kb !== lastKb) { lastKb = kb; S.send('shell:focus', kb); }
  const edges = JSON.stringify({ bottom: dockHidden(), top: menubarHidden() });
  if (edges !== lastEdges) { lastEdges = edges; S.send('shell:edges', JSON.parse(edges)); }
  const work = JSON.stringify([30, dockReserve()]);
  if (work !== lastWork) { lastWork = work; S.send('shell:workarea', ...JSON.parse(work)); }
}

// Measuring is only needed while something changes: after any DOM/style change (or pointer activity
// over the shell) we track every frame for a short while, then go idle.
let activeUntil = 0, looping = false;
function wake(ms = 450) {
  activeUntil = Math.max(activeUntil, performance.now() + ms);
  if (looping) return;
  looping = true;
  const loop = () => {
    measure();
    if (performance.now() < activeUntil) requestAnimationFrame(loop); else looping = false;
  };
  requestAnimationFrame(loop);
}

export function initShellShape() {
  glassSel = glassSelectors();
  new MutationObserver(() => wake()).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  addEventListener('mousemove', () => wake(200), { passive: true });
  addEventListener('transitionrun', () => wake(700));
  addEventListener('animationstart', () => wake(700));
  setInterval(() => wake(50), 2000);   // a slow safety net
  measure();
  // kept for compatibility: a WM-reported click outside every popover closes them
  S.on('session:outside', ({ x, y }) => {
    const target = document.elementFromPoint(x, y) || document.body;
    closeMenu();
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
  });
  // where a dragged window would tile
  S.on('session:snap', (r) => {
    let el = $('.snap-preview');
    if (!r) { el?.remove(); return; }
    if (!el) { el = document.createElement('div'); el.className = 'snap-preview'; el.style.position = 'fixed'; document.body.append(el); }
    Object.assign(el.style, { left: r[0] + 'px', top: r[1] + 'px', width: r[2] + 'px', height: r[3] + 'px', zIndex: 7000 });
  });
  bus.on('lock', (on) => S.send('shell:locked', on));
  S.on('session:edge', (side) => (side === 'bottom' ? revealDock() : revealMenubar()));
}
