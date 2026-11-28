// Reminders — lists of things to do, like the Mac's: smart lists (Today, Scheduled, All, Flagged, Completed) and your
// own colored lists. Type "Call Sam tomorrow at 5pm" and the date is set for you. Reminders with a date show in
// Calendar and alert you at their time (reminders.js runs the alerts, so they come even with this app closed).
import { h, $, $$ } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym } from '../icons.js';
import { bus } from '../util.js';
import { contextMenu, confirmDialog } from '../menus.js';
import { loadReminders, editReminders, uid, SMART, sortItems, dueText, isOverdue, parseQuick, COLORS, toggleDone, todayKey } from '../reminders.js';
import { loadCalendar, occurrences, calOf } from '../calendardata.js';
import { store } from '../store.js';

const SMART_ICONS = {
  today: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="4.5" width="18" height="16" rx="3"/><text x="12" y="17.6" text-anchor="middle" font-size="9" font-weight="700" fill="#fff" font-family="Inter Variable, sans-serif">' + new Date().getDate() + '</text></svg>',
  scheduled: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9h18" stroke="#fff" stroke-width="1.6"/><g fill="#fff"><circle cx="8" cy="13" r="1.2"/><circle cx="12" cy="13" r="1.2"/><circle cx="16" cy="13" r="1.2"/><circle cx="8" cy="16.6" r="1.2"/><circle cx="12" cy="16.6" r="1.2"/></g></svg>',
  all: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M7 8.5h10M7 12h10M7 15.5h6" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>',
  flagged: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 21V4h1.6v.8c3.3-1.5 6 1.6 11.4.2v9c-5.4 1.4-8.1-1.7-11.4-.2V21z"/></svg>',
  completed: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="9"/><path d="m7.8 12.3 2.8 2.8 5.6-5.8" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const FLAG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 21V4h1.6v.8c3.3-1.5 6 1.6 11.4.2v9c-5.4 1.4-8.1-1.7-11.4-.2V21z"/></svg>';
const INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.6v.1" stroke-linecap="round" stroke-width="2"/></svg>';
const LISTI = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M9 7.5h9M9 12h9M9 16.5h9"/><g fill="#fff" stroke="none"><circle cx="5.6" cy="7.5" r="1.3"/><circle cx="5.6" cy="12" r="1.3"/><circle cx="5.6" cy="16.5" r="1.3"/></g></svg>';

registerApp({
  id: 'reminders', name: 'Reminders', size: [860, 580], minSize: [560, 380], overlayContent: true, hideTitle: true, singleton: true,
  keywords: ['todo', 'to do', 'tasks', 'checklist', 'list'],
  about: 'Lists of things to do, with alerts and dates in Calendar.',
  menus: (win) => [{ title: 'File', items: [
    { label: 'New Reminder', shortcut: '⌘N', action: () => win?.state?.newItem() },
    { label: 'New List', shortcut: '⇧⌘N', action: () => win?.state?.newList() }, '-',
    { label: 'Close Window', shortcut: '⌘W', action: () => win?.close() }] },
  { title: 'View', items: [
    { label: 'Show Completed', checked: !!win?.state?.showDone, action: () => win?.state?.toggleDone() }] }],
  open(win, args = {}) {
    let view = 'today', sel = args.item || null, showDone = false, editing = null, infoFor = null;
    const side = h('div.sidebar.rm-side');
    const smart = h('div.rm-smart');
    const lists = h('div.rm-lists');
    const addList = h('button.rm-addlist', { onclick: () => newList() }, h('span', { html: sym.plus }), 'Add List');
    side.append(h('div.rm-side-top'), smart, h('div.sb-sec', 'My Lists'), lists, h('div.spacer'), addList);
    const head = h('div.rm-head');
    const body = h('div.rm-body');
    const main = h('div.main-pane.rm-main', head, body);
    win.body.append(side, main);
    // the window moves from its toolbar; lists are for clicking (a drag region there eats clicks)
    win.toolbar.append(h('div.spacer'),
      h('div.tb-group', h('button.tb-btn', { title: 'Show Completed', html: SMART_ICONS.completed.replace('fill="currentColor"', 'fill="none" stroke="currentColor" stroke-width="1.6"').replace('stroke="#fff"', 'stroke="currentColor"'), onclick: () => toggleShowDone() }),
        h('button.tb-btn', { title: 'New Reminder', html: sym.plus, onclick: () => newItem() })));

    const data = () => loadReminders();
    const listOf = (d, id) => d.lists.find((l) => l.id === id);
    const viewItems = (d) => {
      if (SMART[view]) return d.items.filter(SMART[view].test);
      return d.items.filter((it) => it.list === view && (showDone || !it.done));
    };
    const viewInfo = (d) => SMART[view] ? { name: SMART[view].name, color: SMART[view].color } : listOf(d, view) || { name: 'Reminders', color: COLORS[0] };

    function drawSide() {
      const d = data();
      smart.replaceChildren(...Object.entries(SMART).map(([k, s]) => h('div.rm-tile' + (view === k ? '.sel' : ''), {
        onmousedown: (e) => { if (e.button === 0) { view = k; sel = null; draw(); } },
      }, h('span.rm-tile-ic', { style: { background: s.color }, html: SMART_ICONS[k].replace('fill="currentColor"', 'fill="#fff"').replace(/fill="#fff" font-family/, `fill="${s.color}" font-family`).replace(/stroke="#fff"/g, `stroke="${s.color}"`).replace(/<g fill="#fff">/, `<g fill="${s.color}">`) }),
      h('b', k === 'completed' ? '' : d.items.filter(s.test).length), h('span', s.name))));
      lists.replaceChildren(...d.lists.map((l) => {
        const el = h('div.rm-list' + (view === l.id ? '.sel' : ''), {
          onmousedown: (e) => { if (e.button === 0) { view = l.id; sel = null; draw(); } },
          ondragover: (e) => { if (e.dataTransfer.types.includes('text/liquid-reminder')) { e.preventDefault(); el.classList.add('over'); } },
          ondragleave: () => el.classList.remove('over'),
          ondrop: (e) => { el.classList.remove('over'); const id = e.dataTransfer.getData('text/liquid-reminder'); if (id) { editReminders((x) => { const it = x.items.find((y) => y.id === id); if (it) it.list = l.id; }); draw(); } },
        }, h('span.rm-dot', { style: { background: l.color }, html: LISTI }), h('span.rm-lname', l.name), h('small', d.items.filter((it) => it.list === l.id && !it.done).length));
        el.addEventListener('contextmenu', (e) => contextMenu(e, [
          { label: 'Rename…', action: () => renameList(l.id) },
          { label: 'Color', submenu: COLORS.map((c) => ({ label: ' ', icon: `<span style="display:block;width:12px;height:12px;border-radius:50%;background:${c}"></span>`, checked: c === l.color, action: () => { editReminders((x) => { listOf(x, l.id).color = c; }); draw(); } })) }, '-',
          { label: 'Delete List…', danger: true, disabled: d.lists.length < 2, action: () => deleteList(l.id) },
        ]));
        el.addEventListener('dblclick', () => renameList(l.id));
        return el;
      }));
    }

    function draw() {
      const d = data();
      drawSide();
      const info = viewInfo(d);
      const items = sortItems(viewItems(d));
      const open = items.filter((x) => !x.done).length;
      head.replaceChildren(h('h1', { style: { color: info.color } }, info.name), h('span.rm-count', { style: { color: info.color } }, view === 'completed' ? items.length : open));
      head.style.setProperty('--rm-color', info.color);
      body.replaceChildren();
      if (view === 'completed' && items.length) body.append(h('div.rm-sub', h('span', `${items.length} Completed`), h('button.btn.plain', { onclick: clearCompleted }, 'Clear')));
      // Today: today's events from Calendar, above the reminders
      if (view === 'today') body.append(...todaysEvents());
      // Today and Scheduled come in sections (Overdue / by day), the rest as one list
      if (view === 'scheduled' || view === 'today') {
        const groups = new Map();
        for (const it of items) {
          const g = isOverdue(it) ? 'Overdue' : view === 'today' ? 'Today' : dueText({ due: it.due });
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push(it);
        }
        for (const [g, list] of groups) { body.append(h('div.rm-group' + (g === 'Overdue' ? '.late' : ''), g)); list.forEach((it) => body.append(row(it, d))); }
      } else items.forEach((it) => body.append(row(it, d)));
      if (view !== 'completed') body.append(newRow());
      if (!items.length && view !== 'completed') body.append(h('div.rm-empty', view === 'today' ? 'Nothing due today.' : view === 'flagged' ? 'No flagged reminders.' : view === 'scheduled' ? 'No scheduled reminders.' : 'No Reminders'));
      if (!items.length && view === 'completed') body.append(h('div.rm-empty', 'No completed reminders.'));
      if (!SMART[view]) {
        const doneCount = d.items.filter((it) => it.list === view && it.done).length;
        if (doneCount) body.append(h('div.rm-sub.foot', h('span', `${doneCount} Completed`), h('button.btn.plain', { onclick: toggleShowDone }, showDone ? 'Hide' : 'Show')));
      }
      win.setTitle(info.name);
      if (editing) { const el = $(`.rm-item[data-id="${editing}"] .rm-title`, body); if (el) { focusEnd(el); } editing = null; }
    }
    const focusEnd = (el) => { el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); };

    function row(it, d) {
      const list = listOf(d, it.list) || d.lists[0];
      const color = list?.color || COLORS[0];
      const circle = h('button.rm-check' + (it.done ? '.done' : ''), { style: { '--c': color }, title: it.done ? 'Mark as Not Completed' : 'Mark as Completed',
        onclick: (e) => { e.stopPropagation(); const el = e.currentTarget.closest('.rm-item'); el.classList.add('ticking'); circle.classList.toggle('done'); setTimeout(() => { toggleDone(it.id); draw(); }, it.done ? 0 : 450); } });
      const title = h('div.rm-title', { contenteditable: 'plaintext-only', spellcheck: true }, it.title);
      title.addEventListener('focus', () => { sel = it.id; $$('.rm-item.sel', body).forEach((x) => x.classList.toggle('sel', x.dataset.id === it.id)); });
      title.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); title.blur(); newItem(); }
        if (e.key === 'Escape') { title.textContent = it.title; title.blur(); }
        if (e.key === 'Backspace' && !title.textContent) { e.preventDefault(); remove(it.id); }
      });
      title.addEventListener('blur', () => {
        const t = title.textContent.trim();
        if (t === it.title) return;
        if (!t) { remove(it.id); return; }
        // dates typed into a new reminder's title ("… tomorrow at 5pm") become its date
        const q = !it.due ? parseQuick(t) : { title: t };
        editReminders((x) => { const r = x.items.find((y) => y.id === it.id); if (!r) return; r.title = q.title; if (q.due) { r.due = q.due; r.time = q.time; } });
        draw();
      });
      const meta = [];
      if (it.due) meta.push(h('span' + (isOverdue(it) ? '.late' : ''), dueText(it)));
      if (SMART[view] && list && d.lists.length > 1) meta.push(h('span.rm-in', { style: { color } }, list.name));
      if (it.url) meta.push(h('a.rm-url', { href: '#', onclick: (e) => { e.preventDefault(); wm.open('browser', { url: it.url }); } }, it.url.replace(/^https?:\/\//, '').slice(0, 40)));
      const el = h('div.rm-item' + (it.id === sel ? '.sel' : '') + (it.done ? '.is-done' : ''), { 'data-id': it.id, draggable: true },
        circle,
        h('div.rm-main-col',
          h('div.rm-line', it.priority ? h('span.rm-prio', { style: { color } }, '!'.repeat(it.priority)) : null, title),
          it.notes ? h('div.rm-notes', it.notes) : null,
          meta.length ? h('div.rm-meta', ...meta) : null),
        it.flagged ? h('span.rm-flag', { html: FLAG }) : null,
        h('button.rm-info', { title: 'Show Details', html: INFO, onclick: (e) => { e.stopPropagation(); details(it.id, e.currentTarget); } }));
      el.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest('.rm-check, .rm-info, .rm-title, a')) { sel = it.id; $$('.rm-item', body).forEach((x) => x.classList.toggle('sel', x.dataset.id === it.id)); } });
      el.addEventListener('dblclick', (e) => { if (!e.target.closest('.rm-title, .rm-check')) details(it.id, $('.rm-info', el)); });
      el.addEventListener('dragstart', (e) => { if (document.activeElement === title) { e.preventDefault(); return; } e.dataTransfer.setData('text/liquid-reminder', it.id); e.dataTransfer.setData('text/plain', it.title); });
      el.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: it.done ? 'Mark as Not Completed' : 'Mark as Completed', action: () => { toggleDone(it.id); draw(); } },
        { label: it.flagged ? 'Unflag' : 'Flag', action: () => set(it.id, { flagged: !it.flagged }) },
        { label: 'Show Details', action: () => details(it.id, $('.rm-info', el)) }, '-',
        { label: 'Due Today', action: () => set(it.id, { due: todayKey() }) },
        { label: 'Due Tomorrow', action: () => { const t = new Date(); t.setDate(t.getDate() + 1); set(it.id, { due: ymd(t) }); } },
        { label: 'Due This Weekend', action: () => { const t = new Date(); t.setDate(t.getDate() + ((6 - t.getDay() + 7) % 7 || 7)); set(it.id, { due: ymd(t) }); } },
        it.due ? { label: 'Remove Due Date', action: () => set(it.id, { due: null, time: null }) } : null,
        it.due ? { label: 'Show in Calendar', action: () => wm.activate('calendar', { day: it.due }) } : null, '-',
        { label: 'Priority', submenu: [['None', 0], ['Low', 1], ['Medium', 2], ['High', 3]].map(([l, p]) => ({ label: l, checked: (it.priority || 0) === p, action: () => set(it.id, { priority: p }) })) },
        d.lists.length > 1 ? { label: 'Move to', submenu: d.lists.map((l) => ({ label: l.name, checked: l.id === it.list, action: () => set(it.id, { list: l.id }) })) } : null, '-',
        { label: 'Delete', danger: true, action: () => remove(it.id) },
      ].filter(Boolean)));
      return el;
    }
    /** Calendar's events today (not the hidden calendars), as a small list: click one to see it in Calendar. */
    function todaysEvents() {
      const k = todayKey(), cal = loadCalendar(), hide = new Set(store.get('calHidden') || []), now = Date.now();
      const occ = occurrences(k, k, cal).filter((o) => !hide.has(o.ev.cal));
      if (!occ.length) return [];
      return [h('div.rm-cal',
        h('div.rm-cal-head', h('span', 'Today’s Calendar'), h('button.btn.plain', { onclick: () => wm.activate('calendar', { day: k }) }, 'Open Calendar')),
        ...occ.map((o) => h('div.rm-cal-ev' + (!o.ev.allDay && o.end.getTime() < now ? '.past' : ''), { style: { '--c': calOf(cal, o.ev.cal).color }, title: 'Show in Calendar', onclick: () => wm.activate('calendar', { event: o.ev.id, day: o.key }) },
          h('i'), h('span', o.ev.title || 'Event'), h('small', o.ev.allDay ? 'All day' : `${o.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} – ${o.end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`))))];
    }
    const ymd = (t) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    function newRow() {
      const input = h('input.rm-new-input', { placeholder: 'New Reminder', spellcheck: true });
      const hint = h('small.rm-hint');
      input.addEventListener('input', () => { const q = parseQuick(input.value); hint.textContent = q.due ? '⏰ ' + dueText(q) : ''; });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) { add(input.value); setTimeout(() => $('.rm-new-input', body)?.focus(), 0); }
        if (e.key === 'Escape') { input.value = ''; hint.textContent = ''; input.blur(); }
      });
      input.addEventListener('blur', () => { if (input.value.trim()) add(input.value); });
      return h('div.rm-item.rm-new', h('span.rm-check.ghost', { html: sym.plus }), h('div.rm-main-col', input, hint));
    }
    function add(text) {
      const q = parseQuick(text);
      const d0 = data();
      const list = SMART[view] ? d0.lists[0].id : view;
      const it = { id: uid(), list, title: q.title, notes: '', due: q.due || (view === 'today' ? todayKey() : null), time: q.time || null, flagged: view === 'flagged', priority: 0, done: null, created: Date.now() };
      editReminders((d) => { d.items.push(it); });
      draw();
      return it;
    }
    function newItem() {
      const input = $('.rm-new-input', body);
      if (input) { input.focus(); return; }
      view = loadReminders().lists[0].id; draw(); $('.rm-new-input', body)?.focus();
    }
    const set = (id, patch) => { editReminders((d) => { const it = d.items.find((x) => x.id === id); if (it) Object.assign(it, patch); }); draw(); };
    const remove = (id) => { editReminders((d) => { d.items = d.items.filter((x) => x.id !== id); }); if (sel === id) sel = null; draw(); };
    async function clearCompleted() {
      if (!(await confirmDialog('Delete all completed reminders?', 'This can’t be undone.', 'Delete', { danger: true }, win.el))) return;
      editReminders((d) => { d.items = d.items.filter((x) => !x.done); }); draw();
    }
    function newList() {
      const id = uid();
      editReminders((d) => { d.lists.push({ id, name: 'New List', color: COLORS[d.lists.length % COLORS.length] }); });
      view = id; draw(); renameList(id);
    }
    function renameList(id) {
      const el = $$('.rm-list', lists).find((x, i) => loadReminders().lists[i]?.id === id);
      const name = el && $('.rm-lname', el);
      if (!name) return;
      name.contentEditable = 'plaintext-only';
      focusAll(name);
      const done = () => { name.contentEditable = 'false'; const t = name.textContent.trim(); editReminders((d) => { const l = listOf(d, id); if (l && t) l.name = t.slice(0, 60); }); draw(); };
      name.addEventListener('blur', done, { once: true });
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); name.blur(); } });
    }
    const focusAll = (el) => { el.focus(); const r = document.createRange(); r.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(r); };
    async function deleteList(id) {
      const d = data(); const l = listOf(d, id);
      const n = d.items.filter((x) => x.list === id).length;
      if (!(await confirmDialog(`Delete “${l.name}”?`, n ? `This deletes ${n} reminder${n === 1 ? '' : 's'} in this list.` : 'The list is empty.', 'Delete', { danger: true }, win.el))) return;
      editReminders((x) => { x.lists = x.lists.filter((y) => y.id !== id); x.items = x.items.filter((y) => y.list !== id); });
      if (view === id) view = 'today';
      draw();
    }
    function toggleShowDone() { if (SMART[view]) { view = view === 'completed' ? 'all' : 'completed'; } else showDone = !showDone; draw(); }

    /* the ⓘ popover: notes, date & time, flag, priority, list, link */
    function details(id, anchor) {
      $('.rm-pop', win.el)?.remove();
      const d = data(); const it = d.items.find((x) => x.id === id);
      if (!it) return;
      infoFor = id;
      const notes = h('textarea.field', { placeholder: 'Notes', rows: 3, value: it.notes || '' });
      const url = h('input.field', { placeholder: 'URL', value: it.url || '' });
      const dateOn = h('input', { type: 'checkbox', checked: !!it.due });
      const date = h('input.field', { type: 'date', value: it.due || todayKey(), disabled: !it.due });
      const timeOn = h('input', { type: 'checkbox', checked: !!it.time, disabled: !it.due });
      const time = h('input.field', { type: 'time', value: it.time || '09:00', disabled: !it.time });
      const flag = h('input', { type: 'checkbox', checked: !!it.flagged });
      const prio = h('select.field.square', ...[['None', 0], ['Low', 1], ['Medium', 2], ['High', 3]].map(([l, p]) => h('option', { value: p, selected: (it.priority || 0) === p }, l)));
      const list = h('select.field.square', ...d.lists.map((l) => h('option', { value: l.id, selected: l.id === it.list }, l.name)));
      const tog = (input) => h('label.toggle.small', input, h('span'));
      dateOn.addEventListener('change', () => { date.disabled = !dateOn.checked; timeOn.disabled = !dateOn.checked; if (!dateOn.checked) { timeOn.checked = false; time.disabled = true; } save(); });
      timeOn.addEventListener('change', () => { time.disabled = !timeOn.checked; save(); });
      [date, time, prio, list].forEach((x) => x.addEventListener('change', save));
      flag.addEventListener('change', save);
      notes.addEventListener('input', () => save(false));
      url.addEventListener('change', save);
      function save(redraw = true) {
        editReminders((x) => {
          const r = x.items.find((y) => y.id === id); if (!r) return;
          r.notes = notes.value; r.url = url.value.trim() ? (/^\w+:/.test(url.value.trim()) ? url.value.trim() : 'https://' + url.value.trim()) : '';
          r.due = dateOn.checked ? date.value || todayKey() : null; r.time = dateOn.checked && timeOn.checked ? time.value || '09:00' : null;
          r.flagged = flag.checked; r.priority = +prio.value; r.list = list.value;
        });
        if (redraw) { draw(); place(); }
      }
      const pop = h('div.rm-pop.glass.panel',
        h('div.rm-pop-title', it.title || 'Reminder'), notes, url,
        h('div.rm-pop-row', h('span', 'Date'), date, tog(dateOn)),
        h('div.rm-pop-row', h('span', 'Time'), time, tog(timeOn)),
        h('div.rm-pop-row', h('span', 'Flag'), h('div.spacer'), tog(flag)),
        h('div.rm-pop-row', h('span', 'Priority'), prio),
        h('div.rm-pop-row', h('span', 'List'), list));
      win.el.append(pop);
      function place() {
        const a = $(`.rm-item[data-id="${id}"] .rm-info`, body) || anchor;
        const wr = win.el.getBoundingClientRect(), ar = a.getBoundingClientRect();
        const top = Math.max(50, Math.min(wr.height - pop.offsetHeight - 10, ar.top - wr.top - 30));
        Object.assign(pop.style, { top: top + 'px', left: Math.max(10, ar.left - wr.left - pop.offsetWidth - 10) + 'px' });
      }
      place();
      const off = (e) => { if (!pop.contains(e.target) && !e.target.closest('.menu, .select-menu')) { pop.remove(); infoFor = null; document.removeEventListener('mousedown', off, true); } };
      setTimeout(() => document.addEventListener('mousedown', off, true), 0);
      pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { pop.remove(); infoFor = null; } });
    }

    win.state = { newItem, newList, toggleDone: toggleShowDone, get showDone() { return showDone; } };
    bus.on('reminders', () => { if (!win.el.isConnected) return; if (document.activeElement?.closest?.('.rm-main, .rm-side, .rm-pop')) return; draw(); });
    const offCal = bus.on('calendar', () => { if (!win.el.isConnected) return offCal(); if (view === 'today' && !document.activeElement?.closest?.('.rm-main, .rm-side, .rm-pop')) draw(); });
    win.on('reopen', (a) => { if (a?.item) { const it = loadReminders().items.find((x) => x.id === a.item); if (it) { view = it.list; sel = it.id; draw(); } } });
    if (sel) { const it = loadReminders().items.find((x) => x.id === sel); if (it) view = it.done ? 'completed' : it.list; }
    if (args.view) view = args.view;
    draw();
  },
});
