// Calendar: Day, Week and Month views of your events, with your reminders (Reminders) and Journal pages on their days.
// Events have their own settings (start and end, all-day, repeat, alert, location, calendar, notes, URL, a Journal
// page) in a popover, like the Mac's; reminders open in one too. Data: calendardata.js (events), reminders.js.
import { h, bus, $, $$ } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym } from '../icons.js';
import { store } from '../store.js';
import { prompt, contextMenu, showMenu, confirmDialog } from '../menus.js';
import { api } from '../sys.js';
import { loadReminders, editReminders, toggleDone, uid as rmUid, fmtTime, parseQuick } from '../reminders.js';
import { loadCalendar, editCalendar, occurrences, newEvent, calOf, dayKey, parseDay, addDays, daysBetween, at, hm, REPEATS, ALERTS, CAL_COLORS, journalPageFor, unlinkJournal, linkJournalPage, whenText, uid } from '../calendardata.js';

const HOUR = 48;   // px per hour in Day and Week
const showRm = () => store.get('calShowReminders') !== false;
const hidden = () => new Set(store.get('calHidden') || []);
const JOURNAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3.5h11a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H6z"/><path d="M6 3.5v17M9.5 8h5.5M9.5 11.5h5.5"/></svg>';
const PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>';
const REPEAT_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l3 3-3 3"/><path d="M4 12V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3"/><path d="M20 12v3a3 3 0 0 1-3 3H4"/></svg>';
const tm = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !store.get('clock24') });

