// Calendar's data, shared by the Calendar app, the Up Next widget, Reminders (today's events) and Journal (pages
// linked to events), plus the alerts that run in the shell. Kept in appData 'calendarData' (shared by every window):
//   { calendars: [{ id, name, color }],
//     events: [{ id, cal, title, location, notes, url, allDay, start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' (the last day),
//       startTime: 'HH:MM'|null, endTime: 'HH:MM'|null, repeat: null|'daily'|'weekdays'|'weekly'|'biweekly'|'monthly'|'yearly',
//       repeatUntil: 'YYYY-MM-DD'|null, skip: ['YYYY-MM-DD'…] (occurrences deleted from a repeating event),
//       alert: minutes before|null, journal: Journal page id|null, created }] }
// (The first Calendar kept { 'YYYY-MM-DD': [{ title, time }] } in appData 'calendar': moved over once.)
import { appData } from './store.js';
import { bus } from './util.js';
import { api } from './sys.js';

const KEY = 'calendarData';
export const CAL_COLORS = ['#0a84ff', '#ff9500', '#34c759', '#ff3b30', '#af52de', '#ff2d55', '#5ac8fa', '#ffcc00', '#a2845e', '#8e8e93'];
const FIRST = () => ({ calendars: [{ id: 'home', name: 'Home', color: '#0a84ff' }, { id: 'work', name: 'Work', color: '#ff9500' }], events: [] });

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const parseDay = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (k, n) => { const d = parseDay(k); d.setDate(d.getDate() + n); return dayKey(d); };
export const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 864e5);
export const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
export const at = (k, t) => { const d = parseDay(k); if (t) { const [h, m] = t.split(':').map(Number); d.setHours(h, m, 0, 0); } return d; };

// "12:30", "5pm", "5:30 pm" (the first Calendar's free-text times) → "HH:MM"
function oldTime(t) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(String(t || '').trim());
  if (!m) return null;
  let h = +m[1];
  if (m[3]) h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0);
  return h < 24 ? `${String(h).padStart(2, '0')}:${m[2] || '00'}` : null;
}
export function loadCalendar() {
  let d = appData.get(KEY, null);
  if (!d) {
    d = FIRST();
    const old = appData.get('calendar', null);
    if (old && typeof old === 'object') {
      for (const [day, list] of Object.entries(old)) for (const e of list || []) {
        const t = oldTime(e.time);
        const end = t ? at(day, t) : null; end?.setHours(end.getHours() + 1);
        d.events.push({ id: uid(), cal: 'home', title: e.title || '', location: '', notes: e.time && !t ? `Time: ${e.time}` : '', url: '', allDay: !t, start: day, end: t ? dayKey(end) : day,
          startTime: t, endTime: t ? hm(end) : null, repeat: null, repeatUntil: null, skip: [], alert: null, journal: null, created: Date.now() });
      }
    }
    appData.set(KEY, d);
  }
  if (!d.calendars?.length) d.calendars = FIRST().calendars;
  d.events ||= [];
  return d;
}
export function saveCalendar(d) { appData.set(KEY, d); bus.emit('calendar'); }
/** Change the data and save it (the newest copy first: another window may have changed it). */
export function editCalendar(fn) { const d = loadCalendar(); const r = fn(d); saveCalendar(d); return r; }
addEventListener('storage', (e) => { if (e.key === 'liquid.app.' + KEY) bus.emit('calendar'); });

/** A new event: one hour from the next whole hour on this day, unless told otherwise. */
export function newEvent(o = {}) {
  const day = o.start || dayKey(new Date());
  let st = o.startTime, en = o.endTime;
  if (!o.allDay && !st) { const n = new Date(); st = `${String(Math.min(22, n.getHours() + 1)).padStart(2, '0')}:00`; }
  if (!o.allDay && !en) { const e = at(day, st); e.setHours(e.getHours() + 1); en = hm(e); }
  return { id: uid(), cal: o.cal || loadCalendar().calendars[0].id, title: o.title || '', location: '', notes: '', url: '', allDay: !!o.allDay,
    start: day, end: o.end || day, startTime: o.allDay ? null : st, endTime: o.allDay ? null : en, repeat: null, repeatUntil: null, skip: [], alert: null, journal: o.journal || null, created: Date.now() };
}

