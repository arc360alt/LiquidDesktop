// Weather data from Open-Meteo (no API key). The default city comes from the system time zone.
import { store } from './store.js';
import { wx } from './icons.js';

const WMO = {
  0: ['Clear', 'sun'], 1: ['Mostly Clear', 'partly'], 2: ['Partly Cloudy', 'partly'], 3: ['Cloudy', 'cloud'],
  45: ['Fog', 'fog'], 48: ['Fog', 'fog'], 51: ['Drizzle', 'rain'], 53: ['Drizzle', 'rain'], 55: ['Drizzle', 'rain'],
  61: ['Rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy Rain', 'rain'], 66: ['Freezing Rain', 'rain'], 67: ['Freezing Rain', 'rain'],
  71: ['Snow', 'snow'], 73: ['Snow', 'snow'], 75: ['Heavy Snow', 'snow'], 77: ['Snow', 'snow'], 80: ['Showers', 'rain'], 81: ['Showers', 'rain'],
  82: ['Heavy Showers', 'rain'], 85: ['Snow Showers', 'snow'], 86: ['Snow Showers', 'snow'], 95: ['Thunderstorm', 'storm'], 96: ['Thunderstorm', 'storm'], 99: ['Thunderstorm', 'storm'],
};
export function describe(code, isDay = 1) {
  const [label, icon] = WMO[code] || ['—', 'cloud'];
  const ic = !isDay && (icon === 'sun' || icon === 'partly') ? 'moon' : icon;
  return { label, icon: wx[ic], kind: ic };
}
export const useF = () => { const u = store.get('weatherUnits'); if (u === 'c') return false; if (u === 'f') return true; return /^en-US/.test(navigator.language) || Intl.DateTimeFormat().resolvedOptions().timeZone?.startsWith('America/'); };

export async function geocode(name) {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json&name=${encodeURIComponent(name)}`);
  const j = await r.json();
  return (j.results || []).map((x) => ({ name: x.name, region: [x.admin1, x.country].filter(Boolean).join(', '), lat: x.latitude, lon: x.longitude }));
}

async function defaultCity() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London';
  const guess = tz.split('/').pop().replace(/_/g, ' ');
  const res = await geocode(guess).catch(() => []);
  return res[0] || { name: 'Cupertino', region: 'California', lat: 37.323, lon: -122.032 };
}

let cache = null;
export async function getWeather(force) {
  if (cache && !force && Date.now() - cache.t < 10 * 60_000 && cache.key === JSON.stringify([store.get('weatherCity'), useF()])) return cache.data;
  let city = store.get('weatherCity');
  if (!city) { city = await defaultCity(); store.set('weatherCity', city); }
  const unit = useF() ? '&temperature_unit=fahrenheit&wind_speed_unit=mph' : '';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m&hourly=temperature_2m,weather_code,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max&timezone=auto&forecast_days=10${unit}`;
  const j = await (await fetch(url)).json();
  const data = { city, ...j };
  cache = { t: Date.now(), data, key: JSON.stringify([store.get('weatherCity'), useF()]) };
  return data;
}
