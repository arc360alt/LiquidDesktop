// Clock's data (world clocks, alarms, timers, the stopwatch) and the part that rings: initClockAlerts runs in the
// shell, so alarms and timers go off with the Clock app closed. Everything is kept in appData ('clock'), which all
// windows share, so the app and the shell see each other's changes.
import { appData } from './store.js';
import { bus } from './util.js';

export const uid = () => Math.random().toString(36).slice(2, 10);
const BLANK = () => ({ cities: [], alarms: [], timers: [], stopwatch: { startedAt: null, acc: 0, laps: [] } });

export function loadClock() {
  const d = appData.get('clock', null) || BLANK();
  d.cities ||= []; d.alarms ||= []; d.timers ||= []; d.stopwatch ||= { startedAt: null, acc: 0, laps: [] };
  return d;
}
export function editClock(fn) { const d = loadClock(); fn(d); appData.set('clock', d); bus.emit('clock'); return d; }

/* ------------------------------------------------ time zones */
export const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
/** "America/Argentina/Buenos_Aires" → "Buenos Aires" */
export const cityOf = (tz) => (tz.split('/').pop() || tz).replace(/_/g, ' ');
export const regionOf = (tz) => { const p = tz.split('/'); return p.length > 1 ? p[0].replace(/_/g, ' ') : ''; };
export function allZones() {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Australia/Sydney']; }
}
/** The wall-clock parts of `date` in a time zone. */
export function partsIn(tz, date = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, m: +o.minute, s: +o.second };
}
/** Minutes a zone is ahead of this computer's own time (negative: behind). */
export function offsetMinutes(tz, date = new Date()) {
  const a = partsIn(tz, date), b = partsIn(LOCAL_TZ, date);
  return Math.round((Date.UTC(a.y, a.mo - 1, a.d, a.h, a.m) - Date.UTC(b.y, b.mo - 1, b.d, b.h, b.m)) / 60000);
}
export function offsetText(tz) {
  const m = offsetMinutes(tz);
  const day = (() => { const a = partsIn(tz), b = partsIn(LOCAL_TZ); const da = Date.UTC(a.y, a.mo - 1, a.d), db = Date.UTC(b.y, b.mo - 1, b.d); return da > db ? 'Tomorrow' : da < db ? 'Yesterday' : 'Today'; })();
  if (!m) return `${day}, same time`;
  const hrs = Math.abs(m) / 60;
  return `${day}, ${m > 0 ? '+' : '−'}${Number.isInteger(hrs) ? hrs : hrs.toFixed(1)} hr${hrs === 1 ? '' : 's'}`;
}

/* ------------------------------------------------ formatting */
const use24 = () => { try { return !/[ap]m/i.test(new Date(2020, 0, 1, 15).toLocaleTimeString()); } catch { return false; } };
export function fmtClock(h, m, { seconds = null } = {}) {
  if (use24()) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}${seconds != null ? ':' + String(seconds).padStart(2, '0') : ''}`;
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, '0')}${seconds != null ? ':' + String(seconds).padStart(2, '0') : ''}`;
}
export const ampm = (h) => (use24() ? '' : h < 12 ? 'AM' : 'PM');
/** 3723.4 s → "1:02:03" (or "02:03.40" with hundredths) */
export function fmtDuration(ms, hundredths = false) {
  ms = Math.max(0, ms);
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  if (hundredths) return `${h ? h + ':' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(Math.floor((ms % 1000) / 10)).padStart(2, '0')}`;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function repeatText(days) {
  const d = [...(days || [])].sort();
  if (!d.length) return 'Never';
  if (d.length === 7) return 'Every day';
  if (d.join() === '1,2,3,4,5') return 'Weekdays';
  if (d.join() === '0,6') return 'Weekends';
  return d.map((i) => DAYS[i]).join(' ');
}

/* ------------------------------------------------ timers */
export const timerLeft = (t, now = Date.now()) => (t.endsAt ? t.endsAt - now : t.remaining ?? t.total);
export function startTimer(total, label = '') { const t = { id: uid(), label, total, endsAt: Date.now() + total, remaining: null }; editClock((d) => d.timers.push(t)); return t; }

/** When an alarm next goes off (ms), from `now`. Alarms are at local time. */
export function nextAlarm(a, now = new Date()) {
  const [hh, mm] = a.time.split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, hh, mm, 0, 0);
    if (t <= now) continue;
    if (!a.days?.length || a.days.includes(t.getDay())) return t.getTime();
  }
  return null;
}