/* ------------------------------------------------------------------ repeating events */
export const REPEATS = [[null, 'Never'], ['daily', 'Every Day'], ['weekdays', 'Every Weekday'], ['weekly', 'Every Week'], ['biweekly', 'Every 2 Weeks'], ['monthly', 'Every Month'], ['yearly', 'Every Year']];
// the n-th occurrence's first day (null when that month or year has no such day: the 31st, Feb 29)
function nth(ev, n) {
  const s = parseDay(ev.start);
  switch (ev.repeat) {
    case 'daily': s.setDate(s.getDate() + n); return dayKey(s);
    case 'weekly': s.setDate(s.getDate() + 7 * n); return dayKey(s);
    case 'biweekly': s.setDate(s.getDate() + 14 * n); return dayKey(s);
    case 'monthly': { const d = new Date(s.getFullYear(), s.getMonth() + n, s.getDate()); return d.getDate() === s.getDate() ? dayKey(d) : null; }
    case 'yearly': { const d = new Date(s.getFullYear() + n, s.getMonth(), s.getDate()); return d.getMonth() === s.getMonth() ? dayKey(d) : null; }
    default: return n === 0 ? ev.start : null;
  }
}
/**
 * Every occurrence that touches the days from..to (inclusive): [{ ev, key (its first day), start: Date, end: Date,
 * days: number (how many days it spans) }], sorted by start.
 */
export function occurrences(from, to, d = loadCalendar()) {
  const out = [];
  for (const ev of d.events) {
    const span = Math.max(0, daysBetween(ev.start, ev.end));
    const push = (k) => {
      if (!k || ev.skip?.includes(k)) return;
      const last = addDays(k, span);
      if (last < from || k > to) return;
      const start = at(k, ev.allDay ? null : ev.startTime), end = at(last, ev.allDay ? null : ev.endTime);
      if (ev.allDay) end.setDate(end.getDate() + 1);
      out.push({ ev, key: k, start, end, days: span + 1 });
    };
    if (!ev.repeat) { push(ev.start); continue; }
    const until = ev.repeatUntil && ev.repeatUntil < to ? ev.repeatUntil : to;
    if (ev.repeat === 'weekdays') {
      // every Monday to Friday from its first day
      let k = ev.start < addDays(from, -span) ? addDays(from, -span) : ev.start;
      for (let i = 0; k <= until && i < 4000; i++, k = addDays(k, 1)) { const wd = parseDay(k).getDay(); if (wd > 0 && wd < 6) push(k); }
      continue;
    }
    // jump close to the range rather than walking from the first one (a daily event from years ago)
    const step = { daily: 1, weekly: 7, biweekly: 14, monthly: 28, yearly: 365 }[ev.repeat] || 1;
    let n = Math.max(0, Math.floor((daysBetween(ev.start, from) - span) / (step === 28 ? 31 : step === 365 ? 366 : step)) - 1);
    for (let i = 0; i < 4000; i++, n++) {
      const k = nth(ev, n);
      if (k && k > until) break;
      if (k == null && ev.repeat !== 'monthly' && ev.repeat !== 'yearly') break;
      push(k);
    }
  }
  return out.sort((a, b) => a.start - b.start || b.days - a.days);
}
export const calOf = (d, id) => d.calendars.find((c) => c.id === id) || d.calendars[0];

