// Title bar for a native Linux app window (session mode). The app's own window sits inside this one.
import { store } from './store.js';
import { applyTheme } from './theme.js';
import { session as S } from './layer.js';

const id = Number(new URLSearchParams(location.search).get('id'));
const op = (name, arg) => S.send('frame:op', id, name, arg);
const $ = (s) => document.querySelector(s);

applyTheme();
store.on('change', (k) => { if (['theme', 'accent', 'cursorTheme', 'cursorSize'].includes(k)) applyTheme(); });

const bar = $('.fr-bar'), title = $('.win-title');

$('.tl-close').addEventListener('click', (e) => { e.stopPropagation(); op('close'); });
$('.tl-min').addEventListener('click', (e) => { e.stopPropagation(); op('minimize'); });
$('.tl-max').addEventListener('click', (e) => { e.stopPropagation(); op('zoom', store.get('zoomAction') || 'fill'); });
for (const b of document.querySelectorAll('.traffic button')) b.addEventListener('mousedown', (e) => e.stopPropagation());

// hovering the green button shows the Move & Resize menu (drawn by the shell, since this window is tiny)
let hoverT;
const maxBtn = $('.tl-max');
maxBtn.addEventListener('mouseenter', () => { hoverT = setTimeout(() => { const r = maxBtn.getBoundingClientRect(); S.send('shell:windowMenu', id, Math.round(r.left - 6), Math.round(r.bottom + 6), 'tile', true); }, 700); });
maxBtn.addEventListener('mouseleave', () => clearTimeout(hoverT));

bar.addEventListener('mousedown', (e) => { if (e.button !== 0) return; op('activate'); op('beginMove'); });
bar.addEventListener('dblclick', () => op('toggleMaximize'));
bar.addEventListener('contextmenu', (e) => { e.preventDefault(); S.send('shell:windowMenu', id, e.clientX, e.clientY, 'window', true); });
for (const r of document.querySelectorAll('.rz')) r.addEventListener('mousedown', (e) => { e.preventDefault(); op('activate'); op('beginResize', r.classList[1]); });

S.on('frame:update', (u) => {
  title.textContent = u.title || '';
  document.title = u.title || 'Window';
  document.body.classList.toggle('focused', !!u.focused);
  document.body.classList.toggle('fullscreen', !!u.fullscreen);
});

// Phone Mirroring (main/mirror.js): the phone's own buttons in the title bar — Back, Home, App Switcher, and a
// screenshot — like the controls that show over the Mac's iPhone Mirroring window
const PHONE_BTNS = [
  ['back', 'Back', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>'],
  ['home', 'Home', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="6.5"/></svg>'],
  ['recents', 'App Switcher', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="6" y="5" width="12" height="14" rx="2.5"/></svg>'],
  ['screenshot', 'Take Screenshot', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.6" r="3.3"/></svg>'],
];
let phoneBar = null;
S.on('frame:update', (u) => {
  const isPhone = (u.wmClass || []).some((c) => c === 'liquid-mirroring');
  document.body.classList.toggle('mirror', isPhone);
  if (!isPhone || phoneBar) return;
  phoneBar = document.createElement('div');
  phoneBar.className = 'fr-phone';
  for (const [k, label, icon] of PHONE_BTNS) {
    const b = document.createElement('button');
    b.title = label; b.innerHTML = icon;
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); window.sys?.mirror?.key(k, title.textContent).catch(() => {}); });
    phoneBar.append(b);
  }
  bar.append(phoneBar);
});
