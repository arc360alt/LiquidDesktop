// Phone — everything your phone shares through KDE Connect, in one window: its status, Find My Phone, files and
// links both ways, its notifications (with replies), what it's playing, recent calls, and typing on it with this
// computer's keyboard. Only listed while Phone is on and a device is paired (renderer/js/phone.js).
import { h, bus } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym } from '../icons.js';
import { api } from '../sys.js';
import { shell } from '../shell.js';
import { phoneState, phoneFor, PHONE_ICONS, deviceIcon, signalBars, batteryRing, phoneAct, sendFiles, browsePhone, has, phoneContacts, displayName,
  contactFor, avatar, shortTime, phoneApp, onPhone, canText } from '../phone.js';

const PANES = [
  ['overview', 'Overview', PHONE_ICONS.phone], ['notifications', 'Notifications', sym.bell], ['media', 'Now Playing', sym.music],
  ['calls', 'Recent Calls', '<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6.6 3.5h3l1.5 4.2-2 1.5a12 12 0 0 0 5.7 5.7l1.5-2 4.2 1.5v3a2 2 0 0 1-2.2 2A17.5 17.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z"/></svg>'],
  ['keyboard', 'Type on Phone', sym.keyboard],
];
// KDE Connect's key codes for keys that aren't characters
const SPECIAL = { Backspace: 1, Tab: 2, ArrowLeft: 4, ArrowUp: 5, ArrowRight: 6, ArrowDown: 7, PageUp: 8, PageDown: 9, Home: 10, End: 11, Enter: 12, Delete: 13, Escape: 14 };