/* ------------------------------------------------------------------ alerts (the shell) */
export const ALERTS = [[null, 'None'], [0, 'At time of event'], [5, '5 minutes before'], [10, '10 minutes before'], [15, '15 minutes before'], [30, '30 minutes before'], [60, '1 hour before'], [120, '2 hours before'], [1440, '1 day before'], [2880, '2 days before']];
export function initCalendarAlerts(notify) {
  const check = () => {
    const d = loadCalendar(), now = Date.now(), today = dayKey(new Date());
    const fired = appData.get('calendarFired', {});
    let changed = false;
    for (const o of occurrences(addDays(today, -1), addDays(today, 3), d)) {
      if (o.ev.alert == null) continue;
      // all-day events: counted from 9:00 on their day
      const when = (o.ev.allDay ? o.start.getTime() + 9 * 3600e3 : o.start.getTime()) - o.ev.alert * 60e3;
      const id = `${o.ev.id}|${o.key}`;
      if (when > now || fired[id] === when) continue;
      fired[id] = when; changed = true;
      if (now - when > 3 * 3600e3) continue;   // long past (the computer was off)
      const time = o.ev.allDay ? 'All day' : o.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      notify({ app: 'calendar', title: o.ev.title || 'Event', body: [o.ev.alert ? `${time} · in ${o.ev.alert >= 1440 ? o.ev.alert / 1440 + ' day' + (o.ev.alert > 1440 ? 's' : '') : o.ev.alert >= 60 ? o.ev.alert / 60 + ' hour' + (o.ev.alert > 60 ? 's' : '') : o.ev.alert + ' minutes'}` : time, o.ev.location].filter(Boolean).join(' — '),
        timeout: 0, action: () => import('./wm.js').then(({ wm }) => wm.activate('calendar', { event: o.ev.id, day: o.key })) });
    }
    // forget alerts more than a week old
    for (const [k, v] of Object.entries(fired)) if (now - v > 7 * 864e5) { delete fired[k]; changed = true; }
    if (changed) appData.set('calendarFired', fired);
  };
  setTimeout(check, 5000);
  setInterval(check, 20_000);
  bus.on('calendar', () => setTimeout(check, 500));
}

/* ------------------------------------------------------------------ Journal */
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** "Friday, November 27 · 2:00 – 3:00 PM" */
export function whenText(ev, key = ev.start) {
  const s = at(key, ev.allDay ? null : ev.startTime);
  const day = s.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  if (ev.allDay) { const n = daysBetween(ev.start, ev.end); return n ? `${day} – ${parseDay(addDays(key, n)).toLocaleDateString([], { month: 'long', day: 'numeric' })}` : `${day} · All day`; }
  const e = at(addDays(key, daysBetween(ev.start, ev.end)), ev.endTime), t = (x) => x.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${t(s)} – ${t(e)}`;
}
/** A Journal page for an event (its title, when and where, and its notes on the page), linked both ways. */
export async function journalPageFor(ev, key = ev.start) {
  const id = uid();
  // (the page's own title is the event's, so the note starts with when and where)
  const html = `<p>${esc(whenText(ev, key))}${ev.location ? '<br>' + esc(ev.location) : ''}</p>${ev.notes ? '<p>' + esc(ev.notes).replace(/\n/g, '<br>') + '</p>' : ''}`;
  const now = Date.now();
  await api.journal.write(id, { id, title: ev.title || 'Event', created: now, updated: now, strokes: [], view: { x: 40, y: 90, z: 1 },
    items: [{ id: uid(), type: 'text', x: 0, y: 20, w: 420, h: 90, z: 1, data: { html } }] });
  const ix = await api.journal.index().catch(() => ({ pages: [] }));
  (ix.pages ||= []).push({ id, title: ev.title || 'Event', created: now, updated: now, color: calOf(loadCalendar(), ev.cal).color, event: ev.id, eventDay: key });
  await api.journal.setIndex(ix);
  editCalendar((d) => { const e = d.events.find((x) => x.id === ev.id); if (e) e.journal = id; });
  return id;
}
/** Mark a Journal page as belonging to an event (or to none: evId null), in Journal's index. */
export async function linkJournalPage(pageId, evId, day) {
  const ix = await api.journal?.index().catch(() => null);
  const p = ix?.pages?.find((x) => x.id === pageId);
  if (!p) return;
  if (evId) { p.event = evId; p.eventDay = day; } else { delete p.event; delete p.eventDay; }
  await api.journal.setIndex(ix);
}
/** Unlink an event's Journal page (the page stays). */
export async function unlinkJournal(evId) {
  let pageId = null;
  editCalendar((d) => { const e = d.events.find((x) => x.id === evId); if (e) { pageId = e.journal; e.journal = null; } });
  if (!pageId) return;
  const ix = await api.journal.index().catch(() => null);
  const p = ix?.pages?.find((x) => x.id === pageId);
  if (p) { delete p.event; delete p.eventDay; await api.journal.setIndex(ix); }
}
