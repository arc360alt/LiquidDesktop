// Generates LiquidDesktop's cursor set (an original design in the macOS style: black arrow with a white
// outline and soft shadow, white pointing hand, thin I-beam, double-arrow resizers…).
//
//   node tools/gen-cursors.js
//
// Writes:
//   session/cursors/LiquidCursor/   an X11 (Xcursor) theme, used by the session and by Linux apps in it
//   renderer/css/cursors.css        the same cursors as CSS, so the web UI shows them in any mode
// Shapes are drawn on a 24-unit grid and rendered at 24, 32 and 48 px with 4×4 supersampling.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const THEME = 'LiquidCursor';
const SIZES = [24, 32, 48];

/* ------------------------------------------------------------------ shapes */
const BLACK = [20, 20, 22], WHITE = [255, 255, 255], RED = [235, 64, 52], GREEN = [52, 199, 89];
const rot = (pts, deg, cx = 12, cy = 12) => { const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return pts.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]); };
const scale = (pts, k, cx = 12, cy = 12) => pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
const move = (pts, dx, dy) => pts.map(([x, y]) => [x + dx, y + dy]);

const ARROW = [[3, 2], [3, 18.6], [7.1, 14.9], [9.7, 20.8], [12.3, 19.7], [9.8, 13.9], [15.1, 13.9]];
const HAND = [[9, 3.4], [9.4, 2.3], [10.5, 1.8], [11.6, 2.3], [12, 3.4], [12, 9.6], [12.9, 9.2], [13.9, 9.5], [14.4, 10.3], [15.3, 10.1], [16.2, 10.5], [16.7, 11.4],
  [17.5, 11.3], [18.3, 11.8], [18.6, 12.8], [18.6, 16.4], [17.7, 19.4], [16.7, 21.6], [9.6, 21.6], [7.6, 19.1], [5, 15.9], [4.6, 14.7], [5.1, 13.7], [6.3, 13.5], [9, 15.4]];
const IBEAM = [[8.5, 2.6], [11, 2.6], [12, 3.6], [13, 2.6], [15.5, 2.6], [15.5, 4.3], [12.85, 4.3], [12.85, 19.7], [15.5, 19.7], [15.5, 21.4], [13, 21.4], [12, 20.4], [11, 21.4],
  [8.5, 21.4], [8.5, 19.7], [11.15, 19.7], [11.15, 4.3], [8.5, 4.3]];
const DOUBLE = [[2.5, 12], [7, 7.5], [7, 10.7], [17, 10.7], [17, 7.5], [21.5, 12], [17, 16.5], [17, 13.3], [7, 13.3], [7, 16.5]];
const SLASH = rot([[6.5, 11], [17.5, 11], [17.5, 13], [6.5, 13]], 45);
const PLUS = [[11.2, 7.5], [12.8, 7.5], [12.8, 11.2], [16.5, 11.2], [16.5, 12.8], [12.8, 12.8], [12.8, 16.5], [11.2, 16.5], [11.2, 12.8], [7.5, 12.8], [7.5, 11.2], [11.2, 11.2]];

const poly = (pts, fill) => ({ kind: 'poly', pts, fill });
const circle = (cx, cy, r, fill) => ({ kind: 'circle', cx, cy, r, fill });
const ring = (cx, cy, r1, r2, fill, arc) => ({ kind: 'ring', cx, cy, r1, r2, fill, arc });