/* ------------------------------------------------ the sound */
// A bright two-note chime, made with Web Audio (no sound files needed), repeated until stopped.
let ctx = null;
const ringing = new Map();   // key → interval
function chime() {
  try {
    ctx ||= new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const t0 = ctx.currentTime;
    [[880, 0], [1318.5, 0.16], [880, 0.5], [1318.5, 0.66]].forEach(([f, at]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + at); g.gain.linearRampToValueAtTime(0.28, t0 + at + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.9);
      o.connect(g).connect(ctx.destination); o.start(t0 + at); o.stop(t0 + at + 1);
    });
  } catch { /* no audio */ }
}
export function ring(key, maxMs = 120000) {
  stopRing(key);
  chime();
  const iv = setInterval(chime, 1600);
  ringing.set(key, iv);
  setTimeout(() => stopRing(key), maxMs);
}
export function stopRing(key) { const iv = ringing.get(key); if (iv) { clearInterval(iv); ringing.delete(key); } }
/** A short chime once (Settings previews, the Clock app's test). */
export const chimeOnce = () => chime();

/* ------------------------------------------------ alerts (the shell) */
export function initClockAlerts(notify) {
  let lastMinute = '';
  const fired = appData.get('clockFired', {});
  const check = () => {
    const now = new Date();
    const d = loadClock();
    // timers: the moment they reach zero
    for (const t of d.timers) {
      if (!t.endsAt || t.endsAt > now.getTime() || fired['t' + t.id] === t.endsAt) continue;
      fired['t' + t.id] = t.endsAt; appData.set('clockFired', fired);
      const late = now.getTime() - t.endsAt > 10 * 60000;
      editClock((x) => { const y = x.timers.find((z) => z.id === t.id); if (y) { y.endsAt = null; y.remaining = y.total; y.done = Date.now(); } });
      if (late) continue;
      const key = 'timer:' + t.id;
      ring(key);
      notify({ app: 'clock', urgent: true, title: t.label || 'Timer', body: 'Time’s up.', timeout: 0,
        actions: [{ key: 'stop', label: 'Stop' }, { key: 'repeat', label: 'Repeat' }],
        onAction: (k) => { stopRing(key); if (k === 'repeat') editClock((x) => { const y = x.timers.find((z) => z.id === t.id); if (y) { y.endsAt = Date.now() + y.total; y.remaining = null; } }); },
        onDismiss: () => stopRing(key),
        action: () => { stopRing(key); import('./wm.js').then(({ wm }) => wm.activate('clock', { tab: 'timers' })); } });
    }
    // alarms: once a minute, at :00
    const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
    if (minute !== lastMinute) {
      lastMinute = minute;
      const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      for (const a of d.alarms) {
        const snoozed = a.snoozeUntil && a.snoozeUntil <= now.getTime() && a.snoozeUntil > now.getTime() - 60000;
        const due = a.on && a.time === hm && (!a.days?.length || a.days.includes(now.getDay()));
        if (!due && !snoozed) continue;
        if (fired['a' + a.id] === minute) continue;
        fired['a' + a.id] = minute; appData.set('clockFired', fired);
        // a one-time alarm turns itself off once it has rung
        editClock((x) => { const y = x.alarms.find((z) => z.id === a.id); if (!y) return; if (snoozed) y.snoozeUntil = null; if (!y.days?.length && !snoozed) y.on = false; });
        const key = 'alarm:' + a.id;
        ring(key, 5 * 60000);
        notify({ app: 'clock', urgent: true, title: a.label || 'Alarm', body: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), timeout: 0,
          actions: [{ key: 'stop', label: 'Stop' }, ...(a.snooze !== false ? [{ key: 'snooze', label: 'Snooze (9 min)' }] : [])],
          onAction: (k) => { stopRing(key); if (k === 'snooze') editClock((x) => { const y = x.alarms.find((z) => z.id === a.id); if (y) y.snoozeUntil = Date.now() + 9 * 60000 - (Date.now() % 60000); }); },
          onDismiss: () => stopRing(key),
          action: () => { stopRing(key); import('./wm.js').then(({ wm }) => wm.activate('clock', { tab: 'alarms' })); } });
      }
    }
  };
  setInterval(check, 1000);
  setTimeout(check, 3000);
}
