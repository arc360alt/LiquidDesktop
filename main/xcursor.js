// Sets the root window's cursor from your cursor theme (Xcursor files), so empty areas and window edges
// show a normal arrow instead of the bare X server's "X". Pure JS: parses the Xcursor file and uploads it
// through the RENDER extension. Falls back to the classic core-font arrow if anything is missing.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIRS = [...(process.env.XCURSOR_PATH || '').split(':').filter(Boolean).map((d) => d.replace(/^~/, os.homedir())),
  path.join(__dirname, '..', 'session', 'cursors'), path.join(os.homedir(), '.icons'), path.join(os.homedir(), '.local/share/icons'), '/usr/share/icons', '/usr/local/share/icons'];

function inherits(theme) {
  for (const d of DIRS) {
    try {
      const t = fs.readFileSync(path.join(d, theme, 'index.theme'), 'utf8');
      const m = t.match(/^Inherits\s*=\s*(.+)$/m);
      if (m) return m[1].split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    } catch { /* not in this dir */ }
  }
  return [];
}

function findCursorFile(name) {
  const start = [process.env.XCURSOR_THEME, 'LiquidCursor', 'default'].filter(Boolean);
  const seen = new Set();
  const queue = [...start];
  while (queue.length) {
    const theme = queue.shift();
    if (seen.has(theme)) continue;
    seen.add(theme);
    for (const d of DIRS) {
      const f = path.join(d, theme, 'cursors', name);
      if (fs.existsSync(f)) return f;
    }
    queue.push(...inherits(theme));
  }
  for (const d of DIRS) { const f = path.join(d, 'Adwaita', 'cursors', name); if (fs.existsSync(f)) return f; }
  return null;
}

// Xcursor format: "Xcur" header, a table of contents, then image chunks of premultiplied ARGB pixels.
function parseXcursor(buf, want = 24) {
  if (buf.toString('latin1', 0, 4) !== 'Xcur') return null;
  const ntoc = buf.readUInt32LE(12);
  let best = null;
  for (let i = 0; i < ntoc; i++) {
    const o = 16 + i * 12;
    const type = buf.readUInt32LE(o), size = buf.readUInt32LE(o + 4), pos = buf.readUInt32LE(o + 8);
    if (type !== 0xfffd0002) continue;
    if (!best || Math.abs(size - want) < Math.abs(best.size - want)) best = { size, pos };
  }
  if (!best) return null;
  const p = best.pos;
  const width = buf.readUInt32LE(p + 16), height = buf.readUInt32LE(p + 20), xhot = buf.readUInt32LE(p + 24), yhot = buf.readUInt32LE(p + 28);
  const pixels = buf.subarray(p + 36, p + 36 + width * height * 4);
  return { width, height, xhot, yhot, pixels };
}

function glyphCursor(X) {
  // core "cursor" font, glyph 68 = left_ptr
  const fid = X.AllocID(), cid = X.AllocID();
  const name = Buffer.from('cursor');
  const pad = Buffer.alloc((4 - (name.length % 4)) % 4);
  X.seq_num++;
  X.pack_stream.pack('CxSLSxxaa', [45, 3 + (name.length + pad.length) / 4, fid, name.length, name, pad]);
  X.seq_num++;
  X.pack_stream.pack('CxSLLLSSSSSSSS', [94, 8, cid, fid, fid, 68, 69, 0, 0, 0, 0xffff, 0xffff, 0xffff]);
  X.pack_stream.flush();
  return cid;
}

/** Resolves to a cursor id for `name` (default left_ptr). */
function loadCursor(X, root, name = 'left_ptr', size = Number(process.env.XCURSOR_SIZE) || 24) {
  return new Promise((resolve) => {
    let img = null;
    try { const f = findCursorFile(name); if (f) img = parseXcursor(fs.readFileSync(f), size); } catch { img = null; }
    if (!img || img.pixels.length * 1 > 200000) return resolve(glyphCursor(X));
    X.require('render', (err, Render) => {
      if (err || !Render.rgba32) return resolve(glyphCursor(X));
      const pid = X.AllocID(), gc = X.AllocID(), pic = X.AllocID(), cid = X.AllocID();
      X.CreatePixmap(pid, root, 32, img.width, img.height);
      X.CreateGC(gc, pid, {});
      // PutImage (ZPixmap, depth 32) with a normal-length request
      const data = img.pixels;
      const pad = Buffer.alloc((4 - (data.length % 4)) % 4);
      X.seq_num++;
      X.pack_stream.pack('CCSLLSSssCCxxaa', [72, 2, 6 + (data.length + pad.length) / 4, pid, gc, img.width, img.height, 0, 0, 0, 32, data, pad]);
      X.pack_stream.flush();
      Render.CreatePicture(pic, pid, Render.rgba32, {});
      // RENDER CreateCursor (minor opcode 27)
      X.seq_num++;
      X.pack_stream.pack('CCSLLSS', [Render.majorOpcode, 27, 4, cid, pic, img.xhot, img.yhot]);
      X.pack_stream.flush();
      resolve(cid);
    });
  });
}