const CURSORS = {
  default: { hot: [3, 2], parts: [poly(ARROW, BLACK)], outline: WHITE },
  pointer: { hot: [10.5, 2], parts: [poly(HAND, WHITE)], outline: BLACK, outlineW: 1.1 },
  text: { hot: [12, 12], parts: [poly(IBEAM, BLACK)], outline: WHITE, outlineW: 1.0 },
  'ew-resize': { hot: [12, 12], parts: [poly(DOUBLE, BLACK)], outline: WHITE },
  'ns-resize': { hot: [12, 12], parts: [poly(rot(DOUBLE, 90), BLACK)], outline: WHITE },
  'nwse-resize': { hot: [12, 12], parts: [poly(scale(rot(DOUBLE, 45), 0.95), BLACK)], outline: WHITE },
  'nesw-resize': { hot: [12, 12], parts: [poly(scale(rot(DOUBLE, -45), 0.95), BLACK)], outline: WHITE },
  move: { hot: [12, 12], parts: [poly(DOUBLE, BLACK), poly(rot(DOUBLE, 90), BLACK)], outline: WHITE },
  'not-allowed': { hot: [3, 2], parts: [poly(ARROW, BLACK), ring(16.5, 16.5, 3.4, 5.3, RED), poly(move(scale(SLASH, 0.48), 4.5, 4.5), RED)], outline: WHITE },
  copy: { hot: [3, 2], parts: [poly(ARROW, BLACK), circle(17, 17, 5.2, GREEN), poly(move(scale(PLUS, 0.6), 5, 5), WHITE)], outline: WHITE },
  wait: { hot: [12, 12], parts: [ring(12, 12, 5.5, 9, [120, 120, 128], true)], outline: WHITE },
  progress: { hot: [3, 2], parts: [poly(ARROW, BLACK), ring(17.2, 17.2, 2.6, 4.8, [120, 120, 128], true)], outline: WHITE },
  crosshair: { hot: [12, 12], parts: [poly(scale(PLUS, 1.9), BLACK)], outline: WHITE, outlineW: 1.0 },
};

// names apps ask for (CSS names, classic X11 names, and the hashes Qt/GTK use)
const ALIASES = {
  default: ['left_ptr', 'arrow', 'top_left_arrow', 'context-menu', 'help', 'question_arrow', 'right_ptr', 'X_cursor', 'pirate', 'whats_this', 'd9ce0ab605698f320427677b458ad60b', '5c6cd98b3f3ebcb1f9c7f1c204630408'],
  pointer: ['hand1', 'hand2', 'pointing_hand', 'grab', 'grabbing', 'openhand', 'closedhand', 'dnd-move', 'dnd-none', 'fleur_hand', '9d800788f1b08800ae810202380a0822', 'e29285e634086352946a0e7090d73106', 'fcf21c00b30f7e3f83fe0dfd12e71cff', '208530c400c041818281048008011002'],
  text: ['xterm', 'ibeam', 'vertical-text'],
  'ew-resize': ['sb_h_double_arrow', 'h_double_arrow', 'col-resize', 'size_hor', 'left_side', 'right_side', 'e-resize', 'w-resize', 'split_h', '028006030e0e7ebffc7f7070c0600140', '14fef782d02440884392942c11205230'],
  'ns-resize': ['sb_v_double_arrow', 'v_double_arrow', 'row-resize', 'size_ver', 'top_side', 'bottom_side', 'n-resize', 's-resize', 'split_v', '00008160000006810000408080010102', '2870a09082c103050810ffdffffe0204'],
  'nwse-resize': ['size_fdiag', 'bd_double_arrow', 'top_left_corner', 'bottom_right_corner', 'nw-resize', 'se-resize', 'c7088f0f3e6c8088236ef8e1e3e70000'],
  'nesw-resize': ['size_bdiag', 'fd_double_arrow', 'top_right_corner', 'bottom_left_corner', 'ne-resize', 'sw-resize', 'fcf1c3c7cd4491d801f1e1c78f100000'],
  move: ['fleur', 'all-scroll', 'size_all', '4498f0e0c1937ffe01fd06f973665830', '9081237383d90e509aa00f00170e968f'],
  'not-allowed': ['crossed_circle', 'forbidden', 'no-drop', 'circle', 'dnd-no-drop', '03b6e0fcb3499374a867c041f52298f0'],
  copy: ['dnd-copy', 'alias', 'link', 'dnd-link', '1081e37283d90000800003c07f3ef6bf', '6407b0e94181790501fd1e167b474872', '640fb0e74195791501fd1ed57b41487f', '3085a0e285430894940527032f8b26df'],
  wait: ['watch'],
  progress: ['left_ptr_watch', 'half-busy', '3ecb610c1bf2410f44200f48c40d3599', '08e8e1c95fe2fc01f976f1e063a24ccd', '00000000000000020006000e7e9ffc3f'],
  crosshair: ['cross', 'tcross', 'cross_reverse', 'diamond_cross', 'cell', 'plus', 'color-picker', 'pencil'],
};

