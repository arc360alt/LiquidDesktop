// Procedural wallpapers: layered, softly shaded waves rendered to a canvas (no image assets needed).
// Each has a day and a night palette; "dynamic" wallpapers follow the theme / time of day.
export const WALLPAPERS = {
  peaks: {
    name: 'Alpine Lake', scene: 'peaks',
    day: { sky: ['#5fa8e8', '#9fd0f5', '#e3f2fb'], mtn: ['#8aa6c4', '#5f7f9f', '#3d5a74'], snow: '#f6fbff', water: ['#3fb3c9', '#1e7f9a', '#0f4f66'], trees: '#1f3d33', glow: '#fff6d8' },
    night: { sky: ['#06102a', '#11234a', '#2a3c66'], mtn: ['#2d3d5c', '#1e2b45', '#121b2e'], snow: '#9fb3d6', water: ['#16345a', '#0d2340', '#06142a'], trees: '#060d14', glow: '#a8c4ff' },
  },
  bokeh: {
    name: 'Bokeh', scene: 'bokeh',
    day: { sky: ['#ffb7a6', '#d98ad9', '#6b7fe0'], dots: ['#fff6c8', '#ffd1e8', '#bde6ff', '#ffffff', '#ffc38a'] },
    night: { sky: ['#14081f', '#27103b', '#0b1433'], dots: ['#ffb347', '#ff5e9a', '#5ec8ff', '#b57bff', '#fff1a8'] },
  },
  lagoon: {
    name: 'Lagoon',
    day: { sky: ['#8ec5ff', '#3d7fe0', '#1d4fb8'], waves: ['#7fd1ff', '#4aa3f5', '#2f7be6', '#1f5fd0', '#1640a8', '#0e2c80'], glow: '#d8f1ff' },
    night: { sky: ['#0b1a3f', '#0a2259', '#06143a'], waves: ['#2b5bbf', '#1f47a3', '#173a8c', '#102c70', '#0b1f55', '#06133a'], glow: '#5d8cff' },
  },
  bloom: {
    name: 'Bloom',
    day: { sky: ['#ffd6e8', '#f7a8d0', '#c58bf2'], waves: ['#ffc0dc', '#f59ac8', '#e57bc0', '#c56bd8', '#9b5de5', '#7346c9'], glow: '#fff0f7' },
    night: { sky: ['#2a0f33', '#3b1450', '#1c0a2e'], waves: ['#8a3a9e', '#73308c', '#5d2678', '#481d63', '#33144d', '#200b36'], glow: '#e07bd8' },
  },
  ember: {
    name: 'Ember',
    day: { sky: ['#ffe2b8', '#ffb07a', '#ff7a59'], waves: ['#ffc58a', '#ffa26a', '#ff8a5c', '#f2684f', '#d94c4a', '#b23545'], glow: '#fff3df' },
    night: { sky: ['#2b0d12', '#3d1218', '#1a0709'], waves: ['#b8433b', '#9a3534', '#7d292d', '#611f25', '#46151c', '#2c0c12'], glow: '#ff8a5c' },
  },
  meadow: {
    name: 'Meadow',
    day: { sky: ['#e6ffd9', '#a8e6a1', '#5cc6a0'], waves: ['#b8f0a8', '#8fdc96', '#62c78c', '#3fae84', '#2a8f78', '#1b6e66'], glow: '#f5fff0' },
    night: { sky: ['#06201c', '#0a2e27', '#04140f'], waves: ['#1f7a64', '#196654', '#135244', '#0e4036', '#092d27', '#051b18'], glow: '#4fe0b0' },
  },
  graphite: {
    name: 'Graphite',
    day: { sky: ['#e9eaee', '#c9ccd3', '#9ea3ad'], waves: ['#d6d8de', '#bfc2ca', '#a6aab4', '#8d929e', '#747a87', '#5b616e'], glow: '#ffffff' },
    night: { sky: ['#17181b', '#1e2024', '#0c0d0f'], waves: ['#4a4d55', '#3d4047', '#31343a', '#25282d', '#1b1d21', '#111215'], glow: '#9aa0ab' },
  },
  aurora: {
    name: 'Aurora',
    day: { sky: ['#bff3ff', '#7fd8e8', '#5a8de0'], waves: ['#9ff2d8', '#6fe0c9', '#4cc3c8', '#3d9fd0', '#4479d6', '#4a55c8'], glow: '#ecfffb' },
    night: { sky: ['#030914', '#071a2b', '#020611'], waves: ['#28e0a8', '#1fb59a', '#1a8a8f', '#2d5f9a', '#3a3f8f', '#1c1f55'], glow: '#5cffc9' },
  },
};

