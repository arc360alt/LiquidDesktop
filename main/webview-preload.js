// Runs inside every web page shown by the Browser app (isolated from the page's own scripts).
// It notices logins being submitted (to offer saving the password) and fills saved logins in.
const { ipcRenderer } = require('electron');

const visible = (el) => el && el.offsetParent !== null && !el.disabled && el.type !== 'hidden';
const USER_SEL = 'input[type=email], input[type=text], input[type=tel], input:not([type]), input[autocomplete=username]';

function loginFields(root) {
  const pw = [...(root || document).querySelectorAll('input[type=password]')].find(visible);
  if (!pw) return null;
  const scope = pw.form || document;
  const inputs = [...scope.querySelectorAll(USER_SEL)].filter(visible);
  // the username is the last text-like field before the password field
  let user = null;
  for (const i of inputs) if (i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) user = i;
  return { pw, user: user || inputs[0] || null };
}

let lastSent = '';
function capture(root) {
  const f = loginFields(root);
  if (!f || !f.pw.value) return;
  const data = { origin: location.origin, username: f.user ? f.user.value : '', password: f.pw.value };
  const key = data.username + '\u0000' + data.password;
  if (key === lastSent) return;
  lastSent = key;
  ipcRenderer.sendToHost('pw-capture', data);
}

addEventListener('submit', (e) => capture(e.target), true);
addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('button, input[type=submit], [role=button]');
  if (b) capture(b.form || document);
}, true);
addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.type === 'password') capture(e.target.form || document); }, true);

// ask for saved logins when a password field shows up (also on single-page apps)
let asked = false;
function check() {
  if (asked || !loginFields()) return;
  asked = true;
  ipcRenderer.sendToHost('pw-request', location.origin);
}
addEventListener('DOMContentLoaded', () => {
  check();
  new MutationObserver(() => check()).observe(document.documentElement, { childList: true, subtree: true });
});

function setValue(el, v) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter ? setter.call(el, v) : (el.value = v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
ipcRenderer.on('pw-fill', (_e, { username, password }) => {
  const f = loginFields();
  if (!f) return;
  if (f.user && username) setValue(f.user, username);
  setValue(f.pw, password);
  lastSent = (username || '') + '\u0000' + password;   // don't offer to save what we just filled
});
