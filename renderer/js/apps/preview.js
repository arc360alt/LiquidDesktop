// Preview — image viewer with zoom, plus plain-text preview.
import { h, basename, fileUrl, extOf, dirname } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym, IMAGE_EXT } from '../icons.js';
import { api } from '../sys.js';
import { store } from '../store.js';

registerApp({
  id: 'preview', name: 'Preview', size: [820, 600], minSize: [320, 240], overlayContent: true,
  keywords: ['image', 'photo', 'viewer', 'pictures'],
  open(win, args) {
    const box = h('div.preview');
    win.body.append(box);
    let zoom = 1, img = null, path = args.path, siblings = [];
    const setZoom = (z) => { zoom = Math.max(0.1, Math.min(8, z)); if (img) img.style.transform = `scale(${zoom})`; };
    win.toolbar.append(h('div.spacer'),
      h('div.tb-group', h('button.tb-btn', { html: sym.chevronLeft, title: 'Previous', onclick: () => step(-1) }), h('button.tb-btn', { html: sym.chevronRight, title: 'Next', onclick: () => step(1) })),
      h('div.tb-group', h('button.tb-btn', { html: sym.minus, title: 'Zoom Out', onclick: () => setZoom(zoom / 1.25) }), h('button.tb-btn', { html: sym.plus, title: 'Zoom In', onclick: () => setZoom(zoom * 1.25) })),
      h('div.tb-group', h('button.tb-btn', { html: sym.desktop, title: 'Set as Wallpaper', onclick: () => path && store.set('customWallpaper', fileUrl(path)) }),
        h('button.tb-btn', { html: sym.folder, title: 'Show in Files', onclick: () => path && wm.open('files', { path: dirname(path), select: path }) })));
    const show = async (p) => {
      path = p; box.innerHTML = ''; zoom = 1;
      if (!p) { box.append(h('div.empty-state', 'Open an image from Files')); return; }
      win.setTitle(basename(p));
      if (IMAGE_EXT.has(extOf(p))) { img = h('img', { src: fileUrl(p) }); box.append(img); }
      else { img = null; const pre = h('pre'); box.append(pre); api.fs.read(p).then((t) => (pre.textContent = t)).catch((e) => (pre.textContent = e.message)); }
    };
    const step = (d) => { if (!siblings.length) return; const i = siblings.indexOf(path); show(siblings[(i + d + siblings.length) % siblings.length]); };
    if (path) api.fs.list(dirname(path)).then((l) => { siblings = l.filter((f) => IMAGE_EXT.has(f.ext)).map((f) => f.path).sort(); }).catch(() => {});
    box.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9)); } }, { passive: false });
    win.el.tabIndex = 0;
    win.el.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') step(1); if (e.key === 'ArrowLeft') step(-1); if (e.key === '+' || e.key === '=') setZoom(zoom * 1.25); if (e.key === '-') setZoom(zoom / 1.25); if (e.key === '0') setZoom(1); });
    win.on('reopen', (a) => show(a.path));
    show(path);
  },
});
