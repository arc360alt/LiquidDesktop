// Settings › Lock Screen, the parts beyond the password: when the display turns off, when the screen locks, when the
// computer sleeps, what closing the lid does (main/idle.js) — and Touch ID-style fingerprint unlock (main/fingerprint.js).
import { h } from '../util.js';
import { api } from '../sys.js';
import { status } from '../status.js';

const MIN = [[1, '1 minute'], [2, '2 minutes'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [180, '3 hours'], [0, 'Never']];
const LOCK = [[0, 'Immediately'], [5, 'After 5 seconds'], [60, 'After 1 minute'], [300, 'After 5 minutes'], [900, 'After 15 minutes'], [3600, 'After 1 hour'], [-1, 'Never']];
const LID = [['sleep', 'Sleep'], ['lock', 'Lock and turn off the display'], ['nothing', 'Do nothing']];

export async function powerGroups({ row }) {
  if (!api.power?.idleSettings) return [];
  const c = await api.power.idleSettings().catch(() => null);
  if (!c) return [];
  const sel = (key, opts) => h('select.field.square', { style: { height: '26px', minWidth: '170px' }, onchange: (e) => api.power.idleSettings({ [key]: typeof opts[0][0] === 'number' ? +e.target.value : e.target.value }) },
    ...opts.map(([v, l]) => h('option', { value: v, selected: c[key] === v }, l)));
  const laptop = status.s.battery?.percent != null;
  const out = [h('div.group-title', 'Display & Sleep'), h('div.group',
    laptop ? row('Turn display off on battery when inactive', sel('displayOffBattery', MIN)) : null,
    row(laptop ? 'Turn display off on power adapter when inactive' : 'Turn display off when inactive', sel('displayOffAC', MIN)),
    row('Require password after the display turns off', sel('lockAfter', LOCK), 'The screen locks this long after the display goes to sleep.'),
    laptop ? row('Put the computer to sleep on battery when inactive', sel('sleepBattery', MIN)) : null,
    row(laptop ? 'Put the computer to sleep on power adapter when inactive' : 'Put the computer to sleep when inactive', sel('sleepAC', MIN)),
    c.inhibitors?.length ? row('Kept awake by', h('span.muted', c.inhibitors.map((x) => `${x.app}${x.reason ? ` (${x.reason})` : ''}`).join(', '))) : null)];
  if (laptop) out.push(h('div.group-title', 'Lid'), h('div.group',
    row('When the lid is closed on battery', sel('lid', LID)),
    row('When the lid is closed on power adapter', sel('lidAC', LID), 'With an external display connected, closing the lid keeps the computer awake (like a Mac in clamshell mode).')));
  return out;
}

/* ------------------------------------------------------------------ Fingerprints (main/fingerprint.js) */
const FINGERS = [['right-index-finger', 'Right index finger'], ['right-thumb', 'Right thumb'], ['right-middle-finger', 'Right middle finger'], ['right-ring-finger', 'Right ring finger'], ['right-little-finger', 'Right little finger'],
  ['left-index-finger', 'Left index finger'], ['left-thumb', 'Left thumb'], ['left-middle-finger', 'Left middle finger'], ['left-ring-finger', 'Left ring finger'], ['left-little-finger', 'Left little finger']];
const fingerName = (f) => (FINGERS.find(([id]) => id === f) || [f, f.replace(/-/g, ' ')])[1];
const FP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6.5 6.6A7.5 7.5 0 0 1 19.4 11M4.6 10a7.6 7.6 0 0 1 .9-2M5 15.5c.6-1.3.9-2.7.9-4.2A6.1 6.1 0 0 1 12 5.3M18.6 15.2c.3-1.3.5-2.6.5-4M8.3 19a12 12 0 0 0 1.5-6.9 2.3 2.3 0 0 1 4.5-.2M15.7 13.3a17 17 0 0 1-2 7M11.9 13.1c.1 2.7-.5 5.2-1.9 7.5"/></svg>';

export async function fingerprintGroups({ row, rerender, askSudo, alertDialog, confirmDialog }) {
  if (!api.fp?.status) return [];
  const st = await api.fp.status().catch(() => null);
  if (!st) return [];
  const { store } = await import('../store.js');
  const fail = (e) => alertDialog({ title: 'Fingerprints', message: e.message });
  const title = h('div.group-title', 'Fingerprints');
  if (!st.installed) {
    const b = h('button.btn', { disabled: !st.pm, onclick: async () => {
      if (!(await askSudo('Installing fingerprint support needs your password.'))) return;
      b.disabled = true; b.textContent = 'Installing…';
      try { await api.fp.install(); } catch (e) { fail(e); }
      rerender();
    } }, 'Install');
    return [title, h('div.group', row('Unlock with your fingerprint', b, st.pm ? 'Installs fprintd, the Linux fingerprint service, if your computer has a sensor.' : 'Install fprintd with your package manager.'))];
  }
  if (!st.device) return [title, h('div.group', row(h('span.muted', 'No fingerprint sensor found'), null, 'If your computer has one, its driver may not support Linux yet (libfprint’s list of supported devices).'))];
  const fingers = st.fingers || [];
  const add = async () => {
    const free = FINGERS.filter(([id]) => !fingers.includes(id));
    const pick = h('select.field.square', { style: { width: '100%', height: '28px' } }, ...free.map(([id, n]) => h('option', { value: id }, n)));
    const r = await alertDialog({ title: 'Add a Fingerprint', message: 'Which finger?', content: h('div', { style: { width: '100%' } }, pick), buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Continue', value: 'ok', primary: true }] });
    if (r.button !== 'ok') return;
    enrollSheet(pick.value, st.device, () => rerender(), alertDialog);
  };
  const rows = fingers.map((f) => row(h('div.fp-row', h('span.fp-ic', { html: FP_ICON }), fingerName(f)), h('button.btn', { onclick: async () => {
    if (!(await confirmDialog(`Remove “${fingerName(f)}”?`, 'You can add it again later.', 'Remove', { danger: true }))) return;
    try { await api.fp.remove(f); } catch (e) { fail(e); }
    rerender();
  } }, 'Remove')));
  const loginToggle = h('input', { type: 'checkbox', checked: st.login.on, disabled: !st.login.files.length || !fingers.length, onchange: async (e) => {
    const want = e.target.checked;
    if (!(await askSudo('Changing the login screen needs your password.'))) { e.target.checked = !want; return; }
    try { await api.fp.setLogin(want); } catch (er) { e.target.checked = !want; fail(er); }
  } });
  return [title, h('div.group',
    ...rows, !fingers.length ? row(h('span.muted', 'No fingerprints added'), null) : null,
    row(st.device.name ? h('small.muted', st.device.name) : '', h('button.btn', { disabled: fingers.length >= FINGERS.length, onclick: add }, 'Add Fingerprint…')),
    row('Use your fingerprint to unlock', h('label.toggle', h('input', { type: 'checkbox', checked: store.get('fpUnlock') !== false, disabled: !fingers.length, onchange: (e) => store.set('fpUnlock', e.target.checked) }), h('span')),
      'Touch the sensor on the lock screen instead of typing your password.'),
    row('Use your fingerprint at the login screen', h('label.toggle', loginToggle, h('span')),
      st.login.files.length ? 'Press Enter with an empty password, then touch the sensor. Typing your password works as always.' : 'Needs LiquidDesktop’s own login screen (Login Screen, below).'))];
}

/** The enrolling sheet: "Lift and rest your finger" while a ring fills, like setting up Touch ID. */
function enrollSheet(finger, device, done, alertDialog) {
  const C = 2 * Math.PI * 44;
  const ring = h('div.fp-ring', { html: `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="none" stroke="rgba(128,128,128,.25)" stroke-width="6"/><circle class="fp-prog" cx="50" cy="50" r="44" fill="none" stroke="#ff375f" stroke-width="6" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}" transform="rotate(-90 50 50)"/></svg>` }, h('span', { html: FP_ICON }));
  const text = h('p', device.scanType === 'swipe' ? 'Swipe your finger across the sensor.' : 'Rest your finger on the sensor, then lift it. Repeat until the ring is full.');
  const cancel = h('button.btn', { onclick: () => { api.fp.enrollCancel(); close(); } }, 'Cancel');
  const box = h('div.alert.glass.panel.sheen.fp-box', h('h3', `Add ${fingerName(finger)}`), ring, text, h('div.a-btns', cancel));
  const layer = h('div.global-alert-layer', box);
  document.body.append(layer);
  const close = () => { layer.remove(); off = true; };
  let off = false;
  const prog = ring.querySelector('.fp-prog');
  const set = (p) => prog.setAttribute('stroke-dashoffset', String(C * (1 - p)));
  const HINT = { 'enroll-retry-scan': 'Try again.', 'enroll-swipe-too-short': 'Swipe a bit longer.', 'enroll-finger-not-centered': 'Center your finger on the sensor.', 'enroll-remove-and-retry': 'Lift your finger and try again.' };
  if (!enrollHooked) { enrollHooked = true; api.fp.onEnroll((v) => enrollListener?.(v)); }
  enrollListener = (v) => {
    if (off) return;
    if (v.state === 'progress') { set(v.progress); text.textContent = device.scanType === 'swipe' ? 'Again.' : 'Lift and rest your finger again.'; }
    if (v.state === 'retry') text.textContent = HINT[v.hint] || 'Try again.';
    if (v.state === 'done') { set(1); prog.setAttribute('stroke', '#30d158'); text.textContent = 'Fingerprint added.'; cancel.textContent = 'Done'; cancel.onclick = () => { close(); done(); }; }
  };
  api.fp.enroll(finger).catch((e) => { if (off) return; close(); alertDialog({ title: 'The fingerprint couldn’t be added', message: e.message }); done(); });
}
let enrollHooked = false, enrollListener = null;
