// Clock — World Clock, Alarms, Stopwatch and Timers, like the Mac's. Alarms and timers ring from the shell
// (renderer/js/clock.js), so they go off with this window closed; the stopwatch keeps running too.
import { h, $ } from '../util.js';
import { registerApp } from '../wm.js';
import { sym } from '../icons.js';
import { bus } from '../util.js';
import { contextMenu, alertDialog } from '../menus.js';
import { loadClock, editClock, uid, LOCAL_TZ, cityOf, regionOf, allZones, partsIn, offsetText, fmtClock, ampm, fmtDuration, repeatText, timerLeft, startTimer, nextAlarm, chimeOnce } from '../clock.js';

const TABS = [['world', 'World Clock'], ['alarms', 'Alarms'], ['stopwatch', 'Stopwatch'], ['timers', 'Timers']];
const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const PRESETS = [[60, '1 min'], [180, '3 min'], [300, '5 min'], [600, '10 min'], [900, '15 min'], [1800, '30 min'], [3600, '1 hr']];
const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>';

/** An analog clock face (dark at night, like the Mac's). */
function face(p, size = 96) {
  const night = p.h < 6 || p.h >= 18;
  const ha = ((p.h % 12) + p.m / 60) * 30, ma = (p.m + p.s / 60) * 6, sa = p.s * 6;
  const ticks = Array.from({ length: 60 }, (_, i) => `<path d="M50 ${i % 5 ? 7 : 6}v${i % 5 ? 2.2 : 5}" stroke-width="${i % 5 ? 0.8 : 2}" transform="rotate(${i * 6} 50 50)"/>`).join('');
  const nums = Array.from({ length: 12 }, (_, i) => { const a = ((i + 1) * 30 - 90) * Math.PI / 180; return `<text x="${(50 + 33 * Math.cos(a)).toFixed(1)}" y="${(50 + 33 * Math.sin(a) + 4.3).toFixed(1)}">${i + 1}</text>`; }).join('');
  return `<svg class="ck-face${night ? ' night' : ''}" viewBox="0 0 100 100" width="${size}" height="${size}">
    <circle cx="50" cy="50" r="48" class="ck-dial"/><g class="ck-ticks">${ticks}</g><g class="ck-nums">${nums}</g>
    <path d="M50 52V27" class="ck-hand" stroke-width="4" transform="rotate(${ha} 50 50)"/>
    <path d="M50 52V12" class="ck-hand" stroke-width="2.6" transform="rotate(${ma} 50 50)"/>
    <path d="M50 60V10" class="ck-sec" stroke-width="1" transform="rotate(${sa} 50 50)"/>
    <circle cx="50" cy="50" r="2.4" class="ck-pin"/></svg>`;
}

