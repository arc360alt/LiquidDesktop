// Screenshot of an X display as PNG — for checking what a nested session (tools/nested.sh) really shows,
// without xwd/ImageMagick. Uses the repo's own `x11` module.
//   node tools/xshot.js :7 out.png             the root window (what's on screen with no / an xrender compositor)
//   node tools/xshot.js :7 out.png --overlay   the compositor's overlay window
// No node? Electron works as one: ELECTRON_RUN_AS_NODE=1 electron tools/xshot.js :7 out.png
// Note: a GL compositor (picom's glx backend) presents frames the X server can't read back on some drivers,
// so its screen can come out black here even when it looks right.
const path = require('path');
const zlib = require('zlib');
const fs = require('fs');
const x11 = require(path.join(__dirname, '..', 'node_modules', 'x11'));

const [disp, out = 'xshot.png'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const overlay = process.argv.includes('--overlay');
if (!disp) { console.error('usage: node tools/xshot.js :DISPLAY out.png [--overlay]'); process.exit(2); }

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
function png(W, H, rgb) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let r = 0; r < H; r++) rgb.copy(raw, r * (W * 3 + 1) + 1, r * W * 3, (r + 1) * W * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

x11.createClient({ display: disp }, (err, d) => {
  if (err) { console.error(err.message || err); process.exit(1); }
  const X = d.client, root = d.screen[0].root, W = d.screen[0].pixel_width, H = d.screen[0].pixel_height;
  const rgb = Buffer.alloc(W * H * 3);
  const rows = Math.max(1, Math.floor(200000 / W));   // in strips: one request has a size limit
  const grab = (target) => {
    let y = 0;
    const next = () => {
      if (y >= H) { fs.writeFileSync(out, png(W, H, rgb)); console.log(`saved ${out} (${W}x${H})`); process.exit(0); }
      const h = Math.min(rows, H - y);
      X.GetImage(2, target, 0, y, W, h, 0xffffffff, (e, img) => {
        if (e) { console.error('GetImage failed:', e.message || e); process.exit(1); }
        const bpp = img.data.length / (W * h);   // 4 (BGRX) on 24/32-bit screens
        for (let i = 0; i < W * h; i++) { const o = (y * W + i) * 3; rgb[o] = img.data[i * bpp + 2]; rgb[o + 1] = img.data[i * bpp + 1]; rgb[o + 2] = img.data[i * bpp]; }
        y += h; next();
      });
    };
    next();
  };
  if (!overlay) return grab(root);
  X.require('composite', (e, C) => {
    if (e) { console.error('no Composite extension'); process.exit(1); }
    C.GetOverlayWindow(root, (e2, ov) => grab(ov));
  });
});
