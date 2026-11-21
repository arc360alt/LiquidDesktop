// Contacts — the people in your phone, through KDE Connect (it copies the phone's contacts to this computer).
// Read-only: changes are made on the phone and arrive here. From a contact you can text them (Messages) or copy
// a number. Only listed while Phone is on and a phone that shares contacts is paired.
import { h, bus } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym } from '../icons.js';
import { api } from '../sys.js';
import { shell } from '../shell.js';
import { phoneState, phoneFor, phoneContacts, avatar, phoneApp, onPhone, canText } from '../phone.js';

const shares = (d) => d.supported.includes('contacts') || d.plugins.includes('contacts');
const MSG = '<svg class="sym" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.5C6.8 3.5 2.8 6.9 2.8 11.1c0 2.4 1.3 4.5 3.3 5.9-.2 1.4-1 2.7-2 3.6 1.9-.1 3.6-.9 4.9-2 1 .3 2 .4 3 .4 5.2 0 9.2-3.4 9.2-7.9S17.2 3.5 12 3.5z"/></svg>';
const COPY = '<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="8.5" y="8.5" width="11" height="12" rx="2.2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/></svg>';
const MAIL = '<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m4 7 8 6 8-6"/></svg>';

registerApp({
  id: 'contacts', name: 'Contacts', size: [760, 540], minSize: [520, 360], overlayContent: true, hideTitle: true, singleton: true,
  keywords: ['people', 'address book', 'phone numbers'], hidden: true,
  about: 'The contacts on your phone, through KDE Connect.',
  open(win, args = {}) {
    let dev = phoneFor(shares), people = [], sel = args.uid || null;
    const search = h('input.field', { placeholder: 'Search', oninput: () => drawList() });
    const list = h('div.ct-list');
    const syncBtn = h('button.btn.ct-sync', { onclick: () => syncNow() }, 'Sync Now');
    const syncNote = h('small.ct-sync-note');
    const side = h('div.sidebar.ct-side', h('div.search-field', { html: sym.search }, search), list, h('div.ct-side-foot', syncBtn, syncNote));
    const card = h('div.ct-card');
    const main = h('div.main-pane.ct-main', card);
    // (the window moves from its title bar: the list and the card are for clicking)
    win.body.append(side, main);

    function drawList() {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = '';
      const shown = people.filter((c) => !q || c.name.toLowerCase().includes(q) || c.phones.some((p) => p.number.replace(/\D/g, '').includes(q.replace(/\D/g, '') || '§')) || c.emails.some((e) => e.toLowerCase().includes(q)));
      let letter = null;
      for (const c of shown) {
        const l = (c.name[0] || '#').toUpperCase().replace(/[^A-Z]/, '#');
        if (l !== letter) { letter = l; list.append(h('div.sb-sec', l)); }
        list.append(h('div.ct-item' + (c.uid === sel ? '.sel' : ''), { onmousedown: (e) => { if (e.button === 0) { sel = c.uid; drawList(); drawCard(); } } }, avatar(c.name, c.photo, 28), h('span', c.name || c.phones[0]?.number)));
      }
      if (!shown.length) list.append(h('div.msg-none', q ? 'No Results' : 'No Contacts'));
    }
    function drawCard() {
      const st = phoneState();
      if (!st.running || !dev) {
        card.replaceChildren(h('div.ct-empty', h('b', !st.running ? 'Phone is turned off' : 'No phone shares its contacts'),
          h('p', 'Contacts come from your phone, through KDE Connect.'), h('button.btn.primary', { onclick: () => wm.open('settings', { pane: 'phone' }) }, 'Open Phone Settings')));
        return;
      }
      const c = people.find((x) => x.uid === sel);
      if (!c) {
        card.replaceChildren(h('div.ct-empty', h('b', people.length ? 'No Contact Selected' : 'No Contacts Yet'),
          h('p', people.length ? `${people.length} contacts from ${dev.name}` : dev.reachable ? `Turn on “Contacts” for this computer in KDE Connect on ${dev.name}.` : `${dev.name} isn’t connected.`),
          h('button.btn', { onclick: () => syncNow() }, 'Sync Now'), syncHelp));
        return;
      }
      const texting = canText(dev);
      const action = (icon, label, fn, on = true) => h('button.ct-act', { disabled: !on, onclick: fn }, h('span', { html: icon }), label);
      const first = c.phones[0]?.number;
      card.replaceChildren(
        h('div.ct-hero', avatar(c.name, c.photo, 96), h('h2', c.name || first), c.org ? h('div.muted', c.org) : null,
          h('div.ct-acts', action(MSG, 'message', () => wm.activate('messages', { to: first }), !!first && texting), action(COPY, 'copy', () => copy(first), !!first),
            action(MAIL, 'mail', () => api.fs.open('mailto:' + c.emails[0]), !!c.emails.length))),
        h('div.group.ct-fields',
          ...c.phones.map((p) => h('div.row.ct-field', h('div.label', h('small', p.label), h('span.ct-val', p.number)),
            texting ? h('button.tb-btn', { title: 'Message', html: MSG, onclick: () => wm.activate('messages', { to: p.number }) }) : null,
            h('button.tb-btn', { title: 'Copy', html: COPY, onclick: () => copy(p.number) }))),
          ...c.emails.map((e) => h('div.row.ct-field', h('div.label', h('small', 'email'), h('span.ct-val', e)), h('button.tb-btn', { title: 'Copy', html: COPY, onclick: () => copy(e) }))),
          c.birthday ? h('div.row.ct-field', h('div.label', h('small', 'birthday'), h('span.ct-val', fmtBirthday(c.birthday)))) : null,
          c.note ? h('div.row.ct-field', h('div.label', h('small', 'notes'), h('span.ct-val', c.note))) : null),
        h('p.muted.ct-src', `From ${dev.name}. Edit contacts on the phone.`));
    }
    // Sync Now: ask the phone, wait for its answer, and say what happened
    let syncHelp = null;
    async function syncNow() {
      if (!dev || syncBtn.disabled) return;
      syncBtn.disabled = true; syncBtn.textContent = 'Syncing…';
      syncNote.textContent = `Asking ${dev.name}…`;
      let r;
      try { r = await api.kdc.syncContacts(dev.id); } catch (e) { r = { ok: false, reason: 'error', error: e.message, contacts: people }; }
      syncBtn.disabled = false; syncBtn.textContent = 'Sync Now';
      people = r.contacts || people;
      const why = {
        'off-phone': `${dev.name} isn’t sharing contacts. In KDE Connect on the phone, open this computer › Plugin settings, turn on “Contacts synchronizer”, and allow access to contacts when Android asks.`,
        'off-here': 'Contacts is turned off for this phone in Settings › Phone.',
        'no-answer': `${dev.name} didn’t send any contacts. In KDE Connect on the phone, check that “Contacts synchronizer” is on and that KDE Connect is allowed to read contacts (Android Settings › Apps › KDE Connect › Permissions), then try again.`,
        error: r.error,
      }[r.reason];
      syncNote.textContent = r.ok ? `${people.length} contacts · synced ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
      syncHelp = why ? h('p.ct-help', why, r.reason === 'off-here' ? h('button.btn', { onclick: () => wm.open('settings', { pane: 'phone' }) }, 'Open Phone Settings') : null) : null;
      if (!sel && people.length) sel = people[0].uid;
      drawList(); drawCard();
      if (why && people.length) shell.notify({ app: 'contacts', title: 'Contacts', body: why });
    }
    const copy = (t) => { api.clip.write(t); shell.notify({ app: 'contacts', title: 'Copied', body: t }); };
    async function load(fresh) {
      dev = phoneFor(shares);
      people = dev ? await phoneContacts(dev, fresh) : [];
      if (!sel && people.length) sel = people[0].uid;
      drawList(); drawCard();
    }
    bus.on('phone-contacts', () => { if (win.el.isConnected) load(true); });
    onPhone(win.el, () => { const before = dev?.id; dev = phoneFor(shares); if (dev?.id !== before) load(true); else drawCard(); });
    win.on('reopen', (a) => { if (a?.uid) { sel = a.uid; drawList(); drawCard(); } });
    load(true).then(() => { if (!people.length && dev?.reachable) syncNow(); });
  },
});
phoneApp('contacts', shares);

function fmtBirthday(b) {
  const m = String(b).match(/^(\d{4}|--)-?(\d{2})-?(\d{2})/);
  if (!m) return b;
  const d = new Date(m[1] === '--' ? 2000 : +m[1], +m[2] - 1, +m[3]);
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', ...(m[1] === '--' ? {} : { year: 'numeric' }) });
}
