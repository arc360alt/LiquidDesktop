// Reminders' data, shared by the Reminders app, Calendar (reminders show on their day), the widgets and the alerts.
// Kept in appData 'reminders' (localStorage, shared by every window of the desktop):
//   { lists: [{ id, name, color }], items: [{ id, list, title, notes, url, due: 'YYYY-MM-DD'|null, time: 'HH:MM'|null,
//     flagged, priority: 0–3, done: ms|null, created: ms }] }
// Alerts run in the shell (initReminderAlerts): at the reminder's time, or at 9:00 on its day when it has no time.
import { appData, store } from './store.js';
import { bus } from './util.js';

export const COLORS = ['#0a84ff', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#5ac8fa', '#af52de', '#ff2d55', '#a2845e', '#8e8e93'];
const KEY = 'reminders';
const FIRST = () => ({ lists: [{ id: 'l1', name: 'Reminders', color: '#0a84ff' }], items: [] });

export function loadReminders() {
  const d = appData.get(KEY, null) || FIRST();
  if (!d.lists?.length) d.lists = FIRST().lists;
  d.items ||= [];
  return d;
}
export function saveReminders(d) { appData.set(KEY, d); bus.emit('reminders'); }
/** Change the data and save it (always reads the newest copy first: another window may have changed it). */
export function editReminders(fn) { const d = loadReminders(); const r = fn(d); saveReminders(d); return r; }
// other windows (the app, Calendar, widgets on the desktop) changed it
addEventListener('storage', (e) => { if (e.key === 'liquid.app.' + KEY) bus.emit('reminders'); });

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const todayKey = () => dayKey(new Date());
const parseDay = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
/** When it's due, as a time (a reminder without a time counts from the start of its day). */
export const dueAt = (it) => (it.due ? (() => { const d = parseDay(it.due); if (it.time) { const [hh, mm] = it.time.split(':').map(Number); d.setHours(hh, mm); } return d.getTime(); })() : null);
export const isOverdue = (it) => !it.done && it.due && (it.time ? dueAt(it) < Date.now() : it.due < todayKey());

/** "Today", "Tomorrow", "Yesterday", "Friday", "Mar 4" — plus the time. */
export function dueText(it) {
  if (!it.due) return '';
  const d = parseDay(it.due), t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((d - t) / 864e5);
  const day = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : diff > 1 && diff < 7 ? d.toLocaleDateString([], { weekday: 'long' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== t.getFullYear() ? { year: 'numeric' } : {}) });
  return it.time ? `${day}, ${fmtTime(it.time)}` : day;
}
export function fmtTime(hm) {
  const [hh, mm] = hm.split(':').map(Number);
  const d = new Date(); d.setHours(hh, mm, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !store.get('clock24') });
}

/**
 * Natural-language dates in a new reminder's title, like the Mac: "Call Sam tomorrow at 5pm", "Pay rent on friday",
 * "Dentist march 3 at 9:30", "Water plants in 3 days", "Report next week". Returns { title, due, time } with the
 * date words taken out of the title (left alone when nothing matched).
 */
