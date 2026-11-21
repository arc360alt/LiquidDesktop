// Weather — a LiquidDesktop take on StormView (github.com/StormView-Project/StormView-MacOS): a full-window
// radar map with floating Liquid Glass weather cards, Weather / Radar modes, a radar scrubber with nowcast
// frames, NWS alerts (banner, cards, map polygons), an air-quality overlay and 13 cards you can reorder.
// Data (no API keys): Open-Meteo (forecast, air quality), LibreWXR (radar), NWS (alerts), Nominatim (search).
// The map is StormView's own map engine (renderer/weather-map), running in a frame.
import { h, $, $$, debounce, clamp, bus } from '../util.js';
import { registerApp } from '../wm.js';
import { sym } from '../icons.js';
import { store } from '../store.js';
import { theme } from '../theme.js';
import { describe, useF } from '../weatherdata.js';
import { showMenu, alertDialog } from '../menus.js';

/* ================================================================== data */
const OM = 'https://api.open-meteo.com/v1/forecast', AQ = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const RADAR = 'https://api.librewxr.net', NWS = 'https://api.weather.gov', GEO = 'https://nominatim.openstreetmap.org';

export const CARDS = [
  ['alerts', 'Alerts'], ['hourly', 'Hourly Forecast'], ['daily', '7-Day Forecast'], ['sun', 'Sunrise & Sunset'], ['details', 'Details'],
  ['aqi', 'Air Quality'], ['wind', 'Wind'], ['feels', 'Feels Like'], ['precip', 'Precipitation'], ['daylight', 'Daylight'],
  ['uv', 'UV Index'], ['moon', 'Moon Phase'], ['outlook', 'Today’s Outlook'], ['future', 'Future Weather'], ['month', 'Month Outlook'],
];
export const SCHEMES = [
  [0, 'Black and White'], [1, 'Rainviewer Original'], [2, 'Universal Blue'], [3, 'Titan'], [4, 'The Weather Channel'], [5, 'Meteored'],
  [6, 'NEXRAD Level III'], [7, 'Rainbow @ Selex SI'], [8, 'Dark Sky'], [9, 'Datameteo Valerio'], [10, 'Viper HD'], [11, 'MRMS CREF'],
];
export function cardOrder() {
  const saved = store.get('svCards');
  const known = new Set(CARDS.map((c) => c[0]));
  const list = Array.isArray(saved) ? saved.filter((c) => known.has(c.id)) : [];
  for (const [id] of CARDS) if (!list.some((c) => c.id === id)) list.push({ id, on: true });
  return list;
}

