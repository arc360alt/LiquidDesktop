// Photos — your pictures and videos (Pictures and Videos folders) by when they were taken: Years, Months and All
// Photos, like the Mac's, with Favorites, Videos, Screenshots and albums of your own. Double-click opens a photo
// big; arrows step through. The files stay where they are — albums and favorites are just lists.
import { h, $, $$, fileUrl, basename, dirname, fmtSize } from '../util.js';
import { playableMedia } from '../playable.js';
import { registerApp, wm } from '../wm.js';
import { sym } from '../icons.js';
import { api } from '../sys.js';
import { appData } from '../store.js';
import { contextMenu, prompt, confirmDialog, alertDialog } from '../menus.js';
import { sendToPhoneItem } from '../phone.js';

const HEART = '<svg viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z"/></svg>';
const I = {
  library: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 4 3.5 2.5-2 4.5 3.5" stroke-linejoin="round"/></svg>',
  favorites: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.1a4.3 4.3 0 0 1 7.5 2.7C19.5 15.4 12 20 12 20z" stroke-linejoin="round"/></svg>',
  videos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="m16 10.5 5-3v9l-5-3" stroke-linejoin="round"/></svg>',
  screenshots: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/></svg>',
  recent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  album: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="7" width="16" height="13" rx="2.5"/><path d="M6.5 4.5h11" stroke-linecap="round"/></svg>',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const meta = () => { const m = appData.get('photos', null) || {}; m.favs ||= []; m.albums ||= []; return m; };
const editMeta = (fn) => { const m = meta(); fn(m); appData.set('photos', m); return m; };
const isShot = (it) => /screenshot|screen shot|scrot|snip/i.test(it.name) || /Screenshots$/i.test(it.folder);

registerApp({
  id: 'photos', name: 'Photos', size: [1100, 720], minSize: [640, 420], overlayContent: true, hideTitle: true,
  keywords: ['pictures', 'gallery', 'images', 'albums', 'camera roll'],
  about: 'Your pictures and videos, by when they were taken.',
  menus: (win) => [
    { title: 'File', items: [{ label: 'Import…', shortcut: '⇧⌘I', action: () => win?.state?.importFiles() }, { label: 'New Album…', action: () => win?.state?.newAlbum() }, '-', { label: 'Close Window', shortcut: '⌘W', action: () => win?.close() }] },
    { title: 'View', items: [{ label: 'Years', action: () => win?.state?.setMode('years') }, { label: 'Months', action: () => win?.state?.setMode('months') }, { label: 'All Photos', action: () => win?.state?.setMode('all') }, '-', { label: 'Zoom In', shortcut: '⌘+', action: () => win?.state?.zoom(1) }, { label: 'Zoom Out', shortcut: '⌘−', action: () => win?.state?.zoom(-1) }, '-', { label: 'Refresh', action: () => win?.state?.reload() }] }],
  open(win) {
    let items = [], view = 'library', mode = 'all', size = appData.get('photosSize', 150), sel = new Set(), q = '', viewer = null;
    const side = h('div.sidebar.ph2-side');
    const grid = h('div.ph2-scroll', { tabindex: 0 });
    const main = h('div.main-pane.ph2-main', grid);
    win.body.append(side, main);
    const seg = h('div.segmented.ph2-seg');
    const search = h('input.field', { placeholder: 'Search', style: { width: '180px' } });
    search.addEventListener('input', () => { q = search.value.trim().toLowerCase(); draw(); });
    const zoomOut = h('button.tb-btn', { title: 'Smaller', html: sym.minus, onclick: () => zoom(-1) }), zoomIn = h('button.tb-btn', { title: 'Larger', html: sym.plus, onclick: () => zoom(1) });
    win.toolbar.style.marginLeft = '150px';
    win.toolbar.append(h('div.tb-group', zoomOut, zoomIn), h('div.spacer'), seg, h('div.spacer'),
      h('div.tb-group', h('button.tb-btn', { title: 'Import', html: sym.download || sym.plus, onclick: () => importFiles() })), h('div.search-field', { html: sym.search }, search));

    /* ---------------------------------------------- loading */
    async function load(force) {
      grid.replaceChildren(h('div.ph2-empty', h('div.spinner'), 'Looking for photos…'));
      try { const r = await api.photos.list({ force }); items = r.items; } catch (e) { items = []; grid.replaceChildren(h('div.ph2-empty', e.message)); return; }
      drawSide(); draw();
    }

    /* ---------------------------------------------- sidebar */
    function drawSide() {
      const m = meta();
      const it = (k, label, icon, n) => {
        const el = h('div.sb-item' + (view === k ? '.sel' : ''), { html: icon }, h('span.ellipsis', label), n != null ? h('small.ph2-n', n) : null);
        el.addEventListener('click', () => { view = k; sel.clear(); drawSide(); draw(); grid.scrollTop = 0; });
        if (k.startsWith('album:')) {
          el.addEventListener('contextmenu', (e) => contextMenu(e, [{ label: 'Rename…', action: () => renameAlbum(k.slice(6)) }, { label: 'Delete Album', danger: true, action: () => deleteAlbum(k.slice(6)) }]));
          el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/liquid-photos')) { e.preventDefault(); el.classList.add('drop'); } });
          el.addEventListener('dragleave', () => el.classList.remove('drop'));
          el.addEventListener('drop', (e) => { el.classList.remove('drop'); addToAlbum(k.slice(6), JSON.parse(e.dataTransfer.getData('text/liquid-photos'))); });
        }
        return el;
      };
      side.replaceChildren(
        h('div.sb-sec', 'Photos'), it('library', 'Library', I.library, items.length),
        h('div.sb-sec', 'Collections'),
        it('favorites', 'Favorites', I.favorites, m.favs.filter((p) => items.some((x) => x.path === p)).length),
        it('recent', 'Recently Saved', I.recent), it('videos', 'Videos', I.videos, items.filter((x) => x.video).length), it('screenshots', 'Screenshots', I.screenshots, items.filter(isShot).length),
        h('div.sb-sec.ph2-albums-h', h('span', 'Albums'), h('button.sb-eject', { title: 'New Album', html: sym.plus, onclick: () => newAlbum() })),
        ...m.albums.map((a) => it('album:' + a.id, a.name, I.album, a.paths.length)));
    }

    /* ---------------------------------------------- what's shown */
    function shown() {
      const m = meta();
      let l = items;
      if (view === 'favorites') { const f = new Set(m.favs); l = l.filter((x) => f.has(x.path)); }
      else if (view === 'videos') l = l.filter((x) => x.video);
      else if (view === 'screenshots') l = l.filter(isShot);
      else if (view === 'recent') l = [...l].sort((a, b) => b.mtime - a.mtime).slice(0, 300).sort((a, b) => a.taken - b.taken);
      else if (view.startsWith('album:')) { const a = m.albums.find((x) => x.id === view.slice(6)); const s = new Set(a?.paths || []); l = l.filter((x) => s.has(x.path)); }
      if (q) l = l.filter((x) => x.name.toLowerCase().includes(q) || x.folder.toLowerCase().includes(q) || new Date(x.taken).toLocaleDateString([], { month: 'long', year: 'numeric', day: 'numeric' }).toLowerCase().includes(q));
      return l;
    }
    const drawSeg = () => seg.replaceChildren(...[['years', 'Years'], ['months', 'Months'], ['all', 'All Photos']].map(([k, l]) => h('button' + (mode === k ? '.on' : ''), { onclick: () => setMode(k) }, l)));
    function setMode(k) { mode = k; drawSeg(); draw(); grid.scrollTop = 0; }
    seg.hidden = false;

    /* ---------------------------------------------- the thumbnails (loaded as they scroll into view) */
    const io = new IntersectionObserver((ents) => {
      for (const e of ents) {
        if (!e.isIntersecting) continue;
        const el = e.target; io.unobserve(el);
        api.photos.thumb(el.dataset.path, el.dataset.big ? 600 : 300).then((t) => { el.style.backgroundImage = `url("${fileUrl(t)}")`; el.classList.add('loaded'); }).catch(() => el.classList.add('broken'));
      }
    }, { root: grid, rootMargin: '600px 0px' });
    const tile = (it, big) => {
      const el = h('div.ph2-tile' + (sel.has(it.path) ? '.sel' : ''), { 'data-path': it.path, draggable: true },
        it.video ? h('span.ph2-vid', { html: sym.play }) : null, meta().favs.includes(it.path) ? h('span.ph2-fav', { html: HEART }) : null);
      if (big) el.dataset.big = '1';
      io.observe(el);
      return el;
    };

    function draw() {
      io.disconnect();
      const l = shown();
      grid.style.setProperty('--ph-size', size + 'px');
      seg.style.visibility = view === 'library' ? '' : 'hidden';
      const title = view === 'library' ? null : view.startsWith('album:') ? meta().albums.find((a) => a.id === view.slice(6))?.name : { favorites: 'Favorites', videos: 'Videos', screenshots: 'Screenshots', recent: 'Recently Saved' }[view];
      if (!l.length) {
        grid.replaceChildren(h('div.ph2-empty', h('div.ph2-empty-ic', { html: I.library }), h('b', items.length ? 'No Photos' : 'No Photos Yet'),
          h('small.muted', items.length ? (q ? 'Nothing matches your search.' : view.startsWith('album:') ? 'Drag photos onto the album in the sidebar, or use “Add to Album” in a photo’s menu.' : 'Nothing here yet.') : 'Photos shows the pictures and videos in your Pictures and Videos folders.'),
          !items.length ? h('button.btn.primary', { onclick: () => importFiles() }, 'Import…') : null));
        return;
      }
      const m = view === 'library' ? mode : 'all';
      const out = [];
      if (title) out.push(h('h1.ph2-title', title, h('small', `${l.length} item${l.length === 1 ? '' : 's'}`)));
      if (m === 'years') {
        const by = new Map();
        for (const it of l) { const y = new Date(it.taken).getFullYear(); if (!by.has(y)) by.set(y, []); by.get(y).push(it); }
        const wrap = h('div.ph2-cards.years');
        for (const [y, list] of [...by].sort((a, b) => a[0] - b[0])) {
          const cover = list[Math.floor(list.length / 2)];
          const c = h('div.ph2-card', tile(cover, true), h('div.ph2-card-t', h('b', String(y)), h('small', `${list.length} items`)));
          c.addEventListener('click', () => { mode = 'months'; drawSeg(); draw(); setTimeout(() => $(`[data-year="${y}"]`, grid)?.scrollIntoView({ block: 'start' }), 30); });
          wrap.append(c);
        }
        out.push(wrap);
      } else if (m === 'months') {
        const by = new Map();
        for (const it of l) { const d = new Date(it.taken), k = d.getFullYear() * 12 + d.getMonth(); if (!by.has(k)) by.set(k, []); by.get(k).push(it); }
        const wrap = h('div.ph2-cards.months');
        for (const [k, list] of [...by].sort((a, b) => a[0] - b[0])) {
          const y = Math.floor(k / 12), mo = k % 12;
          const c = h('div.ph2-card', { 'data-year': y }, tile(list[0], true), h('div.ph2-card-t', h('b', `${MONTHS[mo]} ${y}`), h('small', `${list.length} items`)));
          c.addEventListener('click', () => { mode = 'all'; drawSeg(); draw(); setTimeout(() => $(`[data-month="${k}"]`, grid)?.scrollIntoView({ block: 'start' }), 30); });
          wrap.append(c);
        }
        out.push(wrap);
      } else {
        let cur = null, g = null;
        for (const it of l) {
          const d = new Date(it.taken), k = d.getFullYear() * 12 + d.getMonth();
          if (k !== cur) { cur = k; out.push(h('div.ph2-month', { 'data-month': k }, h('b', MONTHS[d.getMonth()]), ` ${d.getFullYear()}`)); g = h('div.ph2-grid'); out.push(g); }
          g.append(tile(it));
        }
      }
      grid.replaceChildren(...out);
      if (m === 'all' && view === 'library' && !q && !grid.dataset.scrolled) { grid.dataset.scrolled = '1'; requestAnimationFrame(() => (grid.scrollTop = grid.scrollHeight)); }   // newest at the bottom, like the Mac
    }

    /* ---------------------------------------------- selecting, opening */
    const byPath = (p) => items.find((x) => x.path === p);
    let last = null;
    grid.addEventListener('mousedown', (e) => {
      const t = e.target.closest('.ph2-tile'); if (!t || t.closest('.ph2-card')) return;
      const p = t.dataset.path;
      if (e.button === 2 && sel.has(p)) return;
      if (e.shiftKey && last) { const l = shown().map((x) => x.path); const a = l.indexOf(last), b = l.indexOf(p); for (let i = Math.min(a, b); i <= Math.max(a, b); i++) sel.add(l[i]); }
      else if (e.ctrlKey || e.metaKey) sel.has(p) ? sel.delete(p) : sel.add(p);
      else { sel.clear(); sel.add(p); }
      last = p; paintSel();
    });
    grid.addEventListener('dblclick', (e) => { const t = e.target.closest('.ph2-tile'); if (t && !t.closest('.ph2-card')) openViewer(t.dataset.path); });
    grid.addEventListener('dragstart', (e) => {
      const t = e.target.closest('.ph2-tile'); if (!t) return;
      if (!sel.has(t.dataset.path)) { sel.clear(); sel.add(t.dataset.path); paintSel(); }
      e.dataTransfer.setData('text/liquid-photos', JSON.stringify([...sel]));
      e.dataTransfer.setData('text/liquid-paths', JSON.stringify([...sel]));
      e.dataTransfer.setData('text/plain', [...sel].join('\n'));
    });
    grid.addEventListener('contextmenu', (e) => {
      const t = e.target.closest('.ph2-tile'); if (!t || t.closest('.ph2-card')) return;
      const paths = sel.has(t.dataset.path) ? [...sel] : [t.dataset.path];
      const m = meta(), fav = paths.every((p) => m.favs.includes(p));
      contextMenu(e, [
        { label: 'Open', action: () => openViewer(paths[0]) },
        { label: 'Open in Preview', action: () => wm.open('preview', { path: paths[0] }) },
        { label: fav ? 'Unfavorite' : 'Favorite', action: () => toggleFav(paths, !fav) },
        { label: 'Add to Album', submenu: [...m.albums.map((a) => ({ label: a.name, action: () => addToAlbum(a.id, paths) })), m.albums.length ? '-' : null, { label: 'New Album…', action: () => newAlbum(paths) }].filter(Boolean) },
        view.startsWith('album:') ? { label: 'Remove from Album', action: () => { editMeta((x) => { const a = x.albums.find((y) => y.id === view.slice(6)); if (a) a.paths = a.paths.filter((p) => !paths.includes(p)); }); drawSide(); draw(); } } : null, '-',
        { label: 'Show in Files', action: () => wm.open('files', { path: dirname(paths[0]), select: paths[0] }) },
        { label: 'Set as Wallpaper', disabled: byPath(paths[0])?.video, action: () => import('../store.js').then(({ store }) => store.set('customWallpaper', fileUrl(paths[0]))) },
        sendToPhoneItem(paths, () => false, (n) => import('../notifications.js').then((m2) => m2.notify(n))),
        { label: 'Get Info', action: () => info(paths[0]) }, '-',
        { label: paths.length > 1 ? `Move ${paths.length} Items to Trash` : 'Move to Trash', danger: true, action: () => trash(paths) },
      ].filter(Boolean));
    });
    const paintSel = () => $$('.ph2-grid .ph2-tile', grid).forEach((el) => el.classList.toggle('sel', sel.has(el.dataset.path)));

    function toggleFav(paths, on) { editMeta((m) => { const s = new Set(m.favs); for (const p of paths) on ? s.add(p) : s.delete(p); m.favs = [...s]; }); drawSide(); draw(); }
    async function newAlbum(paths = []) {
      const name = await prompt('New Album', 'Untitled Album', { ok: 'Create' }, win.el);
      if (!name) return;
      const id = Math.random().toString(36).slice(2, 9);
      editMeta((m) => m.albums.push({ id, name: name.trim(), paths: [...new Set(paths)] }));
      drawSide();
    }
    function addToAlbum(id, paths) { editMeta((m) => { const a = m.albums.find((x) => x.id === id); if (a) a.paths = [...new Set([...a.paths, ...paths])]; }); drawSide(); if (view === 'album:' + id) draw(); }
    async function renameAlbum(id) { const a = meta().albums.find((x) => x.id === id); const n = await prompt('Rename Album', a?.name || '', {}, win.el); if (n) { editMeta((m) => { m.albums.find((x) => x.id === id).name = n.trim(); }); drawSide(); draw(); } }
    async function deleteAlbum(id) {
      if (!(await confirmDialog('Delete this album?', 'The photos stay in your library.', 'Delete', { danger: true }, win.el))) return;
      editMeta((m) => { m.albums = m.albums.filter((x) => x.id !== id); }); if (view === 'album:' + id) view = 'library'; drawSide(); draw();
    }
    async function trash(paths) {
      if (!(await confirmDialog(paths.length > 1 ? `Move ${paths.length} items to the Trash?` : `Move “${basename(paths[0])}” to the Trash?`, 'The files are moved to the Trash, where you can still get them back.', 'Move to Trash', { danger: true }, win.el))) return;
      for (const p of paths) await api.fs.trash(p).catch(() => {});
      items = items.filter((x) => !paths.includes(x.path)); sel.clear();
      if (viewer) closeViewer();
      drawSide(); draw();
    }
    async function info(p) {
      const it = byPath(p); if (!it) return;
      alertDialog({ title: it.name, message: `${new Date(it.taken).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })}\n${fmtSize(it.size)} · ${it.video ? 'Video' : 'Photo'}\n${it.path}` }, win.el);
    }
    async function importFiles() {
      const files = await api.dialog.open({ title: 'Import Photos', multiple: true, filters: [{ name: 'Pictures and videos', patterns: ['*.jpg', '*.jpeg', '*.png', '*.gif', '*.webp', '*.heic', '*.avif', '*.mp4', '*.mov', '*.webm', '*.mkv'] }] }).catch(() => null);
      const l = Array.isArray(files) ? files : files ? [files] : [];
      if (!l.length) return;
      const done = await api.photos.import(l).catch((e) => { alertDialog({ title: 'Import failed', message: e.message }, win.el); return []; });
      if (done.length) { await load(true); view = 'recent'; drawSide(); draw(); }
    }
    function zoom(d) {
      const S = [90, 120, 150, 200, 260, 340];
      const nearest = S.reduce((a, b) => (Math.abs(b - size) < Math.abs(a - size) ? b : a));
      size = S[Math.max(0, Math.min(S.length - 1, S.indexOf(nearest) + d))];
      appData.set('photosSize', size);
      grid.style.setProperty('--ph-size', size + 'px');
    }

    /* ---------------------------------------------- the big view */
    function openViewer(p) {
      const list = shown();
      let i = list.findIndex((x) => x.path === p);
      if (i < 0) return;
      const stage = h('div.ph2-stage');
      const favBtn = h('button.tb-btn.ph2-favbtn', { title: 'Favorite', html: HEART });
      const caption = h('div.ph2-cap');
      const bar = h('div.ph2-vbar', h('div.tb-group', h('button.tb-btn', { title: 'Back to Library', html: sym.chevronLeft, onclick: () => closeViewer() })), caption, h('span.spacer'),
        h('div.tb-group', favBtn, h('button.tb-btn', { title: 'Open in Preview (Live Text, zoom)', html: sym.search, onclick: () => wm.open('preview', { path: list[i].path }) }), h('button.tb-btn', { title: 'Info', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.1" stroke-linecap="round" stroke-width="2.2"/></svg>', onclick: () => info(list[i].path) }), h('button.tb-btn', { title: 'Move to Trash', html: sym.trash, onclick: () => trash([list[i].path]) })));
      const prev = h('button.ph2-nav.l', { html: sym.chevronLeft, onclick: () => go(-1) }), next = h('button.ph2-nav.r', { html: sym.chevronRight, onclick: () => go(1) });
      const v = h('div.ph2-viewer', stage, prev, next, bar);
      const show = () => {
        const it = list[i];
        stage.replaceChildren(it.video ? playableMedia(it.path).el : h('img', { src: fileUrl(it.path), draggable: false }));
        caption.replaceChildren(h('b', new Date(it.taken).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })), h('small', new Date(it.taken).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ' · ' + it.name));
        favBtn.classList.toggle('on', meta().favs.includes(it.path));
        prev.hidden = i === 0; next.hidden = i === list.length - 1;
      };
      const go = (d) => { i = Math.max(0, Math.min(list.length - 1, i + d)); show(); };
      favBtn.onclick = () => { const p2 = list[i].path; toggleFav([p2], !meta().favs.includes(p2)); show(); };
      const key = (e) => { if (e.key === 'ArrowRight') go(1); else if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'Escape' || e.key === ' ') { e.preventDefault(); closeViewer(); } else if (e.key === '.') favBtn.onclick(); else if (e.key === 'Delete') trash([list[i].path]); };
      viewer = { el: v, key };
      win.el.addEventListener('keydown', key);
      // over the whole window (the sidebar too), so the photo is in the middle of it
      win.body.append(v);
      win.el.classList.add('ph2-viewing');   // (the window's buttons stay above it)
      show();
    }
    function closeViewer() { if (!viewer) return; win.el.removeEventListener('keydown', viewer.key); viewer.el.remove(); viewer = null; win.el.classList.remove('ph2-viewing'); grid.focus(); }

    grid.addEventListener('keydown', (e) => {
      if (viewer) return;
      if (e.key === ' ' || e.key === 'Enter') { const p = [...sel][0]; if (p) { e.preventDefault(); openViewer(p); } }
      if (e.key === 'Delete' && sel.size) trash([...sel]);
      if (e.ctrlKey && e.key === 'a') { e.preventDefault(); shown().forEach((x) => sel.add(x.path)); paintSel(); }
      if (e.key === '.' && sel.size) toggleFav([...sel], ![...sel].every((p) => meta().favs.includes(p)));
    });
    win.el.addEventListener('keydown', (e) => { if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoom(1); } if (e.ctrlKey && e.key === '-') { e.preventDefault(); zoom(-1); } if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); importFiles(); } });
    win.on('close', () => io.disconnect());
    win.state = { importFiles, newAlbum, setMode, zoom, reload: () => load(true) };
    drawSeg();
    load();
  },
});