registerApp({
  id: 'clock', name: 'Clock', size: [860, 600], minSize: [560, 440], overlayContent: true, hideTitle: true, singleton: true,
  keywords: ['alarm', 'timer', 'stopwatch', 'world clock', 'time zone', 'time'],
  about: 'World clocks, alarms, a stopwatch and timers.',
  menus: (win) => [{ title: 'File', items: [
    { label: 'New Alarm', shortcut: '⌘N', action: () => win?.state?.add('alarms') },
    { label: 'Add City…', action: () => win?.state?.add('world') },
    { label: 'New Timer', action: () => win?.state?.show('timers') }, '-',
    { label: 'Close Window', shortcut: '⌘W', action: () => win?.close() }] },
  { title: 'View', items: TABS.map(([k, l], i) => ({ label: l, shortcut: `⌘${i + 1}`, checked: win?.state?.tab === k, action: () => win?.state?.show(k) })) }],
  open(win, args = {}) {
    let tab = args.tab || 'world';
    const seg = h('div.segmented.ck-tabs');
    const addBtn = h('button.tb-btn', { title: 'Add', html: sym.plus, onclick: () => add(tab) });
    const addGroup = h('div.tb-group', addBtn);
    win.toolbar.append(h('div.spacer'), seg, h('div.spacer'), addGroup);
    const body = h('div.ck-body');
    win.body.append(h('div.main-pane.ck-main', body));

    const drawTabs = () => seg.replaceChildren(...TABS.map(([k, l]) => h('button' + (tab === k ? '.on' : ''), { onclick: () => show(k) }, l)));
    function show(k) { tab = k; drawTabs(); addGroup.style.visibility = tab === 'world' || tab === 'alarms' ? '' : 'hidden'; draw(); }

    /* ---------------------------------------------- World Clock */
    function drawWorld() {
      const d = loadClock();
      const zones = [LOCAL_TZ, ...d.cities.filter((z) => z !== LOCAL_TZ)];
      const grid = h('div.ck-world');
      for (const tz of zones) {
        const p = partsIn(tz);
        const card = h('div.ck-city', { 'data-tz': tz },
          h('div.ck-city-face', { html: face(p, 120) }),
          h('div.ck-city-name', tz === LOCAL_TZ ? cityOf(tz) : cityOf(tz)),
          h('div.ck-city-off', tz === LOCAL_TZ ? 'Your time zone' : offsetText(tz)),
          h('div.ck-city-time', fmtClock(p.h, p.m), h('small', ampm(p.h))));
        if (tz !== LOCAL_TZ) card.addEventListener('contextmenu', (e) => contextMenu(e, [{ label: `Remove ${cityOf(tz)}`, danger: true, action: () => { editClock((x) => { x.cities = x.cities.filter((c) => c !== tz); }); draw(); } }]));
        grid.append(card);
      }
      grid.append(h('button.ck-city.ck-addcity', { onclick: () => add('world') }, h('span', { html: sym.plus }), 'Add City'));
      return [grid];
    }
    async function addCity() {
      const all = allZones().filter((z) => z.includes('/') && !/^Etc\//.test(z));
      const input = h('input.field', { placeholder: 'Search for a city', style: { width: '100%' } });
      const results = h('div.ck-cityresults');
      let picked = null;
      const draw = () => {
        const q = input.value.trim().toLowerCase();
        const l = all.filter((z) => !q || cityOf(z).toLowerCase().includes(q) || z.toLowerCase().includes(q)).slice(0, 60);
        results.replaceChildren(...l.map((z) => h('div.ck-cityres', { onclick: () => { picked = z; $('.a-btns .primary', results.closest('.alert'))?.click(); } }, h('b', cityOf(z)), h('small.muted', regionOf(z) + ' · ' + offsetText(z)))));
      };
      input.addEventListener('input', draw);
      draw();
      const r = await alertDialog({ title: 'Add a City', content: h('div.ck-citypick', input, results), buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Add', value: 'ok', primary: true }] }, win.el);
      if (r.button !== 'ok') return;
      const z = picked || all.find((x) => cityOf(x).toLowerCase() === input.value.trim().toLowerCase()) || all.find((x) => cityOf(x).toLowerCase().includes(input.value.trim().toLowerCase()));
      if (z) { editClock((d) => { if (!d.cities.includes(z)) d.cities.push(z); }); draw(); }
    }

    /* ---------------------------------------------- Alarms */
    function drawAlarms() {
      const d = loadClock();
      const sorted = [...d.alarms].sort((a, b) => a.time.localeCompare(b.time));
      if (!sorted.length) return [h('div.ck-empty', h('div.ck-empty-ic', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M4.5 5.5l3-2.5M19.5 5.5l-3-2.5" stroke-linecap="round"/></svg>' }), h('b', 'No Alarms'), h('small.muted', 'Add one with the + button.'), h('button.btn.primary', { onclick: () => add('alarms') }, 'New Alarm'))];
      const next = sorted.filter((a) => a.on).map((a) => nextAlarm(a)).filter(Boolean).sort((a, b) => a - b)[0];
      const list = h('div.group.ck-alarms');
      for (const a of sorted) {
        const [hh, mm] = a.time.split(':').map(Number);
        const tog = h('label.toggle', h('input', { type: 'checkbox', checked: !!a.on, onchange: (e) => { editClock((x) => { const y = x.alarms.find((z) => z.id === a.id); if (y) { y.on = e.target.checked; y.snoozeUntil = null; } }); draw(); } }), h('span'));
        const row = h('div.ck-alarm' + (a.on ? '' : '.off'),
          h('div.ck-alarm-t', h('span.ck-alarm-time', fmtClock(hh, mm)), h('small', ampm(hh)), h('div.ck-alarm-sub', [a.label || 'Alarm', repeatText(a.days)].join(', '))), tog);
        row.addEventListener('click', (e) => { if (!e.target.closest('.toggle')) editAlarm(a); });
        row.addEventListener('contextmenu', (e) => contextMenu(e, [{ label: 'Edit…', action: () => editAlarm(a) }, { label: 'Delete', danger: true, action: () => { editClock((x) => { x.alarms = x.alarms.filter((z) => z.id !== a.id); }); draw(); } }]));
        list.append(row);
      }
      // "Next alarm in 3 hr 20 min", or "Next alarm Monday at 7:00 AM" when it's more than a day away
      const nextText = (t) => {
        const m = Math.round((t - Date.now()) / 60000);
        if (m < 60) return `in ${Math.max(1, m)} min`;
        if (m < 24 * 60) return `in ${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}`;
        return `${new Date(t).toLocaleDateString([], { weekday: 'long' })} at ${new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      };
      return [next ? h('div.ck-next', `Next alarm ${nextText(next)}`) : null, list].filter(Boolean);
    }
    async function editAlarm(a) {
      const isNew = !a;
      a = a ? { ...a, days: [...(a.days || [])] } : { id: uid(), time: (() => { const n = new Date(Date.now() + 3600e3); return `${String(n.getHours()).padStart(2, '0')}:00`; })(), days: [], label: '', on: true, snooze: true };
      const time = h('input.ck-timein', { type: 'time', value: a.time, required: true });
      const days = h('div.ck-days', ...DAYS.map((l, i) => h('button' + (a.days.includes(i) ? '.on' : ''), { title: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i], onclick: (e) => { const k = a.days.indexOf(i); k >= 0 ? a.days.splice(k, 1) : a.days.push(i); e.currentTarget.classList.toggle('on'); } }, l)));
      const label = h('input.field.square', { value: a.label, placeholder: 'Alarm', style: { width: '100%' } });
      const snooze = h('label.toggle', h('input', { type: 'checkbox', checked: a.snooze !== false }), h('span'));
      const form = h('div.ck-form', time, h('div.ck-form-row', h('span', 'Repeat'), days), h('div.ck-form-row', h('span', 'Label'), label), h('div.ck-form-row', h('span', 'Snooze'), snooze),
        h('button.btn.plain.ck-test', { onclick: () => chimeOnce() }, h('span', { html: sym.speaker }), 'Sound: Chime'));
      const r = await alertDialog({ title: isNew ? 'New Alarm' : 'Edit Alarm', content: form, buttons: [...(isNew ? [] : [{ label: 'Delete', value: 'delete', danger: true }]), { label: 'Cancel', value: 'cancel' }, { label: 'Save', value: 'ok', primary: true }] }, win.el);
      if (r.button === 'delete') editClock((x) => { x.alarms = x.alarms.filter((z) => z.id !== a.id); });
      if (r.button === 'ok' && time.value) {
        Object.assign(a, { time: time.value, label: label.value.trim(), snooze: snooze.querySelector('input').checked, on: true, snoozeUntil: null });
        editClock((x) => { const i = x.alarms.findIndex((z) => z.id === a.id); if (i >= 0) x.alarms[i] = a; else x.alarms.push(a); });
      }
      draw();
    }

    /* ---------------------------------------------- Stopwatch */
    const swTime = (sw) => sw.acc + (sw.startedAt ? Date.now() - sw.startedAt : 0);
    let swEls = null;
    function drawStopwatch() {
      const sw = loadClock().stopwatch;
      const t = swTime(sw);
      const big = h('div.ck-sw-time', fmtDuration(t, true));
      const dialHand = h('div.ck-sw-dial', { html: swDial(t) });
      const running = !!sw.startedAt;
      const left = h('button.ck-round', { disabled: !running && !t, onclick: () => (running ? lap() : resetSw()) }, running ? 'Lap' : 'Reset');
      const right = h('button.ck-round' + (running ? '.stop' : '.go'), { onclick: () => (running ? stopSw() : startSw()) }, running ? 'Stop' : 'Start');
      const laps = sw.laps || [];
      const lapTimes = laps.map((l, i) => l - (laps[i - 1] || 0));
      const cur = t - (laps[laps.length - 1] || 0);
      const best = lapTimes.length > 1 ? Math.min(...lapTimes) : null, worst = lapTimes.length > 1 ? Math.max(...lapTimes) : null;
      const table = h('div.ck-laps',
        (running || t) && (laps.length || running) ? h('div.ck-lap.cur', h('span', `Lap ${laps.length + 1}`), h('span.ck-lapt', fmtDuration(cur, true))) : null,
        ...lapTimes.map((lt, i) => h('div.ck-lap' + (lt === best ? '.best' : lt === worst ? '.worst' : ''), h('span', `Lap ${i + 1}`), h('span.ck-lapt', fmtDuration(lt, true)))).reverse());
      swEls = { big, dialHand, table };
      return [h('div.ck-sw', dialHand, big, h('div.ck-sw-btns', left, right)), table];
    }
    function swDial(t) {
      const sa = (t / 1000) * 6, ma = ((t / 60000) * 12) % 360;   // the small dial goes round once in 30 minutes
      const ticks = Array.from({ length: 60 }, (_, i) => `<path d="M50 ${i % 5 ? 5 : 4}v${i % 5 ? 2.5 : 5}" stroke-width="${i % 5 ? 0.7 : 1.6}" transform="rotate(${i * 6} 50 50)"/>`).join('');
      const nums = Array.from({ length: 12 }, (_, i) => { const a = ((i + 1) * 30 - 90) * Math.PI / 180; return `<text x="${(50 + 36 * Math.cos(a)).toFixed(1)}" y="${(50 + 36 * Math.sin(a) + 3).toFixed(1)}">${(i + 1) * 5}</text>`; }).join('');
      return `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" class="ck-sw-face"/><g class="ck-ticks">${ticks}</g><g class="ck-sw-nums">${nums}</g>
        <circle cx="50" cy="66" r="9" class="ck-sw-sub"/><path d="M50 66v-8" class="ck-hand" stroke-width="1.2" transform="rotate(${ma} 50 66)"/>
        <path d="M50 58V6" class="ck-sec" stroke-width="1.1" transform="rotate(${sa % 360} 50 50)"/><circle cx="50" cy="50" r="2" class="ck-pin"/></svg>`;
    }
    const startSw = () => { editClock((d) => { d.stopwatch.startedAt = Date.now(); }); draw(); };
    const stopSw = () => { editClock((d) => { d.stopwatch.acc = swTime(d.stopwatch); d.stopwatch.startedAt = null; }); draw(); };
    const lap = () => { editClock((d) => { d.stopwatch.laps.push(swTime(d.stopwatch)); }); draw(); };
    const resetSw = () => { editClock((d) => { d.stopwatch = { startedAt: null, acc: 0, laps: [] }; }); draw(); };

    /* ---------------------------------------------- Timers */
    let pick = { h: 0, m: 5, s: 0 }, timerLabel = '';
    function drawTimers() {
      const d = loadClock();
      const out = [];
      // a new timer: hours, minutes, seconds, a label, or one of the presets
      const num = (k, max) => {
        const el = h('input.ck-num', { type: 'number', min: 0, max, value: pick[k] });
        el.addEventListener('input', () => { pick[k] = Math.max(0, Math.min(max, Math.floor(+el.value || 0))); });
        el.addEventListener('wheel', (e) => { e.preventDefault(); pick[k] = (pick[k] + (e.deltaY < 0 ? 1 : -1) + max + 1) % (max + 1); el.value = pick[k]; }, { passive: false });
        return h('div.ck-numbox', el, h('small', { h: 'hours', m: 'min', s: 'sec' }[k]));
      };
      const label = h('input.field.square', { placeholder: 'Label', value: timerLabel, oninput: (e) => (timerLabel = e.target.value), style: { width: '220px' } });
      out.push(h('div.ck-newtimer',
        h('div.ck-picker', num('h', 23), h('b', ':'), num('m', 59), h('b', ':'), num('s', 59)),
        label,
        h('div.ck-presets', ...PRESETS.map(([s, l]) => h('button.ck-chip', { onclick: () => { startTimer(s * 1000, timerLabel.trim() || l); timerLabel = ''; draw(); } }, l))),
        h('button.ck-round.go', { onclick: () => { const ms = ((pick.h * 60 + pick.m) * 60 + pick.s) * 1000; if (ms > 0) { startTimer(ms, timerLabel.trim()); timerLabel = ''; draw(); } } }, 'Start')));
      if (d.timers.length) {
        const grid = h('div.ck-timers');
        for (const t of d.timers) {
          const left = timerLeft(t);
          const frac = t.total ? Math.max(0, Math.min(1, left / t.total)) : 0;
          const running = !!t.endsAt;
          const ring = `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" class="ck-ring-bg"/><circle cx="50" cy="50" r="44" class="ck-ring" stroke-dasharray="${(2 * Math.PI * 44).toFixed(1)}" stroke-dashoffset="${((1 - frac) * 2 * Math.PI * 44).toFixed(1)}" transform="rotate(-90 50 50)"/></svg>`;
          const card = h('div.ck-timer' + (running ? '' : '.paused'), { 'data-id': t.id },
            h('div.ck-timer-ring', { html: ring }, h('div.ck-timer-mid', h('div.ck-timer-left', fmtDuration(left + (running ? 999 : 0))), h('small', t.label || fmtDuration(t.total)))),
            h('div.ck-timer-btns',
              h('button.ck-mini', { title: 'Cancel', html: sym.close, onclick: () => { editClock((x) => { x.timers = x.timers.filter((z) => z.id !== t.id); }); draw(); } }),
              h('button.ck-mini.main', { title: running ? 'Pause' : t.done && left === t.total ? 'Restart' : 'Resume', html: running ? PAUSE : PLAY, onclick: () => {
                editClock((x) => { const y = x.timers.find((z) => z.id === t.id); if (!y) return; if (y.endsAt) { y.remaining = Math.max(0, y.endsAt - Date.now()); y.endsAt = null; } else { y.endsAt = Date.now() + (y.remaining || y.total); y.remaining = null; y.done = null; } });
                draw();
              } })));
          grid.append(card);
        }
        out.push(h('div.ck-sec', 'Timers'), grid);
      }
      return out;
    }

    /* ---------------------------------------------- drawing */
    function draw() {
      body.dataset.tab = tab;
      body.replaceChildren(...(tab === 'world' ? drawWorld() : tab === 'alarms' ? drawAlarms() : tab === 'stopwatch' ? drawStopwatch() : drawTimers()));
    }
    // ticking: the clocks every second; the stopwatch every frame while it runs; timers every 250 ms
    const tick = setInterval(() => {
      if (tab === 'world') for (const card of body.querySelectorAll('.ck-city[data-tz]')) {
        const p = partsIn(card.dataset.tz);
        card.querySelector('.ck-city-face').innerHTML = face(p, 120);
        card.querySelector('.ck-city-time').firstChild.textContent = fmtClock(p.h, p.m);
      }
      if (tab === 'timers' && !body.querySelector('input:focus')) {
        const d = loadClock();
        for (const card of body.querySelectorAll('.ck-timer')) {
          const t = d.timers.find((x) => x.id === card.dataset.id);
          if (!t) continue;
          const left = timerLeft(t);
          card.querySelector('.ck-timer-left').textContent = fmtDuration(left + (t.endsAt ? 999 : 0));
          card.querySelector('.ck-ring').setAttribute('stroke-dashoffset', ((1 - Math.max(0, Math.min(1, left / t.total))) * 2 * Math.PI * 44).toFixed(1));
        }
      }
    }, 250);
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (tab !== 'stopwatch' || !swEls) return;
      const sw = loadClock().stopwatch;
      if (!sw.startedAt) return;
      const t = swTime(sw);
      swEls.big.textContent = fmtDuration(t, true);
      swEls.dialHand.innerHTML = swDial(t);
      const cur = swEls.table.querySelector('.cur .ck-lapt');
      if (cur) cur.textContent = fmtDuration(t - (sw.laps[sw.laps.length - 1] || 0), true);
    };
    raf = requestAnimationFrame(frame);
    // the shell changes timers when they ring (another window): redraw then
    const onStorage = (e) => { if (e.key === 'liquid.app.clock' && !body.querySelector('input:focus')) draw(); };
    addEventListener('storage', onStorage);
    const off = bus.on('clock', () => {});
    win.on('close', () => { clearInterval(tick); cancelAnimationFrame(raf); removeEventListener('storage', onStorage); off?.(); });

    function add(k) { if (k === 'world') addCity(); else if (k === 'alarms') { if (tab !== 'alarms') show('alarms'); editAlarm(null); } else show(k); }
    win.el.addEventListener('keydown', (e) => {
      if (e.target.closest('input')) return;
      if (e.ctrlKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); show(TABS[+e.key - 1][0]); }
      if (e.ctrlKey && e.key === 'n') { e.preventDefault(); add('alarms'); }
      if (tab === 'stopwatch' && e.key === ' ') { e.preventDefault(); const sw = loadClock().stopwatch; sw.startedAt ? stopSw() : startSw(); }
    });
    win.state = { show, add, get tab() { return tab; } };
    win.on('reopen', (a) => { if (a?.tab) show(a.tab); });
    show(tab);
  },
});