async function json(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fetchWeather(loc, imperial) {
  const q = new URLSearchParams({
    latitude: loc.lat.toFixed(4), longitude: loc.lon.toFixed(4), timezone: 'auto', timeformat: 'unixtime', forecast_days: '7',
    temperature_unit: imperial ? 'fahrenheit' : 'celsius', wind_speed_unit: imperial ? 'mph' : 'kmh', precipitation_unit: imperial ? 'inch' : 'mm',
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,uv_index,dew_point_2m,is_day',
    hourly: 'temperature_2m,apparent_temperature,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m,is_day,uv_index,precipitation,relative_humidity_2m,surface_pressure,visibility',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset,uv_index_max,snowfall_sum',
  });
  const r = await json(`${OM}?${q}`);
  const c = r.current, hh = r.hourly, d = r.daily;
  const hourly = hh.time.map((t, i) => ({ t, temp: hh.temperature_2m[i], feels: hh.apparent_temperature[i], pop: hh.precipitation_probability[i] ?? 0, code: hh.weather_code[i],
    wind: hh.wind_speed_10m[i], dir: hh.wind_direction_10m[i], day: hh.is_day[i], uv: hh.uv_index[i], precip: hh.precipitation[i], hum: hh.relative_humidity_2m[i], pressure: hh.surface_pressure[i], vis: hh.visibility[i] }));
  const daily = d.time.map((t, i) => ({ t, code: d.weather_code[i], max: d.temperature_2m_max[i], min: d.temperature_2m_min[i], precip: d.precipitation_sum[i], pop: d.precipitation_probability_max[i] ?? 0,
    wind: d.wind_speed_10m_max[i], gust: d.wind_gusts_10m_max[i], sunrise: d.sunrise[i], sunset: d.sunset[i], uv: d.uv_index_max[i], snow: d.snowfall_sum[i], feelsMax: d.apparent_temperature_max[i], feelsMin: d.apparent_temperature_min[i] }));
  const now = Date.now() / 1000;
  const hi = Math.max(0, hourly.findIndex((x) => x.t > now) - 1);
  return { tz: r.timezone, imperial, hourly, daily, hi,
    current: { temp: c.temperature_2m, feels: c.apparent_temperature, hum: c.relative_humidity_2m, precip: c.precipitation, code: c.weather_code, cloud: c.cloud_cover, pressure: c.pressure_msl,
      wind: c.wind_speed_10m, dir: c.wind_direction_10m, gust: c.wind_gusts_10m, vis: c.visibility, uv: c.uv_index, dew: c.dew_point_2m, day: c.is_day, pop: hourly[hi]?.pop ?? 0 } };
}
// Open-Meteo's seasonal model: a statistical outlook for dates beyond the normal forecast (about 17–210 days out)
const SEASONAL = 'https://seasonal-api.open-meteo.com/v1/seasonal';
const isoDay = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
async function fetchSeasonal(loc, start, end, imperial) {
  const q = new URLSearchParams({ latitude: loc.lat.toFixed(4), longitude: loc.lon.toFixed(4), start_date: start, end_date: end, timezone: 'auto',
    daily: 'temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,rain_sum,showers_sum,snowfall_sum,wind_speed_10m_max,wind_gusts_10m_max,relative_humidity_2m_mean,cloud_cover_mean',
    temperature_unit: imperial ? 'fahrenheit' : 'celsius', wind_speed_unit: imperial ? 'mph' : 'kmh', precipitation_unit: imperial ? 'inch' : 'mm' });
  const r = await json(`${SEASONAL}?${q}`);
  const d = r.daily || {};
  return (d.time || []).map((date, i) => {
    const v = (k) => d[k]?.[i] ?? null;
    const snow = v('snowfall_sum'), showers = v('showers_sum'), rain = v('rain_sum'), sum = v('precipitation_sum');
    const type = snow == null && rain == null && showers == null && sum == null ? null : snow > 0 ? 'snow' : showers > 0 ? 'showers' : rain > 0 || sum > 0 ? 'rain' : 'none';
    return { date, max: v('temperature_2m_max'), min: v('temperature_2m_min'), mean: v('temperature_2m_mean'), precip: sum, type, wind: v('wind_speed_10m_max'), gust: v('wind_gusts_10m_max'), hum: v('relative_humidity_2m_mean'), cloud: v('cloud_cover_mean') };
  }).filter((x) => x.max != null || x.min != null || x.precip != null);
}
async function fetchAir(lat, lon) {
  const r = await json(`${AQ}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide`);
  return r.current || null;
}
const sevRank = (s) => ({ Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 })[s] ?? 4;
async function fetchAlerts(lat, lon) {
  try {
    const r = await json(`${NWS}/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}&status=actual`, { Accept: 'application/geo+json' });
    return (r.features || []).map((f) => alertFrom(f.properties || {}, f.id)).sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  } catch { return []; }   // outside the US, or offline
}
const alertFrom = (p, id) => ({ id: id || p.id, title: p.event || 'Weather Alert', headline: p.headline || '', description: p.description || '', instruction: p.instruction || '',
  severity: p.severity || 'Unknown', urgency: p.urgency || 'Unknown', certainty: p.certainty || 'Unknown', area: p.areaDesc || '', start: p.onset || p.sent, end: p.ends || p.expires });
async function fetchPolygons(advisories) {
  const r = await json(`${NWS}/alerts/active?status=actual&message_type=alert,update`, { Accept: 'application/geo+json' });
  const feats = r.features || [];
  const isPoly = (f) => ['Polygon', 'MultiPolygon'].includes(f.geometry?.type);
  const warnings = feats.filter(isPoly);
  if (!advisories) return [warnings, []];
  // zone-coded alerts: the zone outlines (the most important alert per zone; capped to stay quick)
  const zones = new Map();
  for (const f of feats.filter((x) => !isPoly(x)).sort((a, b) => sevRank(a.properties?.severity) - sevRank(b.properties?.severity))) {
    for (const z of f.properties?.geocode?.UGC || []) if (!zones.has(z)) zones.set(z, f.properties);
  }
  const list = [...zones.entries()].slice(0, 80);
  const out = [];
  await Promise.all(list.map(async ([z, props]) => {
    try { const g = await json(`${NWS}/zones/${z[2] === 'C' ? 'county' : 'forecast'}/${z}`, { Accept: 'application/geo+json' }); if (g.geometry) out.push({ type: 'Feature', geometry: g.geometry, properties: props }); } catch { /* skip */ }
  }));
  return [warnings, out];
}
async function fetchRadar() {
  const r = await json(`${RADAR}/public/weather-maps.json?_=${Date.now()}`);
  const frames = [...(r.radar?.past || []).map((f) => ({ ...f, kind: 'past' })), ...(r.radar?.nowcast || []).map((f) => ({ ...f, kind: 'nowcast' }))].sort((a, b) => a.time - b.time);
  return { host: r.host || RADAR, frames };
}
async function search(q) {
  const r = await json(`${GEO}/search?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`);
  return r.map((x) => {
    const a = x.address || {};
    const name = a.city || a.town || a.village || a.hamlet || a.county || x.name || x.display_name.split(',')[0];
    return { name, region: [a.state, a.country].filter(Boolean).join(', '), lat: +x.lat, lon: +x.lon };
  });
}
async function reverse(lat, lon) {
  try {
    const x = await json(`${GEO}/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`);
    const a = x.address || {};
    return { name: a.city || a.town || a.village || a.county || x.name || 'Dropped Pin', region: [a.state, a.country].filter(Boolean).join(', '), lat, lon };
  } catch { return { name: 'Dropped Pin', region: `${lat.toFixed(2)}, ${lon.toFixed(2)}`, lat, lon }; }
}

/* ================================================================== formatting */
const round = (v) => (v == null || Number.isNaN(v) ? '—' : String(Math.round(v)));   // text, so 0 shows
const deg = (v) => `${round(v)}°`;
const timeIn = (t, tz, opts) => new Date(t * 1000).toLocaleTimeString([], { timeZone: tz, hour: 'numeric', minute: '2-digit', ...opts });
const hourIn = (t, tz) => new Date(t * 1000).toLocaleTimeString([], { timeZone: tz, hour: 'numeric' });
const dayIn = (t, tz) => new Date(t * 1000).toLocaleDateString([], { timeZone: tz, weekday: 'short' });
const compass = (d) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(((d % 360) + 360) % 360 / 22.5) % 16];
const AQI_LEVELS = [[50, 'Good', '#34c759'], [100, 'Moderate', '#ffcc00'], [150, 'Unhealthy for Sensitive Groups', '#ff9500'], [200, 'Unhealthy', '#ff3b30'], [300, 'Very Unhealthy', '#af52de'], [1e9, 'Hazardous', '#8e1f2f']];
const aqiLevel = (v) => AQI_LEVELS.find(([m]) => v <= m) || AQI_LEVELS.at(-1);
const UV_LEVELS = [[2, 'Low'], [5, 'Moderate'], [7, 'High'], [10, 'Very High'], [1e9, 'Extreme']];
const uvLevel = (v) => UV_LEVELS.find(([m]) => v <= m)[1];
const SEV_COLOR = { Extreme: '#d70015', Severe: '#ff3b30', Moderate: '#ff9500', Minor: '#ffcc00' };
function moon(date = new Date()) {
  const syn = 29.530588853, ref = Date.UTC(2000, 0, 6, 18, 14) / 864e5;
  const p = (((date.getTime() / 864e5 - ref) / syn) % 1 + 1) % 1;
  const illum = (1 - Math.cos(2 * Math.PI * p)) / 2;
  const names = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
  const next = (target) => { let d = ((target - p + 1) % 1) * syn; if (d < 0.5) d += syn; return new Date(date.getTime() + d * 864e5); };
  return { p, illum, name: names[Math.round(p * 8) % 8], nextFull: next(0.5), nextNew: next(0) };
}

