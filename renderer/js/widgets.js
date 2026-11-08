// Widgets — used on the desktop and in Notification Center.
import { h, bus } from './util.js';
import { appData, store } from './store.js';
import { api } from './sys.js';
import { getWeather, describe } from './weatherdata.js';
import { wm } from './wm.js';

const timers = new WeakMap();
const every = (el, ms, fn) => { fn(); const t = setInterval(() => { if (!el.isConnected) return clearInterval(t); fn(); }, ms); };

export const WIDGETS = {
  clock: { name: 'Clock', size: 's', build(el) {
    const s = h('div.w-clock');
    const svgNS = '<svg viewBox="0 0 100 100" width="132" height="132"><circle cx="50" cy="50" r="47" fill="rgba(255,255,255,.92)"/>' +
      Array.from({ length: 12 }, (_, i) => `<text x="${50 + 36 * Math.sin((i + 1) * Math.PI / 6)}" y="${54 + -36 * Math.cos((i + 1) * Math.PI / 6)}" text-anchor="middle" font-size="10" font-weight="600" font-family="Inter Variable" fill="#1c1c1e">${i + 1}</text>`).join('') +
      '<line id="hh" x1="50" y1="50" x2="50" y2="28" stroke="#1c1c1e" stroke-width="3.6" stroke-linecap="round"/><line id="mm" x1="50" y1="50" x2="50" y2="17" stroke="#1c1c1e" stroke-width="2.6" stroke-linecap="round"/>' +
      '<line id="ss" x1="50" y1="58" x2="50" y2="14" stroke="#ff9f0a" stroke-width="1.2" stroke-linecap="round"/><circle cx="50" cy="50" r="2.6" fill="#ff9f0a"/></svg>';
    s.innerHTML = svgNS;
    el.append(s);
    every(el, 1000, () => {
      const d = new Date(), sec = d.getSeconds(), m = d.getMinutes() + sec / 60, hr = (d.getHours() % 12) + m / 60;
      s.querySelector('#hh').setAttribute('transform', `rotate(${hr * 30} 50 50)`);
      s.querySelector('#mm').setAttribute('transform', `rotate(${m * 6} 50 50)`);
      s.querySelector('#ss').setAttribute('transform', `rotate(${sec * 6} 50 50)`);
    });
  } },
  calendar: { name: 'Calendar', size: 's', build(el) {
    const pad = h('div.w-pad');
    el.append(pad);
    el.addEventListener('dblclick', () => wm.activate('calendar'));
    every(el, 60_000, () => {
      const d = new Date(), y = d.getFullYear(), m = d.getMonth();
      const first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();
      const grid = h('div.w-cal-grid', ...'SMTWTFS'.split('').map((c) => h('span.dow', c)));
      for (let i = 0; i < first; i++) grid.append(h('span.other', new Date(y, m, i - first + 1).getDate()));
      for (let i = 1; i <= days; i++) grid.append(h('span' + (i === d.getDate() ? '.today' : ''), i));
      pad.innerHTML = '';
      pad.append(h('div.w-cal-head', d.toLocaleDateString('en', { month: 'long' })), grid);
    });
  } },
  weather: { name: 'Weather', size: 's', build(el) {
    el.classList.add('w-weather');
    const pad = h('div.w-pad', h('div', { style: { opacity: 0.7, fontSize: '12px' } }, 'Loading…'));
    el.append(pad);
    el.addEventListener('dblclick', () => wm.activate('weather'));
    every(el, 15 * 60_000, async () => {
      try {
        const w = await getWeather();
        const c = w.current, d = describe(c.weather_code, c.is_day);
        el.classList.toggle('night', !c.is_day);
        el.classList.toggle('cloudy', ['cloud', 'rain', 'fog', 'storm', 'snow'].includes(d.kind));
        pad.innerHTML = '';
        pad.append(
          h('div', { style: { fontSize: '13px', fontWeight: 600 } }, w.city.name, ' ➤'),
          h('div.w-big', Math.round(c.temperature_2m) + '°'),
          h('div.spacer'),
          h('div', { style: { width: '22px', height: '22px' }, html: d.icon }),
          h('div', { style: { fontSize: '12px', fontWeight: 600 } }, d.label),
          h('div', { style: { fontSize: '12px', fontWeight: 500 } }, `H:${Math.round(w.daily.temperature_2m_max[0])}° L:${Math.round(w.daily.temperature_2m_min[0])}°`));
      } catch {
        pad.innerHTML = '';
        pad.append(h('div', { style: { fontSize: '13px', fontWeight: 600 } }, 'Weather'), h('div.spacer'), h('div', { style: { fontSize: '12px', opacity: 0.8 } }, 'Offline — weather unavailable'));
      }
    });
  } },
  system: { name: 'System', size: 's', build(el) {
    const pad = h('div.w-pad', { style: { justifyContent: 'space-between' } });
    el.append(pad);
    el.addEventListener('dblclick', () => wm.activate('monitor'));
    const ring = (label, color) => {
      const wrap = h('div.w-ring');
      wrap.innerHTML = `<svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="none" stroke="rgba(128,128,128,.25)" stroke-width="4"/><circle class="v" cx="18" cy="18" r="15" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-dasharray="94.2" stroke-dashoffset="94.2" style="transition:stroke-dashoffset .6s"/></svg><b>0%</b><span>${label}</span>`;
      wrap.set = (v) => { wrap.querySelector('.v').style.strokeDashoffset = 94.2 * (1 - v / 100); wrap.querySelector('b').textContent = Math.round(v) + '%'; };
      return wrap;
    };
    const cpu = ring('CPU', '#30d158'), mem = ring('Memory', '#0a84ff'), bat = ring('Battery', '#ffd60a');
    pad.append(h('div', { style: { fontSize: '13px', fontWeight: 600 } }, 'System'), h('div', { style: { display: 'flex', justifyContent: 'space-between' } }, cpu, mem), h('div.up', { style: { fontSize: '11px', opacity: 0.65 } }));
    every(el, 2500, async () => {
      try {
        const s = await api.sys.stats();
        cpu.set(s.cpu); mem.set(100 * (1 - s.memFree / s.memTotal));
        const u = Math.floor(s.uptime / 3600), um = Math.floor((s.uptime % 3600) / 60);
        pad.querySelector('.up').textContent = (s.battery ? `Battery ${s.battery.percent}% · ` : '') + `Up ${u}h ${um}m`;
      } catch { /* backend unavailable */ }
    });
  } },
  notes: { name: 'Quick Note', size: 's', build(el) {
    el.classList.add('w-notes');
    const ta = h('textarea', { placeholder: 'Jot something down…', value: appData.get('quicknote', '') });
    ta.addEventListener('input', () => appData.set('quicknote', ta.value));
    ta.addEventListener('mousedown', (e) => e.stopPropagation());
    el.append(h('div.w-pad', h('div', { style: { fontSize: '13px', fontWeight: 700, color: '#ff9f0a' } }, 'Quick Note'), ta));
  } },
  upcoming: { name: 'Up Next', size: 'm', build(el) {
    const pad = h('div.w-pad');
    el.append(pad);
    el.addEventListener('dblclick', () => wm.activate('calendar'));
    every(el, 60_000, () => {
      const d = new Date();
      const events = appData.get('calendar', {});
      const upcoming = [];
      for (let i = 0; i < 14 && upcoming.length < 3; i++) {
        const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
        const key = day.toISOString().slice(0, 10);
        for (const ev of events[key] || []) upcoming.push({ day, ev });
      }
      pad.innerHTML = '';
      pad.append(h('div', { style: { display: 'flex', gap: '14px', height: '100%' } },
        h('div', { style: { width: '90px' } }, h('div.w-cal-head', d.toLocaleDateString('en', { weekday: 'long' })), h('div.w-big', { style: { fontSize: '44px' } }, d.getDate())),
        h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', minWidth: 0 } },
          upcoming.length ? upcoming.map(({ day, ev }) => h('div.cal-ev', { style: { fontSize: '12px', padding: '4px 8px' } }, h('b', ev.title), h('div', { style: { opacity: 0.7, fontSize: '11px' } }, day.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' }) + (ev.time ? ' · ' + ev.time : ''))))
            : h('div', { style: { opacity: 0.6, marginTop: '10px' } }, 'No upcoming events'))));
    });
  } },
};

export function buildWidget(type) {
  const def = WIDGETS[type];
  const el = h('div.widget.glass.sheen.' + (def?.size || 's'));
  def?.build(el);
  return el;
}
