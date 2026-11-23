// The password sheet for apps asking for administrator rights (polkit, main/polkit.js): "<App> wants to make
// changes. Enter your password to allow this." — like the Mac's. One at a time; a wrong password shakes the sheet.
import { h, $ } from './util.js';
import { session as S } from './layer.js';

const LOCK = '<svg viewBox="0 0 64 64"><defs><linearGradient id="pkg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f7d774"/><stop offset="1" stop-color="#d9a425"/></linearGradient></defs><path d="M20 28v-7a12 12 0 0 1 24 0v7" fill="none" stroke="#a8a8ad" stroke-width="5"/><rect x="12" y="27" width="40" height="29" rx="6" fill="url(#pkg)"/><circle cx="32" cy="39" r="4" fill="#8a6510"/><rect x="30.5" y="40" width="3" height="8" rx="1.5" fill="#8a6510"/></svg>';
const queue = [];
let current = null;

const appName = (info) => {
  const prog = info.details?.program || info.details?.['polkit.caller-program'] || '';
  if (prog) return prog.split('/').pop();
  return '';
};

export function initPolkit() {
  S.on('session:polkit', (info) => { queue.push(info); if (!current) next(); });
  S.on('session:polkitClose', (cookie) => {
    const i = queue.findIndex((q) => q.cookie === cookie);
    if (i >= 0) queue.splice(i, 1);
    if (current?.info.cookie === cookie) close();
  });
}

function close() {
  current?.layer.remove();
  current = null;
  if (queue.length) setTimeout(next, 150);
}

function next() {
  const info = queue.shift();
  if (!info) return;
  // a retry for the sheet that's showing: shake it and say why
  const name = appName(info);
  const users = info.users || [];
  const userSel = users.length > 1 ? h('select.field.square.pk-user', ...users.map((u) => h('option', { value: u.name }, u.real && u.real !== u.name ? `${u.real} (${u.name})` : u.name))) : null;
  const pw = h('input.field.square.pk-pw', { type: 'password', placeholder: 'Password', autocomplete: 'off', spellcheck: false });
  const err = h('div.pk-err', info.error || '');
  const details = h('div.pk-details', { hidden: true },
    h('div', h('b', 'Action: '), info.actionId),
    info.details?.command_line ? h('div', h('b', 'Command: '), info.details.command_line) : null,
    ...Object.entries(info.details || {}).filter(([k]) => !['command_line', 'program'].includes(k) && !k.startsWith('polkit.')).slice(0, 4).map(([k, v]) => h('div', h('b', k + ': '), String(v))));
  const answer = (a) => { S.send('shell:polkitAnswer', info.cookie, a); close(); };
  const ok = () => { if (!pw.value) { pw.focus(); return; } answer({ user: userSel ? userSel.value : users[0]?.name, password: pw.value }); };
  const box = h('div.alert.glass.panel.sheen.pk-box',
    h('div.a-icon.pk-icon', { html: LOCK }),
    h('h3', name ? `“${name}” wants to make changes.` : 'Authentication Required'),
    h('p', `${(info.message || 'An app wants to make changes.').replace(/([^.!?])\s*$/, '$1.')} Enter ${users.length > 1 ? 'an administrator’s' : 'your'} password to allow this.`),
    userSel, pw, err,
    h('button.pk-more', { onclick: (e) => { details.hidden = !details.hidden; e.currentTarget.textContent = details.hidden ? 'Details' : 'Hide Details'; } }, 'Details'),
    details,
    h('div.a-btns', h('button.btn', { onclick: () => answer(null) }, 'Cancel'), h('button.btn.primary', { onclick: ok }, 'OK')));
  const layer = h('div.global-alert-layer.pk-layer', box);
  layer.addEventListener('mousedown', (e) => e.stopPropagation());
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } if (e.key === 'Escape') { e.preventDefault(); answer(null); } });
  layer.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); answer(null); } });
  document.body.append(layer);
  current = { info, layer };
  if (info.error) { box.classList.add('shake'); setTimeout(() => box.classList.remove('shake'), 500); }
  setTimeout(() => { pw.focus(); void $; }, 60);
}
