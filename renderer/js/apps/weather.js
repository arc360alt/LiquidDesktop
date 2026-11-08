// Weather — current conditions, hourly and 10-day forecast (Open-Meteo).
import { h, debounce } from '../util.js';
import { registerApp } from '../wm.js';
import { sym } from '../icons.js';
import { store } from '../store.js';
import { getWeather, describe, geocode } from '../weatherdata.js';

registerApp({
  id: 'weather', name: 'Weather', size: [440, 700], minSize: [360, 480], overlayContent: true, hideTitle: true, className: 'weather-win',
  keywords: ['forecast', 'temperature', 'rain'],
  open(win) {
    const root = h('div.weather');
    win.body.append(root);
    win.dragRegion(root);
    const input = h('input.field', { placeholder: 'Search for a city' });
    const results = h('div');
    win.toolbar.append(h('div.spacer'), h('div.search-field.no-drag', { html: sym.search }, input));
    input.addEventListener('input', debounce(async () => {
      const q = input.value.trim();
      results.innerHTML = '';
      if (q.length < 2) return draw();
      const res = await geocode(q).catch(() => []);
      root.innerHTML = '';
      root.append(h('div.card', h('h4', 'Results'), ...res.map((r) => h('div', { style: { padding: '8px 0', fontSize: '14px', borderTop: '0.5px solid rgba(255,255,255,.2)' }, onclick: () => { store.set('weatherCity', r); input.value = ''; draw(true); } }, h('b', r.name), ' ', h('span', { style: { opacity: 0.7 } }, r.region))), res.length ? null : h('div', 'No results')));
    }, 350));
    const draw = async (force) => {
      root.className = 'weather';
      root.innerHTML = '<div style="margin:auto;opacity:.8">Loading…</div>';
      let w;
      try { w = await getWeather(force); } catch { root.innerHTML = '<div style="margin:auto;text-align:center;opacity:.85">Weather isn’t available.<br>Check your internet connection.</div>'; return; }
      const c = w.current, d = describe(c.weather_code, c.is_day);
      root.classList.toggle('night', !c.is_day);
      root.classList.toggle('cloudy', d.kind === 'cloud' || d.kind === 'fog');
      root.classList.toggle('rain', d.kind === 'rain' || d.kind === 'storm' || d.kind === 'snow');
      root.innerHTML = '';
      const now = Date.now();
      const hours = w.hourly.time.map((t, i) => ({ t: new Date(t), temp: w.hourly.temperature_2m[i], code: w.hourly.weather_code[i], day: w.hourly.is_day[i] })).filter((x) => x.t.getTime() > now - 36e5).slice(0, 24);
      const lo = Math.min(...w.daily.temperature_2m_min), hi = Math.max(...w.daily.temperature_2m_max);
      root.append(
        h('div.w-hero', h('h2', w.city.name), h('div.temp', Math.round(c.temperature_2m) + '°'), h('p', d.label),
          h('p', `H:${Math.round(w.daily.temperature_2m_max[0])}°  L:${Math.round(w.daily.temperature_2m_min[0])}°`)),
        h('div.card', h('h4', 'Hourly Forecast'), h('div.hours', ...hours.map((x, i) => h('div', h('span', i === 0 ? 'Now' : x.t.toLocaleTimeString([], { hour: 'numeric' })), h('span', { html: describe(x.code, x.day).icon }), h('span', Math.round(x.temp) + '°'))))),
        h('div.card', h('h4', '10-Day Forecast'), h('div.days', ...w.daily.time.map((t, i) => {
          const mn = w.daily.temperature_2m_min[i], mx = w.daily.temperature_2m_max[i];
          return h('div', h('span', i === 0 ? 'Today' : new Date(t + 'T12:00').toLocaleDateString([], { weekday: 'short' })), h('span', { html: describe(w.daily.weather_code[i], 1).icon }),
            h('span.lo', Math.round(mn) + '°'), h('div.rng', h('i', { style: { left: ((mn - lo) / (hi - lo || 1)) * 100 + '%', right: (1 - (mx - lo) / (hi - lo || 1)) * 100 + '%' } })), h('span', Math.round(mx) + '°'));
        }))),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px' } },
          h('div.card', h('h4', 'Feels Like'), h('div', { style: { fontSize: '28px' } }, Math.round(c.apparent_temperature) + '°')),
          h('div.card', h('h4', 'Humidity'), h('div', { style: { fontSize: '28px' } }, c.relative_humidity_2m + '%')),
          h('div.card', h('h4', 'Wind'), h('div', { style: { fontSize: '28px' } }, Math.round(c.wind_speed_10m)), h('small', w.current_units?.wind_speed_10m || '')),
          h('div.card', h('h4', 'UV Index'), h('div', { style: { fontSize: '28px' } }, Math.round(w.daily.uv_index_max[0] ?? 0)))));
      win.setTitle(`Weather — ${w.city.name}`);
    };
    draw();
  },
});
