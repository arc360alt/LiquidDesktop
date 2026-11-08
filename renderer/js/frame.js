// Title bar for a native Linux app window (session mode). The app's own window sits inside this one.
import { store } from './store.js';
import { applyTheme } from './theme.js';
import { session as S } from './layer.js';

const id = Number(new URLSearchParams(location.search).get('id'));
const op = (name, arg) => S.send('frame:op', id, name, arg);
const $ = (s) => document.querySelector(s);

applyTheme();
store.on('change', (k) => { if (['theme', 'accent'].includes(k)) applyTheme(); });

const bar = $('.fr-bar'), title = $('.win-title');

$('.tl-close').addEventListener('click', (e) => { e.stopPropagation(); op('close'); });
$('.tl-min').addEventListener('click', (e) => { e.stopPropagation(); op('minimize'); });
$('.tl-max').addEventListener('click', (e) => { e.stopPropagation(); op('toggleMaximize'); });
for (const b of document.querySelectorAll('.traffic button')) b.addEventListener('mousedown', (e) => e.stopPropagation());

// hovering the green button shows the Move & Resize menu (drawn by the shell, since this window is tiny)
let hoverT;
const maxBtn = $('.tl-max');
maxBtn.addEventListener('mouseenter', () => { hoverT = setTimeout(() => { const r = maxBtn.getBoundingClientRect(); S.send('shell:windowMenu', id, Math.round(screenX + r.left - 6), Math.round(screenY + r.bottom + 6), 'tile'); }, 700); });
maxBtn.addEventListener('mouseleave', () => clearTimeout(hoverT));

bar.addEventListener('mousedown', (e) => { if (e.button !== 0) return; op('activate'); op('beginMove'); });
bar.addEventListener('dblclick', () => op('toggleMaximize'));
bar.addEventListener('contextmenu', (e) => { e.preventDefault(); S.send('shell:windowMenu', id, e.screenX, e.screenY, 'window'); });
for (const r of document.querySelectorAll('.rz')) r.addEventListener('mousedown', (e) => { e.preventDefault(); op('activate'); op('beginResize', r.classList[1]); });

S.on('frame:update', (u) => {
  title.textContent = u.title || '';
  document.title = u.title || 'Window';
  document.body.classList.toggle('focused', !!u.focused);
  document.body.classList.toggle('fullscreen', !!u.fullscreen);
});
