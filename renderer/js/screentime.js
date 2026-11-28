// Screen Time: how long each app is in front, per day and hour, plus how many notifications each sent; App Limits.
// Runs in the shell (initScreenTime). Counted in 5-second steps for the focused window's app, and not while you're
// away (no keyboard or mouse for 5 minutes, unless a window is full screen — a film) or the screen is locked.
// Kept in appData 'screentime' (35 days): { days: { 'YYYY-MM-DD': { apps: { id: s }, hours: [24 × s], notifs: { id: n } } },
//   names: { id: { name, icon } } } — names so apps you've since removed still show in the history.
import { appData, store } from './store.js';
import { api } from './sys.js';
import { bus } from './util.js';
import { wm, registry } from './wm.js';
import { catalog } from './catalog.js';

const KEY = 'screentime', STEP = 5, AWAY = 300, KEEP_DAYS = 35;
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const loadScreenTime = () => { const d = appData.get(KEY, null) || {}; d.days ||= {}; d.names ||= {}; return d; };
export const stEnabled = () => store.get('screenTime') !== false;

/** "2h 5m", "14m", "< 1m". */
export function fmtDur(s, short = false) {
  s = Math.round(s || 0);
  if (s < 60) return s ? (short ? '<1m' : '< 1m') : '0m';
  const hrs = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return hrs ? `${hrs}h${m ? ` ${m}m` : ''}` : `${m}m`;
}
/** The app behind an id (built in, installed, or remembered), for its name and icon. */
export function appFor(id, names = loadScreenTime().names) {
  return catalog.find(id) || (names[id] ? { id, name: names[id].name, icon: names[id].icon || null, builtin: false } : { id, name: id.replace(/^(desktop:|x11:)/, ''), builtin: false });
}

let pending = { apps: {}, hours: {}, notifs: {} }, pendingNames = {}, started = false;
function flush() {
  const keys = Object.keys(pending.apps).length + Object.keys(pending.notifs).length;
  if (!keys) return;
  const d = loadScreenTime();
  for (const [day, apps] of Object.entries(pending.apps)) {
    const rec = (d.days[day] ||= { apps: {}, hours: Array(24).fill(0), notifs: {} });
    for (const [id, s] of Object.entries(apps)) rec.apps[id] = (rec.apps[id] || 0) + s;
    for (const [hr, s] of Object.entries(pending.hours[day] || {})) rec.hours[hr] = (rec.hours[hr] || 0) + s;
  }
  for (const [day, n] of Object.entries(pending.notifs)) {
    const rec = (d.days[day] ||= { apps: {}, hours: Array(24).fill(0), notifs: {} });
    for (const [id, c] of Object.entries(n)) rec.notifs[id] = (rec.notifs[id] || 0) + c;
  }
  Object.assign(d.names, pendingNames);
  // only the last few weeks
  const cut = dayKey(new Date(Date.now() - KEEP_DAYS * 864e5));
  for (const k of Object.keys(d.days)) if (k < cut) delete d.days[k];
  appData.set(KEY, d);
  pending = { apps: {}, hours: {}, notifs: {} }; pendingNames = {};
  bus.emit('screentime');
}
/** Today's seconds for an app, saved and not yet saved. */
export function todaySecs(id) {
  const k = dayKey();
  return (loadScreenTime().days[k]?.apps[id] || 0) + (pending.apps[k]?.[id] || 0);
}

export function initScreenTime() {
  if (started) return;
  started = true;
  const remember = (app) => {
    if (!app?.id || registry.get(app.id)) return;   // built-in apps are always known
    pendingNames[app.id] = { name: app.name, icon: typeof app.icon === 'string' ? app.icon : null };
  };
  setInterval(async () => {
    if (!stEnabled()) return;
    const { shell } = await import('./shell.js');
    if (shell.locked) return;
    const w = wm.focused;
    if (!w?.app?.id || w.minimized) return;
    let idle = 0;
    try { idle = await api.sys.idleTime(); } catch { idle = 0; }
    if (idle > AWAY && !w.fullscreen) return;
    const k = dayKey(), hr = new Date().getHours(), id = w.app.id;
    (pending.apps[k] ||= {})[id] = (pending.apps[k][id] || 0) + STEP;
    (pending.hours[k] ||= {})[hr] = (pending.hours[k][hr] || 0) + STEP;
    remember(w.app);
    checkLimit(w, id);
  }, STEP * 1000);
  bus.on('notified', (n) => {
    if (!stEnabled()) return;
    const id = n.app || (n.appName ? 'name:' + n.appName : null);
    if (!id || n.app === 'screentime') return;
    const k = dayKey();
    (pending.notifs[k] ||= {})[id] = (pending.notifs[k][id] || 0) + 1;
    if (!n.app && n.appName) pendingNames[id] = { name: n.appName, icon: typeof n.icon === 'string' && n.icon.startsWith('file://') ? n.icon.slice(7) : null };
  });
  setInterval(flush, 60_000);
  addEventListener('beforeunload', flush);
  bus.on('screentime-flush', flush);
}

/* ------------------------------------------------------------------ App Limits */
// store 'screenLimits': { appId: minutes a day }. At the limit: a notification, and (Block at End of Limit, on by
// default) the app's windows are put away whenever it comes to the front, until you ignore the limit.
const warned = {}, ignored = {};   // appId → day warned / ms ignored until
let lastBlock = 0;
function checkLimit(w, id) {
  const lim = (store.get('screenLimits') || {})[id];
  if (!lim) return;
  const used = todaySecs(id), k = dayKey();
  if (ignored[id] && (ignored[id] === k || ignored[id] > Date.now())) return;
  const name = w.app.name || id;
  if (used >= lim * 60 - 300 && used < lim * 60 && warned[id] !== k + ':5') {
    warned[id] = k + ':5';
    import('./notifications.js').then(({ notify }) => notify({ app: 'screentime', appName: 'Screen Time', title: 'Time Limit', body: `5 minutes left on ${name} today.` }));
  }
  if (used < lim * 60) return;
  const first = warned[id] !== k;
  warned[id] = k;
  const block = store.get('screenLimitBlock') !== false;
  if (block && Date.now() - lastBlock > 4000) { lastBlock = Date.now(); for (const x of wm.windows.filter((y) => y.app?.id === id && !y.minimized)) x.minimize?.(); }
  if (first || block) {
    import('./notifications.js').then(({ notify }) => notify({ app: 'screentime', appName: 'Screen Time', title: 'Time Limit', body: `You’ve reached your ${fmtDur(lim * 60)} limit on ${name} today.`, timeout: block ? 9000 : 0,
      actions: [{ key: '15', label: 'Ignore for 15 Minutes' }, { key: 'day', label: 'Ignore for Today' }],
      onAction: (key) => { ignored[id] = key === 'day' ? dayKey() : Date.now() + 15 * 60_000; } }));
  }
}