/* ------------------------------------------------------------------ themes for Settings › Mouse */
const zlib = require('zlib');
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** Xcursor pixels (premultiplied ARGB, little-endian) → PNG data URL */
function toPng(img) {
  const { width: w, height: h, pixels } = img;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, o = y * (w * 4 + 1) + 1 + x * 4;
      const b = pixels[i], g = pixels[i + 1], r = pixels[i + 2], a = pixels[i + 3];
      raw[o] = a ? Math.min(255, Math.round((r * 255) / a)) : 0; raw[o + 1] = a ? Math.min(255, Math.round((g * 255) / a)) : 0;
      raw[o + 2] = a ? Math.min(255, Math.round((b * 255) / a)) : 0; raw[o + 3] = a;
    }
  }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const themeDirs = () => [...new Set([...(process.env.XCURSOR_PATH || '').split(':').filter(Boolean).map((d) => d.replace(/^~/, os.homedir())),
  path.join(__dirname, '..', 'session', 'cursors'), path.join(os.homedir(), '.local/share/icons'), path.join(os.homedir(), '.icons'), '/usr/share/icons', '/usr/local/share/icons'])];

/** Find one cursor of a specific theme (with its usual alternative names). */
function themeCursor(theme, names, size) {
  for (const d of themeDirs()) {
    for (const n of names) {
      const f = path.join(d, theme, 'cursors', n);
      try { if (fs.existsSync(f)) { const img = parseXcursor(fs.readFileSync(f), size); if (img) return img; } } catch { /* unreadable */ }
    }
  }
  return null;
}

/** Every installed cursor theme, with arrow / hand / I-beam previews. */
function listThemes() {
  const seen = new Map();
  for (const d of themeDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(d); } catch { continue; }
    for (const id of entries) {
      if (seen.has(id) || id === 'default') continue;
      if (!fs.existsSync(path.join(d, id, 'cursors'))) continue;
      let name = id;
      try { const m = fs.readFileSync(path.join(d, id, 'index.theme'), 'utf8').match(/^Name\s*=\s*(.+)$/m); if (m) name = m[1].trim(); } catch { /* no index */ }
      const arrow = themeCursor(id, ['left_ptr', 'default', 'arrow'], 32);
      if (!arrow) continue;
      const hand = themeCursor(id, ['pointer', 'hand2', 'hand1', 'pointing_hand'], 32), text = themeCursor(id, ['text', 'xterm', 'ibeam'], 32);
      seen.set(id, { id, name: id === 'MacOS-Tahoe-Cursor' ? 'macOS Tahoe (by MOYASH)' : id === 'LiquidCursor' ? 'LiquidDesktop Classic' : name, preview: [arrow, hand, text].filter(Boolean).map(toPng) });
    }
  }
  const rank = (t) => (t.id === 'MacOS-Tahoe-Cursor' ? 2 : t.id === 'LiquidCursor' ? 1 : 0);
  return [...seen.values()].sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
}

/** CSS cursor values for the web UI from any installed theme (1x + 2x images). */
const CSS_NAMES = {
  default: ['left_ptr', 'default', 'arrow'], pointer: ['pointer', 'hand2', 'hand1', 'pointing_hand'], text: ['text', 'xterm', 'ibeam'],
  'ew-resize': ['ew-resize', 'sb_h_double_arrow', 'h_double_arrow', 'size_hor'], 'ns-resize': ['ns-resize', 'sb_v_double_arrow', 'v_double_arrow', 'size_ver'],
  'nwse-resize': ['nwse-resize', 'size_fdiag', 'bd_double_arrow', 'bottom_right_corner'], 'nesw-resize': ['nesw-resize', 'size_bdiag', 'fd_double_arrow', 'bottom_left_corner'],
  move: ['move', 'fleur', 'all-scroll', 'size_all'], 'not-allowed': ['not-allowed', 'crossed_circle', 'forbidden'], copy: ['copy', 'dnd-copy'],
  wait: ['wait', 'watch'], progress: ['progress', 'left_ptr_watch', 'half-busy'], crosshair: ['crosshair', 'cross', 'tcross'],
};
function themeCss(theme, size = 24) {
  const out = {};
  for (const [k, names] of Object.entries(CSS_NAMES)) {
    const a = themeCursor(theme, names, size), b = themeCursor(theme, names, size * 2);
    if (!a) continue;
    const scale = (img) => (img.width / size);   // themes without an exact size: CSS scales via image-set resolution
    const s1 = scale(a), s2 = b ? scale(b) : s1;
    out[k] = `-webkit-image-set(url("${toPng(a)}") ${s1}x${b ? `, url("${toPng(b)}") ${s2}x` : ''}) ${Math.round(a.xhot / s1)} ${Math.round(a.yhot / s1)}, ${k}`;
  }
  return out;
}

module.exports = { loadCursor, findCursorFile, parseXcursor, listThemes, themeCss };