/* ================================================================== the app */
registerApp({
  id: 'weather', settings: 'weather', name: 'Weather', size: [1120, 740], minSize: [760, 520], overlayContent: true, hideTitle: true, className: 'weather-win sv-win',
  keywords: ['forecast', 'temperature', 'rain', 'radar', 'stormview', 'alerts', 'air quality'],
  open(win) {
    const S = {
      loc: store.get('weatherCity'), data: null, air: null, alerts: [], radar: { host: RADAR, frames: [] }, idx: -1,
      playing: false, progress: null, err: null, loading: false, mapReady: false,
    };
    let disposed = false;
    const timers = [];

    /* ---------------- map frame + bridge */
    const frame = h('iframe.sv-map', { src: 'weather-map/map.html', title: 'Weather map' });
    let callId = 0;
    const pending = new Map();
    const sv = (name, ...args) => { frame.contentWindow?.postMessage({ sv: name, args }, '*'); };
    const svCall = (name, ...args) => new Promise((res) => { const id = ++callId; pending.set(id, res); frame.contentWindow?.postMessage({ sv: name, args, id }, '*'); setTimeout(() => pending.delete(id) && res(null), 2000); });
    const onMsg = (e) => {
      if (e.source !== frame.contentWindow || !e.data?.svMap) return;
      const m = e.data;
      if (m.type === 'loaded') initMap();
      else if (m.type === 'result') { pending.get(m.id)?.(m.value); pending.delete(m.id); }
      else if (m.type === 'radarProgress') { S.progress = m; drawScrubber(); }
      else if (m.type === 'contextMenu') mapMenu(m);
      else if (m.type === 'mapClick') { if (m.overlay === 'aqi') aqiProbe(m); }
      else if (m.type === 'alertClick') alertSheet(alertFrom(m.properties));
      else if (m.type === 'log') console.warn('[weather map]', m.message);
    };
    addEventListener('message', onMsg);
    const mapTheme = () => (theme.dark ? 'dark' : 'light');
    function initMap() {
      S.mapReady = true;
      sv('init', { theme: mapTheme(), baseMap: store.get('svBaseMap'), accent: store.get('accent'), center: S.loc ? [S.loc.lat, S.loc.lon] : undefined, zoom: 7 });
      sv('setSatellite', !!store.get('svSatellite'));
      sv('setOverlay', store.get('svOverlay'));
      if (S.loc) sv('setLocation', S.loc, false);
      pushRadar();
      loadPolygons();
    }

    /* ---------------- layout */
    const ui = h('div.sv-ui');
    const column = h('div.sv-column');
    const main = h('div.sv-main');
    const topRow = h('div.sv-top');
    const banner = h('div.sv-banner-slot');
    const controls = h('div.sv-controls.glass');
    const radarPanel = h('div.sv-radar-panel.glass');
    const chip = h('div.sv-chip.glass');
    const scrubber = h('div.sv-scrubber.glass');
    const leftStack = h('div.sv-left', chip, radarPanel);
    topRow.append(leftStack, h('div.sv-grow'), banner, h('div.sv-grow'), controls);
    main.append(topRow, h('div.sv-grow'), scrubber);
    ui.append(column, main);
    const root = h('div.sv', frame, ui);
    win.body.append(root);

    // toolbar: panel toggle · Weather/Radar · search · refresh · settings
    const panelBtn = h('button.tb-btn', { html: sym.sidebar, title: 'Show or hide the weather panel', onclick: () => {
      if (store.get('svMode') === 'radar') { store.set('svMode', 'weather'); store.set('svShowPanel', true); } else store.set('svShowPanel', !store.get('svShowPanel'));
    } });
    const seg = h('div.sv-seg', ...[['weather', 'Weather', sym.sun], ['radar', 'Radar', sym.layers]].map(([m, l, ic]) => h('button', { 'data-m': m, html: ic + `<span>${l}</span>`, onclick: () => store.set('svMode', m) })));
    const input = h('input.field', { placeholder: 'Search city or place' });
    const results = h('div.sv-results.glass.panel', { hidden: true });
    const searchBox = h('div.sv-search.no-drag', h('div.search-field', { html: sym.search }, input), results);
    win.toolbar.append(h('div.tb-group', panelBtn), h('div.spacer'), seg, h('div.spacer'), searchBox,
      h('div.tb-group', h('button.tb-btn', { html: sym.refresh, title: 'Refresh weather, alerts and radar', onclick: () => refreshAll(true) }),
        h('button.tb-btn', { html: sym.gear, title: 'Weather settings', onclick: () => import('./settings.js').then((m) => m.openAppSettings('weather')) })));

    function layout() {
      const mode = store.get('svMode'), showCol = mode === 'weather' && store.get('svShowPanel');
      root.dataset.side = store.get('svPanelSide');
      root.dataset.mode = mode;
      column.hidden = !showCol;
      leftStack.hidden = mode !== 'radar';
      scrubber.hidden = store.get('svOverlay') !== 'radar';
      $$('button', seg).forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    }

    /* ---------------- search */
    const showResults = (list, title) => {
      results.innerHTML = '';
      if (title) results.append(h('div.sv-res-title', title));
      for (const r of list) results.append(h('div.sv-res', { onclick: () => { results.hidden = true; input.value = ''; input.blur(); setLocation(r, true); } }, h('b', r.name), h('small', r.region || `${r.lat.toFixed(2)}, ${r.lon.toFixed(2)}`)));
      results.hidden = !list.length;
    };
    input.addEventListener('focus', () => { if (!input.value.trim()) showResults(store.get('svRecent') || [], 'Recent'); });
    input.addEventListener('blur', () => setTimeout(() => (results.hidden = true), 180));
    input.addEventListener('input', debounce(async () => {
      const q = input.value.trim();
      if (!q) return showResults(store.get('svRecent') || [], 'Recent');
      try { showResults(await search(q)); } catch { showResults([]); }
    }, 350));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') results.querySelector('.sv-res')?.click(); if (e.key === 'Escape') { input.value = ''; input.blur(); } });

    function setLocation(loc, fly) {
      S.loc = { name: loc.name, region: loc.region || '', lat: loc.lat, lon: loc.lon };
      store.set('weatherCity', S.loc);
      store.set('svRecent', [S.loc, ...(store.get('svRecent') || []).filter((r) => Math.abs(r.lat - S.loc.lat) > 0.01 || Math.abs(r.lon - S.loc.lon) > 0.01)].slice(0, 6));
      if (S.mapReady) sv('setLocation', S.loc, fly);
      S.data = null; S.air = null; S.alerts = [];
      drawAll();
      refreshWeather();
      refreshAlerts();
    }

    /* ---------------- refresh loops */
    async function refreshWeather() {
      if (!S.loc) return drawAll();
      S.loading = true; drawColumn();
      try {
        const loc = S.loc;
        const [d, a] = await Promise.all([fetchWeather(loc, useF()), fetchAir(loc.lat, loc.lon).catch(() => null)]);
        if (disposed || loc !== S.loc) return;
        S.data = d; S.air = a; S.err = null;
        win.setTitle?.(`Weather — ${loc.name}`);
      } catch (e) { S.err = navigator.onLine === false ? 'You’re offline.' : 'Couldn’t load the weather.'; }
      S.loading = false;
      drawAll();
    }
    async function refreshAlerts() { if (!S.loc) return; S.alerts = await fetchAlerts(S.loc.lat, S.loc.lon); if (!disposed) { drawBanner(); drawColumn(); } }
    async function loadPolygons() {
      if (!S.mapReady) return;
      try { const [w, a] = await fetchPolygons(!!store.get('svAdvisories')); if (!disposed) sv('setAlertPolygons', w, a); } catch { /* keep the old ones */ }
    }
    async function refreshRadar() {
      try {
        const r = await fetchRadar();
        const wasLive = S.idx < 0 || S.idx === nowIndex();
        S.radar = r;
        if (wasLive || S.idx >= r.frames.length) S.idx = nowIndex();
        pushRadar();
      } catch { /* keep the old frames */ }
    }
    function refreshAll() { refreshWeather(); refreshAlerts(); refreshRadar(); loadPolygons(); }
    timers.push(setInterval(refreshWeather, 10 * 60_000), setInterval(refreshAlerts, 90_000), setInterval(refreshRadar, 5 * 60_000), setInterval(loadPolygons, 5 * 60_000));

    /* ---------------- radar */
    const nowIndex = () => { const f = S.radar.frames; let i = -1; f.forEach((x, k) => { if (x.kind === 'past') i = k; }); return i < 0 ? f.length - 1 : i; };
    function pushRadar() {
      if (!S.mapReady || !S.radar.frames.length) return drawScrubber();
      sv('setRadar', { host: S.radar.host, frames: S.radar.frames, cs: store.get('svScheme'), size: 512, smooth: store.get('svSmooth') ? 1 : 0, snow: store.get('svSnow') ? 1 : 0,
        arrows: null, opacity: store.get('svOpacity'), index: S.idx < 0 ? nowIndex() : S.idx });
      drawScrubber();
    }
    function showFrame(i) { const n = S.radar.frames.length; if (!n) return; S.idx = ((i % n) + n) % n; sv('showFrame', S.idx); drawScrubber(); }
    let playTimer = null;
    function play(on) {
      S.playing = on; clearTimeout(playTimer);
      const step = () => {
        if (!S.playing) return;
        const last = S.idx >= S.radar.frames.length - 1;
        showFrame(last ? 0 : S.idx + 1);
        playTimer = setTimeout(step, (S.idx >= S.radar.frames.length - 1 ? 1300 : 520) / (store.get('svSpeed') || 1));
      };
      if (on) playTimer = setTimeout(step, 200);
      drawScrubber();
    }

    function drawScrubber() {
      const f = S.radar.frames, n = f.length;
      scrubber.innerHTML = '';
      if (!n) { scrubber.append(h('span.sv-muted', 'Loading radar…')); return; }
      const cur = f[S.idx < 0 ? nowIndex() : S.idx], ni = nowIndex();
      const mins = Math.round((cur.time - f[ni].time) / 60);
      const when = new Date(cur.time * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const track = h('div.sv-track');
      const nowPct = (ni / Math.max(1, n - 1)) * 100;
      track.append(h('i.sv-track-past', { style: { width: nowPct + '%' } }), h('i.sv-track-cast', { style: { left: nowPct + '%', right: 0 } }));
      for (let i = 0; i < n; i++) track.append(h('i.sv-tick' + (f[i].kind === 'nowcast' ? '.cast' : ''), { style: { left: (i / Math.max(1, n - 1)) * 100 + '%' } }));
      track.append(h('i.sv-knob', { style: { left: ((S.idx < 0 ? ni : S.idx) / Math.max(1, n - 1)) * 100 + '%' } }));
      const pick = (e) => { const r = track.getBoundingClientRect(); showFrame(Math.round(clamp((e.clientX - r.left) / r.width, 0, 1) * (n - 1))); };
      track.addEventListener('mousedown', (e) => { play(false); pick(e); const mv = (ev) => pick(ev); const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); }; addEventListener('mousemove', mv); addEventListener('mouseup', up); });
      const sp = store.get('svSpeed') || 1;
      const prog = S.progress && S.progress.total && S.progress.ready < S.progress.total ? `Loading ${S.progress.ready}/${S.progress.total}` : '';
      scrubber.append(
        h('button.sv-play', { html: S.playing ? sym.pause : sym.play, title: 'Play / pause (Space)', onclick: () => play(!S.playing) }),
        h('div.sv-scrub-mid', track, h('div.sv-scrub-info', h('b', when), h('span', mins === 0 ? 'Now' : mins > 0 ? `+${mins} min · forecast` : `${mins} min`), prog ? h('span.sv-muted', prog) : null)),
        h('button.sv-chipbtn', { title: 'Playback speed', onclick: () => { store.set('svSpeed', sp === 1 ? 2 : sp === 2 ? 0.5 : 1); drawScrubber(); } }, sp === 0.5 ? '½×' : sp + '×'),
        h('button.sv-chipbtn', { title: 'Jump to now', onclick: () => { play(false); showFrame(nowIndex()); } }, 'Now'));
    }

    /* ---------------- map controls, chip, radar panel, banner */
    function drawControls() {
      controls.innerHTML = '';
      const aqi = store.get('svOverlay') === 'aqi';
      controls.append(
        h('button', { html: sym.plus, title: 'Zoom in', onclick: () => sv('zoomIn') }),
        h('button', { html: sym.minus, title: 'Zoom out', onclick: () => sv('zoomOut') }),
        h('i.sv-sep'),
        h('button', { html: sym.location, title: 'Center on the weather location', onclick: () => S.loc && sv('flyTo', S.loc.lat, S.loc.lon, 8) }),
        h('button' + (aqi ? '.on' : ''), { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h8"/></svg>', title: aqi ? 'Show radar' : 'Show air quality', onclick: () => store.set('svOverlay', aqi ? 'radar' : 'aqi') }),
      );
    }
    function drawChip() {
      chip.innerHTML = '';
      if (!S.data) { chip.append(h('span.sv-muted', S.loc ? 'Loading…' : 'No location')); return; }
      const d = describe(S.data.current.code, S.data.current.day);
      chip.append(h('span.sv-chip-ic', { html: d.icon }), h('b', deg(S.data.current.temp)), h('span', d.label), h('small.sv-muted', S.loc?.name || ''));
    }
    function drawRadarPanel() {
      radarPanel.innerHTML = '';
      const row = (label, ctl) => h('div.sv-rp-row', h('span', label), ctl);
      const tog = (key, after) => h('label.toggle', h('input', { type: 'checkbox', checked: !!store.get(key), onchange: (e) => { store.set(key, e.target.checked); after?.(); } }), h('span'));
      const sel = h('select.field.square', { onchange: (e) => store.set('svScheme', +e.target.value) }, ...SCHEMES.map(([v, l]) => h('option', { value: v, selected: store.get('svScheme') === v }, l)));
      const op = h('input.slider', { type: 'range', min: 20, max: 100, value: Math.round(store.get('svOpacity') * 100) });
      const paint = () => op.style.setProperty('--v', ((op.value - 20) / 80) * 100 + '%'); paint();
      op.addEventListener('input', () => { paint(); sv('setOpacity', op.value / 100); });
      op.addEventListener('change', () => store.set('svOpacity', op.value / 100));
      const base = h('div.sv-mini-seg', ...[['muted', 'Muted'], ['streets', 'Streets']].map(([v, l]) => h('button' + (store.get('svBaseMap') === v ? '.on' : ''), { onclick: () => store.set('svBaseMap', v) }, l)));
      radarPanel.append(h('div.sv-rp-title', 'Radar'), row('Colors', sel), row('Opacity', op), row('Map', base),
        row('Satellite', tog('svSatellite')), row('Smoothing', tog('svSmooth')), row('Snow colors', tog('svSnow')));
    }
    function drawBanner() {
      banner.innerHTML = '';
      const a = S.alerts[0];
      if (!a) return;
      banner.append(h('div.sv-banner.glass', { style: { '--sev': SEV_COLOR[a.severity] || '#ff9500' }, onclick: () => alertSheet(a) },
        h('span.sv-banner-dot'), h('b', a.title), S.alerts.length > 1 ? h('small', `+${S.alerts.length - 1} more`) : null));
    }

    /* ---------------- popovers inside the window */
    function overlayCard(x, y, content, w = 260) {
      $('.sv-popover', root)?.remove();
      const r = frame.getBoundingClientRect(), rr = root.getBoundingClientRect();
      const pop = h('div.sv-popover.glass.panel', { style: { left: clamp(r.left - rr.left + x, 8, rr.width - w - 8) + 'px', top: clamp(r.top - rr.top + y, 60, rr.height - 220) + 'px', width: w + 'px' } }, content);
      root.append(pop);
      const off = (e) => { if (!pop.contains(e.target)) { pop.remove(); removeEventListener('mousedown', off, true); } };
      setTimeout(() => addEventListener('mousedown', off, true), 0);
      return pop;
    }
    function mapMenu(m) {
      const r = frame.getBoundingClientRect();
      showMenu([
        { label: 'Set as Weather Location', action: async () => setLocation(await reverse(m.lat, m.lon), false) },
        { label: 'Center Map Here', action: () => sv('panTo', m.lat, m.lon) },
        '-',
        { label: 'Copy Coordinates', action: () => navigator.clipboard.writeText(`${m.lat.toFixed(5)}, ${m.lon.toFixed(5)}`).catch(() => {}) },
        { label: 'Open in OpenStreetMap', action: () => import('../wm.js').then(({ wm }) => wm.open('browser', { url: `https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lon}#map=11/${m.lat}/${m.lon}` })) },
      ], r.left + m.x, r.top + m.y, { onClose: () => sv('clearContextMark') });
    }
    async function aqiProbe(m) {
      const pop = overlayCard(m.x + 12, m.y + 12, h('div.sv-muted', 'Reading air quality…'));
      try {
        const a = await fetchAir(m.lat, m.lon);
        const [, label, color] = aqiLevel(a.us_aqi);
        pop.innerHTML = '';
        pop.append(h('div.sv-card-title', 'Air Quality Here'), h('div.sv-aqi-big', { style: { color } }, round(a.us_aqi)), h('b', label),
          h('div.sv-kv', ...[['PM2.5', a.pm2_5, 'µg/m³'], ['PM10', a.pm10, 'µg/m³'], ['Ozone', a.ozone, 'µg/m³'], ['NO₂', a.nitrogen_dioxide, 'µg/m³']].map(([k, v, u]) => h('div', h('span', k), h('b', `${round(v)} ${u}`)))),
          h('small.sv-muted', `${m.lat.toFixed(3)}, ${m.lon.toFixed(3)}`));
      } catch { pop.innerHTML = ''; pop.append(h('div.sv-muted', 'No air-quality data here.')); }
    }
    function alertSheet(a) {
      const fmt = (s) => (s ? new Date(s).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }) : '—');
      $('.sv-sheet-layer', root)?.remove();
      const layer = h('div.sv-sheet-layer', { onclick: (e) => { if (e.target === layer) layer.remove(); } },
        h('div.sv-sheet.glass.panel', { style: { '--sev': SEV_COLOR[a.severity] || '#ff9500' } },
          h('div.sv-sheet-head', h('span.sv-banner-dot'), h('h2', a.title), h('button.sv-x', { html: sym.close, onclick: () => layer.remove() })),
          a.headline ? h('p.sv-headline', a.headline) : null,
          h('div.sv-tags', ...[a.severity, a.urgency, a.certainty].map((t) => h('span', t))),
          h('div.sv-kv', h('div', h('span', 'From'), h('b', fmt(a.start))), h('div', h('span', 'Until'), h('b', fmt(a.end)))),
          a.area ? h('p.sv-area', a.area) : null,
          h('div.sv-sheet-body', a.description ? h('pre', a.description) : null, a.instruction ? h('div', h('h4', 'What to do'), h('pre', a.instruction)) : null)));
      root.append(layer);
    }

    function sheet(title, ...kids) {
      $('.sv-sheet-layer', root)?.remove();
      const layer = h('div.sv-sheet-layer', { onclick: (e) => { if (e.target === layer) layer.remove(); } },
        h('div.sv-sheet.glass.panel', h('div.sv-sheet-head', h('h2', title), h('button.sv-x', { html: sym.close, onclick: () => layer.remove() })), ...kids));
      root.append(layer);
    }
    const units = (d) => ({ speed: d.imperial ? 'mph' : 'km/h', precip: d.imperial ? 'in' : 'mm', dist: d.imperial ? 'mi' : 'km' });
    function hourSheet(d, x) {
      const u = units(d), ds = describe(x.code, x.day);
      const vis = x.vis == null ? '—' : `${round(d.imperial ? x.vis / 1609 : x.vis / 1000)} ${u.dist}`;
      const cells = [['Feels Like', deg(x.feels)], ['Precip. Chance', `${x.pop}%`], ['Precip. Amount', `${(x.precip ?? 0).toFixed(d.imperial ? 2 : 1)} ${u.precip}`], ['UV Index', `${round(x.uv)} · ${uvLevel(x.uv ?? 0)}`],
        ['Wind', `${compass(x.dir)} ${round(x.wind)} ${u.speed}`], ['Humidity', `${round(x.hum)}%`], ['Pressure', `${round(x.pressure)} hPa`], ['Visibility', vis]];
      sheet(new Date(x.t * 1000).toLocaleString([], { timeZone: d.tz, weekday: 'long', hour: 'numeric' }),
        h('div.sv-hs-top', h('i', { html: ds.icon }), h('div', h('div.sv-big', deg(x.temp)), h('b', ds.label))),
        h('div.sv-grid', ...cells.map(([k, v]) => h('div.sv-tile', h('small.sv-muted', k), h('b', v)))));
    }
    function precipSheet(d) {
      const u = units(d), today = d.hourly.slice(d.hi, d.hi + 24);
      const peak = Math.max(0, ...today.map((x) => x.pop));
      sheet('Precipitation',
        h('div.sv-grid', h('div.sv-tile', h('small.sv-muted', 'Total Today'), h('b', `${(d.daily[0].precip ?? 0).toFixed(d.imperial ? 2 : 1)} ${u.precip}`)), h('div.sv-tile', h('small.sv-muted', 'Peak Chance (24h)'), h('b', `${peak}%`))),
        h('div.sv-plist', ...today.map((x) => h('div.sv-prow', h('span', hourIn(x.t, d.tz)), h('i', { html: describe(x.code, x.day).icon }),
          h('div.sv-pbar', h('b', { style: { width: x.pop + '%' } })), h('span', `${x.pop}%`), h('small.sv-muted', x.precip ? `${x.precip.toFixed(d.imperial ? 2 : 1)} ${u.precip}` : '')))));
    }
    let openDay = -1;
    function dayDetail(d, x, i) {
      const u = units(d);
      const start = x.t, end = d.daily[i + 1]?.t ?? x.t + 86400, now = Date.now() / 1000;
      const hours = d.hourly.filter((y) => y.t >= start && y.t < end && (i > 0 || y.t >= now - 3600));
      const all = d.hourly.filter((y) => y.t >= start && y.t < end);
      const avg = (k) => { const v = all.map((y) => y[k]).filter((n) => Number.isFinite(n)); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
      const strip = h('div.sv-hourly.sv-dd-hours', ...hours.map((y) => h('button.sv-hour', { onclick: (e) => { e.stopPropagation(); hourSheet(d, y); } },
        h('small', hourIn(y.t, d.tz)), h('i', { html: describe(y.code, y.day).icon }), h('small.sv-pop', y.pop >= 10 ? `${y.pop}%` : ''), h('b', deg(y.temp)))));
      const items = [['Max Wind', `${round(x.wind)} ${u.speed}`, `Gusts ${round(x.gust)} ${u.speed}`], ['UV Index', `${round(x.uv)} · ${uvLevel(x.uv ?? 0)}`],
        ['Precipitation', x.precip > 0 ? `${x.precip.toFixed(d.imperial ? 2 : 1)} ${u.precip}` : `${x.pop}%`, x.precip > 0 ? `${x.pop}% chance` : ''],
        ['Feels Like', deg(x.feelsMax), `Low ${deg(x.feelsMin)}`], ['Sunrise', timeIn(x.sunrise, d.tz)], ['Sunset', timeIn(x.sunset, d.tz)],
        ['Avg Humidity', avg('hum') == null ? '—' : `${avg('hum')}%`], ['Avg Pressure', avg('pressure') == null ? '—' : `${avg('pressure')} hPa`]];
      return h('div.sv-dd', { onclick: (e) => e.stopPropagation() }, h('div.sv-dd-label', 'Hourly'), hours.length ? strip : h('small.sv-muted', 'No hourly data for this day'),
        h('div.sv-dd-label', 'Details'), h('div.sv-grid', ...items.map(([k, v, sub]) => h('div.sv-tile', h('small.sv-muted', k), h('b', v), sub ? h('small.sv-muted', sub) : null))));
    }

    /* ---------------- cards */
    const card = (title, icon, ...kids) => h('section.sv-card.glass', title ? h('div.sv-card-title', icon ? h('span', { html: icon }) : null, title) : null, ...kids);
    const ICON = {
      hourly: sym.clock, daily: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
      sun: sym.sun, details: sym.list, aqi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h8"/></svg>',
      wind: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h8"/></svg>',
      feels: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 14.5V4a2 2 0 1 1 4 0v10.5a4 4 0 1 1-4 0z"/></svg>',
      precip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/></svg>',
      daylight: sym.sunDim, uv: sym.sun, moon: sym.moon, outlook: sym.doc, alerts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10.3 3.9 1.8 18.6A2 2 0 0 0 3.5 21.6h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4.5M12 17.2v.3"/></svg>',
    };
    function hero(d) {
      const c = d.current, today = d.daily[0], dd = describe(c.code, c.day);
      return h('section.sv-card.glass.sv-hero',
        h('div.sv-hero-top', h('div', h('div.sv-place', S.loc?.name || ''), h('small.sv-muted', S.loc?.region || '')), S.loading ? h('span.sv-spin') : null),
        h('div.sv-hero-main', h('div.sv-hero-temp', deg(c.temp)), h('div.sv-hero-ic', { html: dd.icon })),
        h('div.sv-hero-cond', dd.label),
        h('div.sv-hero-sub', `H:${deg(today.max)}  L:${deg(today.min)}  ·  Feels like ${deg(c.feels)}${c.pop >= 20 ? `  ·  ${c.pop}% chance of precipitation` : ''}`));
    }
    const R = {
      alerts(d) {
        if (!S.alerts.length) return null;
        return card('Alerts', ICON.alerts, ...S.alerts.map((a) => h('div.sv-alert', { style: { '--sev': SEV_COLOR[a.severity] || '#ff9500' }, onclick: () => alertSheet(a) },
          h('span.sv-banner-dot'), h('div', h('b', a.title), h('small.sv-muted', a.end ? `Until ${new Date(a.end).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : a.severity)))));
      },
      hourly(d) {
        const row = h('div.sv-hourly');
        d.hourly.slice(d.hi, d.hi + 25).forEach((x, i) => {
          const ds = describe(x.code, x.day);
          row.append(h('button.sv-hour', { title: 'Details', onclick: () => hourSheet(d, x) }, h('small', i === 0 ? 'Now' : hourIn(x.t, d.tz)), h('i', { html: ds.icon }), h('small.sv-pop', x.pop >= 10 ? `${x.pop}%` : ''), h('b', deg(x.temp))));
        });
        return card('Hourly Forecast', ICON.hourly, row);
      },
      daily(d) {
        const lo = Math.min(...d.daily.map((x) => x.min)), hi = Math.max(...d.daily.map((x) => x.max)), span = Math.max(1, hi - lo);
        return card('7-Day Forecast', ICON.daily, ...d.daily.map((x, i) => {
          const ds = describe(x.code, 1);
          const bar = h('div.sv-range', h('i', { style: { left: ((x.min - lo) / span) * 100 + '%', right: (100 - ((x.max - lo) / span) * 100) + '%' } }));
          if (i === 0) bar.append(h('b.sv-now-dot', { style: { left: clamp(((d.current.temp - lo) / span) * 100, 0, 100) + '%' } }));
          const open = openDay === i;
          const rowEl = h('button.sv-day' + (open ? '.open' : ''), { onclick: () => { openDay = open ? -1 : i; drawColumn(); } },
            h('span.sv-dname', i === 0 ? 'Today' : dayIn(x.t, d.tz)), h('i.sv-dic', { html: ds.icon }), h('span.sv-dpop', x.pop >= 10 ? `${x.pop}%` : ''), h('span.sv-lo', deg(x.min)), bar, h('span', deg(x.max)), h('span.sv-chev', { html: sym.chevronDown }));
          return open ? h('div.sv-day-wrap', rowEl, dayDetail(d, x, i)) : rowEl;
        }));
      },
      future(d) {
        const out = h('div.sv-future-out');
        const min = new Date(Date.now() + 17 * 864e5), max = new Date(Date.now() + 210 * 864e5);
        const input = h('input.field', { type: 'date', min: isoDay(min), max: isoDay(max), onchange: async (e) => {
          if (!e.target.value) return out.replaceChildren();
          out.replaceChildren(h('small.sv-muted', 'Loading…'));
          try {
            const [x] = await fetchSeasonal(S.loc, e.target.value, e.target.value, d.imperial);
            if (!x) return out.replaceChildren(h('small.sv-muted', 'No outlook for that date yet.'));
            const u = units(d);
            out.replaceChildren(h('div.sv-aqi-row', h('div.sv-big', deg(x.mean ?? x.max)), h('div', h('b', `H:${deg(x.max)}  L:${deg(x.min)}`), h('small.sv-muted', { rain: 'Rain', showers: 'Showers', snow: 'Snow', none: 'Dry' }[x.type] || ''))),
              h('div.sv-kv', h('div', h('span', 'Precipitation'), h('b', `${(x.precip ?? 0).toFixed(d.imperial ? 2 : 1)} ${u.precip}`)), h('div', h('span', 'Wind'), h('b', `${round(x.wind)} ${u.speed}`)),
                h('div', h('span', 'Humidity'), h('b', `${round(x.hum)}%`)), h('div', h('span', 'Cloud Cover'), h('b', `${round(x.cloud)}%`))),
              h('small.sv-muted', 'A long-range statistical outlook, not a precise forecast.'));
          } catch { out.replaceChildren(h('small.sv-muted', 'Couldn’t load the outlook.')); }
        } });
        return card('Future Weather', ICON.daily, h('small.sv-muted', 'Pick a date 17 days to 7 months ahead to see its outlook.'), input, out);
      },
      month(d) {
        const out = h('div.sv-month-out');
        const now = new Date(), opts = [];
        for (let k = 0; k < 8; k++) { const m = new Date(now.getFullYear(), now.getMonth() + k, 1); opts.push([`${m.getFullYear()}-${m.getMonth()}`, m.toLocaleDateString([], { month: 'long', year: 'numeric' }), m]); }
        const sel = h('select.field.square', { onchange: async (e) => {
          const o = opts.find((x) => x[0] === e.target.value);
          if (!o) return out.replaceChildren();
          const m = o[2], first = new Date(m), last = new Date(m.getFullYear(), m.getMonth() + 1, 0);
          const start = new Date(Math.max(first.getTime(), Date.now() + 864e5)), end = new Date(Math.min(last.getTime(), Date.now() + 210 * 864e5));
          out.replaceChildren(h('small.sv-muted', 'Loading…'));
          try {
            const days = await fetchSeasonal(S.loc, isoDay(start), isoDay(end), d.imperial);
            if (!days.length) return out.replaceChildren(h('small.sv-muted', 'No outlook for that month yet.'));
            const firstSnow = days.findIndex((x) => x.type === 'snow');
            out.replaceChildren(...days.map((x, i) => {
              const dt = new Date(x.date + 'T00:00:00');
              return h('div.sv-mrow' + (i === firstSnow ? '.flag' : ''), h('span', dt.toLocaleDateString([], { weekday: 'short' })), h('b', dt.getDate()),
                h('span.sv-mtype', { rain: '🌧 Rain', showers: '🌦 Showers', snow: '❄ Snow', none: 'Dry' }[x.type] || ''), h('span.sv-lo', deg(x.min)), h('span', deg(x.max)));
            }));
          } catch { out.replaceChildren(h('small.sv-muted', 'Couldn’t load the outlook.')); }
        } }, h('option', { value: '' }, 'Select a month…'), ...opts.map(([v, l]) => h('option', { value: v }, l)));
        return card('Month Outlook', ICON.daily, h('small.sv-muted', 'Every day of a month: high, low and precipitation. A long-range estimate.'), sel, out);
      },
      sun(d) {
        const t = d.daily[0], now = Date.now() / 1000, p = clamp((now - t.sunrise) / (t.sunset - t.sunrise), 0, 1);
        const ang = Math.PI * (1 - p), cx = 100 + 80 * Math.cos(ang), cy = 70 - 55 * Math.sin(ang);
        const up = now >= t.sunrise && now <= t.sunset;
        return card('Sunrise & Sunset', ICON.sun,
          h('div.sv-sunarc', { html: `<svg viewBox="0 0 200 80"><path d="M20 70 A80 55 0 0 1 180 70" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2" stroke-dasharray="4 4"/><line x1="0" y1="70" x2="200" y2="70" stroke="currentColor" stroke-opacity=".2"/>${up ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="7" fill="#ffcc00"/>` : ''}</svg>` }),
          h('div.sv-kv', h('div', h('span', 'Sunrise'), h('b', timeIn(t.sunrise, d.tz))), h('div', h('span', 'Sunset'), h('b', timeIn(t.sunset, d.tz)))));
      },
      details(d) {
        const c = d.current, imp = d.imperial;
        const vis = c.vis == null ? '—' : imp ? `${round(c.vis / 1609)} mi` : `${round(c.vis / 1000)} km`;
        const pr = c.pressure == null ? '—' : imp ? `${(c.pressure * 0.02953).toFixed(2)} inHg` : `${round(c.pressure)} hPa`;
        const items = [['Humidity', `${round(c.hum)}%`], ['Dew Point', deg(c.dew)], ['Pressure', pr], ['Visibility', vis], ['Cloud Cover', `${round(c.cloud)}%`],
          ['Wind Gusts', `${round(c.gust)} ${imp ? 'mph' : 'km/h'}`], ['Precip Today', `${(d.daily[0].precip ?? 0).toFixed(imp ? 2 : 1)} ${imp ? 'in' : 'mm'}`], ['UV Index', round(c.uv)]];
        return card('Details', ICON.details, h('div.sv-grid', ...items.map(([k, v]) => h('div.sv-tile', h('small.sv-muted', k), h('b', v)))));
      },
      aqi() {
        const a = S.air;
        if (!a || a.us_aqi == null) return card('Air Quality', ICON.aqi, h('small.sv-muted', 'No air-quality data for this place.'));
        const [, label, color] = aqiLevel(a.us_aqi);
        return card('Air Quality', ICON.aqi, h('div.sv-aqi-row', h('div.sv-aqi-big', { style: { color } }, round(a.us_aqi)), h('div', h('b', label), h('small.sv-muted', 'US AQI'))),
          h('div.sv-scale.aqi', h('b', { style: { left: clamp((a.us_aqi / 300) * 100, 0, 100) + '%' } })),
          h('div.sv-kv', ...[['PM2.5', a.pm2_5], ['PM10', a.pm10], ['Ozone', a.ozone], ['NO₂', a.nitrogen_dioxide]].map(([k, v]) => h('div', h('span', k), h('b', `${round(v)} µg/m³`)))));
      },
      wind(d) {
        const c = d.current, u = d.imperial ? 'mph' : 'km/h';
        return card('Wind', ICON.wind, h('div.sv-wind',
          h('div.sv-compass', { html: `<svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" fill="none" stroke="currentColor" stroke-opacity=".2" stroke-width="2"/>${Array.from({ length: 36 }, (_, i) => { const a = (i * 10 * Math.PI) / 180, r1 = i % 9 === 0 ? 44 : 48; return `<line x1="${60 + r1 * Math.sin(a)}" y1="${60 - r1 * Math.cos(a)}" x2="${60 + 52 * Math.sin(a)}" y2="${60 - 52 * Math.cos(a)}" stroke="currentColor" stroke-opacity="${i % 9 === 0 ? 0.7 : 0.25}"/>`; }).join('')}<text x="60" y="26" text-anchor="middle" font-size="11" fill="currentColor" font-weight="700">N</text><text x="98" y="64" text-anchor="middle" font-size="10" fill="currentColor" opacity=".6">E</text><text x="60" y="102" text-anchor="middle" font-size="10" fill="currentColor" opacity=".6">S</text><text x="22" y="64" text-anchor="middle" font-size="10" fill="currentColor" opacity=".6">W</text><g transform="rotate(${(c.dir + 180) % 360} 60 60)"><path d="M60 22 L67 40 L60 35 L53 40 Z" fill="var(--accent)"/><line x1="60" y1="35" x2="60" y2="92" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"/></g></svg>` }),
          h('div', h('div.sv-big', round(c.wind), h('small', ` ${u}`)), h('small.sv-muted', `From the ${compass(c.dir)} (${round(c.dir)}°)`), h('div', h('small.sv-muted', 'Gusts '), h('b', `${round(c.gust)} ${u}`)))));
      },
      feels(d) {
        const c = d.current, diff = Math.round(c.feels - c.temp);
        const why = Math.abs(diff) < 2 ? 'Similar to the actual temperature.' : diff < 0 ? (c.wind > (d.imperial ? 10 : 16) ? 'Wind is making it feel cooler.' : 'It feels cooler than it is.') : c.hum > 60 ? 'Humidity is making it feel warmer.' : 'It feels warmer than it is.';
        return card('Feels Like', ICON.feels, h('div.sv-big', deg(c.feels)), h('small.sv-muted', why));
      },
      precip(d) {
        const next = d.hourly.slice(d.hi, d.hi + 24);
        const first = next.find((x) => x.pop >= 40);
        const total = d.daily[0].precip ?? 0;
        const text = first ? `${describe(first.code, first.day).label} likely around ${hourIn(first.t, d.tz)} (${first.pop}%).` : 'No precipitation expected in the next 24 hours.';
        const el = card('Precipitation', ICON.precip, h('p.sv-text', text),
          h('div.sv-bars', ...next.map((x, i) => h('i', { title: `${hourIn(x.t, d.tz)}: ${x.pop}%`, style: { height: Math.max(3, x.pop) + '%', opacity: i === 0 ? 1 : 0.85 } }))),
          h('div.sv-bars-axis', h('small', 'Now'), h('small', '+12h'), h('small', '+24h')),
          h('small.sv-muted', `Today: ${total.toFixed(d.imperial ? 2 : 1)} ${d.imperial ? 'in' : 'mm'}${d.daily[0].snow ? ` · snow ${d.daily[0].snow.toFixed(1)} ${d.imperial ? 'in' : 'cm'}` : ''} · click for details`));
        el.classList.add('sv-clickable'); el.onclick = () => precipSheet(d);
        return el;
      },
      daylight(d) {
        const t = d.daily[0], t2 = d.daily[1], len = t.sunset - t.sunrise, now = Date.now() / 1000;
        const hm = (s) => `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
        const change = t2 ? (t2.sunset - t2.sunrise) - len : 0;
        const left = now < t.sunset && now > t.sunrise ? t.sunset - now : 0;
        return card('Daylight', ICON.daylight, h('div.sv-big', hm(len)),
          h('small.sv-muted', `${change >= 0 ? '+' : '−'}${Math.abs(Math.round(change / 60))} min tomorrow${left ? ` · ${hm(left)} of daylight left` : ''}`));
      },
      uv(d) {
        const v = d.current.uv ?? 0;
        return card('UV Index', ICON.uv, h('div.sv-aqi-row', h('div.sv-big', round(v)), h('b', uvLevel(v))),
          h('div.sv-scale.uv', h('b', { style: { left: clamp((v / 11) * 100, 0, 100) + '%' } })),
          h('small.sv-muted', `Today’s high: ${round(d.daily[0].uv)} (${uvLevel(d.daily[0].uv ?? 0)})`));
      },
      moon() {
        const m = moon();
        const lit = m.p <= 0.5 ? 1 - 4 * m.p : 4 * m.p - 3, wax = m.p < 0.5;   // ellipse factor -1…1
        const art = `<svg viewBox="0 0 60 60"><circle cx="30" cy="30" r="24" fill="#2c2c32"/><path d="M30 6 A24 24 0 0 ${wax ? 1 : 0} 30 54 A${Math.abs(24 * lit).toFixed(2)} 24 0 0 ${(wax ? lit > 0 : lit < 0) ? 0 : 1} 30 6 Z" fill="#f2efe6"/></svg>`;
        return card('Moon Phase', ICON.moon, h('div.sv-moon', h('div', { html: art }), h('div', h('b', m.name), h('small.sv-muted', `${Math.round(m.illum * 100)}% illuminated`),
          h('small.sv-muted', `Full moon ${m.nextFull.toLocaleDateString([], { month: 'short', day: 'numeric' })} · New moon ${m.nextNew.toLocaleDateString([], { month: 'short', day: 'numeric' })}`))));
      },
      outlook(d) {
        const t = d.daily[0], c = d.current, ds = describe(t.code, 1);
        const u = d.imperial ? 'mph' : 'km/h';
        const parts = [`${ds.label} today, with a high of ${deg(t.max)} and a low of ${deg(t.min)}.`,
          t.pop >= 30 ? `${t.pop}% chance of precipitation.` : 'Little chance of precipitation.',
          t.wind >= (d.imperial ? 20 : 32) ? `Windy, with gusts up to ${round(t.gust)} ${u}.` : `Winds up to ${round(t.wind)} ${u}.`,
          (t.uv ?? 0) >= 6 ? `UV index reaches ${round(t.uv)}; use sun protection.` : ''];
        if (S.alerts[0]) parts.unshift(`${S.alerts[0].title} in effect.`);
        return card('Today’s Outlook', ICON.outlook, h('p.sv-text', parts.filter(Boolean).join(' ')), h('small.sv-muted', `Now ${deg(c.temp)}, ${describe(c.code, c.day).label.toLowerCase()}.`));
      },
    };
    function drawColumn() {
      if (column.hidden) return;
      const scroll = column.scrollTop;
      column.innerHTML = '';
      if (!S.loc) {
        column.append(card(null, null, h('div.sv-empty', h('div', { html: sym.location }), h('b', 'Set a location to see the weather'),
          h('small.sv-muted', 'Search for a place in the toolbar, or right-click anywhere on the map and choose “Set as Weather Location”.'))));
      } else if (!S.data) {
        column.append(S.err ? card(null, null, h('div.sv-empty', h('b', S.err), h('button.btn', { onclick: refreshWeather }, 'Try Again'))) : h('div.sv-loading', ...[0, 1, 2].map(() => h('div.sv-card.glass.sv-skel'))));
      } else {
        if (S.err) column.append(h('div.sv-notice.glass', S.err));
        column.append(hero(S.data));
        for (const c of cardOrder()) if (c.on) { const el = R[c.id]?.(S.data); if (el) column.append(el); }
        column.append(h('div.sv-attr.glass', 'Weather by Open-Meteo · Alerts by NWS · Radar by LibreWXR · Maps © Esri, OpenStreetMap'));
      }
      column.scrollTop = scroll;
    }
    function drawAll() { layout(); drawColumn(); drawChip(); drawBanner(); drawControls(); drawRadarPanel(); drawScrubber(); }

    /* ---------------- keyboard: Space plays, ←/→ step frames */
    win.el.addEventListener('keydown', (e) => {
      if (e.target.matches('input, select, textarea')) return;
      if (e.key === ' ') { e.preventDefault(); play(!S.playing); }
      else if (e.key === 'ArrowLeft') { play(false); showFrame(S.idx - 1); }
      else if (e.key === 'ArrowRight') { play(false); showFrame(S.idx + 1); }
    });

    /* ---------------- settings and theme */
    const offStore = store.on('change', (k) => {
      if (disposed) return;
      if (['svMode', 'svShowPanel', 'svPanelSide'].includes(k)) { layout(); drawColumn(); setTimeout(() => sv('invalidate'), 360); }
      if (k === 'svOverlay') { sv('setOverlay', store.get('svOverlay')); drawAll(); }
      if (k === 'svBaseMap') { sv('setBaseMap', store.get('svBaseMap')); drawRadarPanel(); }
      if (k === 'svSatellite') sv('setSatellite', !!store.get('svSatellite'));
      if (['svScheme', 'svSmooth', 'svSnow'].includes(k)) pushRadar();
      if (k === 'svOpacity') sv('setOpacity', store.get('svOpacity'));
      if (k === 'svAdvisories') loadPolygons();
      if (k === 'svCards') drawColumn();
      if (k === 'weatherUnits') refreshWeather();
      if (k === 'accent') sv('setTheme', mapTheme(), store.get('accent'));
      if (k === 'weatherCity' && store.get('weatherCity') && store.get('weatherCity') !== S.loc) { S.loc = store.get('weatherCity'); sv('setLocation', S.loc, true); refreshWeather(); refreshAlerts(); }
    });
    const offTheme = bus.on('theme', () => sv('setTheme', mapTheme(), store.get('accent')));
    win.on('close', () => {
      disposed = true;
      timers.forEach(clearInterval); clearTimeout(playTimer);
      removeEventListener('message', onMsg);
      offTheme();
      if (typeof offStore === 'function') offStore();
    });

    drawAll();
    refreshAll();
  },
});
