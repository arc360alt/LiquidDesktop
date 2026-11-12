// The LiquidDesktop login screen (run by greetd, see main/greeter.js): the lock screen's look, with real
// blur, for logging in — pick a person and a session, type the password, or sleep / restart / shut down.
import { wallpaperUrl } from './wallpapers.js';
import { sym } from './icons.js';

const $ = (s) => document.querySelector(s);
const g = window.greeter;
const night = () => { const hr = new Date().getHours(); return hr < 7 || hr >= 19; };

// wallpaper and clock
function wall() { $('#g-wall').style.backgroundImage = `url("${wallpaperUrl('peaks', Math.round(innerWidth * devicePixelRatio), Math.round(innerHeight * devicePixelRatio), night())}")`; }
function clock() {
  const d = new Date();
  $('.g-date').textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  $('.g-time').textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
}
wall(); clock();
setInterval(clock, 1000);
addEventListener('resize', wall);

let info = { users: [], sessions: [], last: {} }, user = null, session = null, busy = false;
const initials = (n) => n.split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
const avatar = (u, cls = '') => {
  const el = document.createElement('div');
  el.className = 'g-av ' + cls;
  if (u?.avatar) { const img = document.createElement('img'); img.src = u.avatar; el.append(img); } else el.textContent = u ? initials(u.realName || u.name) : '?';
  return el;
};

function pick(u) {
  user = u;
  $('.g-avatar').replaceChildren(avatar(u, 'big'));
  $('.g-name').textContent = u ? u.realName : 'Other User';
  $('.g-user').hidden = !!u;
  document.querySelectorAll('.g-person').forEach((p) => p.classList.toggle('sel', p.dataset.name === (u?.name ?? '')));
  msg('');
  (u ? $('.g-pass') : $('.g-user')).focus();
}
function drawPeople() {
  const box = $('.g-people');
  box.replaceChildren();
  if (info.users.length < 2) return;
  for (const u of [...info.users, null]) {
    const b = document.createElement('button');
    b.className = 'g-person'; b.dataset.name = u?.name ?? '';
    b.append(u ? avatar(u) : Object.assign(avatar(null), { textContent: '…' }), Object.assign(document.createElement('span'), { textContent: u ? u.realName : 'Other' }));
    b.addEventListener('click', () => pick(u));
    box.append(b);
  }
}
function drawSession() {
  const btn = $('.g-session');
  btn.textContent = session ? session.name : 'No sessions';
  btn.onclick = (e) => {
    e.stopPropagation();
    document.querySelector('.g-menu')?.remove();
    const m = document.createElement('div');
    m.className = 'g-menu glass';
    for (const s of info.sessions) {
      const it = document.createElement('button');
      it.textContent = s.name + (s.type === 'wayland' ? '  (Wayland)' : '');
      if (s === session) it.className = 'on';
      it.onclick = () => { session = s; drawSession(); m.remove(); $('.g-pass').focus(); };
      m.append(it);
    }
    document.body.append(m);
    const r = btn.getBoundingClientRect();
    m.style.left = r.left + 'px'; m.style.bottom = innerHeight - r.top + 8 + 'px';
    setTimeout(() => addEventListener('click', () => m.remove(), { once: true }), 0);
  };
}
function drawPower() {
  const box = $('.g-power');
  for (const [action, label, icon] of [['suspend', 'Sleep', sym.moon], ['restart', 'Restart', sym.restart], ['shutdown', 'Shut Down', sym.power]]) {
    const b = document.createElement('button');
    b.className = 'g-pbtn';
    b.innerHTML = `<span class="glass">${icon}</span>${label}`;
    b.onclick = () => g.power(action);
    box.append(b);
  }
}
function msg(t, bad) { const m = $('.g-msg'); m.textContent = t; m.classList.toggle('bad', !!bad); }

$('.g-field').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  const name = user ? user.name : $('.g-user').value.trim();
  const pass = $('.g-pass').value;
  if (!name || !pass) return;
  busy = true; msg('Logging in…'); document.body.classList.add('busy');
  const r = await g.login(name, pass, session?.id).catch((err) => ({ ok: false, error: err.message }));
  busy = false; document.body.classList.remove('busy');
  if (r.ok) {
    if (r.test) { msg(`Test mode: would start ${r.cmd.join(' ')}`); return; }
    msg('Welcome'); document.body.classList.add('leaving');
    return;
  }
  $('.g-pass').value = '';
  msg(r.error || 'Couldn’t log in', true);
  const f = $('.g-field'); f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake');
  $('.g-pass').focus();
});
addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('.g-pass').value = ''; msg(''); } });

(async () => {
  try { info = await g.info(); } catch { /* not under the greeter */ }
  session = info.sessions.find((s) => s.id === info.last?.session) || info.sessions[0] || null;
  drawPeople(); drawSession(); drawPower();
  pick(info.users.find((u) => u.name === info.last?.user) || info.users[0] || null);
  document.body.classList.add('ready');
})();
