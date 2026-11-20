// Phone Mirroring — your Android phone's screen in a window, to use with the mouse and keyboard (like the Mac's
// iPhone Mirroring). main/mirror.js runs scrcpy; this window sets it up: installing it, connecting the phone (USB
// cable, or Wireless debugging paired once with a code), and the options. Once the phone shows, this window steps
// aside; the phone's window has Back, Home, App Switcher and Screenshot in its title bar.
import { h } from '../util.js';
import { registerApp } from '../wm.js';
import { api } from '../sys.js';
import { store } from '../store.js';
import { alertDialog, prompt } from '../menus.js';
import { shell } from '../shell.js';

const PHONE = '<svg viewBox="0 0 60 100"><defs><linearGradient id="mrb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#64d2ff"/><stop offset="1" stop-color="#5e5ce6"/></linearGradient></defs><rect x="2" y="2" width="56" height="96" rx="11" fill="#1c1c1e"/><rect x="6" y="9" width="48" height="84" rx="7" fill="url(#mrb)"/><rect x="24" y="4.5" width="12" height="2.4" rx="1.2" fill="#555"/></svg>';
const opt = (k, d) => (store.get(k) ?? d);

registerApp({
  id: 'mirroring', name: 'Phone Mirroring', size: [560, 560], minSize: [460, 440], overlayContent: true, hideTitle: true, singleton: true,
  keywords: ['scrcpy', 'android', 'phone screen', 'mirror', 'cast'],
  about: 'Use your Android phone from this computer.',
  open(win) {
    const root = h('div.mr');
    win.body.append(root);
    let st = null, busy = false, showPair = false, nearbyList = { pairing: [], connect: [] };
    api.mirror?.watch?.();
    const fail = (e) => alertDialog({ title: 'Phone Mirroring', message: e.message || String(e) }, win.el);
    async function askSudo(why) {
      if (!(await api.sddm.sudoStatus()).needed) return true;
      for (let i = 0; i < 3; i++) {
        const pw = await prompt('Enter your password', '', { type: 'password', ok: 'Authenticate', message: why }, win.el);
        if (pw == null) return false;
        if (await api.sddm.sudoCheck(pw)) return true;
        await alertDialog({ title: 'Incorrect password', message: 'Try again.' }, win.el);
      }
      return false;
    }
    async function refresh() {
      if (!api.mirror) { st = { unavailable: true }; return draw(); }
      st = await api.mirror.status().catch((e) => ({ error: e.message, devices: [], sessions: [] }));
      if (st.adb && (showPair || !st.devices.some((d) => d.state === 'device'))) nearbyList = await api.mirror.nearby().catch(() => nearbyList);
      draw();
    }
    const hero = (title, text, ...rest) => h('div.mr-hero', h('div.mr-phone', { html: PHONE }), h('h1', title), text ? h('p', text) : null, ...rest);

    function draw() {
      if (!st) { root.replaceChildren(hero('Phone Mirroring', 'Looking for your phone…')); return; }
      if (st.unavailable) { root.replaceChildren(hero('Phone Mirroring', 'Phone Mirroring needs the LiquidDesktop app.')); return; }
      if (!st.scrcpy || !st.adb) {
        const b = h('button.btn.primary', { disabled: busy || !st.pm, onclick: async () => {
          if (!(await askSudo('Installing Phone Mirroring (scrcpy and adb) needs your password.'))) return;
          busy = true; draw();
          try { await api.mirror.install(); } catch (e) { fail(e); }
          busy = false; refresh();
        } }, busy ? 'Installing…' : 'Install Phone Mirroring');
        root.replaceChildren(hero('Use your phone from here', 'See your Android phone’s screen in a window and use it with your mouse and keyboard — apps, messages, games. It uses scrcpy, which is free and open source; nothing is sent anywhere but between your phone and this computer.',
          st.pm ? b : h('p.muted', 'Install scrcpy and adb (android-tools) with your package manager, then come back.'), busy ? h('small.muted', 'Downloading scrcpy and adb…') : null));
        return;
      }
      const ready = st.devices.filter((d) => d.state === 'device');
      const waiting = st.devices.filter((d) => d.state !== 'device');
      const kids = [];
      if (ready.length && !showPair) {
        kids.push(h('div.mr-title', h('h2', 'Your Phones'), h('button.btn.plain', { onclick: () => { showPair = true; refresh(); } }, 'Add Phone…')));
        kids.push(h('div.group.mr-list', ...ready.map((d) => {
          const name = d.name || d.model;
          const mirroring = st.sessions.some((s) => s.serial === d.serial);
          return h('div.row.mr-dev', h('span.mr-dev-ic', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6.5" y="2" width="11" height="20" rx="2.6"/><path d="M10.5 4.6h3"/></svg>' }),
            h('div.label', h('span', name), h('small', [d.wireless ? 'Wi-Fi' : 'USB', d.name && d.model !== d.name ? d.model : null, mirroring ? 'Mirroring' : null].filter(Boolean).join(' · '))),
            d.wireless ? h('button.btn.plain', { title: 'Forget this connection', onclick: () => api.mirror.disconnect(d.serial).then(refresh) }, 'Disconnect') : null,
            mirroring ? h('button.btn', { onclick: () => api.mirror.stop(d.serial) }, 'Stop') : h('button.btn.primary', { onclick: () => startMirror(d) }, 'Mirror'));
        })));
      } else kids.push(setupGuide(waiting));
      if (st.error) kids.push(h('div.mr-error', st.error));
      kids.push(options());
      root.replaceChildren(...kids);
    }

    // first time: how to let this computer in (USB debugging / Wireless debugging), and pairing with a code
    function setupGuide(waiting) {
      const addr = h('input.field.square', { placeholder: '192.168.1.20:37045', style: { flex: 1.4 } });
      const code = h('input.field.square', { placeholder: '6-digit code', inputmode: 'numeric', maxlength: 6, style: { flex: 1 } });
      const pairBtn = h('button.btn.primary', { onclick: async () => {
        pairBtn.disabled = true; pairBtn.textContent = 'Pairing…';
        try { await api.mirror.pair(addr.value.trim(), code.value.trim()); showPair = false; } catch (e) { fail(e); }
        pairBtn.disabled = false; pairBtn.textContent = 'Pair'; refresh();
      } }, 'Pair');
      const found = nearbyList.pairing[0];
      if (found && !addr.value) addr.value = found.addr;
      const step = (n, title, body) => h('div.mr-step', h('b.mr-n', n), h('div', h('b', title), h('p', ...[].concat(body))));
      return h('div.mr-setup',
        hero(waiting.some((d) => d.state === 'unauthorized') ? 'Allow this computer on your phone' : 'Connect your phone',
          waiting.some((d) => d.state === 'unauthorized') ? 'Your phone is asking “Allow USB debugging?” — tap Allow (and “Always allow from this computer”).'
            : waiting.some((d) => d.state === 'permissions') ? 'Your phone is plugged in, but this computer isn’t allowed to talk to it. Install android-udev rules (sudo pacman -S android-udev), then plug it in again.'
              : 'Phone Mirroring talks to your phone through Android’s developer connection. This is a one-time setup.'),
        h('div.group.mr-steps',
          step(1, 'Turn on Developer options', 'On the phone: Settings › About phone › tap Build number seven times.'),
          step(2, 'Plug in with a cable…', 'Settings › System › Developer options › turn on USB debugging, plug the phone in, and tap Allow when it asks.'),
          step(3, '…or connect over Wi-Fi (Android 11+)', ['In Developer options, turn on Wireless debugging, tap ', h('i', 'Pair device with pairing code'), ', and enter what it shows:',
            h('div.mr-pair', addr, code, pairBtn),
            found ? h('small.mr-found', `Found ${found.name.replace(/^adb-|-[\w]+$/g, '')} waiting to pair at ${found.addr}.`) : null])),
        st.devices.some((d) => d.state === 'device') ? h('button.btn.plain', { onclick: () => { showPair = false; draw(); } }, 'Back to Your Phones') : null);
    }

    function options() {
      const tog = (key, def, label, sub) => h('div.row', h('div.label', label, sub ? h('small', sub) : null),
        h('label.toggle', h('input', { type: 'checkbox', checked: !!opt(key, def), onchange: (e) => store.set(key, e.target.checked) }), h('span')));
      const quality = h('select.field.square', { style: { height: '26px' }, onchange: (e) => store.set('mirrorSize', +e.target.value) },
        ...[[0, 'Full resolution'], [1920, 'High (1920)'], [1280, 'Balanced (1280)'], [960, 'Fast (960)']].map(([v, l]) => h('option', { value: v, selected: opt('mirrorSize', 1920) === v }, l)));
      return h('div.mr-opts', h('div.group-title', 'Options'), h('div.group',
        tog('mirrorAudio', true, 'Play phone audio on this computer', 'Android 11 or later.'),
        tog('mirrorScreenOff', true, 'Turn off the phone’s screen while mirroring', 'Like the Mac, the phone stays locked-looking; it wakes when you stop.'),
        tog('mirrorLock', false, 'Lock the phone when you close the window'),
        tog('mirrorUhid', false, 'Use a physical-keyboard connection', 'Every key and keyboard layout works (Android 9+). Off: text is typed into the phone.'),
        h('div.row', h('div.label', 'Quality'), quality)));
    }

    async function startMirror(d) {
      try {
        await api.mirror.start(d.serial, { title: d.name || d.model, audio: opt('mirrorAudio', true), screenOff: opt('mirrorScreenOff', true), lockOnClose: opt('mirrorLock', false),
          maxSize: opt('mirrorSize', 1920) || 0, keyboard: opt('mirrorUhid', false) ? 'uhid' : null, bitRate: '8M' });
        // the phone's own window takes over; this one steps out of the way
        setTimeout(() => { if (win.el.isConnected) win.minimize(); }, 1500);
      } catch (e) { fail(e); }
    }

    api.mirror?.onChanged?.((e) => {
      if (!win.el.isConnected) return;
      if (e?.ended && e.error) { win.restore?.(); shell.notify({ app: 'mirroring', title: 'Phone Mirroring stopped', body: e.error }); }
      if (e?.screenshot) shell.notify({ app: 'mirroring', title: 'Screenshot saved', body: e.screenshot.split('/').pop(), action: () => api.fs.reveal?.(e.screenshot) });
      refresh();
    });
    // a phone being paired or plugged in: look again now and then while the setup is showing
    const t = setInterval(() => { if (!win.el.isConnected) return clearInterval(t); if (!st?.devices?.some((d) => d.state === 'device') || showPair) refresh(); }, 4000);
    draw();
    refresh();
  },
});
