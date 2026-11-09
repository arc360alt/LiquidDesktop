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

module.exports = { loadCursor, findCursorFile, parseXcursor };