/* ------------------------------------------------------------------ rasterizer */
function inPoly(x, y, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function inside(p, x, y) {
  if (p.kind === 'poly') return inPoly(x, y, p.pts);
  const d = Math.hypot(x - p.cx, y - p.cy);
  return p.kind === 'circle' ? d <= p.r : d >= p.r1 && d <= p.r2;
}
function edgeDist(p, x, y) {
  if (p.kind === 'poly') { let m = Infinity; for (let i = 0, j = p.pts.length - 1; i < p.pts.length; j = i++) m = Math.min(m, segDist(x, y, p.pts[j], p.pts[i])); return m; }
  const d = Math.hypot(x - p.cx, y - p.cy);
  return p.kind === 'circle' ? Math.abs(d - p.r) : Math.min(Math.abs(d - p.r1), Math.abs(d - p.r2));
}
function partColor(p, x, y) {
  if (!p.arc) return p.fill;
  // a spinner: the ring is light, a quarter of it dark
  const a = (Math.atan2(y - p.cy, x - p.cx) + Math.PI) / (2 * Math.PI);
  return a < 0.28 ? [55, 55, 62] : [178, 178, 186];
}

function render(def, size) {
  const k = size / 24, N = 4;
  const ow = def.outlineW ?? 1.3, sh = 2.4;
  const px = new Float32Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const x = (pxl + (sx + 0.5) / N) / k, y = (py + (sy + 0.5) / N) / k;
          let col = null;
          for (let i = def.parts.length - 1; i >= 0; i--) if (inside(def.parts[i], x, y)) { col = partColor(def.parts[i], x, y); break; }
          if (col) { r += col[0]; g += col[1]; b += col[2]; a += 1; continue; }
          const d = Math.min(...def.parts.map((p) => edgeDist(p, x, y)));
          if (d <= ow) { r += def.outline[0]; g += def.outline[1]; b += def.outline[2]; a += 1; continue; }
          // soft drop shadow, a little below the shape
          const ds = Math.min(...def.parts.map((p) => (inside(p, x, y - 0.9) ? 0 : edgeDist(p, x, y - 0.9))));
          if (ds <= ow + sh) { const al = 0.32 * (1 - (ds - ow) / sh) ** 1.5; a += al; }
        }
      }
      const n = N * N, i = (py * size + pxl) * 4;
      px[i + 3] = a / n;
      // r,g,b were summed only over opaque samples; shadows are black
      px[i] = r / n; px[i + 1] = g / n; px[i + 2] = b / n;   // premultiplied (shadow contributes 0 colour)
    }
  }
  return px;
}