function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

export function renderWallpaper(id, w, h, night) {
  const wp = WALLPAPERS[id] || WALLPAPERS.lagoon;
  const pal = night ? wp.night : wp.day;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  const r = rng(Object.keys(WALLPAPERS).indexOf(id) * 977 + 31);
  if (wp.scene === 'peaks') { drawPeaks(x, w, h, pal, r, night); return c.toDataURL('image/jpeg', 0.92); }
  if (wp.scene === 'bokeh') { drawBokeh(x, w, h, pal, r, night); return c.toDataURL('image/jpeg', 0.92); }

  // sky
  const sky = x.createLinearGradient(0, 0, w * 0.3, h);
  sky.addColorStop(0, pal.sky[0]); sky.addColorStop(0.55, pal.sky[1]); sky.addColorStop(1, pal.sky[2]);
  x.fillStyle = sky; x.fillRect(0, 0, w, h);

  // a soft light source
  const glow = x.createRadialGradient(w * 0.72, h * 0.18, 0, w * 0.72, h * 0.18, w * 0.6);
  glow.addColorStop(0, pal.glow + (night ? '55' : 'aa')); glow.addColorStop(1, pal.glow + '00');
  x.fillStyle = glow; x.fillRect(0, 0, w, h);

  // aurora curtains at night
  if (id === 'aurora' && night) {
    x.save(); x.filter = `blur(${Math.round(w / 60)}px)`; x.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 5; i++) {
      const g = x.createLinearGradient(0, h * 0.05, 0, h * 0.6);
      g.addColorStop(0, 'rgba(80,255,200,0)'); g.addColorStop(0.5, `rgba(${60 + i * 30},255,${180 + i * 10},.25)`); g.addColorStop(1, 'rgba(80,255,200,0)');
      x.fillStyle = g; x.beginPath();
      const bx = w * (0.1 + i * 0.18);
      x.moveTo(bx, 0);
      for (let t = 0; t <= 1; t += 0.05) x.lineTo(bx + Math.sin(t * 6 + i) * w * 0.05 + t * w * 0.1, t * h * 0.65);
      x.lineTo(bx + w * 0.18, h * 0.65); x.lineTo(bx + w * 0.12, 0); x.fill();
    }
    x.restore();
  }

  // layered waves from back to front, each casting a soft shadow on the one behind it
  const n = pal.waves.length;
  for (let i = 0; i < n; i++) {
    const base = h * (0.32 + i * 0.12) + r() * h * 0.04;
    const amp = h * (0.05 + r() * 0.06), amp2 = h * (0.02 + r() * 0.03);
    const f1 = (1.1 + r() * 1.4) * Math.PI / w, f2 = (2.5 + r() * 3) * Math.PI / w;
    const p1 = r() * 6, p2 = r() * 6, tilt = (r() - 0.5) * h * 0.18;
    const y = (px) => base + Math.sin(px * f1 + p1) * amp + Math.sin(px * f2 + p2) * amp2 + tilt * (px / w - 0.5);
    const wave = (dy = 0) => {
      x.beginPath(); x.moveTo(-10, h + 10);
      for (let px = -10; px <= w + 10; px += 8) x.lineTo(px, y(px) + dy);
      x.lineTo(w + 10, h + 10); x.closePath();
    };
    // soft shadow cast upward onto the layer behind (a blurred copy, not shadowBlur, which Skia clips)
    x.save();
    x.filter = `blur(${Math.round(h * 0.022)}px)`;
    wave(-h * 0.012);
    x.fillStyle = night ? 'rgba(0,0,0,.45)' : 'rgba(10,20,60,.22)';
    x.fill();
    x.restore();
    wave();
    const g = x.createLinearGradient(0, base - amp, 0, h);
    g.addColorStop(0, pal.waves[i]); g.addColorStop(1, pal.waves[Math.min(n - 1, i + 1)]);
    x.fillStyle = g; x.fill();
    // crest highlight
    x.save();
    x.beginPath();
    for (let px = -10; px <= w + 10; px += 8) px === -10 ? x.moveTo(px, y(px) + 1) : x.lineTo(px, y(px) + 1);
    x.strokeStyle = night ? 'rgba(255,255,255,.08)' : 'rgba(255,255,255,.28)';
    x.lineWidth = Math.max(1, h / 500); x.filter = 'blur(1px)'; x.stroke();
    x.restore();
  }

  // fine grain so gradients don't band
  const grain = x.getImageData(0, 0, w, h), d = grain.data;
  for (let i = 0; i < d.length; i += 4) { const v = (Math.random() - 0.5) * 6; d[i] += v; d[i + 1] += v; d[i + 2] += v; }
  x.putImageData(grain, 0, 0);
  return c.toDataURL('image/jpeg', 0.92);
}