registerApp({
  id: 'calendar', name: 'Calendar', size: [1080, 700], minSize: [640, 440], overlayContent: true, hideTitle: true, singleton: true,
  keywords: ['events', 'date', 'schedule', 'agenda', 'meeting', 'appointment'],
  menus: (win) => [
    { title: 'File', items: [{ label: 'New Event', shortcut: '⌃N', action: () => win?.state?.newEvent() }, { label: 'New Reminder', action: () => win?.state?.newReminder() }, '-', { label: 'New Calendar…', action: () => win?.state?.newCalendar() }] },
    { title: 'View', items: [{ label: 'Day', shortcut: 'D', checked: win?.state?.mode === 'day', action: () => win?.state?.setMode('day') }, { label: 'Week', shortcut: 'W', checked: win?.state?.mode === 'week', action: () => win?.state?.setMode('week') }, { label: 'Month', shortcut: 'M', checked: win?.state?.mode === 'month', action: () => win?.state?.setMode('month') }, '-',
      { label: 'Go to Today', shortcut: 'T', action: () => win?.state?.today() }, '-',
      { label: 'Show Reminders', checked: showRm(), action: () => store.set('calShowReminders', !showRm()) }] }],
  open(win, args = {}) {
    let mode = store.get('calMode') || 'month';
    let cur = dayKey(new Date());   // the day the view is on
    let journal = [];               // Journal's pages ({ id, title, created, color, event })
    let pop = null;                 // the open editor popover

    /* -------------------------------------------- layout */
    const side = h('div.sidebar.cal-side');
    const main = h('div.main-pane.cal-main');
    win.body.append(side, main);
    const seg = h('div.segmented.cal-seg', ...[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([m, l]) => h('button', { 'data-m': m, onclick: () => setMode(m) }, l)));
    win.toolbar.style.marginLeft = '160px';
    win.toolbar.append(h('div.spacer'), seg, h('div.spacer'),
      h('div.tb-group', h('button.tb-btn', { title: 'Previous', html: sym.chevronLeft, onclick: () => go(-1) }),
        h('button.btn.plain', { style: { height: '28px' }, onclick: () => today() }, 'Today'),
        h('button.tb-btn', { title: 'Next', html: sym.chevronRight, onclick: () => go(1) })),
      h('div.tb-group', h('button.tb-btn', { title: 'New Event (Ctrl+N)', html: sym.plus, onclick: (e) => addMenu(e.currentTarget) })));

    const setMode = (m) => { mode = m; store.set('calMode', m); draw(); };
    const today = () => { cur = dayKey(new Date()); draw(); scrollToNow(); };
    const go = (n) => {
      if (mode === 'day') cur = addDays(cur, n);
      else if (mode === 'week') cur = addDays(cur, 7 * n);
      else { const d = parseDay(cur); cur = dayKey(new Date(d.getFullYear(), d.getMonth() + n, 1)); }
      draw();
    };
    const addMenu = (anchor) => {
      const r = anchor.getBoundingClientRect();
      showMenu([{ label: 'New Event', action: () => openNewEvent() }, { label: 'New Reminder', action: () => openNewReminder() }], r.left, r.bottom + 4);
    };
    const openNewEvent = (preset = {}, anchor) => {
      const ev = newEvent({ start: cur === dayKey(new Date()) || mode === 'month' ? cur : cur, ...preset });
      eventEditor(ev, ev.start, anchor, true);
    };
    const openNewReminder = (day = cur, anchor) => {
      const d = loadReminders();
      reminderEditor({ id: rmUid(), list: d.lists[0].id, title: '', notes: '', url: '', due: day, time: null, flagged: false, priority: 0, done: null, created: Date.now() }, anchor, true);
    };
    async function newCalendar() {
      const name = await prompt('New Calendar', '', { placeholder: 'Name', ok: 'Create' }, win.el);
      if (!name) return;
      editCalendar((d) => { d.calendars.push({ id: uid(), name, color: CAL_COLORS[d.calendars.length % CAL_COLORS.length] }); });
      draw();
    }

    /* -------------------------------------------- what's on a day */
    // the range shown, as day keys
    const range = () => {
      if (mode === 'day') return [cur, cur];
      if (mode === 'week') { const s = addDays(cur, -parseDay(cur).getDay()); return [s, addDays(s, 6)]; }
      const d = parseDay(cur), first = new Date(d.getFullYear(), d.getMonth(), 1);
      const s = addDays(dayKey(first), -first.getDay());
      return [s, addDays(s, 41)];
    };
    // everything to show: events (not in hidden calendars) and reminders with a date (a Journal page shows only as the
    // event it's been added to: Journal › Add to Calendar…, or Calendar › Make a Journal Page)
    function gather(from, to) {
      const cal = loadCalendar(), hide = hidden();
      const occ = occurrences(from, to, cal).filter((o) => !hide.has(o.ev.cal));
      const rm = showRm() ? loadReminders() : null;
      const rms = rm ? rm.items.filter((it) => it.due && it.due >= from && it.due <= to) : [];
      return { cal, occ, rm, rms };
    }
    const onDay = (o, k) => o.key <= k && addDays(o.key, o.days - 1) >= k
      // (a timed event that ends at midnight doesn't show on the next day)
      && !(k > o.key && !o.ev.allDay && o.end.getTime() === at(k).getTime());

    /* -------------------------------------------- chips (month view, all-day rows) */
    function evChip(o, cal, k) {
      const c = calOf(cal, o.ev.cal).color;
      const timed = !o.ev.allDay && o.days === 1;
      const el = h('div.cal-chip' + (timed ? '.timed' : '.allday'), { style: { '--c': c }, title: `${o.ev.title || 'New Event'}\n${whenText(o.ev, o.key)}${o.ev.location ? '\n' + o.ev.location : ''}`, 'data-ev': o.ev.id },
        timed ? h('i') : null, h('span.t', o.ev.title || 'New Event'),
        o.ev.journal ? h('span.ic', { html: JOURNAL }) : null, o.ev.repeat ? h('span.ic', { html: REPEAT_IC }) : null,
        timed ? h('small', tm(o.start)) : null);
      el.addEventListener('click', (e) => { e.stopPropagation(); eventEditor(o.ev, o.key, el); });
      el.addEventListener('contextmenu', (e) => contextMenu(e, eventMenu(o)));
      return el;
    }
    function rmChip(it, rm) {
      const color = rm.lists.find((l) => l.id === it.list)?.color || '#0a84ff';
      const el = h('div.cal-rm' + (it.done ? '.done' : ''), { style: { '--c': color }, title: 'Reminder — click the circle to complete it' },
        h('i', { onclick: (e) => { e.stopPropagation(); toggleDone(it.id); } }), h('span.t', it.title || 'Reminder'), it.time ? h('small', fmtTime(it.time)) : null);
      el.addEventListener('click', (e) => { e.stopPropagation(); reminderEditor(it, el); });
      el.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: it.done ? 'Mark as Not Completed' : 'Mark as Completed', action: () => toggleDone(it.id) },
        { label: 'Show in Reminders', action: () => wm.activate('reminders', { item: it.id }) }, '-',
        { label: 'Delete Reminder', danger: true, action: () => editReminders((x) => { x.items = x.items.filter((y) => y.id !== it.id); }) }]));
      return el;
    }
    function eventMenu(o) {
      const items = [{ label: 'Edit Event…', action: () => eventEditor(o.ev, o.key) },
        o.ev.journal ? { label: 'Open Journal Page', action: () => wm.activate('journal', { page: o.ev.journal }) } : { label: 'Make a Journal Page', action: async () => { const id = await journalPageFor(o.ev, o.key); wm.activate('journal', { page: id }); } },
        { label: 'Duplicate', action: () => editCalendar((d) => { d.events.push({ ...structuredClone(o.ev), id: uid(), journal: null, created: Date.now() }); }) },
        { label: 'Calendar', submenu: loadCalendar().calendars.map((c) => ({ label: c.name, checked: c.id === o.ev.cal, action: () => editCalendar((d) => { const e = d.events.find((x) => x.id === o.ev.id); if (e) e.cal = c.id; }) })) }, '-'];
      if (o.ev.repeat) items.push({ label: 'Delete This Event Only', danger: true, action: () => deleteEvent(o, 'one') }, { label: 'Delete All Repeats', danger: true, action: () => deleteEvent(o, 'all') });
      else items.push({ label: 'Delete Event', danger: true, action: () => deleteEvent(o, 'all') });
      return items;
    }
    function deleteEvent(o, which) {
      editCalendar((d) => {
        if (which === 'one') { const e = d.events.find((x) => x.id === o.ev.id); if (e) (e.skip ||= []).push(o.key); }
        else d.events = d.events.filter((x) => x.id !== o.ev.id);
      });
      // its Journal page stays, no longer linked
      if (which === 'all' && o.ev.journal) linkJournalPage(o.ev.journal, null).catch(() => {});
      closePop();
    }

    /* -------------------------------------------- month */
    function drawMonth(box) {
      const [from, to] = range();
      const { cal, occ, rm, rms } = gather(from, to);
      const month = parseDay(cur).getMonth(), todayK = dayKey(new Date());
      const firstDow = 0;
      box.append(h('div.cal-dow', ...Array.from({ length: 7 }, (_, i) => h('span', parseDay(addDays(from, i + firstDow)).toLocaleDateString([], { weekday: 'short' })))));
      const grid = h('div.cal-grid');
      for (let i = 0; i < 42; i++) {
        const k = addDays(from, i), d = parseDay(k);
        const items = h('div.cal-items');
        const evs = occ.filter((o) => onDay(o, k)).sort((a, b) => (!a.ev.allDay - !b.ev.allDay) || (b.days - a.days) || (a.start - b.start));
        items.append(...evs.map((o) => evChip(o, cal, k)), ...rms.filter((it) => it.due === k).sort((a, b) => (a.time || '99').localeCompare(b.time || '99')).map((it) => rmChip(it, rm)));
        const cell = h('div.cal-cell' + (d.getMonth() !== month ? '.other' : '') + (k === todayK ? '.today' : '') + (d.getDay() % 6 === 0 ? '.weekend' : ''),
          h('span.d', { onclick: (e) => { e.stopPropagation(); cur = k; setMode('day'); }, title: 'Show this day' }, d.getDate() === 1 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : String(d.getDate())), items);
        cell.addEventListener('dblclick', (e) => { if (e.target.closest('.cal-chip, .cal-rm, .cal-jr')) return; openNewEvent({ start: k, allDay: false }, cell); });
        cell.addEventListener('contextmenu', (e) => { if (e.target.closest('.cal-chip, .cal-rm, .cal-jr')) return; contextMenu(e, [{ label: 'New Event', action: () => openNewEvent({ start: k }, cell) }, { label: 'New All-Day Event', action: () => openNewEvent({ start: k, allDay: true }, cell) }, { label: 'New Reminder', action: () => openNewReminder(k, cell) }]); });
        grid.append(cell);
      }
      box.append(grid);
      // more than fits: "3 more", which opens the day
      requestAnimationFrame(() => {
        for (const items of $$('.cal-items', grid)) {
          const kids = [...items.children];
          if (items.scrollHeight <= items.clientHeight + 1) continue;
          let n = 0;
          while (items.scrollHeight > items.clientHeight + 1 && kids.length) { kids.pop().remove(); n++; }
          if (n) { kids.pop()?.remove(); n++; }
          const k = addDays(from, [...$$('.cal-items', grid)].indexOf(items));
          items.append(h('div.cal-more', { onclick: (e) => { e.stopPropagation(); cur = k; setMode('day'); } }, `${n} more`));
        }
      });
    }

    /* -------------------------------------------- day and week */
    function drawTimeGrid(box, days) {
      const [from, to] = [days[0], days[days.length - 1]];
      const { cal, occ, rm, rms } = gather(from, to);
      const todayK = dayKey(new Date());
      const cols = days.length;
      // the heading: each day's name and date
      box.append(h('div.cal-tg-head', { style: { '--cols': cols } }, h('div.cal-gut'), ...days.map((k) => {
        const d = parseDay(k);
        return h('div.cal-tg-day' + (k === todayK ? '.today' : ''), { onclick: () => { if (mode === 'week') { cur = k; setMode('day'); } } },
          h('span', d.toLocaleDateString([], { weekday: cols === 1 ? 'long' : 'short' })), h('b', String(d.getDate())));
      })));
      // all-day: events, reminders without a time, journal pages
      const allDay = h('div.cal-allday', { style: { '--cols': cols } }, h('div.cal-gut', 'all-day'));
      for (const k of days) {
        const col = h('div.cal-ad-col');
        // (timed events over more than two days go here too; shorter ones are drawn in the hours)
        col.append(...occ.filter((o) => (o.ev.allDay || o.days > 2) && onDay(o, k)).map((o) => evChip(o, cal, k)),
          ...rms.filter((it) => it.due === k && !it.time).map((it) => rmChip(it, rm)));
        col.addEventListener('dblclick', (e) => { if (e.target === col) openNewEvent({ start: k, allDay: true }, col); });
        allDay.append(col);
      }
      box.append(allDay);
      // the hours
      const scroll = h('div.cal-tg-scroll');
      const body = h('div.cal-tg', { style: { '--cols': cols, height: 24 * HOUR + 'px' } });
      const gut = h('div.cal-gut.hours', ...Array.from({ length: 24 }, (_, i) => h('span', { style: { top: i * HOUR + 'px' } }, i ? tm(new Date(2000, 0, 1, i)).replace(':00', '') : '')));
      body.append(gut);
      days.forEach((k, ci) => {
        const col = h('div.cal-tg-col' + (k === todayK ? '.today' : '') + (parseDay(k).getDay() % 6 === 0 ? '.weekend' : ''), { 'data-day': k });
        // timed events, side by side where they overlap
        const list = occ.filter((o) => !o.ev.allDay && o.days <= 2 && onDay(o, k)).map((o) => {
          const dayStart = at(k).getTime();
          const s = Math.max(o.start.getTime(), dayStart), e = Math.min(o.end.getTime(), dayStart + 864e5);
          return { o, s: (s - dayStart) / 60e3, e: Math.max((e - dayStart) / 60e3, (s - dayStart) / 60e3 + 20) };
        }).filter((x) => x.e > x.s);
        layoutLanes(list);
        for (const x of list) col.append(evBlock(x, cal, k));
        // reminders with a time: a marker at their time
        for (const it of rms.filter((r) => r.due === k && r.time)) {
          const [hh, mm] = it.time.split(':').map(Number);
          const el = rmChip(it, rm);
          el.classList.add('cal-rm-at');
          el.style.top = ((hh * 60 + mm) * HOUR) / 60 + 'px';
          col.append(el);
        }
        if (k === todayK) { const n = new Date(); col.append(h('div.cal-now', { style: { top: ((n.getHours() * 60 + n.getMinutes()) * HOUR) / 60 + 'px' } })); }
        col.addEventListener('mousedown', (e) => { if (e.button === 0 && e.target === col) dragCreate(col, k, e); });
        col.addEventListener('contextmenu', (e) => {
          if (e.target !== col) return;
          const t = snap(minutesAt(col, e.clientY));
          contextMenu(e, [{ label: 'New Event', action: () => openNewEvent({ start: k, startTime: fmtHM(t), endTime: fmtHM(Math.min(t + 60, 1439)) }, col) }, { label: 'New Reminder', action: () => openNewReminder(k, col) }]);
        });
        body.append(col);
        void ci;
      });
      scroll.append(body);
      box.append(scroll);
      return scroll;
    }
    const fmtHM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const snap = (m) => Math.max(0, Math.min(1440 - 15, Math.round(m / 15) * 15));
    const minutesAt = (col, y) => ((y - col.getBoundingClientRect().top) / HOUR) * 60;
    // overlapping events share the column: each gets a lane, and the group's width is split between its lanes
    function layoutLanes(list) {
      list.sort((a, b) => a.s - b.s || b.e - a.e);
      let group = [], end = -1;
      const flush = () => { const n = Math.max(...group.map((x) => x.lane)) + 1; for (const x of group) x.n = n; group = []; };
      for (const x of list) {
        if (x.s >= end && group.length) flush();
        const used = new Set(group.filter((g) => g.e > x.s).map((g) => g.lane));
        x.lane = 0; while (used.has(x.lane)) x.lane++;
        group.push(x); end = Math.max(end, x.e);
      }
      if (group.length) flush();
    }
    function evBlock(x, cal, k) {
      const { o } = x;
      const c = calOf(cal, o.ev.cal).color;
      const short = x.e - x.s < 45;
      const el = h('div.cal-block' + (short ? '.short' : ''), { style: { '--c': c, top: (x.s * HOUR) / 60 + 'px', height: Math.max(18, ((x.e - x.s) * HOUR) / 60 - 2) + 'px', left: `calc(${(x.lane / x.n) * 100}% + 2px)`, width: `calc(${100 / x.n}% - 4px)` }, 'data-ev': o.ev.id },
        h('b', o.ev.title || 'New Event', o.ev.repeat ? h('span.ic', { html: REPEAT_IC }) : null, o.ev.journal ? h('span.ic', { html: JOURNAL }) : null),
        h('small', short ? tm(o.start) : `${tm(o.start)} – ${tm(o.end)}`), !short && o.ev.location ? h('small.loc', o.ev.location) : null,
        o.ev.repeat ? null : h('div.cal-resize'));
      el.title = `${o.ev.title || 'New Event'}\n${whenText(o.ev, o.key)}${o.ev.location ? '\n' + o.ev.location : ''}`;
      el.addEventListener('mousedown', (e) => { if (e.button === 0) dragEvent(el, o, k, e); });
      el.addEventListener('contextmenu', (e) => contextMenu(e, eventMenu(o)));
      return el;
    }
    // drag on an empty part of a day: a new event over that time (a click: an hour from there)
    function dragCreate(col, k, e) {
      e.preventDefault();
      closePop();
      const s0 = snap(minutesAt(col, e.clientY));
      const ghost = h('div.cal-block.ghost', { style: { '--c': calOf(loadCalendar(), loadCalendar().calendars[0].id).color, top: (s0 * HOUR) / 60 + 'px', height: HOUR - 2 + 'px', left: '2px', width: 'calc(100% - 4px)' } }, h('b', 'New Event'), h('small'));
      col.append(ghost);
      let a = s0, b = s0 + 60, moved = false;
      const show = () => { ghost.style.top = (a * HOUR) / 60 + 'px'; ghost.style.height = Math.max(18, ((b - a) * HOUR) / 60 - 2) + 'px'; ghost.lastChild.textContent = `${tm(at(k, fmtHM(a)))} – ${tm(at(k, fmtHM(Math.min(b, 1439))))}`; };
      show();
      const mv = (ev) => { const m = snap(minutesAt(col, ev.clientY)); if (m !== s0) moved = true; a = Math.min(s0, m); b = Math.max(s0, m) + (moved ? 15 : 60); if (b - a < 15) b = a + 15; show(); };
      const up = () => {
        removeEventListener('mousemove', mv, true); removeEventListener('mouseup', up, true);
        const end = Math.min(b, 1439);
        openNewEvent({ start: k, startTime: fmtHM(a), endTime: fmtHM(end) }, ghost);
        // (the ghost stays until the popover closes)
        pop && (pop.ghost = ghost);
      };
      addEventListener('mousemove', mv, true); addEventListener('mouseup', up, true);
    }
    // drag an event to move it (to another time or day); drag its bottom edge to change when it ends; click to edit
    function dragEvent(el, o, k, e) {
      e.stopPropagation();
      const resize = e.target.classList.contains('cal-resize');
      const col = el.parentNode, sy = e.clientY, sx = e.clientX;
      const top0 = parseFloat(el.style.top), h0 = parseFloat(el.style.height);
      let moved = false, dm = 0, targetDay = k;
      const cols = $$('.cal-tg-col', main);
      const mv = (ev) => {
        if (!moved && Math.abs(ev.clientY - sy) < 4 && Math.abs(ev.clientX - sx) < 4) return;
        if (o.ev.repeat) return;   // a repeating event moves in its editor (all of them at once)
        moved = true; el.classList.add('dragging');
        dm = Math.round((((ev.clientY - sy) / HOUR) * 60) / 15) * 15;
        if (resize) el.style.height = Math.max(18, h0 + (dm * HOUR) / 60) + 'px';
        else {
          el.style.top = top0 + (dm * HOUR) / 60 + 'px';
          const over = cols.find((c) => { const r = c.getBoundingClientRect(); return ev.clientX >= r.left && ev.clientX < r.right; });
          if (over && over !== el.parentNode) { over.append(el); targetDay = over.dataset.day; }
        }
      };
      const up = () => {
        removeEventListener('mousemove', mv, true); removeEventListener('mouseup', up, true);
        if (!moved) return eventEditor(o.ev, o.key, el);
        editCalendar((d) => {
          const ev = d.events.find((x) => x.id === o.ev.id); if (!ev) return;
          const s = at(ev.start, ev.startTime), en = at(ev.end, ev.endTime);
          if (resize) { en.setMinutes(en.getMinutes() + dm); if (en - s < 15 * 60e3) en.setTime(s.getTime() + 15 * 60e3); }
          else { const shift = daysBetween(k, targetDay) * 864e5 + dm * 60e3; s.setTime(s.getTime() + shift); en.setTime(en.getTime() + shift); }
          ev.start = dayKey(s); ev.startTime = hm(s); ev.end = dayKey(en); ev.endTime = hm(en);
        });
        void col;
      };
      addEventListener('mousemove', mv, true); addEventListener('mouseup', up, true);
    }

    /* -------------------------------------------- the sidebar: calendars, other things to show, a small month */
    function drawSide() {
      const cal = loadCalendar(), hide = hidden();
      const check = (on, color, onchange) => h('label.cal-check', { style: { '--c': color } }, h('input', { type: 'checkbox', checked: on, onchange }), h('span'));
      const rows = cal.calendars.map((c) => {
        const el = h('div.cal-side-row', check(!hide.has(c.id), c.color, (e) => { const s = hidden(); e.target.checked ? s.delete(c.id) : s.add(c.id); store.set('calHidden', [...s]); }), h('span', c.name));
        el.addEventListener('contextmenu', (e) => contextMenu(e, [
          { label: 'Rename…', action: async () => { const n = await prompt('Rename Calendar', c.name, { ok: 'Rename' }, win.el); if (n) editCalendar((d) => { calOf(d, c.id).name = n; }); } },
          { label: 'Color', submenu: CAL_COLORS.map((col) => ({ label: ' ', checked: col === c.color, icon: `<span style="display:block;width:12px;height:12px;border-radius:50%;background:${col}"></span>`, action: () => editCalendar((d) => { calOf(d, c.id).color = col; }) })) },
          '-', { label: 'Delete Calendar…', danger: true, disabled: cal.calendars.length < 2, action: async () => {
            const n = cal.events.filter((x) => x.cal === c.id).length;
            if (!(await confirmDialog(`Delete “${c.name}”?`, n ? `Its ${n} event${n === 1 ? '' : 's'} will be deleted too.` : 'It has no events.', 'Delete', { danger: true }, win.el))) return;
            editCalendar((d) => { d.calendars = d.calendars.filter((x) => x.id !== c.id); d.events = d.events.filter((x) => x.cal !== c.id); });
          } }]));
        return el;
      });
      const rmd = loadReminders();
      side.replaceChildren(
        h('div.sb-sec.cal-side-sec', 'Calendars', h('button.tb-btn.cal-side-add', { title: 'New Calendar', html: sym.plus, onclick: newCalendar })), ...rows,
        h('div.sb-sec.cal-side-sec', 'Other'),
        h('div.cal-side-row', check(showRm(), rmd.lists[0]?.color || '#0a84ff', () => store.set('calShowReminders', !showRm())), h('span', 'Reminders'), h('button.tb-btn.cal-side-go', { title: 'Open Reminders', html: sym.chevronRight, onclick: () => wm.activate('reminders') })),
        h('div.spacer'), miniMonth(cal));
    }
    let miniView = null;
    function miniMonth(cal) {
      const base = miniView || cur, d = parseDay(base), first = new Date(d.getFullYear(), d.getMonth(), 1);
      const from = addDays(dayKey(first), -first.getDay());
      const busy = new Set();
      for (const o of occurrences(from, addDays(from, 41), cal)) for (let i = 0; i < o.days; i++) busy.add(addDays(o.key, i));
      const [rf, rt] = range(), todayK = dayKey(new Date());
      const shiftMini = (n) => { miniView = dayKey(new Date(d.getFullYear(), d.getMonth() + n, 1)); drawSide(); };
      return h('div.cal-mini',
        h('div.cal-mini-head', h('b', first.toLocaleDateString([], { month: 'long', year: 'numeric' })), h('div.spacer'),
          h('button.tb-btn', { html: sym.chevronLeft, onclick: () => shiftMini(-1) }), h('button.tb-btn', { html: sym.chevronRight, onclick: () => shiftMini(1) })),
        h('div.cal-mini-grid', ...['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x) => h('span.dow', x)), ...Array.from({ length: 42 }, (_, i) => {
          const k = addDays(from, i), dd = parseDay(k);
          return h('button' + (dd.getMonth() !== first.getMonth() ? '.other' : '') + (k === todayK ? '.today' : '') + (k >= rf && k <= rt && mode !== 'month' ? '.inrange' : '') + (busy.has(k) ? '.busy' : ''),
            { onclick: () => { cur = k; miniView = null; if (mode === 'month') draw(); else draw(); } }, String(dd.getDate()));
        })));
    }

    /* -------------------------------------------- the editor popovers */
    function closePop() {
      if (!pop) return;
      const p = pop; pop = null;
      p.ghost?.remove(); p.onClose?.();
      p.classList.add('closing'); setTimeout(() => p.remove(), 150);
      // (changes made while it was open weren't drawn yet)
      setTimeout(redraw, 0);
    }
    function placePop(p, anchor) {
      const wr = win.el.getBoundingClientRect();
      const ar = anchor?.isConnected ? anchor.getBoundingClientRect() : { left: wr.left + wr.width / 2 - 10, right: wr.left + wr.width / 2 + 10, top: wr.top + 120, bottom: wr.top + 140 };
      const pw = p.offsetWidth, ph = p.offsetHeight;
      // beside what it's for: to the right, else to the left; level with it, kept inside the window
      let left = ar.right - wr.left + 10, side = 'r';
      if (left + pw > wr.width - 10) { left = ar.left - wr.left - pw - 10; side = 'l'; }
      if (left < 10) { left = Math.max(10, Math.min(wr.width - pw - 10, ar.left - wr.left)); side = 'n'; }
      const top = Math.max(56, Math.min(wr.height - ph - 10, ar.top - wr.top - 30));
      Object.assign(p.style, { left: left + 'px', top: top + 'px' });
      p.dataset.side = side;
      const arrowY = Math.max(16, Math.min(ph - 16, ar.top - wr.top + Math.min(ar.bottom - ar.top, 40) / 2 - top));
      p.style.setProperty('--ay', arrowY + 'px');
    }
    function openPop(content, anchor, onClose) {
      closePop();
      const p = h('div.cal-pop.glass.panel', content);
      p.onClose = onClose;
      win.el.append(p);
      placePop(p, anchor);
      pop = p;
      const off = (e) => { if (pop !== p) return document.removeEventListener('mousedown', off, true); if (!p.contains(e.target) && !e.target.closest('.menu, .select-menu, .alert-layer')) { document.removeEventListener('mousedown', off, true); closePop(); } };
      setTimeout(() => document.addEventListener('mousedown', off, true), 0);
      p.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); } });
      return p;
    }
    const row = (label, ...kids) => h('div.cal-pop-row' + (kids.some((k) => k?.classList?.contains('cal-pop-time')) ? '.dt' : ''), h('span.lbl', label), h('div.cal-pop-val', ...kids));
    const tog = (input) => h('label.toggle.small', input, h('span'));
    const sel = (opts, value) => h('select.field.square', ...opts.map(([v, l]) => h('option', { value: v == null ? '' : String(v), selected: (v == null ? '' : String(v)) === (value == null ? '' : String(value)) }, l)));

    /** An event's settings. isNew: not saved yet (it's added when the popover closes with a title, or with Add). */
    function eventEditor(ev0, key, anchor, isNew = false) {
      const cal = loadCalendar();
      const ev = structuredClone(cal.events.find((x) => x.id === ev0.id) || ev0);
      const span = daysBetween(ev.start, ev.end);
      // a repeating event is edited from the occurrence that was clicked: its dates show that one's
      const occStart = ev.repeat ? key : ev.start;
      const title = h('input.cal-pop-title', { value: ev.title, placeholder: 'New Event', spellcheck: false });
      const loc = h('input.field.cal-pop-loc', { value: ev.location || '', placeholder: 'Add Location' });
      const allDay = h('input', { type: 'checkbox', checked: !!ev.allDay });
      const sDate = h('input.field', { type: 'date', value: occStart }), sTime = h('input.field', { type: 'time', value: ev.startTime || '09:00', step: 300 });
      const eDate = h('input.field', { type: 'date', value: addDays(occStart, span) }), eTime = h('input.field', { type: 'time', value: ev.endTime || '10:00', step: 300 });
      const repeat = sel(REPEATS, ev.repeat), until = h('input.field', { type: 'date', value: ev.repeatUntil || addDays(occStart, 90) });
      const untilOn = h('input', { type: 'checkbox', checked: !!ev.repeatUntil });
      const calSel = h('div.cal-pop-cals', ...cal.calendars.map((c) => h('button.cal-pop-cal' + (c.id === ev.cal ? '.on' : ''), { type: 'button', style: { '--c': c.color }, title: c.name, onclick: (e) => { ev.cal = c.id; $$('.cal-pop-cal', calSel).forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } }, h('i'), c.name)));
      const alert = sel(ALERTS, ev.alert);
      const url = h('input.field', { value: ev.url || '', placeholder: 'URL' });
      const notes = h('textarea.field', { rows: 3, placeholder: 'Notes', value: ev.notes || '' });
      const timeRow = [h('span.cal-pop-time', sTime), h('span.cal-pop-time', eTime)];
      const sync = () => {
        for (const t of [sTime, eTime]) t.parentNode.hidden = allDay.checked;
        untilRow.hidden = !repeat.value;
        until.disabled = !untilOn.checked;
      };
      // moving the start moves the end with it (keeping the length), like the Mac
      let lastStart = at(sDate.value, allDay.checked ? null : sTime.value);
      const startChanged = () => {
        const ns = at(sDate.value || occStart, allDay.checked ? null : sTime.value);
        const ne = at(eDate.value || sDate.value, allDay.checked ? null : eTime.value);
        ne.setTime(ne.getTime() + (ns - lastStart));
        eDate.value = dayKey(ne); if (!allDay.checked) eTime.value = hm(ne);
        lastStart = ns;
      };
      sDate.addEventListener('change', startChanged); sTime.addEventListener('change', startChanged);
      allDay.addEventListener('change', () => { lastStart = at(sDate.value, allDay.checked ? null : sTime.value); sync(); });
      repeat.addEventListener('change', sync); untilOn.addEventListener('change', sync);
      const untilRow = row('End Repeat', until, tog(untilOn));
      const jrBox = h('div.cal-pop-jr');
      const drawJr = () => {
        const cur2 = loadCalendar().events.find((x) => x.id === ev.id);
        const pid = cur2?.journal || ev.journal;
        jrBox.replaceChildren(pid
          ? h('div.cal-pop-jr-on', h('span.ic', { html: JOURNAL }), h('span', journal.find((p) => p.id === pid)?.title || 'Journal page'), h('div.spacer'),
            h('button.btn.small', { type: 'button', onclick: () => wm.activate('journal', { page: pid }) }, 'Open'),
            h('button.btn.small.plain', { type: 'button', title: 'Unlink (the page stays in Journal)', onclick: async () => { ev.journal = null; if (!isNew) await unlinkJournal(ev.id); drawJr(); } }, 'Unlink'))
          : h('button.btn.small', { type: 'button', onclick: async () => { const saved = commit(true); if (!saved) { title.focus(); return; } const id = await journalPageFor(saved, saved.start); ev.journal = id; await refreshJournal(); drawJr(); wm.activate('journal', { page: id }); } }, h('span.ic', { html: JOURNAL }), 'Make a Journal Page'));
      };
      drawJr();
      let done = false;
      // save what's in the popover (a new event only once it has a title, or when forced)
      function commit(force) {
        if (done) return null;
        const t = title.value.trim();
        if (isNew && !t && !force) return null;
        ev.title = t || (isNew ? 'New Event' : ev.title);
        ev.location = loc.value.trim(); ev.url = url.value.trim() ? (/^\w+:/.test(url.value.trim()) ? url.value.trim() : 'https://' + url.value.trim()) : ''; ev.notes = notes.value;
        ev.allDay = allDay.checked;
        let s = at(sDate.value || occStart, ev.allDay ? null : sTime.value), e = at(eDate.value || sDate.value, ev.allDay ? null : eTime.value);
        if (e < s) e = new Date(s.getTime() + (ev.allDay ? 0 : 3600e3));
        // (a repeating event: the change to this occurrence's dates moves the whole series by the same amount)
        const shift = daysBetween(occStart, dayKey(s));
        ev.start = ev.repeat && repeat.value ? addDays(ev.start, shift) : dayKey(s);
        ev.end = addDays(ev.start, daysBetween(dayKey(s), dayKey(e)));
        ev.startTime = ev.allDay ? null : hm(s); ev.endTime = ev.allDay ? null : hm(e);
        ev.repeat = repeat.value || null; ev.repeatUntil = ev.repeat && untilOn.checked ? until.value || null : null;
        ev.alert = alert.value === '' ? null : +alert.value;
        // (ev.journal is kept up to date by the Make / Unlink buttons, which also save it themselves)
        editCalendar((d) => { const i = d.events.findIndex((x) => x.id === ev.id); if (i >= 0) d.events[i] = { ...ev }; else d.events.push({ ...ev }); });
        // made for a Journal page (Journal › Add to Calendar): the page points back at it
        if (isNew && ev.journal) linkJournalPage(ev.journal, ev.id, ev.start).catch(() => {});
        isNew = false;
        return ev;
      }
      const head = h('div.cal-pop-head', h('i.cal-pop-dot', { style: { background: calOf(cal, ev.cal).color } }), title);
      const foot = h('div.cal-pop-foot',
        isNew ? null : h('button.btn.danger.plain', { type: 'button', onclick: () => { done = true; deleteEvent({ ev, key }, ev.repeat ? 'one' : 'all'); } }, ev.repeat ? 'Delete This One' : 'Delete'),
        !isNew && ev.repeat ? h('button.btn.danger.plain', { type: 'button', onclick: () => { done = true; deleteEvent({ ev, key }, 'all'); } }, 'Delete All') : null,
        h('div.spacer'), h('button.btn.primary', { type: 'button', onclick: () => { commit(true); closePop(); } }, isNew ? 'Add' : 'Done'));
      const content = h('form.cal-pop-in', { onsubmit: (e) => { e.preventDefault(); commit(true); closePop(); } },
        head, h('div.cal-pop-locrow', h('span.ic', { html: PIN }), loc),
        h('div.cal-pop-sep'),
        row('All-day', h('div.spacer'), tog(allDay)),
        row('Starts', sDate, timeRow[0]),
        row('Ends', eDate, timeRow[1]),
        row('Repeat', repeat), untilRow,
        h('div.cal-pop-sep'),
        row('Calendar', calSel),
        row('Alert', alert),
        h('div.cal-pop-sep'),
        url, notes, jrBox, foot, h('button', { type: 'submit', hidden: true }));
      sync();
      const p = openPop(content, anchor, () => commit(false));
      calSel.addEventListener('click', () => { head.firstChild.style.background = calOf(cal, ev.cal).color; });
      setTimeout(() => { if (isNew) title.focus(); }, 30);
      title.addEventListener('keydown', (e) => {
        // typed in the title of a new event: "Lunch tomorrow at 12:30" sets the day and time
        if (e.key === 'Enter' && isNew) {
          const q = parseQuick(title.value);
          if (q.due) { title.value = q.title; sDate.value = q.due; if (q.time) { allDay.checked = false; sTime.value = q.time; const en = at(q.due, q.time); en.setHours(en.getHours() + 1); eDate.value = dayKey(en); eTime.value = hm(en); } else eDate.value = q.due; sync(); }
        }
      });
      return p;
    }

    /** A reminder's settings (the same as in Reminders). */
    function reminderEditor(it0, anchor, isNew = false) {
      const d = loadReminders();
      const it = structuredClone(d.items.find((x) => x.id === it0.id) || it0);
      const title = h('input.cal-pop-title', { value: it.title, placeholder: 'New Reminder', spellcheck: false });
      const doneBox = h('input', { type: 'checkbox', checked: !!it.done });
      const date = h('input.field', { type: 'date', value: it.due || dayKey(new Date()) });
      const dateOn = h('input', { type: 'checkbox', checked: !!it.due });
      const time = h('input.field', { type: 'time', value: it.time || '09:00', step: 300 });
      const timeOn = h('input', { type: 'checkbox', checked: !!it.time });
      const list = h('div.cal-pop-cals', ...d.lists.map((l) => h('button.cal-pop-cal' + (l.id === it.list ? '.on' : ''), { type: 'button', style: { '--c': l.color }, onclick: (e) => { it.list = l.id; $$('.cal-pop-cal', list).forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } }, h('i'), l.name)));
      const prio = sel([[0, 'None'], [1, 'Low'], [2, 'Medium'], [3, 'High']], it.priority || 0);
      const flag = h('input', { type: 'checkbox', checked: !!it.flagged });
      const url = h('input.field', { value: it.url || '', placeholder: 'URL' });
      const notes = h('textarea.field', { rows: 3, placeholder: 'Notes', value: it.notes || '' });
      const sync = () => { date.disabled = !dateOn.checked; timeOn.disabled = !dateOn.checked; time.disabled = !(dateOn.checked && timeOn.checked); };
      dateOn.addEventListener('change', sync); timeOn.addEventListener('change', sync);
      let done = false;
      const commit = (force) => {
        if (done) return;
        const t = title.value.trim();
        if (isNew && !t && !force) return;
        Object.assign(it, { title: t || it.title || 'Reminder', due: dateOn.checked ? date.value || null : null, time: dateOn.checked && timeOn.checked ? time.value || null : null,
          priority: +prio.value, flagged: flag.checked, notes: notes.value, url: url.value.trim() ? (/^\w+:/.test(url.value.trim()) ? url.value.trim() : 'https://' + url.value.trim()) : '' });
        if (doneBox.checked !== !!it.done) it.done = doneBox.checked ? Date.now() : null;
        editReminders((x) => { const i = x.items.findIndex((y) => y.id === it.id); if (i >= 0) x.items[i] = it; else x.items.push(it); });
        isNew = false;
      };
      const content = h('form.cal-pop-in', { onsubmit: (e) => { e.preventDefault(); commit(true); closePop(); } },
        h('div.cal-pop-head', h('label.cal-pop-rmcheck', { title: 'Completed', style: { '--c': d.lists.find((l) => l.id === it.list)?.color || '#0a84ff' } }, doneBox, h('span')), title),
        h('small.cal-pop-kind', 'Reminder'),
        h('div.cal-pop-sep'),
        row('Date', date, tog(dateOn)), row('Time', time, tog(timeOn)),
        h('div.cal-pop-sep'),
        row('List', list), row('Priority', prio), row('Flagged', h('div.spacer'), tog(flag)),
        h('div.cal-pop-sep'),
        url, notes,
        h('div.cal-pop-foot',
          isNew ? null : h('button.btn.danger.plain', { type: 'button', onclick: () => { done = true; editReminders((x) => { x.items = x.items.filter((y) => y.id !== it.id); }); closePop(); } }, 'Delete'),
          isNew ? null : h('button.btn.plain', { type: 'button', onclick: () => { commit(true); closePop(); wm.activate('reminders', { item: it.id }); } }, 'Show in Reminders'),
          h('div.spacer'), h('button.btn.primary', { type: 'button', onclick: () => { commit(true); closePop(); } }, isNew ? 'Add' : 'Done')),
        h('button', { type: 'submit', hidden: true }));
      sync();
      openPop(content, anchor, () => commit(false));
      setTimeout(() => { if (isNew) title.focus(); }, 30);
    }

    /* -------------------------------------------- drawing */
    function draw() {
      // (redrawn in the same view: stay where it was scrolled to — once it has been placed at all)
      const prevSc = $('.cal-tg-scroll', main);
      const keepScroll = prevSc?.dataset.placed && prevSc.dataset.mode === mode ? prevSc.scrollTop : null;
      for (const b of $$('button', seg)) b.classList.toggle('on', b.dataset.m === mode);
      main.replaceChildren();
      const d = parseDay(cur);
      const [from, to] = range();
      const head = mode === 'month' ? h('h2', d.toLocaleDateString([], { month: 'long' }), ' ', h('span', String(d.getFullYear())))
        : mode === 'week' ? h('h2', parseDay(from).toLocaleDateString([], { month: 'long' }), ' ', h('span', parseDay(from).getMonth() === parseDay(to).getMonth() ? String(d.getFullYear()) : '– ' + parseDay(to).toLocaleDateString([], { month: 'long', year: 'numeric' })))
          : h('h2', d.toLocaleDateString([], { month: 'long', day: 'numeric' }), ' ', h('span', `${d.getFullYear()} · ${d.toLocaleDateString([], { weekday: 'long' })}`));
      main.append(h('div.cal-head', head));
      const box = h('div.cal-view.' + mode);
      main.append(box);
      if (mode === 'month') drawMonth(box);
      else {
        const days = mode === 'day' ? [cur] : Array.from({ length: 7 }, (_, i) => addDays(from, i));
        const sc = drawTimeGrid(box, days);
        sc.dataset.mode = mode;
        requestAnimationFrame(() => { sc.scrollTop = keepScroll ?? startScroll(days); sc.dataset.placed = '1'; });
      }
      win.setTitle(mode === 'month' ? d.toLocaleDateString([], { month: 'long', year: 'numeric' }) : d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }));
      drawSide();
    }
    // where the hours start: 8:00 (or two hours ago, on today), earlier when an event starts before that
    function startScroll(days) {
      const todayK = dayKey(new Date());
      let m = days.includes(todayK) ? Math.max(0, (new Date().getHours() - 2) * 60) : 8 * 60;
      const hide = hidden();
      for (const o of occurrences(days[0], days[days.length - 1])) {
        if (o.ev.allDay || hide.has(o.ev.cal) || o.days > 1) continue;
        m = Math.min(m, o.start.getHours() * 60 + o.start.getMinutes() - 30);
      }
      return Math.max(0, (m * HOUR) / 60);
    }
    const scrollToNow = () => requestAnimationFrame(() => { const sc = $('.cal-tg-scroll', main); if (sc) sc.scrollTop = startScroll(mode === 'day' ? [cur] : Array.from({ length: 7 }, (_, i) => addDays(range()[0], i))); });
    async function refreshJournal() { journal = (await api.journal?.index().catch(() => null))?.pages || []; }

    // show an event (from an alert, Journal, Reminders): its day, with its popover open
    function showEvent(id, day) {
      const ev = loadCalendar().events.find((x) => x.id === id);
      if (!ev) return;
      cur = day || ev.start;
      if (mode === 'month' && !day) mode = 'day';
      draw();
      requestAnimationFrame(() => eventEditor(ev, day || ev.start, $(`[data-ev="${id}"]`, main)));
    }
    const handleArgs = (a) => {
      if (!a) return;
      if (a.event) showEvent(a.event, a.day);
      else if (a.create) { cur = a.create.start || cur; draw(); requestAnimationFrame(() => openNewEvent(a.create)); }
      else if (a.day) { cur = a.day; draw(); }
    };

    // keys: ←/→ move, T today, D/W/M views, Ctrl+N a new event, Delete the open event
    win.el.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); openNewEvent(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'arrowleft') go(-1); else if (k === 'arrowright') go(1); else if (k === 't') today();
      else if (k === 'd') setMode('day'); else if (k === 'w') setMode('week'); else if (k === 'm') setMode('month');
      else return;
      e.preventDefault();
    });

    win.state = { get mode() { return mode; }, setMode, today, newEvent: () => openNewEvent(), newReminder: () => openNewReminder(), newCalendar };
    const redraw = () => { if (!win.el.isConnected || pop) return; draw(); };
    const offs = [bus.on('calendar', redraw), bus.on('reminders', redraw),
      store.on('change:calShowReminders', redraw), store.on('change:calHidden', redraw)];
    // Journal's pages change in another window: look again when this one comes to the front
    let jrSeen = '';
    win.on('focus', async () => {
      await refreshJournal();
      const k = JSON.stringify(journal.map((p) => [p.id, p.title, p.event]));
      if (k !== jrSeen) { jrSeen = k; redraw(); }
    });
    win.on('close', () => offs.forEach((f) => f?.()));
    win.on('reopen', handleArgs);
    // the time line moves; a new day starts
    const tick = setInterval(() => { if (!win.el.isConnected) return clearInterval(tick); const n = $('.cal-now', main); if (n) { const t = new Date(); n.style.top = ((t.getHours() * 60 + t.getMinutes()) * HOUR) / 60 + 'px'; } }, 60_000);

    refreshJournal().then(() => { draw(); handleArgs(args); });
    draw();
  },
});
