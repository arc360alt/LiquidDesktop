// Settings › Screen Time: today or the last 7 days — total, a bar chart, the apps you used most, notifications,
// and App Limits. The numbers come from screentime.js (counted by the shell).
import { h, bus } from '../util.js';
import { appIcon } from '../icons.js';
import { store } from '../store.js';
import { alertDialog, confirmDialog } from '../menus.js';
import { appData } from '../store.js';
import { catalog } from '../catalog.js';
import { loadScreenTime, fmtDur, appFor, dayKey } from '../screentime.js';

let mode = 'day', dayOffset = 0;   // the day shown (0 today, 1 yesterday…), kept while Settings is open

export async function screenTimePane({ row, hero, rerender }) {
  bus.emit('screentime-flush');   // the testing window counts in this page: save what's counted so far
  const st = loadScreenTime();
  const on = store.get('screenTime') !== false;
  const days = (n, from = 0) => Array.from({ length: n }, (_, i) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - from - (n - 1 - i)); return d; });
  const rec = (d) => st.days[dayKey(d)] || { apps: {}, hours: Array(24).fill(0), notifs: {} };
  const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
  const shownDays = mode === 'day' ? [days(1, dayOffset)[0]] : days(7);
  const apps = {}, notifs = {};
  for (const d of shownDays) { const r = rec(d); for (const [k, v] of Object.entries(r.apps)) apps[k] = (apps[k] || 0) + v; for (const [k, v] of Object.entries(r.notifs || {})) notifs[k] = (notifs[k] || 0) + v; }
  const total = sum(apps);

  // the chart: hours of the day, or the last 7 days
  const bars = mode === 'day' ? rec(shownDays[0]).hours.map((s, i) => ({ s, label: i % 6 === 0 ? new Date(2000, 0, 1, i).toLocaleTimeString([], { hour: 'numeric' }) : '' }))
    : shownDays.map((d) => ({ s: sum(rec(d).apps), label: d.toLocaleDateString([], { weekday: 'narrow' }), today: dayKey(d) === dayKey() }));
  const max = Math.max(mode === 'day' ? 900 : 3600, ...bars.map((b) => b.s));
  const avg = mode === 'week' ? total / 7 : 0;
  const scaleTop = mode === 'day' ? [15, 30, 60].find((m) => m * 60 >= max) || 60 : Math.ceil(max / 3600);
  const chart = h('div.st-chart' + (mode === 'week' ? '.week' : ''),
    h('div.st-bars', ...bars.map((b) => h('div.st-bar' + (b.today ? '.today' : ''), { title: fmtDur(b.s) },
      h('i', { style: { height: Math.max(b.s ? 2 : 0, (b.s / (mode === 'day' ? scaleTop * 60 : scaleTop * 3600)) * 100) + '%' } }), h('small', b.label)))),
    avg ? h('div.st-avg', { style: { bottom: (18 + Math.min(1, avg / (scaleTop * 3600)) * 112) + 'px' } }, h('span', 'avg')) : null,
    h('div.st-scale', h('small', mode === 'day' ? `${scaleTop}m` : `${scaleTop}h`), h('small', '0')));
  const dayName = (d) => (dayKey(d) === dayKey() ? 'Today' : dayOffset === 1 ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }));
  const nav = mode === 'day' ? h('div.st-nav',
    h('button.btn.plain', { disabled: dayOffset >= 34, onclick: () => { dayOffset++; rerender(); } }, '‹'),
    h('button.btn.plain', { disabled: dayOffset === 0, onclick: () => { dayOffset--; rerender(); } }, '›')) : null;
  const summary = h('div.group.st-summary',
    h('div.st-top', h('div', h('small', mode === 'day' ? dayName(shownDays[0]) : 'Daily Average'), h('div.st-total', fmtDur(mode === 'day' ? total : avg))),
      mode === 'week' ? h('div.st-side', h('small', 'Total'), h('b', fmtDur(total))) : nav),
    chart);

  // most used
  const limits = store.get('screenLimits') || {};
  const ranked = Object.entries(apps).sort((a, b) => b[1] - a[1]);
  const top = ranked[0]?.[1] || 1;
  const appRow = ([id, s]) => {
    const a = appFor(id, st.names);
    return h('div.row.st-app', appIcon(a, 'st-ic'),
      h('div.label', h('span', a.name), h('div.st-meter', h('i', { style: { width: (s / top) * 100 + '%' } }))),
      limits[id] ? h('span.st-limit', { title: 'Daily limit' }, fmtDur(limits[id] * 60)) : null,
      h('span.muted.st-time', fmtDur(s)));
  };
  const used = ranked.length ? ranked.slice(0, 12).map(appRow) : [row(h('span.muted', on ? 'Nothing yet — use some apps and come back.' : 'Screen Time is off.'), null)];
  const notifRows = Object.entries(notifs).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, n]) => {
    const a = appFor(id, st.names);
    return h('div.row.st-app', appIcon(a, 'st-ic'), h('div.label', a.name), h('span.muted', `${n}`));
  });

  // App Limits
  const limitRows = Object.entries(limits).map(([id, min]) => {
    const a = appFor(id, st.names);
    return h('div.row.st-app', appIcon(a, 'st-ic'), h('div.label', a.name, h('small', `${fmtDur((st.days[dayKey()]?.apps[id]) || 0)} used today`)),
      h('select.field.square', { style: { height: '26px' }, onchange: (e) => { store.set('screenLimits', { ...store.get('screenLimits'), [id]: +e.target.value }); rerender(); } },
        ...LIMITS.map((m) => h('option', { value: m, selected: m === min }, fmtDur(m * 60) + ' a day'))),
      h('button.btn', { onclick: () => { const l = { ...store.get('screenLimits') }; delete l[id]; store.set('screenLimits', l); rerender(); } }, 'Remove'));
  });
  const addLimit = async () => {
    // apps you used lately first, then every app
    const recent = Object.keys(apps);
    const all = [...new Set([...recent, ...catalog.all().map((a) => a.id)])].filter((id) => !limits[id]).map((id) => appFor(id, st.names));
    const appSel = h('select.field.square', { style: { width: '100%', height: '28px' } }, ...all.map((a) => h('option', { value: a.id }, a.name)));
    const minSel = h('select.field.square', { style: { width: '100%', height: '28px', marginTop: '8px' } }, ...LIMITS.map((m) => h('option', { value: m, selected: m === 60 }, fmtDur(m * 60) + ' a day')));
    const r = await alertDialog({ title: 'Add App Limit', message: 'When you reach the limit, Screen Time tells you, and puts the app away if Block at End of Limit is on.', content: h('div', { style: { width: '100%' } }, appSel, minSel),
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Add', value: 'ok', primary: true }] });
    if (r !== 'ok' && r?.button !== 'ok') return;
    store.set('screenLimits', { ...store.get('screenLimits'), [appSel.value]: +minSel.value });
    rerender();
  };

  const segBtn = (v, l) => h('button' + (mode === v ? '.on' : ''), { onclick: () => { mode = v; dayOffset = 0; rerender(); } }, l);
  return [
    hero('screentime', 'Screen Time', 'See how much time you spend in apps, how many notifications they send, and set daily limits.'),
    h('div.st-seg', h('div.segmented', segBtn('day', 'Day'), segBtn('week', 'Week'))),
    summary,
    h('div.group-title', 'Most Used'), h('div.group', ...used),
    notifRows.length ? h('div.group-title', 'Notifications') : null, notifRows.length ? h('div.group', ...notifRows) : null,
    h('div.group-title', 'App Limits'),
    h('div.group', ...limitRows, row(limitRows.length ? '' : h('span.muted', 'No limits'), h('button.btn', { onclick: addLimit }, 'Add Limit…')),
      row('Block at End of Limit', h('label.toggle', h('input', { type: 'checkbox', checked: store.get('screenLimitBlock') !== false, onchange: (e) => store.set('screenLimitBlock', e.target.checked) }), h('span')), 'Put the app away when it comes to the front after its limit, until you choose Ignore.')),
    h('div.group-title', 'Options'),
    h('div.group',
      row('Screen Time', h('label.toggle', h('input', { type: 'checkbox', checked: on, onchange: (e) => { store.set('screenTime', e.target.checked); rerender(); } }), h('span')), 'Kept only on this computer.'),
      row('Clear Screen Time history', h('button.btn', { onclick: async () => { if (await confirmDialog('Clear Screen Time history?', 'Your app usage and notification counts are deleted. Limits are kept.', 'Clear', { danger: true })) { appData.set('screentime', { days: {}, names: {} }); rerender(); } } }, 'Clear…'))),
  ];
}
const LIMITS = [5, 15, 30, 45, 60, 90, 120, 180, 240, 360];
