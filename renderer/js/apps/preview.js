// Preview: pictures (with zoom), videos and audio, plus plain-text files.
import { h, basename, fileUrl, extOf, dirname, fmtSize } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym, docIcon, IMAGE_EXT, VIDEO_EXT, AUDIO_EXT, TEXT_EXT } from '../icons.js';
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
    // what this file can't be shown as: its icon, and a way to open it elsewhere
    const cantShow = (p, why) => box.append(h('div.pv-none', h('div.pv-none-ic', { html: docIcon(extOf(p)) }), h('b', basename(p)), h('small.muted', why),
      h('button.btn', { onclick: () => api.fs.open(p) }, 'Open With System App')));
    const show = async (p) => {
      path = p; box.innerHTML = ''; zoom = 1;
      box.classList.remove('media');
      if (!p) { box.append(h('div.empty-state', 'Open a picture, video or song from Files')); return; }
      win.setTitle(basename(p));
      const ext = extOf(p);
      img = null;
      if (IMAGE_EXT.has(ext)) {
        img = h('img', { src: fileUrl(p), draggable: false, onerror: () => { box.innerHTML = ''; cantShow(p, 'This picture couldn’t be opened.'); } });
        box.append(img);
      } else if (VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext)) {
        // played straight from the file, so any size works
        const video = VIDEO_EXT.has(ext);
        const el = h(video ? 'video.pv-media' : 'audio.pv-media', { src: fileUrl(p), controls: true, autoplay: true, preload: 'metadata',
          onerror: () => { box.innerHTML = ''; cantShow(p, `This ${video ? 'video' : 'audio'} format can’t be played here.`); } });
        if (!video) box.append(h('div.pv-audio', h('div.pv-none-ic', { html: sym.music }), h('b', basename(p)), el));
        else box.append(el);
        box.classList.add('media');
      } else {
        // text: only files that are text and not huge
        const st = await api.fs.stat(p).catch(() => null);
        if (path !== p) return;
        if (TEXT_EXT.has(ext) && st && st.size <= 5 * 1024 * 1024) {
          const pre = h('pre'); box.append(pre);
          api.fs.read(p).then((t) => (pre.textContent = t)).catch((e) => { box.innerHTML = ''; cantShow(p, e.message); });
        } else cantShow(p, st ? `${(ext || 'This').toUpperCase()} file · ${fmtSize(st.size)} — Preview can’t show this kind of file.` : 'This file couldn’t be read.');
      }
    };
    const step = (d) => { if (!siblings.length) return; const i = siblings.indexOf(path); show(siblings[(i + d + siblings.length) % siblings.length]); };
    const sameKind = (e) => (IMAGE_EXT.has(extOf(path || '')) ? IMAGE_EXT.has(e) : VIDEO_EXT.has(extOf(path || '')) ? VIDEO_EXT.has(e) : AUDIO_EXT.has(extOf(path || '')) ? AUDIO_EXT.has(e) : false);
    if (path) api.fs.list(dirname(path)).then((l) => { siblings = l.filter((f) => sameKind(f.ext)).map((f) => f.path).sort(); }).catch(() => {});
    box.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9)); } }, { passive: false });
    win.el.tabIndex = 0;
    win.el.addEventListener('keydown', (e) => { if (e.target.closest?.('video, audio')) return; if (e.key === 'ArrowRight') step(1); if (e.key === 'ArrowLeft') step(-1); if (e.key === '+' || e.key === '=') setZoom(zoom * 1.25); if (e.key === '-') setZoom(zoom / 1.25); if (e.key === '0') setZoom(1); });
    win.on('reopen', (a) => show(a.path));
    show(path);
  },
});
