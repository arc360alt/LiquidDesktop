// Setup Assistant: the first time LiquidDesktop starts (and from Settings › General › Run Setup Assistant…) — a
// full-screen glass walk-through: hello, Wi-Fi, your name and picture, how it looks, your phone, the essentials.
// Every step can be skipped; nothing here can't be changed later in Settings.
import { h, $, $$ } from './util.js';
import { api } from './sys.js';
import { store } from './store.js';
import { sym, logoBadge } from './icons.js';
import { wallpaperFor } from './theme.js';

const HELLOS = ['hello', 'hola', 'bonjour', 'hallo', 'ciao', 'olá', 'привет', 'こんにちは', '你好', '안녕하세요', 'merhaba', 'hej', 'cześć', 'नमस्ते', 'مرحبا'];
const ACCENTS = [['#0a84ff', 'Blue'], ['#af52de', 'Purple'], ['#ff2d55', 'Pink'], ['#ff3b30', 'Red'], ['#ff9500', 'Orange'], ['#ffcc00', 'Yellow'], ['#34c759', 'Green'], ['#8e8e93', 'Graphite']];
let open = false;

/** First start: show it unless it's been done (or LiquidDesktop was already set up before it existed). */
export async function maybeRunSetup() {
  if (store.get('setupDone')) return false;
  // a live system from an installer image (main/system.js liveSession): it's there to install the OS, not to set up
  const info = await api.sys.info().catch(() => ({}));
  if (info.live?.live) return false;
  if (store.get('welcomed')) { store.set('setupDone', true); return false; }   // already using LiquidDesktop
  runSetup();
  return true;
}

