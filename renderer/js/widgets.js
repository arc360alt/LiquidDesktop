// Widgets — used on the desktop and in Notification Center.
import { h, bus } from './util.js';
import { appData, store } from './store.js';
import { api } from './sys.js';
import { getWeather, describe } from './weatherdata.js';
import { customWidgets, renderCustom } from './customwidget.js';
import { sym, folderIcon, docIcon, IMAGE_EXT } from './icons.js';
import { fileUrl } from './util.js';
import { wm } from './wm.js';

const timers = new WeakMap();
const every = (el, ms, fn) => { fn(); const t = setInterval(() => { if (!el.isConnected) return clearInterval(t); fn(); }, ms); };

export const WIDGETS = {
  clock: { name: 'Clock', cat: 'clock', size: 's', build(el) {
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
  calendar: { name: 'Calendar', cat: 'clock', size: 's', build(el) {
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
  weather: { name: 'Weather', cat: 'weather', size: 's', build(el) {
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
  system: { name: 'System', cat: 'system', size: 's', build(el) {
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
  notes: { name: 'Quick Note', cat: 'productivity', size: 's', build(el) {
    el.classList.add('w-notes');
    const ta = h('textarea', { placeholder: 'Jot something down…', value: appData.get('quicknote', '') });
    ta.addEventListener('input', () => appData.set('quicknote', ta.value));
    ta.addEventListener('mousedown', (e) => e.stopPropagation());
    el.append(h('div.w-pad', h('div', { style: { fontSize: '13px', fontWeight: 700, color: '#ff9f0a' } }, 'Quick Note'), ta));
  } },
  upcoming: { name: 'Up Next', cat: 'clock', size: 'm', build(el) {
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

/* ---------------------------------------------- more widgets for the built-in apps */
const label = (t, color) => h('div.w-label', { style: color ? { color } : null }, t);
Object.assign(WIDGETS, {
  date: { name: 'Date', cat: 'clock', size: 's', build(el) {
    const pad = h('div.w-pad.w-date');
    el.append(pad);
    el.addEventListener('dblclick', () => wm.activate('calendar'));
    every(el, 60_000, () => {
      const d = new Date();
      pad.innerHTML = '';
      pad.append(h('div.w-date-dow', d.toLocaleDateString([], { weekday: 'long' }).toUpperCase()), h('div.w-date-num', d.getDate()), h('div.w-date-mon', d.toLocaleDateString([], { month: 'long', year: 'numeric' })));
    });
  } },
  worldclock: { name: 'World Clock', cat: 'clock', size: 'm', build(el) {
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const zones = [[here.split('/').pop().replace(/_/g, ' '), here], ['New York', 'America/New_York'], ['London', 'Europe/London'], ['Tokyo', 'Asia/Tokyo']]
      .filter((z, i, a) => a.findIndex((x) => x[1] === z[1]) === i).slice(0, 4);
    const row = h('div.w-world');
    el.append(h('div.w-pad', label('World Clock'), row));
    every(el, 15_000, () => {
      row.innerHTML = '';
      for (const [name, tz] of zones) {
        const d = new Date(), t = d.toLocaleTimeString([], { timeZone: tz, hour: 'numeric', minute: '2-digit' });
        const hr = +d.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }) % 24;
        row.append(h('div.w-wc' + (hr >= 7 && hr < 19 ? '' : '.night'), h('b', t.replace(/\s?[AP]M$/i, '')), h('small', /PM$/i.test(t) ? 'PM' : /AM$/i.test(t) ? 'AM' : ''), h('span', name)));
      }
    });
  } },
  forecast: { name: 'Forecast', cat: 'weather', size: 'm', build(el) {
    el.classList.add('w-weather');
    const pad = h('div.w-pad', h('div', { style: { opacity: 0.7, fontSize: '12px' } }, 'Loading…'));
    el.append(pad);
    el.addEventListener('dblclick', () => wm.activate('weather'));
    every(el, 15 * 60_000, async () => {
      try {
        const w = await getWeather(), c = w.current, d = describe(c.weather_code, c.is_day);
        el.classList.toggle('night', !c.is_day);
        el.classList.toggle('cloudy', ['cloud', 'rain', 'fog', 'storm', 'snow'].includes(d.kind));
        const now = Date.now(), times = w.hourly.time.map((t) => new Date(t).getTime());
        const i0 = Math.max(0, times.findIndex((t) => t > now) - 1);
        const hours = h('div.w-fc');
        for (let i = i0; i < i0 + 6 && i < times.length; i++) {
          const dd = describe(w.hourly.weather_code[i], w.hourly.is_day[i]);
          hours.append(h('div', h('small', i === i0 ? 'Now' : new Date(times[i]).toLocaleTimeString([], { hour: 'numeric' })), h('i', { html: dd.icon }), h('b', Math.round(w.hourly.temperature_2m[i]) + '°')));
        }
        pad.innerHTML = '';
        pad.append(h('div.w-fc-top', h('div', h('div', { style: { fontSize: '13px', fontWeight: 600 } }, w.city.name), h('div.w-big', { style: { fontSize: '32px' } }, Math.round(c.temperature_2m) + '°')),
          h('div', { style: { textAlign: 'right', fontSize: '12px', fontWeight: 600 } }, h('div', { style: { width: '22px', height: '22px', marginLeft: 'auto' }, html: d.icon }), d.label, h('div', `H:${Math.round(w.daily.temperature_2m_max[0])}° L:${Math.round(w.daily.temperature_2m_min[0])}°`))), hours);
      } catch { pad.innerHTML = ''; pad.append(label('Forecast'), h('div', { style: { fontSize: '12px', opacity: 0.8 } }, 'Offline — weather unavailable')); }
    });
  } },
  battery: { name: 'Battery', cat: 'system', size: 's', build(el) {
    const pad = h('div.w-pad', { style: { alignItems: 'center', justifyContent: 'center', gap: '6px' } });
    el.append(pad);
    every(el, 20_000, async () => {
      const s = await api.sys.status().catch(() => null);
      const b = s?.battery;
      pad.innerHTML = '';
      if (!b) { pad.append(label('Battery'), h('div', { style: { fontSize: '12px', opacity: 0.7, marginTop: '30px' } }, 'No battery')); return; }
      const col = b.charging ? '#30d158' : b.percent <= 20 ? '#ff453a' : '#30d158';
      pad.append(h('div.w-batt', { html: `<svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="none" stroke="rgba(128,128,128,.25)" stroke-width="3.5"/><circle cx="18" cy="18" r="15" fill="none" stroke="${col}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="94.25" stroke-dashoffset="${(94.25 * (1 - b.percent / 100)).toFixed(1)}" transform="rotate(-90 18 18)"/></svg>` },
        h('span', { html: b.charging ? sym.bolt : '' })), h('b', { style: { fontSize: '20px' } }, b.percent + '%'), h('small', { style: { opacity: 0.7 } }, b.charging ? 'Charging' : 'On battery'));
    });
  } },
  activity: { name: 'Activity', cat: 'system', size: 'm', build(el) {
    const cv = h('canvas.w-graph');
    const vals = h('div.w-act-vals');
    el.append(h('div.w-pad', h('div.w-act-top', label('Activity'), vals), cv));
    el.addEventListener('dblclick', () => wm.activate('monitor'));
    const hist = [];
    every(el, 2000, async () => {
      const s = await api.sys.stats().catch(() => null);
      if (!s) return;
      const mem = 100 * (1 - s.memFree / s.memTotal);
      hist.push([s.cpu, mem]); if (hist.length > 40) hist.shift();
      vals.innerHTML = '';
      vals.append(h('span', { style: { color: '#30d158' } }, `CPU ${Math.round(s.cpu)}%`), h('span', { style: { color: '#0a84ff' } }, `Memory ${Math.round(mem)}%`));
      const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
      if (!W) return;
      cv.width = W * dpr; cv.height = H * dpr;
      const g = cv.getContext('2d'); g.scale(dpr, dpr);
      for (const [k, col] of [[1, '#0a84ff'], [0, '#30d158']]) {
        g.beginPath();
        hist.forEach((v, i) => { const x = W - (hist.length - 1 - i) * (W / 39), y = H - (v[k] / 100) * (H - 2) - 1; i ? g.lineTo(x, y) : g.moveTo(x, y); });
        g.strokeStyle = col; g.lineWidth = 1.8; g.stroke();
        g.lineTo(W, H); g.lineTo(W - (hist.length - 1) * (W / 39), H); g.closePath(); g.fillStyle = col + '30'; g.fill();
      }
    });
  } },
  nowplaying: { name: 'Now Playing', cat: 'media', size: 'm', build(el) {
    const pad = h('div.w-pad.w-np');
    el.append(pad);
    let shown = null;
    every(el, 3000, async () => {
      const m = await api.sys.media().catch(() => null);
      const key = JSON.stringify(m && [m.title, m.artist, m.player, m.status, m.art]);
      if (key === shown) return;   // unchanged: don't rebuild (the artwork would flash)
      shown = key;
      pad.innerHTML = '';
      if (!m || !m.title) { pad.append(label('Now Playing'), h('div', { style: { opacity: 0.7, fontSize: '12px', marginTop: '10px' } }, 'Nothing is playing')); return; }
      const artOk = /^(file:|https?:|data:image\/)/.test(m.art || '');
      const noArt = () => h('div.w-np-noart', { html: sym.music });
      const art = artOk ? h('img', { src: m.art, draggable: false, onerror: (e) => e.target.replaceWith(noArt()) }) : noArt();
      const btn = (ic, cmd) => h('button', { html: ic, onclick: (e) => { e.stopPropagation(); api.sys.mediaCmd(cmd); } });
      pad.append(h('div.w-np-row', h('div.w-np-art', art), h('div.w-np-t', h('b', m.title), h('span', m.artist || m.player || ''),
        h('div.w-np-btns', btn(sym.prev, 'previous'), btn(m.status === 'Playing' ? sym.pause : sym.play, 'play-pause'), btn(sym.next, 'next')))));
    });
  } },
  photo: { name: 'Photo', cat: 'media', size: 's', build(el) {
    el.classList.add('w-photo');
    let pics = [], i = 0;
    el.addEventListener('dblclick', () => pics[i] && wm.open('preview', { path: pics[i] }));
    every(el, 60_000, async () => {
      if (!pics.length) {
        const places = await api.fs.places().catch(() => null);
        const list = places ? await api.fs.list(places.pictures).catch(() => []) : [];
        pics = list.filter((f) => !f.isDir && IMAGE_EXT.has(f.ext) && f.ext !== 'svg').map((f) => f.path).sort(() => Math.random() - 0.5);
      }
      el.innerHTML = '';
      if (!pics.length) { el.append(h('div.w-pad', label('Photo'), h('div', { style: { opacity: 0.7, fontSize: '12px', marginTop: '10px' } }, 'Add pictures to your Pictures folder.'))); return; }
      i = (i + 1) % pics.length;
      // a small thumbnail from the main process (full photos are many megapixels)
      const src = await api.fs.thumb?.(pics[i], 400).catch(() => null);
      if (src) el.append(h('div.w-photo-in', h('img', { src, draggable: false, decoding: 'async' })));
    });
  } },
  downloads: { name: 'Recent Downloads', cat: 'productivity', size: 'm', build(el) {
    const list = h('div.w-files');
    el.append(h('div.w-pad', label('Recent Downloads'), list));
    every(el, 30_000, async () => {
      const places = await api.fs.places().catch(() => null);
      const files = places ? (await api.fs.list(places.downloads).catch(() => [])).filter((f) => !f.hidden).sort((a, b) => b.mtime - a.mtime).slice(0, 4) : [];
      list.innerHTML = '';
      if (!files.length) list.append(h('div', { style: { opacity: 0.7, fontSize: '12px' } }, 'No downloads yet'));
      for (const f of files) {
        const it = h('div.w-file', h('div.w-file-ic', { html: f.isDir ? folderIcon(f.name) : docIcon(f.ext) }), h('span', f.name));
        it.addEventListener('dblclick', (e) => { e.stopPropagation(); api.fs.open(f.path); });
        list.append(it);
      }
    });
  } },
});

export const CATEGORIES = [['all', 'All Widgets'], ['clock', 'Clock & Calendar'], ['weather', 'Weather'], ['system', 'System'], ['productivity', 'Productivity'], ['media', 'Media'], ['mine', 'My Widgets']];
export const SIZE_PX = { s: [164, 164], m: [340, 164], l: [340, 340] };

/** A widget's definition: built-in, or a custom one ("custom:<id>"). */
export function widgetDef(type) {
  if (typeof type === 'string' && type.startsWith('custom:')) {
    const spec = customWidgets()[type.slice(7)];
    return spec ? { name: spec.name, cat: 'mine', size: spec.size, custom: spec } : null;
  }
  return WIDGETS[type] || null;
}
export function buildWidget(type) {
  const def = widgetDef(type);
  const el = h('div.widget.glass.sheen.' + (def?.size || 's'));
  if (def?.custom) renderCustom(el, def.custom);
  else def?.build(el);
  return el;
}