export function parseQuick(text) {
  let s = ' ' + text.trim() + ' ';
  let due = null, time = null;
  const now = new Date();
  const set = (d) => { due = dayKey(d); };
  const take = (re, fn) => { const m = s.match(re); if (m) { if (fn(m) !== false) s = s.replace(m[0], ' '); } };
  // a time: "at 5", "at 5pm", "at 17:30", "5:30pm", "noon"
  take(/\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s/i, (m) => { let hh = +m[1] % 12; if (/pm/i.test(m[3])) hh += 12; if (+m[1] > 12) return false; time = `${String(hh).padStart(2, '0')}:${m[2] || '00'}`; });
  if (!time) take(/\sat\s+(\d{1,2})(?::(\d{2}))?\s/i, (m) => { let hh = +m[1]; if (hh > 23) return false; if (hh < 7 && !m[2]) hh += 12; time = `${String(hh).padStart(2, '0')}:${m[2] || '00'}`; });
  if (!time) take(/\s(?:at\s+)?(\d{1,2}):(\d{2})\s/i, (m) => { if (+m[1] > 23) return false; time = `${m[1].padStart(2, '0')}:${m[2]}`; });
  take(/\s(?:at\s+)?(noon|midday)\s/i, () => { time = '12:00'; });
  take(/\s(?:this\s+)?(morning)\s/i, () => { time ||= '09:00'; });
  take(/\s(?:this\s+)?(evening|tonight)\s/i, () => { time ||= '18:00'; if (!due) set(now); });
  // a day
  take(/\s(today)\s/i, () => set(now));
  take(/\s(tomorrow|tmrw)\s/i, () => { const d = new Date(now); d.setDate(d.getDate() + 1); set(d); });
  take(/\sin\s+(\d{1,3})\s+(day|days|week|weeks)\s/i, (m) => { const d = new Date(now); d.setDate(d.getDate() + +m[1] * (/week/i.test(m[2]) ? 7 : 1)); set(d); });
  take(/\s(next\s+week)\s/i, () => { const d = new Date(now); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); set(d); });
  const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  // whole day names ("sat" alone is more often a word than Saturday)
  take(/\s(?:on\s+|next\s+|this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s/i, (m) => {
    const i = DOW.indexOf(m[1].toLowerCase());
    if (i < 0) return false;
    const d = new Date(now); d.setDate(d.getDate() + ((i - d.getDay() + 7) % 7 || 7)); set(d);
  });
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  take(/\s(?:on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\s/i, (m) => {
    const mo = MON.indexOf(m[1].toLowerCase().slice(0, 3));
    const d = new Date(m[3] ? +m[3] : now.getFullYear(), mo, +m[2]);
    if (!m[3] && d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d.setFullYear(d.getFullYear() + 1);
    set(d);
  });
  // a time without a day: today if it's still ahead, else tomorrow
  if (time && !due) { const d = new Date(now); const [hh, mm] = time.split(':').map(Number); d.setHours(hh, mm, 0, 0); if (d < now) d.setDate(d.getDate() + 1); set(d); }
  const title = s.replace(/\s+/g, ' ').trim().replace(/\s+(on|at|by)$/i, '');
  if (!due) return { title: text.trim(), due: null, time: null };
  return { title: title || text.trim(), due, time };
}

/** The smart lists' contents (Today counts what's overdue too, like the Mac). */
export const SMART = {
  today: { name: 'Today', color: '#0a84ff', test: (it) => !it.done && !!it.due && it.due <= todayKey() },
  scheduled: { name: 'Scheduled', color: '#ff3b30', test: (it) => !it.done && !!it.due },
  all: { name: 'All', color: '#5b5b60', test: (it) => !it.done },
  flagged: { name: 'Flagged', color: '#ff9500', test: (it) => !it.done && !!it.flagged },
  completed: { name: 'Completed', color: '#8e8e93', test: (it) => !!it.done },
};
export const sortItems = (list) => list.slice().sort((a, b) => (!!a.done - !!b.done) || ((dueAt(a) ?? 9e15) - (dueAt(b) ?? 9e15)) || (b.priority || 0) - (a.priority || 0) || a.created - b.created);

export function toggleDone(id) {
  return editReminders((d) => { const it = d.items.find((x) => x.id === id); if (it) it.done = it.done ? null : Date.now(); return it; });
}

/* ------------------------------------------------------------------ alerts (the shell) */
// Each reminder alerts once per due time: fired[id] = the due time it alerted for, so moving the time alerts again.
export function initReminderAlerts(notify) {
  const check = () => {
    const d = loadReminders();
    const fired = appData.get('remindersFired', {});
    const now = Date.now();
    let changed = false;
    for (const it of d.items) {
      if (it.done || !it.due) continue;
      const at = it.time ? dueAt(it) : dueAt(it) + 9 * 3600e3;   // all-day reminders at 9:00
      if (at > now || fired[it.id] === at) continue;
      fired[it.id] = at; changed = true;
      if (now - at > 6 * 3600e3) continue;   // long past (the computer was off): no late pile of alerts
      const list = d.lists.find((l) => l.id === it.list);
      notify({ app: 'reminders', title: it.title || 'Reminder', body: [it.notes, list && d.lists.length > 1 ? list.name : null].filter(Boolean).join(' — ') || dueText(it), timeout: 0,
        actions: [{ key: 'done', label: 'Mark as Completed' }, { key: 'later', label: 'Remind Me in 1 Hour' }],
        onAction: (k) => {
          if (k === 'done') toggleDone(it.id);
          if (k === 'later') editReminders((x) => { const r = x.items.find((y) => y.id === it.id); if (!r) return; const t = new Date(Date.now() + 3600e3); r.due = dayKey(t); r.time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; });
        },
        action: () => import('./wm.js').then(({ wm }) => wm.activate('reminders', { item: it.id })) });
    }
    // forget reminders that are gone
    for (const id of Object.keys(fired)) if (!d.items.some((x) => x.id === id)) { delete fired[id]; changed = true; }
    if (changed) appData.set('remindersFired', fired);
  };
  setTimeout(check, 4000);
  // on the minute (and when something changes, a new time could be due now)
  setInterval(check, 20_000);
  bus.on('reminders', () => setTimeout(check, 500));
}
