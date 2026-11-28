// Preview: pictures (with zoom), videos and audio, plus plain-text files.
import { h, basename, fileUrl, extOf, dirname, fmtSize } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym, docIcon, IMAGE_EXT, VIDEO_EXT, AUDIO_EXT, TEXT_EXT } from '../icons.js';
import { api } from '../sys.js';
import { store } from '../store.js';
import { showMenu, alertDialog } from '../menus.js';

// Live Text's button: text in a box with selection handles
const LIVETEXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M8 9h8M8 12.5h8M8 16h5"/></svg>';

registerApp({
  id: 'preview', name: 'Preview', size: [820, 600], minSize: [320, 240], overlayContent: true,
  keywords: ['image', 'photo', 'viewer', 'pictures'],
  menus: (win) => [{ title: 'File', items: [{ label: 'Print…', shortcut: '⌃P', disabled: !win?.state?.printable, action: () => win?.state?.print() }] },
    { title: 'View', items: [{ label: 'Live Text…', action: () => win?.state?.setupLiveText() }] }],
  open(win, args) {
    const box = h('div.preview');
    win.body.append(box);
    let zoom = 1, img = null, path = args.path, siblings = [];
    let textLayer = null, ltBtn = null, ocrSeq = 0;
    const setZoom = (z) => { zoom = Math.max(0.1, Math.min(8, z)); if (img) img.style.transform = `scale(${zoom})`; placeText(); };
    win.toolbar.append(h('div.spacer'),
      h('div.tb-group', h('button.tb-btn', { html: sym.chevronLeft, title: 'Previous', onclick: () => step(-1) }), h('button.tb-btn', { html: sym.chevronRight, title: 'Next', onclick: () => step(1) })),
      h('div.tb-group', h('button.tb-btn', { html: sym.minus, title: 'Zoom Out', onclick: () => setZoom(zoom / 1.25) }), h('button.tb-btn', { html: sym.plus, title: 'Zoom In', onclick: () => setZoom(zoom * 1.25) })),
      h('div.tb-group', h('button.tb-btn', { html: sym.desktop, title: 'Set as Wallpaper', onclick: () => path && store.set('customWallpaper', fileUrl(path)) }),
        h('button.tb-btn', { html: sym.folder, title: 'Show in Files', onclick: () => path && wm.open('files', { path: dirname(path), select: path }) })));
    // File › Print… for pictures and PDFs (videos and songs don't print)
    const printable = () => path && /\.(png|jpe?g|gif|webp|bmp|svg|tiff?|pdf)$/i.test(path);
    // View › Live Text…: reading text in pictures needs tesseract and its English data
    const setupLiveText = async () => {
      const st = await api.ocr.status().catch(() => null);
      if (st?.ready) { await alertDialog({ title: 'Live Text is on', message: `Text in pictures can be selected and copied — drag across it, or use the button in the corner. Languages: ${st.langs.join(', ')}.` }, win.el); return; }
      const r = await alertDialog({ title: 'Turn on Live Text?', message: 'Selecting text in pictures and screenshots needs the tesseract text reader (about 15 MB). It works on this computer — nothing is sent anywhere.', buttons: [{ label: 'Not Now', value: 'no' }, { label: 'Install', value: 'ok', primary: true }] }, win.el);
      if (r.button !== 'ok') return;
      const { withAdmin } = await import('../admin.js');
      if (await withAdmin('Installing Live Text needs your password.', () => api.ocr.install(), win.el)) { if (path) show(path); }
    };
    win.state = { setupLiveText, print: () => printable() && import('../print.js').then(({ printDialog }) => printDialog({ title: basename(path), file: path }, win.el)), get printable() { return printable(); } };
    win.el.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'p') { e.preventDefault(); win.state.print(); } });
    // what this file can't be shown as: its icon, and a way to open it elsewhere
    const cantShow = (p, why) => box.append(h('div.pv-none', h('div.pv-none-ic', { html: docIcon(extOf(p)) }), h('b', basename(p)), h('small.muted', why),
      h('button.btn', { onclick: () => api.fs.open(p) }, 'Open With System App')));
    const show = async (p) => {
      path = p; box.innerHTML = ''; zoom = 1; textLayer = null; ltBtn = null; ocrSeq++;
      box.classList.remove('media');
      if (!p) { box.append(h('div.empty-state', 'Open a picture, video or song from Files')); return; }
      win.setTitle(basename(p));
      const ext = extOf(p);
      img = null;
      if (IMAGE_EXT.has(ext)) {
        img = h('img', { src: fileUrl(p), draggable: false, onerror: () => { box.innerHTML = ''; cantShow(p, 'This picture couldn’t be opened.'); } });
        box.append(img);
        liveText(p);
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
    /* ------------------------------------------------ Live Text: select and copy the text in a picture */
    // Each line tesseract found becomes a line of see-through text over the picture, stretched to the line's
    // width, so dragging across it selects real text (Ctrl+C copies it). The button shows where the text is.
    async function liveText(p) {
      const my = ocrSeq;
      const st = await api.ocr?.status?.().catch(() => null);
      if (!st?.ready || my !== ocrSeq) return;
      const res = await api.ocr.recognize(p).catch(() => null);
      if (my !== ocrSeq || !res?.lines?.length || !img) return;
      textLayer = h('div.pv-text');
      for (const l of res.lines) {
        const el = h('span.pv-line', { style: { left: (l.x / res.width) * 100 + '%', top: (l.y / res.height) * 100 + '%', width: (l.w / res.width) * 100 + '%', height: (l.h / res.height) * 100 + '%' } }, l.text);
        el.dataset.h = l.h / res.height;
        textLayer.append(el);
      }
      textLayer.allText = res.lines.map((l) => l.text).join('\n');
      box.append(textLayer);
      ltBtn = h('button.pv-lt', { title: 'Live Text — select text in this picture', html: LIVETEXT, onclick: (e) => {
        const on = !textLayer.classList.contains('show');
        textLayer.classList.toggle('show', on); ltBtn.classList.toggle('on', on);
        if (on) { const r = e.currentTarget.getBoundingClientRect(); showMenu([{ label: 'Copy All Text', action: () => api.clip.write(textLayer.allText) }, { label: 'Select All Text', action: () => { const r2 = document.createRange(); r2.selectNodeContents(textLayer); getSelection().removeAllRanges(); getSelection().addRange(r2); } }], r.left - 120, r.top - 70); }
      } });
      box.append(ltBtn);
      if (img.complete) placeText(); else img.addEventListener('load', placeText, { once: true });
    }
    // the text layer sits exactly on the picture (same box, same zoom), each line's text sized to fill it
    function placeText() {
      if (!textLayer || !img) return;
      Object.assign(textLayer.style, { left: img.offsetLeft + 'px', top: img.offsetTop + 'px', width: img.offsetWidth + 'px', height: img.offsetHeight + 'px', transform: `scale(${zoom})` });
      const H = img.offsetHeight;
      for (const el of textLayer.children) {
        el.style.fontSize = Math.max(4, el.dataset.h * H * 0.86) + 'px';
        el.style.transform = '';
        const natural = el.scrollWidth, want = el.clientWidth;
        if (natural > 0 && want > 0) el.style.transform = `scaleX(${want / natural})`;
      }
    }
    new ResizeObserver(() => placeText()).observe(box);
    // copying selected Live Text: line by line (the lines are separate boxes, which a plain copy would run together)
    const selectedText = () => {
      const sel = getSelection();
      if (!textLayer || sel.isCollapsed || !sel.rangeCount) return null;
      const range = sel.getRangeAt(0);
      const out = [];
      for (const el of textLayer.children) {
        if (!sel.containsNode(el, true)) continue;
        const r = document.createRange(); r.selectNodeContents(el);
        if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
        if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
        out.push(r.toString());
      }
      return out.length ? out.join('\n') : null;
    };
    win.el.addEventListener('copy', (e) => { const t = selectedText(); if (t != null) { e.preventDefault(); e.clipboardData?.setData('text/plain', t); api.clip.write(t); } });
    win.el.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'c') { const t = selectedText(); if (t != null) { e.preventDefault(); api.clip.write(t); } } });
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