export async function runSetup() {
  if (open) return;
  open = true;
  const info = await api.sys.info().catch(() => ({}));
  const root = h('div#setup', { style: { backgroundImage: `url("${wallpaperFor()}")` } });
  const card = h('div.su-card.glass.panel');
  const dots = h('div.su-dots');
  root.append(h('div.su-veil'), card, dots);
  document.body.append(root);
  let step = 0;
  const STEPS = [hello, wifi, account, look, phone, tour];
  const go = (i) => {
    step = Math.max(0, Math.min(STEPS.length - 1, i));
    card.classList.remove('in'); void card.offsetWidth; card.classList.add('in');
    card.replaceChildren(...STEPS[step]());
    dots.replaceChildren(...STEPS.map((_, j) => h('i' + (j === step ? '.on' : ''))));
    setTimeout(() => $('input:not([type=hidden]), button.primary', card)?.focus(), 80);
  };
  const nav = (next = 'Continue', { back = true, skip = false, onNext } = {}) => h('div.su-nav',
    back && step > 0 ? h('button.btn.plain', { onclick: () => go(step - 1) }, 'Back') : h('span'),
    h('div.spacer'),
    skip ? h('button.btn.plain', { onclick: () => go(step + 1) }, 'Set Up Later') : null,
    h('button.btn.primary', { onclick: async () => { if (onNext && (await onNext()) === false) return; go(step + 1); } }, next));
  const finish = () => {
    store.set('setupDone', true); store.set('welcomed', true);
    root.classList.add('out');
    setTimeout(() => { root.remove(); open = false; }, 600);
  };

  /* -------------------------------------------- hello */
  function hello() {
    const word = h('div.su-hello', HELLOS[0]);
    let i = 0;
    const t = setInterval(() => { if (!word.isConnected) return clearInterval(t); i = (i + 1) % HELLOS.length; word.classList.remove('show'); void word.offsetWidth; word.textContent = HELLOS[i]; word.classList.add('show'); }, 2200);
    word.classList.add('show');
    return [h('div.su-logo', { html: logoBadge() }), word, h('p.su-sub', 'Welcome to LiquidDesktop. Let’s get a few things ready — it takes about a minute.'),
      h('div.su-nav.center', h('button.btn.primary.su-big', { onclick: () => go(1) }, 'Get Started'))];
  }

  /* -------------------------------------------- Wi-Fi */
  function wifi() {
    const list = h('div.su-list', h('div.su-empty', h('span.spinner'), 'Looking for networks…'));
    const status = h('p.su-sub', 'Choose a network to get online.');
    const draw = async () => {
      const st = await api.sys.status().catch(() => ({}));
      if (st.wifi?.wired && !st.wifi?.ssid) status.textContent = 'You’re connected with a cable. You can also join a Wi-Fi network.';
      else if (st.wifi?.ssid) status.textContent = `You’re connected to ${st.wifi.ssid}.`;
      const nets = await api.sys.wifiList().catch(() => null);
      if (!nets) { list.replaceChildren(h('div.su-empty', 'Wi-Fi isn’t available here.')); return; }
      if (!nets.length) { list.replaceChildren(h('div.su-empty', 'No networks found.')); return; }
      list.replaceChildren(...nets.slice(0, 12).map((n) => h('div.su-row' + (n.active ? '.on' : ''), { onclick: () => join(n) },
        h('span.su-ic', { html: sym.wifi, style: { opacity: 0.35 + n.signal / 150 } }), h('span.su-name', n.ssid), n.active ? h('span.su-check', { html: sym.check }) : null, n.secure ? h('span.su-lock', { html: sym.lock }) : null)));
    };
    const join = async (n) => {
      if (n.active) return;
      let r = await api.sys.wifiConnect(n.ssid).catch((e) => ({ ok: false, error: e.message }));
      if (r && !r.ok && n.secure) {
        const pw = h('input.field.square', { type: 'password', placeholder: `Password for ${n.ssid}`, style: { width: '100%', height: '32px' } });
        const row = h('div.su-pw', pw, h('button.btn.primary', { onclick: async () => { status.textContent = `Joining ${n.ssid}…`; r = await api.sys.wifiConnect(n.ssid, pw.value).catch(() => ({ ok: false })); status.textContent = r?.ok === false ? 'That password didn’t work.' : `Connected to ${n.ssid}.`; draw(); } }, 'Join'));
        $('.su-pw', card)?.remove();
        list.after(row); pw.focus();
        pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') row.querySelector('button').click(); });
        return;
      }
      draw();
    };
    draw();
    return [h('div.su-icon', { html: sym.wifi }), h('h1', 'Get Online'), status, list, nav('Continue', { skip: true })];
  }

  /* -------------------------------------------- your account */
  function account() {
    const initials = (info.fullName || info.user || '?').split(/\s+/).map((s) => s[0]).join('').slice(0, 2).toUpperCase();
    const pic = h('div.su-avatar', store.get('userAvatar') ? h('img', { src: store.get('userAvatar'), alt: '' }) : initials);
    const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async () => {
      const f = file.files[0]; if (!f) return;
      const img = new Image(); img.src = URL.createObjectURL(f); await img.decode().catch(() => {});
      const c = document.createElement('canvas'); c.width = c.height = 256;
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
      const url = c.toDataURL('image/png');
      try { await api.sys.setAvatar?.(url); } catch { /* kept locally anyway */ }
      store.set('userAvatar', url);
      pic.replaceChildren(h('img', { src: url, alt: '' }));
    } });
    const name = h('input.field.square.su-input', { value: info.fullName || '', placeholder: 'Your name' });
    const save = async () => {
      const v = name.value.trim();
      if (v && v !== info.fullName) { try { await api.sys.setRealName?.(v); info.fullName = v; } catch { /* keep going */ } }
    };
    return [h('h1', 'About You'), h('p.su-sub', 'Your name and picture show on the lock screen, the login screen and in the menu bar.'),
      h('div.su-account', pic, h('button.btn', { onclick: () => file.click() }, 'Choose Picture…'), file),
      name, nav('Continue', { onNext: save })];
  }

  /* -------------------------------------------- appearance */
  function look() {
    const cards = h('div.su-themes');
    const accents = h('div.su-accents');
    const glass = h('div.segmented');
    const draw = () => {
      cards.replaceChildren(...[['light', 'Light', 'linear-gradient(135deg,#8ec5ff,#3d7fe0)', '#f6f6f8'], ['dark', 'Dark', 'linear-gradient(135deg,#0b1a3f,#06143a)', '#232326'],
        ['auto', 'Auto', 'linear-gradient(90deg,#8ec5ff 50%,#0b1a3f 50%)', 'linear-gradient(90deg,#f6f6f8 50%,#232326 50%)']].map(([v, l, bg, fg]) =>
        h('button.su-theme' + (store.get('theme') === v ? '.on' : ''), { onclick: () => { store.set('theme', v); draw(); } }, h('div.pv', { style: { background: bg } }, h('i', { style: { background: fg } })), h('span', l))));
      accents.replaceChildren(...ACCENTS.map(([c, n]) => h('button' + (store.get('accent') === c ? '.on' : ''), { title: n, style: { background: c }, onclick: () => { store.set('accent', c); draw(); } })));
      glass.replaceChildren(...[['clear', 'Clear'], ['tinted', 'Tinted']].map(([v, l]) => h('button' + (store.get('glass') === v ? '.on' : ''), { onclick: () => { store.set('glass', v); draw(); } }, l)));
    };
    draw();
    return [h('h1', 'Choose Your Look'), h('p.su-sub', 'Auto switches between light and dark with the time of day.'), cards,
      h('div.su-opt', h('span', 'Accent color'), accents), h('div.su-opt', h('span', 'Liquid Glass'), glass), nav()];
  }

  /* -------------------------------------------- your phone (KDE Connect) */
  function phone() {
    const body = h('div.su-list', h('div.su-empty', h('span.spinner'), 'Looking for your phone…'));
    const draw = async () => {
      const st = await api.kdc?.state().catch(() => null);
      if (!st?.installed) {
        body.replaceChildren(h('div.su-empty.col', h('b', 'Use your phone with this computer'), h('span', 'Texts, calls, notifications, files and phone mirroring work through KDE Connect. Install it from the App Store, and KDE Connect on your phone, then pair them in Settings › Phone.')));
        return;
      }
      const devs = (st.devices || []).filter((d) => d.reachable || d.paired);
      if (!devs.length) { body.replaceChildren(h('div.su-empty.col', h('b', 'No phone found yet'), h('span', 'Open KDE Connect on your phone, on the same Wi-Fi. It shows up here.'))); return; }
      body.replaceChildren(...devs.map((d) => h('div.su-row', h('span.su-ic', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6.5" y="2" width="11" height="20" rx="2.6"/></svg>' }), h('span.su-name', d.name, h('small', d.paired ? 'Paired' : d.requested ? 'Accept on your phone…' : 'Available')),
        d.paired ? h('span.su-check', { html: sym.check }) : h('button.btn', { onclick: async () => { await api.kdc.act(d.id, 'pair').catch(() => {}); setTimeout(draw, 800); } }, 'Pair'))));
    };
    draw();
    const t = setInterval(() => { if (!body.isConnected) return clearInterval(t); draw(); }, 3000);
    return [h('div.su-icon', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6.5" y="2" width="11" height="20" rx="2.6"/><path d="M10.5 4.6h3"/></svg>' }),
      h('h1', 'Your Phone'), h('p.su-sub', 'Pair your Android phone to text from here, get its notifications, send files, and see its screen.'), body, nav('Continue', { skip: true })];
  }

  /* -------------------------------------------- the essentials */
  function tour() {
    const tip = (icon, t, d) => h('div.su-tip', h('span.su-tip-ic', { html: icon }), h('div', h('b', t), h('small', d)));
    return [h('h1', 'You’re All Set'), h('p.su-sub', 'A few things worth knowing:'),
      h('div.su-tips',
        tip(sym.search, 'Spotlight', 'Alt+Space finds apps, files and settings.'),
        tip(sym.grid, 'Apps & Mission Control', 'F4 shows every app; F3 shows every window.'),
        tip('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="5.5" y="4" width="13" height="17" rx="2.2"/><path d="M9 4V3h6v1"/></svg>', 'Clipboard History', 'Super+V brings back anything you copied.'),
        tip(sym.widgets || sym.grid, 'Widgets', 'Click the clock in the menu bar, or right-click the desktop › Edit Widgets.')),
      h('div.su-nav', h('button.btn.plain', { onclick: () => go(step - 1) }, 'Back'), h('div.spacer'), h('button.btn.primary.su-big', { onclick: finish }, 'Start Using LiquidDesktop'))];
  }

  root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.target.closest('input, button')) $('.su-nav .btn.primary', card)?.click(); });
  void $$;
  go(0);
}