const cache = new Map();
export function wallpaperUrl(id, w, h, night) {
  const key = `${id}:${w}x${h}:${night}`;
  if (!cache.has(key)) cache.set(key, renderWallpaper(id, w, h, night));
  return cache.get(key);
}

/* ------------------------------------------------------------------ detailed scenes */
// a ridge line from layered noise
function ridge(r, w, base, amp, rough) {
  const pts = [], n = 120, phases = [r() * 9, r() * 9, r() * 9, r() * 9];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let y = Math.sin(t * 3.1 + phases[0]) * 0.5 + Math.sin(t * 7.3 + phases[1]) * 0.25 * rough + Math.sin(t * 17 + phases[2]) * 0.1 * rough + Math.sin(t * 41 + phases[3]) * 0.04 * rough;
    y += (Math.abs(((t * 5 + phases[0]) % 2) - 1) - 0.5) * 0.6 * rough;   // sharp peaks
    pts.push([t * w, base - y * amp]);
  }
  return pts;
}
function drawPeaks(x, w, h, p, r, night) {
  const horizon = h * 0.6;
  const sky = x.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, p.sky[0]); sky.addColorStop(0.6, p.sky[1]); sky.addColorStop(1, p.sky[2]);
  x.fillStyle = sky; x.fillRect(0, 0, w, horizon + 2);
  if (night) { for (let i = 0; i < 500; i++) { x.fillStyle = `rgba(255,255,255,${r() * 0.8})`; const s = r() * 1.6 * (h / 1000); x.fillRect(r() * w, r() * horizon * 0.8, s, s); } }
  const g = x.createRadialGradient(w * 0.7, h * 0.25, 0, w * 0.7, h * 0.25, w * 0.35);
  g.addColorStop(0, p.glow + (night ? '66' : 'cc')); g.addColorStop(1, p.glow + '00');
  x.fillStyle = g; x.fillRect(0, 0, w, horizon);
  // clouds
  x.save(); x.filter = `blur(${Math.round(h / 60)}px)`;
  for (let i = 0; i < 14; i++) { x.fillStyle = `rgba(255,255,255,${night ? 0.05 : 0.35})`; x.beginPath(); x.ellipse(r() * w, h * (0.08 + r() * 0.25), w * (0.06 + r() * 0.1), h * (0.015 + r() * 0.03), 0, 0, Math.PI * 2); x.fill(); }
  x.restore();
  const layers = [
    { base: horizon - h * 0.12, amp: h * 0.2, rough: 1, col: p.mtn[0], snow: true },
    { base: horizon - h * 0.04, amp: h * 0.12, rough: 0.8, col: p.mtn[1], snow: true },
    { base: horizon + h * 0.005, amp: h * 0.06, rough: 0.6, col: p.mtn[2], snow: false },
  ];
  const ridges = [];
  for (const L of layers) {
    const pts = ridge(r, w, L.base, L.amp, L.rough);
    ridges.push({ pts, L });
    const grad = x.createLinearGradient(0, L.base - L.amp, 0, horizon);
    grad.addColorStop(0, L.col); grad.addColorStop(1, shade(L.col, -0.25));
    x.beginPath(); x.moveTo(0, horizon + 2); for (const [px, py] of pts) x.lineTo(px, py); x.lineTo(w, horizon + 2); x.closePath();
    x.fillStyle = grad; x.fill();
    if (L.snow) {    // snow caps: the band just under the ridge, on the upper part of each peak
      x.save(); x.clip();
      x.beginPath(); x.moveTo(0, 0); for (const [px, py] of pts) x.lineTo(px, py + h * (0.012 + r() * 0.03)); x.lineTo(w, 0); x.closePath();
      const sg = x.createLinearGradient(0, L.base - L.amp, 0, L.base - L.amp * 0.2);
      sg.addColorStop(0, p.snow); sg.addColorStop(1, p.snow + '00');
      x.fillStyle = sg; x.fill();
      x.restore();
    }
  }
  // tree line
  x.fillStyle = p.trees;
  for (let i = 0; i < w / 5; i++) {
    const tx = r() * w, th = h * (0.012 + r() * 0.035), ty = horizon + h * 0.004;
    x.beginPath(); x.moveTo(tx, ty - th); x.lineTo(tx - th * 0.28, ty); x.lineTo(tx + th * 0.28, ty); x.fill();
  }
  x.fillRect(0, horizon, w, h * 0.006);
  // lake with a mirrored, rippled reflection
  const water = x.createLinearGradient(0, horizon, 0, h);
  water.addColorStop(0, p.water[0]); water.addColorStop(0.5, p.water[1]); water.addColorStop(1, p.water[2]);
  x.fillStyle = water; x.fillRect(0, horizon + h * 0.006, w, h - horizon);
  x.save(); x.globalAlpha = 0.35; x.filter = `blur(${Math.max(1, Math.round(h / 400))}px)`;
  for (const { pts, L } of ridges) {
    x.beginPath(); x.moveTo(0, horizon);
    for (const [px, py] of pts) x.lineTo(px, horizon + (horizon - py) * 0.8);
    x.lineTo(w, horizon); x.closePath(); x.fillStyle = L.col; x.fill();
  }
  x.restore();
  for (let i = 0; i < h * 0.6; i++) {
    const yy = horizon + Math.pow(r(), 1.6) * (h - horizon), len = w * (0.02 + r() * 0.12) * (1 + (yy - horizon) / h * 3);
    x.strokeStyle = `rgba(255,255,255,${night ? 0.04 + r() * 0.06 : 0.06 + r() * 0.16})`;
    x.lineWidth = Math.max(1, h / 900); x.beginPath(); const sx = r() * w; x.moveTo(sx, yy); x.lineTo(sx + len, yy); x.stroke();
  }
  // shoreline rocks in the foreground
  for (let i = 0; i < 9; i++) {
    const rx = r() * w, ry = h * (0.82 + r() * 0.2), rw = w * (0.03 + r() * 0.08), rh = rw * (0.35 + r() * 0.25);
    const rg = x.createLinearGradient(0, ry - rh, 0, ry + rh);
    rg.addColorStop(0, night ? '#4a5568' : '#c9c6bd'); rg.addColorStop(1, night ? '#151a24' : '#5d5a54');
    x.fillStyle = rg; x.beginPath(); x.ellipse(rx, ry, rw, rh, (r() - 0.5) * 0.3, Math.PI, 0); x.fill();
  }
  grain(x, w, h, 5);
}
function drawBokeh(x, w, h, p, r, night) {
  const g = x.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, p.sky[0]); g.addColorStop(0.5, p.sky[1]); g.addColorStop(1, p.sky[2]);
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  x.globalCompositeOperation = night ? 'lighter' : 'screen';
  for (let i = 0; i < 140; i++) {
    const rad = h * (0.01 + Math.pow(r(), 2.2) * 0.12), col = p.dots[Math.floor(r() * p.dots.length)];
    x.save();
    x.filter = `blur(${Math.round(r() < 0.5 ? rad * 0.05 : rad * 0.35)}px)`;
    const rg = x.createRadialGradient(0, 0, rad * 0.2, 0, 0, rad);
    rg.addColorStop(0, col + (night ? '55' : '66')); rg.addColorStop(0.85, col + (night ? '44' : '55')); rg.addColorStop(1, col + 'aa');
    x.translate(r() * w, r() * h);
    x.fillStyle = rg; x.beginPath(); x.arc(0, 0, rad, 0, Math.PI * 2); x.fill();
    x.restore();
  }
  x.globalCompositeOperation = 'source-over';
  grain(x, w, h, 6);
}
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * (1 + k))));
  return '#' + [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
function grain(x, w, h, amt) {
  const img = x.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const v = (Math.random() - 0.5) * amt; d[i] += v; d[i + 1] += v; d[i + 2] += v; }
  x.putImageData(img, 0, 0);
}