/* ------------------------------------------------------------------ encoders */
function xcursor(images) {
  const header = Buffer.alloc(16 + images.length * 12);
  header.write('Xcur', 0, 'latin1'); header.writeUInt32LE(16, 4); header.writeUInt32LE(0x10000, 8); header.writeUInt32LE(images.length, 12);
  const chunks = [];
  let pos = header.length;
  images.forEach((im, idx) => {
    const ch = Buffer.alloc(36 + im.size * im.size * 4);
    ch.writeUInt32LE(36, 0); ch.writeUInt32LE(0xfffd0002, 4); ch.writeUInt32LE(im.size, 8); ch.writeUInt32LE(1, 12);
    ch.writeUInt32LE(im.size, 16); ch.writeUInt32LE(im.size, 20); ch.writeUInt32LE(im.hot[0], 24); ch.writeUInt32LE(im.hot[1], 28); ch.writeUInt32LE(0, 32);
    for (let p = 0; p < im.size * im.size; p++) {
      const q = p * 4, A = Math.round(im.px[q + 3] * 255);
      const R = Math.round(Math.min(255, im.px[q])), G = Math.round(Math.min(255, im.px[q + 1])), B = Math.round(Math.min(255, im.px[q + 2]));
      ch.writeUInt32LE(((A << 24) | (R << 16) | (G << 8) | B) >>> 0, 36 + p * 4);   // premultiplied ARGB
    }
    header.writeUInt32LE(0xfffd0002, 16 + idx * 12); header.writeUInt32LE(im.size, 20 + idx * 12); header.writeUInt32LE(pos, 24 + idx * 12);
    pos += ch.length; chunks.push(ch);
  });
  return Buffer.concat([header, ...chunks]);
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(px, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const q = (y * size + x) * 4, a = px[q + 3], o = y * (size * 4 + 1) + 1 + x * 4;
      // un-premultiply for PNG
      raw[o] = a ? Math.min(255, Math.round(px[q] / a)) : 0; raw[o + 1] = a ? Math.min(255, Math.round(px[q + 1] / a)) : 0; raw[o + 2] = a ? Math.min(255, Math.round(px[q + 2] / a)) : 0; raw[o + 3] = Math.round(a * 255);
    }
  }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ------------------------------------------------------------------ write everything */
const themeDir = path.join(ROOT, 'session', 'cursors', THEME);
const curDir = path.join(themeDir, 'cursors');
fs.rmSync(themeDir, { recursive: true, force: true });
fs.mkdirSync(curDir, { recursive: true });
fs.writeFileSync(path.join(themeDir, 'index.theme'), `[Icon Theme]\nName=${THEME}\nComment=LiquidDesktop cursors\nInherits=Adwaita\n`);

const css = [];
for (const [name, def] of Object.entries(CURSORS)) {
  const images = SIZES.map((size) => ({ size, px: render(def, size), hot: def.hot.map((v) => Math.round((v * size) / 24)) }));
  fs.writeFileSync(path.join(curDir, name), xcursor(images));
  for (const alias of ALIASES[name] || []) if (alias !== name) fs.symlinkSync(name, path.join(curDir, alias));
  const p1 = png(images[0].px, 24).toString('base64'), p2 = png(images[2].px, 48).toString('base64');
  const fallback = { default: 'default', pointer: 'pointer', text: 'text', copy: 'copy', wait: 'wait', progress: 'progress' }[name] || name;
  css.push(`  --cur-${name}: -webkit-image-set(url("data:image/png;base64,${p1}") 1x, url("data:image/png;base64,${p2}") 2x) ${def.hot[0]} ${def.hot[1]}, ${fallback};`);
}

fs.writeFileSync(path.join(ROOT, 'renderer', 'css', 'cursors.css'), `/* Generated by tools/gen-cursors.js — LiquidDesktop's cursors for the web UI. */
:root {
${css.join('\n')}
}
html, body, button, select, label, .menu-item, .mb-item, .dock-item, .tb-btn, .btn, .win-titlebar, .sidebar, .sb-item, a, summary { cursor: var(--cur-default); }
a[href], .br-fav, .br-recent-row, [role='link'] { cursor: var(--cur-pointer); }
input:not([type='range']):not([type='checkbox']):not([type='button']), textarea, [contenteditable='true'], [contenteditable='true'] *, .xterm, .xterm .xterm-screen, .xterm-helper-textarea { cursor: var(--cur-text); }
.rz.n, .rz.s { cursor: var(--cur-ns-resize); }
.rz.e, .rz.w { cursor: var(--cur-ew-resize); }
.rz.ne, .rz.sw { cursor: var(--cur-nesw-resize); }
.rz.nw, .rz.se { cursor: var(--cur-nwse-resize); }
:disabled, .disabled { cursor: var(--cur-default); }
body.resizing-win, body.resizing-win * { cursor: inherit; }
`);
console.log(`wrote ${Object.keys(CURSORS).length} cursors (+ aliases) to ${path.relative(ROOT, themeDir)} and renderer/css/cursors.css`);
