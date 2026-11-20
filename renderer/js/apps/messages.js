// Messages — your phone's text messages (SMS/MMS) on the computer, through KDE Connect: every conversation, its
// history, names and pictures from the phone's contacts, new messages as they arrive, and sending (from the
// phone's number). Only listed while Phone is on and a phone that can text is paired (renderer/js/phone.js).
import { h, $, $$, bus } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym } from '../icons.js';
import { api } from '../sys.js';
import { shell } from '../shell.js';
import { phoneState, phoneFor, canText, phoneContacts, contactFor, displayName, avatar, shortTime, phoneApp, onPhone, digits, markSeen, isUnread } from '../phone.js';

const SEND = '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="12" fill="currentColor"/><path d="M12 17V7.5M7.8 11.3 12 7.2l4.2 4.1" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PLUS = '<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg>';

registerApp({
  id: 'messages', name: 'Messages', size: [940, 620], minSize: [600, 400], overlayContent: true, hideTitle: true, singleton: true,
  keywords: ['sms', 'text', 'chat', 'imessage', 'phone', 'mms'], hidden: true,
  about: 'Text messages from your phone, through KDE Connect.',
  menus: (win) => [{ title: 'File', items: [
    { label: 'New Message', shortcut: '⌘N', action: () => win.emit('compose') },
    '-', { label: 'Refresh Conversations', action: () => win.emit('refresh') },
    { label: 'Close Window', shortcut: '⌘W', action: () => win.close() }] }],
  open(win, args = {}) {
    let dev = phoneFor(canText), threads = [], cur = null, msgs = [], count = 60, composing = false, to = [];
    const search = h('input.field.msg-search', { placeholder: 'Search', oninput: () => drawList() });
    const list = h('div.msg-threads');
    const side = h('div.sidebar.msg-side', h('div.msg-side-top', h('div.search-field', { html: sym.search }, search),
      h('button.tb-btn.msg-new', { title: 'New Message', html: sym.compose, onclick: () => compose() })), list);
    // the window moves from the sidebar's top strip and the header only: a press on a conversation is a click
    win.dragRegion(side.firstChild);
    const head = h('div.msg-head');
    const scroller = h('div.msg-scroll');
    const field = h('textarea.msg-field', { placeholder: 'Text Message', rows: 1, spellcheck: true });
    const sendBtn = h('button.msg-send', { title: 'Send', html: SEND, disabled: true, onclick: () => send() });
    const attach = h('button.msg-attach', { title: 'Attach a picture or file', html: PLUS, onclick: () => pickFiles() });
    let files = [];
    const fileChips = h('div.msg-files');
    const bar = h('div.msg-bar', attach, h('div.msg-input', fileChips, field, sendBtn));
    const main = h('div.main-pane.msg-main', head, scroller, bar);
    const empty = h('div.msg-empty');
    win.body.append(side, main, empty);
    win.dragRegion(head);

    /* ---------------------------------------------- what's shown when there's nothing to show */
    function setEmpty(text, sub, button) {
      empty.replaceChildren(h('div.msg-empty-ic', { html: '<svg viewBox="0 0 64 64" width="64" height="64"><path d="M32 8C17 8 6 17.6 6 29.6c0 6.7 3.5 12.7 9 16.6-.6 4-2.7 7.6-5.6 10.2 5.2-.3 10-2.4 13.6-5.6 2.8.8 5.8 1.2 9 1.2 15 0 26-9.6 26-21.4S47 8 32 8z" fill="currentColor"/></svg>' }),
        h('b', text), sub ? h('p', sub) : null, button || null);
      empty.hidden = !text;
      side.hidden = main.hidden = !!text;
    }
    function checkDevice() {
      const st = phoneState();
      dev = phoneFor(canText);
      if (!st.running) return setEmpty('Phone is turned off', 'Turn on Phone in Settings to see your text messages here.', h('button.btn.primary', { onclick: () => wm.open('settings', { pane: 'phone' }) }, 'Open Phone Settings'));
      if (!dev) return setEmpty('No phone that can text', 'Pair an Android phone with KDE Connect in Settings › Phone.', h('button.btn.primary', { onclick: () => wm.open('settings', { pane: 'phone' }) }, 'Open Phone Settings'));
      if (!dev.reachable && !threads.length) return setEmpty(`${dev.name} isn’t connected`, 'Open KDE Connect on the phone, on the same Wi-Fi as this computer. Messages appear as soon as it connects.');
      if (dev.reachable && !dev.plugins.includes('sms')) return setEmpty('Messages is turned off on the phone', `Turn on “SMS” for this computer in KDE Connect on ${dev.name}, and allow it to read your messages.`);
      setEmpty('');
      return true;
    }

    /* ---------------------------------------------- the list of conversations */
    const nameOf = (addresses) => addresses.map((a) => { const n = displayName(dev, a); return addresses.length > 1 ? n.split(' ')[0] : n; }).join(', ');
    let listSig = '';
    function drawList() {
      const q = search.value.trim().toLowerCase();
      // nothing that's shown changed: leave the list alone (it's asked for often while the phone reports in)
      const sig = JSON.stringify([q, cur, composing, to, threads.map((t) => [t.thread, t.last, isUnread(dev, t), t.addresses]), dev?.id]);
      if (sig === listSig && list.childElementCount) return;
      listSig = sig;
      list.innerHTML = '';
      const shown = threads.filter((t) => !q || nameOf(t.addresses).toLowerCase().includes(q) || t.addresses.some((a) => digits(a).includes(digits(q)) && digits(q)) || t.last.body.toLowerCase().includes(q));
      if (composing) list.append(h('div.msg-thread.sel', avatar('', null, 42), h('div.msg-t', h('div.msg-t-top', h('b', 'New Message')), h('small', to.length ? nameOf(to) : ''))));
      for (const t of shown) {
        const c = t.addresses.length === 1 ? contactFor(dev, t.addresses[0]) : null;
        const it = h('div.msg-thread' + (t.thread === cur && !composing ? '.sel' : '') + (isUnread(dev, t) ? '.unread' : ''),
          h('i.msg-dot'), avatar(c?.name || nameOf(t.addresses), c?.photo, 42, t.addresses.length > 1),
          h('div.msg-t', h('div.msg-t-top', h('b', nameOf(t.addresses)), h('time', shortTime(t.last.date))),
            h('small', (t.last.type === 2 ? 'You: ' : '') + (t.last.body || (t.last.attachments ? 'Attachment' : '')))));
        // on press (like a Mac), so a redraw arriving before the button comes up can't swallow it
        it.addEventListener('mousedown', (e) => { if (e.button === 0) openThread(t.thread); });
        list.append(it);
      }
      if (!shown.length && !composing) list.append(h('div.msg-none', q ? 'No Results' : 'No Conversations'));
    }
    async function loadThreads(refresh) {
      if (!checkDevice()) return;
      await phoneContacts(dev);
      threads = await api.kdc.conversations(dev.id, refresh).catch(() => threads) || [];
      drawList();
      if (cur == null && !composing && threads.length) openThread(threads[0].thread);
      else if (!threads.length && refresh) setTimeout(() => loadThreads(false), 1500);
    }

    /* ---------------------------------------------- one conversation */
    function drawHead(addresses) {
      const one = addresses.length === 1, c = one ? contactFor(dev, addresses[0]) : null;
      head.replaceChildren(...[avatar(c?.name || nameOf(addresses), c?.photo, 34, !one),
        h('div.msg-head-t', h('b', one ? displayName(dev, addresses[0]) : nameOf(addresses)), h('small', one ? (c ? addresses[0] : dev.name) : `${addresses.length} people`)),
        c ? h('button.tb-btn', { title: 'Show in Contacts', html: '<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1" stroke-linecap="round"/></svg>', onclick: () => wm.activate('contacts', { uid: c.uid }) }) : null].filter(Boolean));
    }
    function drawMessages(stick) {
      const atBottom = stick || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
      const prevH = scroller.scrollHeight, prevTop = scroller.scrollTop;
      scroller.innerHTML = '';
      const t = threads.find((x) => x.thread === cur);
      const group = (t?.addresses.length || 1) > 1;
      if (msgs.length >= count) scroller.append(h('button.msg-more', { onclick: () => { count += 80; loadMessages(false); } }, 'Load Earlier Messages'));
      let last = null;
      msgs.forEach((m, i) => {
        // a time between messages more than an hour apart (and at the top)
        if (!last || m.date - last.date > 3600_000) scroller.append(h('div.msg-time', `${shortTime(m.date)}${shortTime(m.date).includes(':') ? '' : ' ' + new Date(m.date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`));
        const mine = m.type === 2, next = msgs[i + 1];
        const tailEnd = !next || next.type !== m.type || next.date - m.date > 60_000 || (group && next.addresses[0] !== m.addresses[0]);
        if (group && !mine && (!last || last.type !== m.type || last.addresses[0] !== m.addresses[0])) scroller.append(h('div.msg-from', displayName(dev, m.addresses[0])));
        const parts = [];
        for (const a of m.attachments || []) {
          if (a.thumb) {
            const img = h('img.msg-img', { src: a.thumb, title: 'Open', draggable: false });
            img.addEventListener('click', async () => {
              img.classList.add('loading');
              try { const p = await api.kdc.attachment(dev.id, a.part, a.uid); api.fs.open(p); } catch (e) { shell.notify({ app: 'messages', title: 'Couldn’t open the attachment', body: e.message }); }
              img.classList.remove('loading');
            });
            parts.push(img);
          } else parts.push(h('div.msg-file', '📎 ' + (a.mime || 'Attachment')));
        }
        if (m.body) parts.push(h('div.msg-text', linkify(m.body)));
        const bubble = h('div.msg-bubble' + (mine ? '.me' : '') + (tailEnd ? '.tail' : '') + (onlyEmoji(m.body) && !m.attachments?.length ? '.emoji' : ''), { title: new Date(m.date).toLocaleString() }, ...parts);
        scroller.append(h('div.msg-row' + (mine ? '.me' : '') + (m.pending ? '.pending' : ''), bubble));
        last = m;
      });
      if (msgs.length && msgs[msgs.length - 1].type === 2) scroller.append(h('div.msg-status', 'Sent'));
      if (atBottom) scroller.scrollTop = scroller.scrollHeight;
      else scroller.scrollTop = prevTop + (scroller.scrollHeight - prevH);
    }
    async function loadMessages(stick) {
      const t = cur;
      const list = await api.kdc.conversation(dev.id, t, count).catch(() => null);
      if (t !== cur || !list) return;
      msgs = withPending(t, list);
      markSeen(dev, t);
      drawMessages(stick);
    }
    // texts sent from here, shown until the phone reports them back (then the real one replaces it)
    const pending = new Map();   // thread → [{ body, date }]
    function withPending(thread, list) {
      const mine = pending.get(thread) || [];
      const left = mine.filter((p) => !list.some((m) => m.type === 2 && m.body === p.body && m.date >= p.date - 120_000));
      if (left.length) pending.set(thread, left); else pending.delete(thread);
      return [...list, ...left.map((p) => ({ type: 2, body: p.body, date: p.date, addresses: [], attachments: [], pending: !p.reported, placeholder: true, id: -p.date }))].sort((a, b) => a.date - b.date);
    }
    // ask the phone for what's new in a thread (and the list), a few times over the next while
    const followUp = (thread) => {
      for (const ms of [1500, 5000, 12000, 30000]) setTimeout(() => {
        if (!win.el.isConnected || !dev) return;
        api.kdc.fetchLatest(dev.id, thread ?? null);
        if (thread != null) api.kdc.fetchLatest(dev.id, null);
      }, ms);
    };
    function openThread(thread) {
      composing = false; to = [];
      cur = thread; count = 60;
      const t = threads.find((x) => x.thread === thread);
      if (!t) return;
      main.classList.remove('composing');
      drawHead(t.addresses);
      msgs = [];
      scroller.replaceChildren(h('div.msg-loading', h('span.spinner')));
      drawList();
      loadMessages(true);
      api.kdc.fetchLatest?.(dev.id, thread);   // anything newer than what KDE Connect had
      field.focus();
    }

    /* ---------------------------------------------- a new message: who to */
    const toField = h('input.msg-to-input', { placeholder: 'Name or number', spellcheck: false });
    const toChips = h('div.msg-to-chips.no-drag');
    const suggest = h('div.msg-suggest.no-drag');
    function compose(number) {
      composing = true; cur = null; to = number ? [number] : [];
      main.classList.add('composing');
      head.replaceChildren(h('div.msg-to', h('span.muted', 'To:'), toChips, toField), suggest);
      drawChips();
      scroller.replaceChildren();
      drawList();
      (number ? field : toField).focus();
    }
    function drawChips() {
      toChips.replaceChildren(...to.map((a) => h('span.msg-chip', displayName(dev, a), h('button', { html: sym.close, onclick: () => { to = to.filter((x) => x !== a); drawChips(); drawList(); } }))));
      updateSend();
    }
    toField.addEventListener('input', async () => {
      const q = toField.value.trim().toLowerCase();
      suggest.innerHTML = '';
      if (!q) return;
      const contacts = await phoneContacts(dev);
      const hits = [];
      for (const c of contacts) for (const p of c.phones) if (c.name.toLowerCase().includes(q) || (digits(q) && digits(p.number).includes(digits(q)))) hits.push([c, p]);
      for (const [c, p] of hits.slice(0, 8)) {
        suggest.append(h('div.msg-sug', { onmousedown: (e) => { e.preventDefault(); add(p.number); } }, avatar(c.name, c.photo, 26), h('b', c.name), h('small', `${p.label} ${p.number}`)));
      }
    });
    const add = (n) => { if (n && !to.includes(n)) to.push(n); toField.value = ''; suggest.innerHTML = ''; drawChips(); drawList(); field.focus(); };
    toField.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ',') && toField.value.trim()) { e.preventDefault(); const first = $('.msg-sug', suggest); if (first) first.dispatchEvent(new MouseEvent('mousedown')); else add(toField.value.trim()); }
      if (e.key === 'Backspace' && !toField.value && to.length) { to.pop(); drawChips(); }
    });
    toField.addEventListener('blur', () => setTimeout(() => { suggest.innerHTML = ''; }, 150));

    /* ---------------------------------------------- sending */
    const updateSend = () => { sendBtn.disabled = !(field.value.trim() || files.length) || (composing && !to.length && !toField.value.trim()); };
    field.addEventListener('input', () => { field.style.height = 'auto'; field.style.height = Math.min(120, field.scrollHeight) + 'px'; updateSend(); });
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    async function pickFiles() {
      const picked = await api.dialog?.open({ title: 'Attach', multiple: true, filters: [{ name: 'Pictures and videos', patterns: ['*.jpg', '*.jpeg', '*.png', '*.gif', '*.webp', '*.mp4', '*.3gp'] }, { name: 'All files', patterns: ['*'] }] }).catch(() => null);
      if (!picked?.length) return;
      files.push(...picked);
      fileChips.replaceChildren(...files.map((f) => h('span.msg-chip', f.split('/').pop(), h('button', { html: sym.close, onclick: () => { files = files.filter((x) => x !== f); fileChips.replaceChildren(...[...fileChips.children].filter((x) => x.textContent !== f.split('/').pop())); updateSend(); } }))));
      updateSend();
    }
    async function send() {
      if (composing && toField.value.trim()) add(toField.value.trim());
      const text = field.value.trim();
      if ((!text && !files.length) || (composing && !to.length)) return;
      if (!dev.reachable) { shell.notify({ app: 'messages', title: 'Not sent', body: `${dev.name} isn’t connected.` }); return; }
      const o = composing ? { addresses: to, text, files } : { thread: cur, text, files };
      // shown right away (greyed until the phone has it), and at the top of the list
      const sent = { body: text || (files.length ? '📎 ' + files.map((f) => f.split('/').pop()).join(', ') : ''), date: Date.now() };
      const thread = cur;
      if (!composing) {
        pending.set(thread, [...(pending.get(thread) || []), sent]);
        msgs = withPending(thread, msgs.filter((m) => !m.placeholder));
        drawMessages(true);
        const t = threads.find((x) => x.thread === thread);
        if (t) { t.last = { body: sent.body, date: sent.date, type: 2, attachments: 0 }; threads.sort((a, b) => b.last.date - a.last.date); drawList(); }
      }
      field.value = ''; files = []; fileChips.replaceChildren(); field.style.height = 'auto'; updateSend();
      try {
        await api.kdc.sendText(dev.id, o);
        // handed to the phone: no longer greyed, even if the phone never reports it back
        sent.reported = true;
        if (!composing && cur === thread) { msgs = withPending(thread, msgs.filter((m) => !m.placeholder)); drawMessages(true); }
      } catch (e) {
        shell.notify({ app: 'messages', title: 'Message not sent', body: e.message });
        pending.set(thread, (pending.get(thread) || []).filter((p) => p !== sent));
        if (!composing && cur === thread) { msgs = withPending(thread, msgs.filter((m) => !m.placeholder)); drawMessages(); }
        return;
      }
      followUp(composing ? null : thread);
      // a new conversation: open it once the phone reports it
      if (composing) { const want = to.map(digits).sort().join(); pendingNew = want; setTimeout(() => loadThreads(false), 1500); }
    }
    let pendingNew = null;

    /* ---------------------------------------------- live */
    api.kdc.onSms?.((changes) => {
      if (!win.el.isConnected || !dev) return;
      const mine = changes.filter((c) => c.device === dev.id);
      if (!mine.length) return;
      api.kdc.conversations(dev.id).then((t) => {
        threads = t || threads;
        // a text sent from here that the phone hasn't reported yet is still the newest in its thread
        for (const x of threads) { const p = (pending.get(x.thread) || []).at(-1); if (p && p.date > x.last.date) x.last = { body: p.body, date: p.date, type: 2, attachments: 0 }; }
        threads.sort((a, b) => b.last.date - a.last.date);
        if (pendingNew) {
          const hit = threads.find((x) => x.addresses.map(digits).sort().join() === pendingNew);
          if (hit) { pendingNew = null; openThread(hit.thread); return; }
        }
        drawList();
        if (cur != null && mine.some((c) => c.thread === cur)) loadMessages(false).then(drawList);
      }).catch(() => {});
    });
    bus.on('phone-contacts', () => { if (!win.el.isConnected) return; phoneContacts(dev, true).then(() => { listSig = ''; drawList(); if (cur != null) { const t = threads.find((x) => x.thread === cur); if (t) drawHead(t.addresses); drawMessages(); } }); });
    let wasReachable = dev?.reachable;
    onPhone(win.el, () => {
      const before = dev?.id;
      checkDevice();
      if (dev && (dev.id !== before || dev.reachable !== wasReachable)) { wasReachable = dev.reachable; if (dev.reachable) loadThreads(true); }
    });
    win.on('compose', () => compose());
    win.on('refresh', () => loadThreads(true));
    win.on('reopen', (a) => { if (a?.to) compose(a.to); else if (a?.thread != null) openThread(a.thread); });
    if (args.to) { loadThreads(true); compose(args.to); } else loadThreads(true);
  },
});
phoneApp('messages', canText);

const onlyEmoji = (t) => !!t && t.length <= 12 && /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\s]*$/u.test(t);
// links in a message open in the browser
function linkify(text) {
  const out = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g)) {
    out.append(text.slice(last, m.index));
    const url = m[0];
    out.append(h('a', { href: '#', onclick: (e) => { e.preventDefault(); wm.open('browser', { url }); } }, url));
    last = m.index + url.length;
  }
  out.append(text.slice(last));
  return out;
}