registerApp({
  id: 'phone', name: 'Phone', size: [880, 600], minSize: [620, 420], overlayContent: true, hideTitle: true, singleton: true,
  keywords: ['kde connect', 'android', 'find my phone', 'mobile', 'calls'], hidden: true,
  about: 'Your phone on this computer, through KDE Connect.',
  open(win, args = {}) {
    let pane = args.pane || 'overview', dev = phoneFor();
    const side = h('div.sidebar.ph-side');
    const body = h('div.ph-body');
    win.dragRegion(side);   // (its items are clickable; the panes on the right aren't a drag area)
    win.body.append(side, h('div.main-pane', body));
    const notify = shell.notify;

    function drawSide() {
      side.replaceChildren(h('div.ph-side-dev', h('span.ph-side-ic' + (dev?.reachable ? '.on' : ''), { html: deviceIcon(dev) }),
        h('div', h('b', dev?.name || 'No Phone'), h('small', !dev ? '' : dev.reachable ? (dev.battery ? `${dev.battery.percent}%${dev.battery.charging ? ' · Charging' : ''}` : 'Connected') : 'Not Connected'))),
      ...PANES.map(([id, label, icon]) => h('div.sb-item' + (pane === id ? '.sel' : ''), { onclick: () => { pane = id; draw(); } },
        h('span', { html: icon }), label, id === 'notifications' && dev?.notifications?.length ? h('span.count', String(dev.notifications.length)) : null)));
    }
    const card = (title, ...kids) => h('div.ph-card', title ? h('h4', title) : null, ...kids);
    const act = (icon, label, on, fn) => h('button.ph-act', { disabled: !on, onclick: fn }, h('span', { html: icon }), label);

    /* ---------------------------------------------- Overview */
    function overview() {
      const ok = (p) => dev.reachable && has(dev, p);
      const b = dev.reachable ? dev.battery : null;
      const linkField = h('input.field', { placeholder: 'A link or some text', onkeydown: (e) => { if (e.key === 'Enter') sendLink(); } });
      const sendLink = async () => {
        const v = linkField.value.trim();
        if (!v) return;
        const r = await phoneAct(dev, /^https?:\/\/\S+$/.test(v) ? 'shareUrl' : 'shareText', v, notify);
        if (r) { linkField.value = ''; notify({ app: 'phone', title: dev.name, body: /^https?:/.test(v) ? 'Link opened on the phone.' : 'Text sent.' }); }
      };
      const drop = h('div.ph-drop', h('span', { html: PHONE_ICONS.send }), h('b', 'Drop files here to send them'), h('small', `They’re saved in ${dev.name}’s Downloads.`));
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', async (e) => {
        e.preventDefault(); drop.classList.remove('over');
        const paths = [...(e.dataTransfer.files || [])].map((f) => f.path || window.sys?.pathOf?.(f)).filter(Boolean);
        const uri = e.dataTransfer.getData('text/uri-list');
        if (!paths.length && uri) paths.push(...uri.split(/\r?\n/).filter((l) => l.startsWith('file://')).map((l) => decodeURI(l.slice(7))));
        if (!paths.length) return sendFiles(dev, notify);
        if (await phoneAct(dev, 'share', paths, notify)) notify({ app: 'phone', title: `Sending to ${dev.name}`, body: paths.length === 1 ? paths[0].split('/').pop() : `${paths.length} files` });
      });
      drop.addEventListener('click', () => ok('share') && sendFiles(dev, notify));
      return [
        h('div.ph-hero', h('div.ph-device', h('div.ph-screen', h('span', { html: deviceIcon(dev) }))),
          h('div.ph-hero-t', h('h2', dev.name), h('div.muted', dev.reachable ? `Connected${dev.address ? ' · ' + dev.address : ''}` : 'Not connected — open KDE Connect on the phone'),
            h('div.ph-stats', b ? h('div.ph-stat', batteryRing(b, deviceIcon(dev)), h('b', b.percent + '%'), h('small', b.charging ? 'Charging' : 'Battery')) : null,
              dev.reachable && dev.signal ? h('div.ph-stat', h('div.ph-sig', signalBars(dev.signal)), h('b', dev.signal.type || 'Cellular'), h('small', 'Signal')) : null))),
        h('div.ph-acts', act(PHONE_ICONS.ring, 'Find My Phone', ok('findmyphone'), () => phoneAct(dev, 'ring', null, notify)),
          act(PHONE_ICONS.ping, 'Ping', ok('ping'), () => phoneAct(dev, 'ping', null, notify)),
          act(PHONE_ICONS.clipboard, 'Send Clipboard', ok('clipboard'), () => phoneAct(dev, 'clipboard', null, notify).then((r) => r && notify({ app: 'phone', title: dev.name, body: 'Clipboard sent.' }))),
          act(PHONE_ICONS.folder, 'Browse Files', ok('sftp'), () => browsePhone(dev, notify, (path) => wm.open('files', { path }))),
          act('<svg class="sym" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.5C6.8 3.5 2.8 6.9 2.8 11.1c0 2.4 1.3 4.5 3.3 5.9-.2 1.4-1 2.7-2 3.6 1.9-.1 3.6-.9 4.9-2 1 .3 2 .4 3 .4 5.2 0 9.2-3.4 9.2-7.9S17.2 3.5 12 3.5z"/></svg>', 'Messages', canText(dev), () => wm.activate('messages'))),
        card('Send to Phone', ok('share') ? drop : h('p.muted', 'Sending files needs “Share and receive” turned on for this computer in KDE Connect on the phone.'),
          ok('share') ? h('div.ph-link', linkField, h('button.btn', { onclick: sendLink }, 'Send')) : null),
      ];
    }

    /* ---------------------------------------------- Notifications */
    function notifications() {
      const ns = dev.reachable ? dev.notifications || [] : [];
      if (!dev.reachable) return [h('div.ph-none', `${dev.name} isn’t connected.`)];
      if (!has(dev, 'notifications')) return [h('div.ph-none', 'Turn on “Receive notifications” for this computer in KDE Connect on the phone.')];
      if (!ns.length) return [h('div.ph-none', h('span', { html: sym.bell }), 'No Notifications')];
      return [h('div.ph-notifs', ...ns.map((n) => {
        const reply = n.replyId ? h('input.field.ph-reply', { placeholder: `Reply to ${n.title || n.app}…`, onkeydown: async (e) => {
          if (e.key !== 'Enter' || !e.target.value.trim()) return;
          const text = e.target.value.trim();
          e.target.value = '';
          if (await phoneAct(dev, 'reply', { replyId: n.replyId, text }, notify) !== null) notify({ app: 'phone', title: 'Reply sent', body: text });
        } }) : null;
        return h('div.ph-notif', n.icon ? h('img.ph-nimg', { src: n.icon }) : h('span.ph-nimg', { html: sym.bell }),
          h('div.ph-ntext', h('div.ph-nhead', h('small', n.app), h('time', shortTime(n.time))), h('b', n.title), h('p', n.text), reply),
          n.dismissable ? h('button.tb-btn', { title: 'Dismiss', html: sym.close, onclick: () => phoneAct(dev, 'dismiss', n.id).then(() => api.kdc.state()) }) : null);
      }))];
    }

    /* ---------------------------------------------- Now Playing */
    let tick = null;
    function media() {
      const m = dev.reachable ? dev.media : null;
      if (!dev.reachable) return [h('div.ph-none', `${dev.name} isn’t connected.`)];
      if (!m || !(m.title || m.players?.length)) return [h('div.ph-none', h('span', { html: sym.music }), 'Nothing is playing on the phone')];
      const fmt = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
      const t0 = Date.now(), pos0 = Math.min(m.position || 0, m.length || Infinity);
      const bar = h('input.slider.ph-seek', { type: 'range', min: 0, max: Math.max(1, m.length || 1), value: pos0 });
      const elapsed = h('small', fmt(pos0)), left = h('small', m.length ? '-' + fmt(m.length - pos0) : '');
      const paint = () => bar.style.setProperty('--v', (bar.value / bar.max) * 100 + '%');
      bar.addEventListener('change', () => phoneAct(dev, 'position', +bar.value));
      clearInterval(tick);
      tick = setInterval(() => {
        if (!bar.isConnected) return clearInterval(tick);
        if (!m.playing || document.activeElement === bar) return;
        const p = Math.min(m.length || 0, pos0 + (Date.now() - t0));
        bar.value = p; elapsed.textContent = fmt(p); left.textContent = m.length ? '-' + fmt(m.length - p) : ''; paint();
      }, 500);
      paint();
      const vol = h('input.slider', { type: 'range', min: 0, max: 100, value: m.volume ?? 50 });
      const vpaint = () => vol.style.setProperty('--v', vol.value + '%');
      vol.addEventListener('input', vpaint);
      vol.addEventListener('change', () => phoneAct(dev, 'mediaVolume', +vol.value));
      vpaint();
      return [h('div.ph-player',
        h('div.ph-art', m.art ? h('img', { src: m.art }) : h('span', { html: sym.music })),
        h('h2', m.title || 'Not Playing'), h('div.muted', [m.artist, m.album].filter(Boolean).join(' — ')),
        h('div.ph-seek-row', elapsed, bar, left),
        h('div.ph-ctrls', h('button', { html: sym.prev, onclick: () => phoneAct(dev, 'media', 'Previous') }),
          h('button.big', { html: m.playing ? sym.pause : sym.play, onclick: () => phoneAct(dev, 'media', 'PlayPause') }),
          h('button', { html: sym.next, onclick: () => phoneAct(dev, 'media', 'Next') })),
        h('div.ph-vol', h('span', { html: sym.speakerLow }), vol, h('span', { html: sym.speaker })),
        m.players?.length > 1 ? h('select.field.square.ph-players', { onchange: (e) => phoneAct(dev, 'mediaPlayer', e.target.value) },
          ...m.players.map((p) => h('option', { value: p, selected: p === m.player }, p))) : null)];
    }

    /* ---------------------------------------------- Recent Calls */
    async function callsPane(el) {
      const list = await api.kdc.calls().catch(() => []) || [];
      await phoneContacts(dev);
      const mine = list.filter((c) => c.device === dev.id);
      if (!mine.length) { el.replaceChildren(h('div.ph-none', h('span', { html: PANES[3][2] }), 'No Recent Calls', h('small', 'Calls to your phone are listed here from now on.'))); return; }
      const KIND = { missedCall: ['Missed', '#ff3b30'], ringing: ['Incoming', null], callReceived: ['Incoming', null], talking: ['Answered', null] };
      el.replaceChildren(h('div.group.ph-calls', ...mine.map((c) => {
        const name = c.name || displayName(dev, c.number), contact = contactFor(dev, c.number);
        const [kind, color] = KIND[c.event] || ['Call', null];
        return h('div.row.ph-call', avatar(name, contact?.photo, 34), h('div.label', h('span', { style: color ? { color } : null }, name), h('small', `${kind}${name !== c.number ? ' · ' + c.number : ''}`)),
          h('small.muted', shortTime(c.time)),
          canText(dev) ? h('button.tb-btn', { title: 'Message', html: '<svg class="sym" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.5C6.8 3.5 2.8 6.9 2.8 11.1c0 2.4 1.3 4.5 3.3 5.9-.2 1.4-1 2.7-2 3.6 1.9-.1 3.6-.9 4.9-2 1 .3 2 .4 3 .4 5.2 0 9.2-3.4 9.2-7.9S17.2 3.5 12 3.5z"/></svg>', onclick: () => wm.activate('messages', { to: c.number }) }) : null);
      })), h('button.btn.ph-clear', { onclick: async () => { await api.kdc.clearCalls(); draw(); } }, 'Clear Recent Calls'));
    }

    /* ---------------------------------------------- Type on Phone */
    function keyboard() {
      if (!dev.reachable || !has(dev, 'remotekeyboard')) {
        return [h('div.ph-none', h('span', { html: sym.keyboard }), 'Typing on the phone isn’t available', h('small', 'Install KDE Connect’s keyboard on the phone (Settings › Languages & input), switch to it, and turn on “Remote keyboard” for this computer.'))];
      }
      const pad = h('div.ph-kbd', { tabindex: 0 }, h('span', { html: sym.keyboard }), h('b', 'Click here, then type'), h('small', `What you type goes to the text field that’s open on ${dev.name}. Enter, Backspace and the arrow keys work too.`));
      const echo = h('div.ph-echo');
      pad.addEventListener('keydown', (e) => {
        if (e.metaKey) return;
        const special = SPECIAL[e.key];
        if (!special && e.key.length !== 1) return;
        e.preventDefault();
        phoneAct(dev, 'key', { key: special ? '' : e.key, special: special || 0, shift: e.shiftKey && !!special, ctrl: e.ctrlKey, alt: e.altKey });
        if (special === 1) echo.textContent = echo.textContent.slice(0, -1);
        else if (special === 12) echo.textContent = '';
        else if (!special) echo.textContent = (echo.textContent + e.key).slice(-60);
      });
      // text pasted in goes over a character at a time
      pad.addEventListener('paste', (e) => { e.preventDefault(); const t = e.clipboardData.getData('text'); for (const ch of t.slice(0, 2000)) phoneAct(dev, 'key', { key: ch }); echo.textContent = t.slice(-60); });
      pad.addEventListener('focus', () => pad.classList.add('on'));
      pad.addEventListener('blur', () => pad.classList.remove('on'));
      return [pad, echo];
    }

    function draw() {
      dev = phoneFor();
      drawSide();
      const st = phoneState();
      if (!st.running || !dev) {
        body.replaceChildren(h('div.ph-none', h('span', { html: PHONE_ICONS.phone }), !st.running ? 'Phone is turned off' : 'No phone is paired',
          h('button.btn.primary', { onclick: () => wm.open('settings', { pane: 'phone' }) }, 'Open Phone Settings')));
        return;
      }
      const head = h('h1.ph-title', PANES.find((p) => p[0] === pane)[1]);
      if (pane === 'calls') { const el = h('div'); body.replaceChildren(head, el); callsPane(el); return; }
      const kids = pane === 'overview' ? overview() : pane === 'notifications' ? notifications() : pane === 'media' ? media() : keyboard();
      // don't rebuild under the user's hands (typing a reply, a focused keyboard pad)
      if (body.contains(document.activeElement) && document.activeElement !== body && body.dataset.pane === pane) return;
      body.dataset.pane = pane;
      body.replaceChildren(head, ...kids);
    }
    let key = '';
    onPhone(win.el, () => {
      // redrawn only when something it shows changed (the media position ticking doesn't count)
      const d = phoneFor();
      const k = JSON.stringify(d && [d.id, d.reachable, d.battery, d.signal, d.plugins, d.notifications?.map((n) => n.id), d.media && [d.media.title, d.media.playing, d.media.player, d.media.volume]]);
      if (k !== key) { key = k; draw(); }
    });
    api.kdc.onCall?.(() => { if (win.el.isConnected && pane === 'calls') draw(); });
    win.on('reopen', (a) => { if (a?.pane) { pane = a.pane; draw(); } });
    draw();
  },
});
phoneApp('phone', null);
