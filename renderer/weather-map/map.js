/* StormView map engine (from StormView for macOS by arc360alt; only the bridge below is LiquidDesktop's).
 *
 * Swift drives everything through `window.sv.*`; this file reports back through
 * `webkit.messageHandlers.sv.postMessage({ type, ... })`. Leaflet draws only
 * map content — all UI chrome is native SwiftUI.
 */
(() => {
  'use strict';

  // LiquidDesktop bridge: messages go to the Weather app (the parent page); the app calls window.sv.* by
  // sending { sv: name, args: [...], id? } and gets { type: 'result', id, value } back for calls that return.
  const post = (type, payload = {}) => {
    try { window.parent.postMessage({ svMap: true, type, ...payload }, '*'); } catch (_) { /* not embedded */ }
  };
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m.sv !== 'string' || e.source !== window.parent) return;
    const fn = window.sv && window.sv[m.sv];
    if (typeof fn !== 'function') return;
    let value;
    try { value = fn.apply(window.sv, m.args || []); } catch (err) { post('log', { message: `sv.${m.sv}: ${err.message}` }); }
    if (m.id != null) post('result', { id: m.id, value });
  });
  window.addEventListener('error', (e) => post('log', { message: `JS error: ${e.message} @${e.lineno}` }));

  /* ------------------------------------------------------------------ */
  /* Map + panes                                                         */
  /* ------------------------------------------------------------------ */

  const map = L.map('map', {
    center: [39.5, -98.35],
    zoom: 5,
    minZoom: 2,
    maxZoom: 14,
    zoomControl: false,
    attributionControl: true,
    zoomSnap: 0,          // fractional zoom so wheel/pinch zoom can glide smoothly
    zoomDelta: 1,
    wheelPxPerZoomLevel: 110,
    worldCopyJump: true,
    fadeAnimation: true,
    zoomAnimation: true,
  });
  map.attributionControl.setPrefix(false);

  const mkPane = (name, z, pointer = false) => {
    const p = map.createPane(name);
    p.style.zIndex = z;
    p.style.pointerEvents = pointer ? '' : 'none';
    p.classList.add(`leaflet-${name}-pane`);
    return p;
  };
  mkPane('satellite', 210);
  mkPane('radar', 250);
  mkPane('aqi', 260);
  mkPane('labels', 380);
  mkPane('alerts', 420, true);

  const S = {
    theme: 'dark',
    baseMap: 'muted',
    overlay: 'radar',
    host: 'https://api.librewxr.net',
    frames: [],
    idx: -1,
    cs: 7,
    size: 512,
    smooth: 1,
    snow: 1,
    arrows: null,
    opacity: 0.75,
    accent: '#4f8ef5',
  };

  /* ------------------------------------------------------------------ */
  /* Base map (+ separate label layer drawn above the radar)            */
  /* ------------------------------------------------------------------ */

  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  const ESRI_ATTR = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors';
  let baseLayer = null;
  let labelLayer = null;

  function applyBaseMap() {
    if (baseLayer) map.removeLayer(baseLayer);
    if (labelLayer) map.removeLayer(labelLayer);
    baseLayer = labelLayer = null;
    const dark = S.theme === 'dark';

    if (S.baseMap === 'streets') {
      baseLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: OSM_ATTR, className: 'basemap-invert',
      });
    } else {
      // Esri Canvas (keyless): muted gray base, with labels drawn above the radar.
      const style = dark ? 'World_Dark_Gray' : 'World_Light_Gray';
      const esri = (layer) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${layer}/MapServer/tile/{z}/{y}/{x}`;
      baseLayer = L.tileLayer(esri(`${style}_Base`), { maxZoom: 16, attribution: ESRI_ATTR });
      labelLayer = L.tileLayer(esri(`${style}_Reference`), { maxZoom: 16, pane: 'labels' });
    }
    baseLayer.addTo(map).bringToBack();
    if (labelLayer) labelLayer.addTo(map);
  }

  /* ------------------------------------------------------------------ */
  /* Satellite imagery                                                   */
  /* ------------------------------------------------------------------ */

  let satLayer = null;
  function setSatellite(on) {
    if (on && !satLayer) {
      satLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19, pane: 'satellite', attribution: 'Imagery &copy; Esri' }
      ).addTo(map);
    } else if (!on && satLayer) {
      map.removeLayer(satLayer);
      satLayer = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Radar — windowed frame cache with prioritised prefetch + crossfade  */
  /* ------------------------------------------------------------------ */

  const MAX_CONCURRENT_FRAMES = 3;
  const FRAME_TIMEOUT_MS = 12000;
  const cache = new Map(); // key → entry { key, frame, layer, onMap, ready, timer }
  let activeKey = null;

  const paramsKey = () => `${S.cs}|${S.size}|${S.smooth}_${S.snow}|${S.arrows || ''}`;
  const frameKey = (f) => `${f.path}|${paramsKey()}`;

  function tileUrl(f) {
    let u = `${S.host}${f.path}/${S.size}/{z}/{x}/{y}/${S.cs}/${S.smooth}_${S.snow}.png`;
    if (S.arrows) u += `?arrows=${S.arrows}`;
    return u;
  }

  function entryFor(f) {
    const key = frameKey(f);
    let e = cache.get(key);
    if (e) return e;
    const layer = L.tileLayer(tileUrl(f), {
      pane: 'radar',
      opacity: 0,
      tileSize: 512,
      zoomOffset: -1,
      minZoom: 1,
      maxNativeZoom: 12,
      keepBuffer: 1,
      updateWhenIdle: true,
      updateWhenZooming: false,
      className: 'radar-frame',
      attribution: 'Radar &copy; <a href="https://librewxr.net">LibreWXR</a>',
    });
    e = { key, frame: f, layer, onMap: false, ready: false, timer: null };
    layer.on('loading', () => { e.ready = false; armTimeout(e); });
    layer.on('load', () => markReady(e));
    // Decode PNGs off the main thread.
    const create = layer.createTile.bind(layer);
    layer.createTile = (coords, done) => {
      const img = create(coords, done);
      img.decoding = 'async';
      return img;
    };
    cache.set(key, e);
    return e;
  }

  function armTimeout(e) {
    clearTimeout(e.timer);
    e.timer = setTimeout(() => markReady(e), FRAME_TIMEOUT_MS);
  }

  function markReady(e) {
    clearTimeout(e.timer);
    e.timer = null;
    if (!e.onMap) return;
    e.ready = true;
    if (e.key === activeKey) { hideAllExcept(e.key); prune(e.key); }
    reportProgress();
    schedulePrefetch();
  }

  function addToMap(e) {
    if (e.onMap) return;
    e.onMap = true;
    e.ready = false;
    e.layer.addTo(map);
    armTimeout(e);
  }

  function removeFromMap(e) {
    clearTimeout(e.timer);
    e.timer = null;
    if (e.onMap) { try { map.removeLayer(e.layer); } catch (_) {} }
    e.onMap = false;
    e.ready = false;
  }

  function hideAllExcept(key) {
    for (const e of cache.values()) {
      if (e.key !== key && e.onMap) e.layer.setOpacity(0);
    }
  }

  // Drop frames that are no longer wanted (expired, or rendered with old
  // settings). `keep` protects the frame currently on screen.
  function prune(keep) {
    const wanted = new Set(S.frames.map(frameKey));
    for (const [k, e] of cache) {
      if (!wanted.has(k) && k !== keep) { removeFromMap(e); cache.delete(k); }
    }
  }

  function clearRadar() {
    for (const e of cache.values()) removeFromMap(e);
    cache.clear();
    activeKey = null;
    post('radarProgress', { ready: 0, total: 0 });
  }

  function showFrame(i) {
    if (S.overlay !== 'radar' || !S.frames.length) return;
    S.idx = Math.max(0, Math.min(i, S.frames.length - 1));
    const e = entryFor(S.frames[S.idx]);
    addToMap(e);
    e.layer.setOpacity(S.opacity);
    e.layer.bringToFront();
    const prevKey = activeKey;
    activeKey = e.key;
    // Keep the previous frame visible until the new one has its tiles, so
    // scrubbing never flashes an empty map.
    if (e.ready || !prevKey) { hideAllExcept(e.key); prune(e.key); }
    else hideAllExcept2(e.key, prevKey);
    schedulePrefetch();
  }

  function hideAllExcept2(a, b) {
    for (const e of cache.values()) {
      if (e.key !== a && e.key !== b && e.onMap) e.layer.setOpacity(0);
    }
  }

  let prefetchTimer = null;
  function schedulePrefetch() {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(pumpPrefetch, 40);
  }

  function pumpPrefetch() {
    if (S.overlay !== 'radar' || !S.frames.length || map._animatingZoom) return;
    let inFlight = 0;
    for (const e of cache.values()) if (e.onMap && !e.ready) inFlight++;
    const n = S.frames.length;
    // Walk forward from the current frame so upcoming playback frames load first.
    for (let j = 1; j < n && inFlight < MAX_CONCURRENT_FRAMES; j++) {
      const e = entryFor(S.frames[(S.idx + j) % n]);
      if (!e.onMap) { addToMap(e); inFlight++; }
    }
    reportProgress();
  }

  let lastProgress = '';
  function reportProgress() {
    const total = S.frames.length;
    let ready = 0;
    for (const f of S.frames) {
      const e = cache.get(frameKey(f));
      if (e && e.onMap && e.ready) ready++;
    }
    const sig = `${ready}/${total}`;
    if (sig !== lastProgress) {
      lastProgress = sig;
      post('radarProgress', { ready, total });
    }
  }

  // Pan/zoom: stop background frames from fetching the old viewport, keep the
  // visible frame, then re-warm the rest once the view settles.
  let settleTimer = null;
  function onViewStart() {
    clearTimeout(settleTimer);
    for (const e of cache.values()) if (e.key !== activeKey) removeFromMap(e);
  }
  function onViewEnd() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(schedulePrefetch, 450);
    reportProgress();
  }
  map.on('movestart zoomstart', onViewStart);
  map.on('moveend zoomend', onViewEnd);

  /* ------------------------------------------------------------------ */
  /* Air-quality heat map (IDW over an Open-Meteo sample grid)           */
  /* ------------------------------------------------------------------ */

  const AQ_BASE = 'https://air-quality-api.open-meteo.com/v1/air-quality';
  const NICE_STEPS = [0.5, 1, 1.5, 2, 3, 4, 5, 8, 10, 15, 20, 30, 45, 90];
  const AQ_MAX_BATCH = 200;
  const AQ_CHUNK = 100;
  const AQ_TTL = 60 * 60 * 1000;
  const AQ_CANVAS = 256;
  const AQ_CACHE = new Map();
  const AQ_INFLIGHT = new Set();
  const RAMP = [
    { v: 0, c: [0, 228, 0] }, { v: 50, c: [0, 228, 0] }, { v: 100, c: [255, 255, 0] },
    { v: 150, c: [255, 126, 0] }, { v: 200, c: [255, 0, 0] }, { v: 300, c: [143, 63, 151] },
    { v: 500, c: [126, 0, 35] },
  ];
  let aqiOverlay = null;
  let aqiFetchId = 0;
  let aqiTimer = null;

  const aqStep = (b) => Math.min(NICE_STEPS.find((s) => s >= Math.max(b.getNorth() - b.getSouth(), b.getEast() - b.getWest()) / 25) ?? 90, 2);
  const snap = (v, s) => parseFloat((Math.round(v / s) * s).toFixed(4));
  const aqKey = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

  function aqGrid(b, step) {
    const s = snap(b.getSouth() - step, step), n = snap(b.getNorth() + step, step);
    const w = snap(b.getWest() - step, step), e = snap(b.getEast() + step, step);
    const pts = [];
    for (let r = 0; r <= Math.round((n - s) / step); r++) {
      const lat = parseFloat((s + r * step).toFixed(4));
      if (lat < -85 || lat > 85) continue;
      for (let c = 0; c <= Math.round((e - w) / step); c++) {
        pts.push({ lat, lon: parseFloat((w + c * step).toFixed(4)) });
      }
    }
    return pts;
  }

  function aqNear(b, pad) {
    const now = Date.now();
    const pts = [];
    for (const [k, v] of AQ_CACHE) {
      if (now - v.ts > AQ_TTL) { AQ_CACHE.delete(k); continue; }
      const [lat, lon] = k.split(',').map(Number);
      if (lat >= b.getSouth() - pad && lat <= b.getNorth() + pad && lon >= b.getWest() - pad && lon <= b.getEast() + pad) {
        pts.push({ lat, lon, aqi: v.aqi });
      }
    }
    return pts;
  }

  function rampRgb(aqi) {
    const v = Math.max(0, Math.min(500, aqi));
    for (let i = 0; i < RAMP.length - 1; i++) {
      const lo = RAMP[i], hi = RAMP[i + 1];
      if (v <= hi.v) {
        const t = (v - lo.v) / (hi.v - lo.v || 1);
        return lo.c.map((c, j) => Math.round(c + t * (hi.c[j] - c)));
      }
    }
    return RAMP[RAMP.length - 1].c;
  }

  function idw(lat, lon, pts) {
    let ws = 0, vs = 0;
    for (const p of pts) {
      const d2 = (lat - p.lat) ** 2 + (lon - p.lon) ** 2;
      if (d2 < 1e-8) return p.aqi;
      const w = 1 / d2 ** 1.5;
      ws += w; vs += w * p.aqi;
    }
    return ws > 0 ? vs / ws : 0;
  }

  function renderAqi(b, pts) {
    const sz = AQ_CANVAS;
    const off = document.createElement('canvas');
    off.width = off.height = sz;
    const octx = off.getContext('2d');
    const img = octx.createImageData(sz, sz);
    const latSpan = b.getNorth() - b.getSouth(), lonSpan = b.getEast() - b.getWest();
    for (let row = 0; row < sz; row++) {
      const lat = b.getNorth() - (row / sz) * latSpan;
      for (let col = 0; col < sz; col++) {
        const [r, g, bl] = rampRgb(idw(lat, b.getWest() + (col / sz) * lonSpan, pts));
        const i = (row * sz + col) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = bl; img.data[i + 3] = 170;
      }
    }
    octx.putImageData(img, 0, 0);
    const out = document.createElement('canvas');
    out.width = out.height = sz;
    const ctx = out.getContext('2d');
    ctx.filter = 'blur(4px)';
    ctx.drawImage(off, 0, 0);
    return out.toDataURL('image/png');
  }

  function pushAqi(b, pts) {
    if (pts.length < 2) return;
    const url = renderAqi(b, pts);
    if (aqiOverlay) map.removeLayer(aqiOverlay);
    aqiOverlay = L.imageOverlay(url, b, { opacity: 0.65, pane: 'aqi', interactive: false, className: 'aqi-canvas-overlay' }).addTo(map);
  }

  async function fetchAqBatch(points) {
    const lats = points.map((p) => p.lat.toFixed(4)).join(',');
    const lons = points.map((p) => p.lon.toFixed(4)).join(',');
    try {
      const res = await fetch(`${AQ_BASE}?latitude=${lats}&longitude=${lons}&current=us_aqi&timezone=auto`);
      if (!res.ok) return [];
      const data = await res.json();
      const arr = Array.isArray(data) ? data : [data];
      return arr.map((d, i) => ({ lat: points[i]?.lat, lon: points[i]?.lon, aqi: d.current?.us_aqi ?? null }))
        .filter((r) => r.lat != null);
    } catch (_) { return []; }
  }

  async function updateAqi() {
    if (S.overlay !== 'aqi') return;
    const id = ++aqiFetchId;
    const b = map.getBounds();
    const step = aqStep(b);
    const cached = aqNear(b, step * 2);
    if (cached.length >= 2) pushAqi(b, cached);

    const c = b.getCenter();
    const toFetch = aqGrid(b, step)
      .filter((p) => {
        const k = aqKey(p.lat, p.lon);
        if (AQ_INFLIGHT.has(k)) return false;
        const hit = AQ_CACHE.get(k);
        return !hit || Date.now() - hit.ts > AQ_TTL;
      })
      .sort((a, z) => ((a.lat - c.lat) ** 2 + (a.lon - c.lng) ** 2) - ((z.lat - c.lat) ** 2 + (z.lon - c.lng) ** 2))
      .slice(0, AQ_MAX_BATCH);
    if (!toFetch.length) return;

    post('aqiLoading', { loading: true });
    toFetch.forEach((p) => AQ_INFLIGHT.add(aqKey(p.lat, p.lon)));
    const chunks = [];
    for (let i = 0; i < toFetch.length; i += AQ_CHUNK) chunks.push(toFetch.slice(i, i + AQ_CHUNK));
    const results = await Promise.all(chunks.map(fetchAqBatch));
    const now = Date.now();
    for (const r of results.flat()) if (r.aqi != null) AQ_CACHE.set(aqKey(r.lat, r.lon), { aqi: r.aqi, ts: now });
    toFetch.forEach((p) => AQ_INFLIGHT.delete(aqKey(p.lat, p.lon)));
    post('aqiLoading', { loading: false });

    if (id !== aqiFetchId || S.overlay !== 'aqi') return;
    const nb = map.getBounds();
    const pts = aqNear(nb, aqStep(nb) * 2);
    if (pts.length >= 2) pushAqi(nb, pts);
  }

  map.on('moveend zoomend', () => {
    if (S.overlay !== 'aqi') return;
    clearTimeout(aqiTimer);
    aqiFetchId++;
    aqiTimer = setTimeout(updateAqi, 1200);
  });

  function setOverlay(kind) {
    if (S.overlay === kind) return;
    S.overlay = kind;
    map.getContainer().classList.toggle('aqi-mode', kind === 'aqi');
    if (kind === 'aqi') {
      clearRadar();
      updateAqi();
    } else {
      aqiFetchId++;
      clearTimeout(aqiTimer);
      if (aqiOverlay) { map.removeLayer(aqiOverlay); aqiOverlay = null; }
      showFrame(S.idx);
    }
  }

  /* ------------------------------------------------------------------ */
  /* NWS warning polygons                                                */
  /* ------------------------------------------------------------------ */

  const EVENT_STYLE = {
    'Tornado Warning': ['#FF0000', '#CC0000', 0.38], 'Tornado Watch': ['#FFFF00', '#CCBB00', 0.28],
    'Tornado Emergency': ['#FF00FF', '#CC00CC', 0.45], 'Severe Thunderstorm Warning': ['#FFA500', '#CC6600', 0.35],
    'Severe Thunderstorm Watch': ['#DDBB00', '#AA8800', 0.25], 'Flash Flood Warning': ['#00CC00', '#008800', 0.35],
    'Flash Flood Watch': ['#2E8B57', '#1A5C38', 0.25], 'Flash Flood Emergency': ['#8B0000', '#5C0000', 0.42],
    'Flood Warning': ['#00AA00', '#007700', 0.30], 'Flood Watch': ['#2E8B57', '#1A5C38', 0.22],
    'Flood Advisory': ['#00FF7F', '#00BB60', 0.20], 'Winter Storm Warning': ['#9400D3', '#6A0099', 0.35],
    'Winter Storm Watch': ['#4682B4', '#2E5A8A', 0.25], 'Blizzard Warning': ['#FF4500', '#CC3300', 0.38],
    'Ice Storm Warning': ['#8B0000', '#5C0000', 0.35], 'Winter Weather Advisory': ['#7B68EE', '#5A4ECC', 0.22],
    'Wind Advisory': ['#D2691E', '#A0481A', 0.22], 'High Wind Warning': ['#DAA520', '#A07818', 0.30],
    'Dense Fog Advisory': ['#708090', '#4A5568', 0.22], 'Heat Advisory': ['#FF7F50', '#CC5A30', 0.22],
    'Excessive Heat Warning': ['#C71585', '#8B0E5C', 0.35], 'Extreme Heat Warning': ['#C71585', '#8B0E5C', 0.35],
    'Extreme Cold Warning': ['#0000FF', '#0000CC', 0.35], 'Special Weather Statement': ['#FFE4B5', '#CCBB8E', 0.22],
    'Air Quality Alert': ['#8B8B00', '#666600', 0.20], 'Beach Hazard Statement': ['#40E0D0', '#28A8A0', 0.20],
    'Rip Current Statement': ['#008B8B', '#006666', 0.22], 'Small Craft Advisory': ['#D2B48C', '#A08060', 0.20],
    'Frost Advisory': ['#6495ED', '#4070CC', 0.20], 'Freeze Warning': ['#483D8B', '#302866', 0.28],
    'Hard Freeze Warning': ['#9400D3', '#6A0099', 0.30], 'Freeze Watch': ['#00CED1', '#009DA0', 0.20],
    'Lake Wind Advisory': ['#D2691E', '#A0481A', 0.18], 'Dust Advisory': ['#BDB76B', '#8A8440', 0.22],
    'Dust Storm Warning': ['#FFE4C4', '#CCA88A', 0.30], 'Smoke Advisory': ['#808080', '#555555', 0.20],
    'Red Flag Warning': ['#FF1493', '#CC0060', 0.30], 'Fire Weather Watch': ['#FFDEAD', '#CCA868', 0.22],
  };
  const SEVERITY_STYLE = {
    Extreme: ['#FF0000', '#CC0000', 0.35], Severe: ['#FF6600', '#CC4400', 0.30],
    Moderate: ['#FFAA00', '#CC7700', 0.25], Minor: ['#4169E1', '#2E4FAA', 0.20],
  };

  function alertStyle(feature, dashed) {
    const p = feature.properties || {};
    const [fill, stroke, op] = EVENT_STYLE[p.event] || SEVERITY_STYLE[p.severity] || ['#888888', '#555555', 0.18];
    return {
      fillColor: fill, color: stroke, fillOpacity: op, opacity: dashed ? 0.7 : 0.9,
      weight: dashed ? 1.5 : 2, dashArray: dashed ? '5 4' : null, className: 'sv-alert', pane: 'alerts',
    };
  }

  let warnLayer = null, advLayer = null;

  function buildAlertLayer(features, dashed) {
    let layer;
    layer = L.geoJSON({ type: 'FeatureCollection', features }, {
      pane: 'alerts',
      style: (f) => alertStyle(f, dashed),
      onEachFeature(f, fl) {
        fl.on('mouseover', (e) => { e.target.setStyle({ fillOpacity: 0.6, weight: 3, dashArray: null }); e.target.bringToFront(); });
        fl.on('mouseout', (e) => layer.resetStyle(e.target));
        fl.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          const pt = map.latLngToContainerPoint(e.latlng);
          post('alertClick', { properties: f.properties || {}, x: pt.x, y: pt.y });
        });
      },
    });
    return layer.addTo(map);
  }

  function setAlertPolygons(warnings, advisories) {
    if (warnLayer) { map.removeLayer(warnLayer); warnLayer = null; }
    if (advLayer) { map.removeLayer(advLayer); advLayer = null; }
    if (advisories && advisories.length) advLayer = buildAlertLayer(advisories, true);
    if (warnings && warnings.length) warnLayer = buildAlertLayer(warnings, false);
  }

  /* ------------------------------------------------------------------ */
  /* Location marker, context menu, clicks                               */
  /* ------------------------------------------------------------------ */

  let marker = null;
  let ctxMarker = null;

  function setLocation(loc, fly) {
    if (marker) { map.removeLayer(marker); marker = null; }
    if (!loc) return;
    marker = L.marker([loc.lat, loc.lon], {
      icon: L.divIcon({ className: '', html: '<div class="sv-pin"><div class="sv-pin-pulse"></div><div class="sv-pin-dot"></div></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
      keyboard: false,
      interactive: false,
    }).addTo(map);
    if (fly) map.flyTo([loc.lat, loc.lon], Math.max(map.getZoom(), 7), { duration: 1.1 });
  }

  function clearContextMark() {
    if (ctxMarker) { map.removeLayer(ctxMarker); ctxMarker = null; }
  }

  map.on('contextmenu', (e) => {
    clearContextMark();
    ctxMarker = L.marker(e.latlng, {
      icon: L.divIcon({ className: '', html: '<div class="sv-ctx-mark"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
      interactive: false, keyboard: false,
    }).addTo(map);
    post('contextMenu', { lat: e.latlng.lat, lon: wrapLon(e.latlng.lng), x: e.containerPoint.x, y: e.containerPoint.y });
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  map.on('click', (e) => {
    post('mapClick', { lat: e.latlng.lat, lon: wrapLon(e.latlng.lng), x: e.containerPoint.x, y: e.containerPoint.y, overlay: S.overlay });
  });

  // Report zoom once it settles, not on every frame of a wheel glide.
  map.on('zoomend', () => { if (!wheel.raf) post('zoom', { zoom: map.getZoom() }); });
  map.on('movestart', () => post('moveStart'));

  const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

  // Mouse-wheel zoom (driven from Swift, which can tell a wheel from a trackpad).
  // Each notch moves a target zoom; a frame loop eases the map toward it, so fast
  // scrolling accumulates instead of being dropped mid-animation like Leaflet's.
  const wheel = { target: null, pt: null, raf: 0 };
  function wheelStep() {
    const z = map.getZoom();
    const diff = wheel.target - z;
    if (Math.abs(diff) < 0.004) {
      map.setZoomAround(wheel.pt, wheel.target, { animate: false });
      wheel.target = null;
      wheel.raf = 0;
      onViewEnd();
      post('zoom', { zoom: map.getZoom() });
      return;
    }
    map.setZoomAround(wheel.pt, z + diff * 0.22, { animate: false });
    wheel.raf = requestAnimationFrame(wheelStep);
  }
  function wheelZoom(dz, x, y) {
    if (map._animatingZoom) map._stop?.();
    const base = wheel.target ?? map.getZoom();
    wheel.target = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), base + dz));
    wheel.pt = L.point(x, y);
    if (!wheel.raf) {
      onViewStart();
      wheel.raf = requestAnimationFrame(wheelStep);
    }
  }

  // Trackpad pinch (WebKit gesture events) → smooth zoom around the cursor.
  let gesture = null;
  document.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    const rect = map.getContainer().getBoundingClientRect();
    gesture = { zoom: map.getZoom(), pt: L.point(e.clientX - rect.left, e.clientY - rect.top) };
    onViewStart();
  });
  document.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (!gesture) return;
    const z = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), gesture.zoom + Math.log2(e.scale)));
    map.setZoomAround(gesture.pt, z, { animate: false });
  });
  document.addEventListener('gestureend', (e) => {
    e.preventDefault();
    gesture = null;
    onViewEnd();
  });

  /* ------------------------------------------------------------------ */
  /* Public API for Swift                                                */
  /* ------------------------------------------------------------------ */

  window.sv = {
    init(o) {
      S.theme = o.theme || S.theme;
      S.baseMap = o.baseMap || S.baseMap;
      document.body.classList.toggle('theme-dark', S.theme === 'dark');
      if (o.accent) document.documentElement.style.setProperty('--sv-accent', o.accent);
      if (o.center) map.setView(o.center, o.zoom || 7, { animate: false });
      applyBaseMap();
      post('ready');
    },
    setTheme(theme, accent) {
      const changed = theme !== S.theme;
      S.theme = theme;
      document.body.classList.toggle('theme-dark', theme === 'dark');
      if (accent) document.documentElement.style.setProperty('--sv-accent', accent);
      if (changed) applyBaseMap();
    },
    setBaseMap(kind) {
      if (kind === S.baseMap) return;
      S.baseMap = kind;
      applyBaseMap();
    },
    setLocation(loc, fly) { setLocation(loc, fly); },
    flyTo(lat, lon, zoom) { map.flyTo([lat, lon], zoom ?? map.getZoom(), { duration: 0.9 }); },
    panTo(lat, lon) { map.panTo([lat, lon], { animate: true }); },
    zoomIn() { map.zoomIn(1); },
    wheelZoom(dz, x, y) { wheelZoom(dz, x, y); },
    zoomOut() { map.zoomOut(1); },
    setRadar(o) {
      // o: { host, frames:[{time,path,kind}], cs, size, smooth, snow, arrows, opacity, index }
      const paramsChanged = o.cs !== S.cs || o.size !== S.size || o.smooth !== S.smooth || o.snow !== S.snow || (o.arrows || null) !== S.arrows;
      S.host = o.host || S.host;
      S.frames = o.frames || [];
      S.cs = o.cs; S.size = o.size; S.smooth = o.smooth; S.snow = o.snow;
      S.arrows = o.arrows || null;
      S.opacity = o.opacity;
      if (paramsChanged) {
        // Keep the visible frame until its replacement loads, then prune.
        for (const e of cache.values()) if (e.key !== activeKey) removeFromMap(e);
      }
      prune(activeKey);
      lastProgress = '';
      showFrame(o.index ?? S.frames.length - 1);
      reportProgress();
    },
    showFrame(i) { showFrame(i); },
    setOpacity(v) {
      S.opacity = v;
      const e = cache.get(activeKey);
      if (e) e.layer.setOpacity(v);
    },
    setOverlay(kind) { setOverlay(kind); },
    setSatellite(on) { setSatellite(on); },
    setAlertPolygons(warnings, advisories) { setAlertPolygons(warnings, advisories); },
    clearContextMark() { clearContextMark(); },
    invalidate() { map.invalidateSize({ pan: false }); },
    center() { const c = map.getCenter(); return { lat: c.lat, lon: wrapLon(c.lng), zoom: map.getZoom() }; },
  };

  new ResizeObserver(() => map.invalidateSize({ pan: false })).observe(document.getElementById('map'));
  post('loaded');
})();
