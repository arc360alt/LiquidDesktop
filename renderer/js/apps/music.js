// Music — plays the songs in your Music folder, like the Mac's Music app: Recently Added, Artists, Albums, Songs and
// playlists of your own, with the player in the toolbar. It tells the system what's playing (MPRIS, through
// Chromium's media session), so Control Center's Now Playing and the media keys work with it.
import { h, $, $$, fileUrl, basename, dirname } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym } from '../icons.js';
import { api } from '../sys.js';
import { appData } from '../store.js';
import { contextMenu, prompt, confirmDialog, alertDialog } from '../menus.js';

const I = {
  recent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  artists: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="10" r="3.2"/><path d="M3.5 19c.7-3.2 2.8-4.8 5.5-4.8s4.8 1.6 5.5 4.8" stroke-linecap="round"/><path d="M17.5 5v8.5" stroke-linecap="round"/><circle cx="16" cy="14.2" r="1.8"/><path d="M17.5 5l3 1" stroke-linecap="round"/></svg>',
  albums: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".9" fill="currentColor"/></svg>',
  songs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 17V5.5l10-2v11"/><circle cx="6.8" cy="17.2" r="2.3"/><circle cx="16.8" cy="14.7" r="2.3"/></svg>',
  playlist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6.5h11M4 11h11M4 15.5h7"/><path d="M18 9.5v7.5"/><circle cx="16.3" cy="17.2" r="1.8"/><path d="M18 9.5l2.5.7"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7h3c4 0 6 10 10 10h4M3.5 17h3c1.7 0 3-1.8 4.2-4M13.3 11c1.2-2.2 2.5-4 4.2-4h3"/><path d="m18 4.5 2.5 2.5L18 9.5M18 14.5l2.5 2.5-2.5 2.5"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H19M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H5"/><path d="m16 3 3 3-3 3M8 21l-3-3 3-3"/></svg>',
  queue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h16M4 11h16M4 16h9"/><path d="M16 14.5v5l4-2.5z" fill="currentColor"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="currentColor" opacity=".45"><path d="M9 17.5V6l10-2v11.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="6.8" cy="17.5" r="2.4"/><circle cx="16.8" cy="15.4" r="2.4"/></svg>',
};
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const meta = () => { const m = appData.get('music', null) || {}; m.playlists ||= []; return m; };
const editMeta = (fn) => { const m = meta(); fn(m); appData.set('music', m); return m; };

registerApp({
  id: 'music', name: 'Music', size: [1120, 720], minSize: [760, 460], overlayContent: true, hideTitle: true, singleton: true,
  keywords: ['songs', 'audio', 'player', 'mp3', 'albums', 'playlist'],
  about: 'Play the music in your Music folder.',
  menus: (win) => [
    { title: 'File', items: [{ label: 'New Playlist…', action: () => win?.state?.newPlaylist() }, { label: 'Add Folder to Library…', action: () => win?.state?.addFolder() }, '-', { label: 'Close Window', shortcut: '⌘W', action: () => win?.close() }] },
    { title: 'Controls', items: [{ label: 'Play / Pause', shortcut: 'Space', action: () => win?.state?.toggle() }, { label: 'Next', shortcut: '⌘→', action: () => win?.state?.next() }, { label: 'Previous', shortcut: '⌘←', action: () => win?.state?.prev() }, '-', { label: 'Shuffle', checked: !!win?.state?.shuffle, action: () => win?.state?.toggleShuffle() }, { label: 'Repeat', checked: !!win?.state?.repeat, action: () => win?.state?.cycleRepeat() }] },
    { title: 'View', items: [{ label: 'Refresh Library', action: () => win?.state?.reload() }] }],
  open(win) {
    let tracks = [], view = 'albums', detail = null, q = '', sortKey = 'title', sel = new Set();
    // the player
    const audio = new Audio();
    audio.preload = 'auto';
    let queue = [], qi = -1, order = null, shuffle = !!meta().shuffle, repeat = meta().repeat || 'off';
    const byId = new Map();

    const side = h('div.sidebar.mu-side');
    const content = h('div.mu-content');
    const queuePanel = h('div.mu-queue', { hidden: true });
    const main = h('div.main-pane.mu-main', content, queuePanel);
    win.body.append(side, main);

    /* ---------------------------------------------- toolbar player */
    const playBtn = h('button.mu-ctl.big', { title: 'Play', html: sym.play, onclick: () => toggle() });
    const shufBtn = h('button.mu-ctl.sm', { title: 'Shuffle', html: I.shuffle, onclick: () => toggleShuffle() });
    const repBtn = h('button.mu-ctl.sm', { title: 'Repeat', html: I.repeat, onclick: () => cycleRepeat() });
    const lcdArt = h('div.mu-lcd-art', { html: I.note });
    const lcdTitle = h('div.mu-lcd-t'), lcdSub = h('div.mu-lcd-s');
    const bar = h('div.mu-lcd-bar', h('i'));
    const tNow = h('small.mu-lcd-now'), tLeft = h('small.mu-lcd-left');
    const lcd = h('div.mu-lcd', lcdArt, h('div.mu-lcd-mid', lcdTitle, lcdSub, h('div.mu-lcd-prog', tNow, bar, tLeft)));
    const vol = h('input.slider.mu-vol', { type: 'range', min: 0, max: 100, value: Math.round((meta().volume ?? 0.8) * 100) });
    const paintVol = () => vol.style.setProperty('--v', vol.value + '%');
    vol.addEventListener('input', () => { audio.volume = vol.value / 100; paintVol(); editMeta((m) => { m.volume = audio.volume; }); });
    audio.volume = vol.value / 100; paintVol();
    const search = h('input.field', { placeholder: 'Search', style: { width: '160px' } });
    search.addEventListener('input', () => { q = search.value.trim().toLowerCase(); draw(); });
    win.toolbar.style.marginLeft = '150px';
    win.toolbar.append(
      h('div.tb-group.mu-ctls', shufBtn, h('button.mu-ctl', { title: 'Previous', html: sym.prev, onclick: () => prev() }), playBtn, h('button.mu-ctl', { title: 'Next', html: sym.next, onclick: () => next() }), repBtn),
      lcd,
      h('div.mu-volbox', h('span', { html: sym.speakerLow || sym.speaker }), vol),
      h('div.tb-group', h('button.tb-btn', { title: 'Up Next', html: I.queue, onclick: () => { queuePanel.hidden = !queuePanel.hidden; drawQueue(); } })),
      h('div.search-field', { html: sym.search }, search));
    bar.addEventListener('mousedown', (e) => {
      if (!audio.duration) return;
      const seek = (ev) => { const r = bar.getBoundingClientRect(); audio.currentTime = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * audio.duration; };
      seek(e);
      const up = () => { removeEventListener('mousemove', seek); removeEventListener('mouseup', up); };
      addEventListener('mousemove', seek); addEventListener('mouseup', up);
    });

    /* ---------------------------------------------- the library */
    async function load(force) {
      content.replaceChildren(h('div.mu-empty', h('div.spinner'), 'Reading your music…'));
      const r = await api.music.list({ force, folders: meta().folders }).catch((e) => ({ tracks: [], error: e.message }));
      tracks = r.tracks || [];
      byId.clear(); for (const t of tracks) byId.set(t.id, t);
      if (!r.probe && tracks.length) console.warn('[music] ffprobe missing: titles come from file names');
      drawSide(); draw();
      // where you were: the last queue, not playing
      const last = meta().last;
      if (last?.queue?.length && qi < 0) { queue = last.queue.filter((id) => byId.has(id)); qi = Math.min(Math.max(0, last.qi), queue.length - 1); if (queue[qi]) loadTrack(byId.get(queue[qi]), false, last.time || 0); }
    }
    const albumKey = (t) => `${(t.albumArtist || t.artist || '').toLowerCase()}|${(t.album || '').toLowerCase()}`;
    function albums(list = tracks) {
      const m = new Map();
      for (const t of list) { const k = albumKey(t); if (!m.has(k)) m.set(k, { key: k, name: t.album, artist: t.albumArtist || t.artist, year: t.year, tracks: [], added: 0 }); const a = m.get(k); a.tracks.push(t); a.added = Math.max(a.added, t.added); a.year ||= t.year; }
      for (const a of m.values()) a.tracks.sort((x, y) => (x.disc || 1) - (y.disc || 1) || (x.track || 999) - (y.track || 999) || x.title.localeCompare(y.title));
      return [...m.values()];
    }
    const match = (t) => !q || [t.title, t.artist, t.album, t.genre].some((v) => (v || '').toLowerCase().includes(q));

    /* ---------------------------------------------- sidebar */
    function drawSide() {
      const it = (k, label, icon) => {
        const el = h('div.sb-item' + (view === k ? '.sel' : ''), { html: icon }, h('span.ellipsis', label));
        el.addEventListener('click', () => { view = k; detail = null; sel.clear(); drawSide(); draw(); content.scrollTop = 0; });
        if (k.startsWith('pl:')) {
          el.addEventListener('contextmenu', (e) => contextMenu(e, [{ label: 'Play', action: () => { const p = meta().playlists.find((x) => x.id === k.slice(3)); playList(p.ids.map((id) => byId.get(id)).filter(Boolean), 0); } }, { label: 'Rename…', action: () => renamePlaylist(k.slice(3)) }, { label: 'Delete Playlist', danger: true, action: () => deletePlaylist(k.slice(3)) }]));
          el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/liquid-tracks')) { e.preventDefault(); el.classList.add('drop'); } });
          el.addEventListener('dragleave', () => el.classList.remove('drop'));
          el.addEventListener('drop', (e) => { el.classList.remove('drop'); addToPlaylist(k.slice(3), JSON.parse(e.dataTransfer.getData('text/liquid-tracks'))); });
        }
        return el;
      };
      side.replaceChildren(h('div.sb-sec', 'Library'), it('recent', 'Recently Added', I.recent), it('artists', 'Artists', I.artists), it('albums', 'Albums', I.albums), it('songs', 'Songs', I.songs),
        h('div.sb-sec.ph2-albums-h', h('span', 'Playlists'), h('button.sb-eject', { title: 'New Playlist', html: sym.plus, onclick: () => newPlaylist() })),
        ...meta().playlists.map((p) => it('pl:' + p.id, p.name, I.playlist)));
    }

    /* ---------------------------------------------- views */
    const art = (t, cls = '') => {
      const el = h('div.mu-art' + cls, { html: I.note });
      if (t) api.music.art(t.path).then((p) => { if (p) { el.innerHTML = ''; el.style.backgroundImage = `url("${fileUrl(p)}")`; el.classList.add('has'); } }).catch(() => {});
      return el;
    };
    function draw() {
      if (!tracks.length) {
        content.replaceChildren(h('div.mu-empty', h('div.mu-empty-ic', { html: I.songs }), h('b', 'Your music library is empty'), h('small.muted', 'Music plays the songs in your Music folder (MP3, FLAC, AAC, Ogg, Opus, WAV).'),
          h('div.mu-empty-b', h('button.btn', { onclick: () => api.fs.places().then((p) => wm.open('files', { path: p.music })) }, 'Open Music Folder'), h('button.btn.primary', { onclick: () => addFolder() }, 'Add a Folder…'))));
        return;
      }
      if (detail) return drawAlbum(detail);
      if (view === 'albums' || view === 'recent') {
        let list = albums(tracks.filter(match));
        list = view === 'recent' ? list.sort((a, b) => b.added - a.added).slice(0, 60) : list.sort((a, b) => (a.artist || '').localeCompare(b.artist || '') || (a.name || '').localeCompare(b.name || ''));
        const grid = h('div.mu-albums');
        for (const a of list) {
          const c = h('div.mu-album', art(a.tracks[0]), h('b.ellipsis', a.name || 'Unknown Album'), h('small.ellipsis', a.artist || 'Unknown Artist'));
          c.querySelector('.mu-art').append(h('button.mu-art-play', { title: 'Play', html: sym.play, onclick: (e) => { e.stopPropagation(); playList(a.tracks, 0); } }));
          c.addEventListener('click', () => { detail = a.key; draw(); content.scrollTop = 0; });
          c.addEventListener('contextmenu', (e) => contextMenu(e, [{ label: 'Play', action: () => playList(a.tracks, 0) }, { label: 'Shuffle', action: () => playList(a.tracks, -1, true) }, { label: 'Play Next', action: () => playNext(a.tracks) }, { label: 'Add to Up Next', action: () => addUpNext(a.tracks) }, addToMenu(a.tracks)]));
          grid.append(c);
        }
        content.replaceChildren(h('h1.mu-h1', view === 'recent' ? 'Recently Added' : 'Albums'), grid);
      } else if (view === 'artists') {
        const by = new Map();
        for (const t of tracks.filter(match)) { const k = t.albumArtist || t.artist || 'Unknown Artist'; if (!by.has(k)) by.set(k, []); by.get(k).push(t); }
        const names = [...by.keys()].sort((a, b) => a.localeCompare(b));
        let cur = detailArtist && by.has(detailArtist) ? detailArtist : names[0];
        const list = h('div.mu-artists', ...names.map((n) => { const el = h('div.mu-artist' + (n === cur ? '.sel' : ''), art(by.get(n)[0], '.round'), h('span.ellipsis', n)); el.addEventListener('click', () => { detailArtist = n; draw(); }); return el; }));
        const right = h('div.mu-artist-main');
        if (cur) {
          right.append(h('div.mu-ahead', h('h1.mu-h1', cur), h('button.btn.primary.mu-playbtn', { onclick: () => playList(by.get(cur), 0) }, h('span', { html: sym.play }), 'Play'), h('button.btn.mu-playbtn', { onclick: () => playList(by.get(cur), -1, true) }, h('span', { html: I.shuffle }), 'Shuffle')));
          for (const a of albums(by.get(cur)).sort((x, y) => (y.year || 0) - (x.year || 0))) right.append(albumBlock(a, true));
        }
        content.replaceChildren(h('div.mu-split', list, right));
      } else if (view === 'songs') {
        const list = tracks.filter(match).sort(sorter());
        content.replaceChildren(h('h1.mu-h1', 'Songs'), songTable(list, true));
      } else if (view.startsWith('pl:')) {
        const p = meta().playlists.find((x) => x.id === view.slice(3));
        if (!p) { view = 'albums'; return draw(); }
        const list = p.ids.map((id) => byId.get(id)).filter(Boolean).filter(match);
        const total = list.reduce((s, t) => s + (t.duration || 0), 0);
        content.replaceChildren(h('div.mu-ahead.pl', h('div.mu-plart', { html: I.playlist }), h('div', h('h1.mu-h1', p.name), h('small.muted', `${list.length} song${list.length === 1 ? '' : 's'} · ${total < 60 ? `${Math.round(total)} sec` : `${Math.round(total / 60)} min`}`),
          h('div.mu-abtns', h('button.btn.primary.mu-playbtn', { disabled: !list.length, onclick: () => playList(list, 0) }, h('span', { html: sym.play }), 'Play'), h('button.btn.mu-playbtn', { disabled: !list.length, onclick: () => playList(list, -1, true) }, h('span', { html: I.shuffle }), 'Shuffle')))),
        list.length ? songTable(list, false, p.id) : h('div.mu-empty.small', 'Drag songs here, or use “Add to Playlist” in a song’s menu.'));
      }
    }
    let detailArtist = null;
    function albumBlock(a, compact) {
      const total = a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
      return h('div.mu-ablock' + (compact ? '.compact' : ''),
        h('div.mu-ahead', art(a.tracks[0], '.big'), h('div.mu-ainfo', h('h1.mu-h1', a.name || 'Unknown Album'), h('div.mu-aartist', a.artist || 'Unknown Artist'), h('small.muted', [a.tracks[0].genre, a.year].filter(Boolean).join(' · ')),
          h('div.mu-abtns', h('button.btn.primary.mu-playbtn', { onclick: () => playList(a.tracks, 0) }, h('span', { html: sym.play }), 'Play'), h('button.btn.mu-playbtn', { onclick: () => playList(a.tracks, -1, true) }, h('span', { html: I.shuffle }), 'Shuffle')))),
        songTable(a.tracks, false, null, true),
        h('small.muted.mu-afoot', `${a.tracks.length} song${a.tracks.length === 1 ? '' : 's'}, ${total < 60 ? `${Math.round(total)} seconds` : `${Math.round(total / 60)} minutes`}`));
    }
    function drawAlbum(key) {
      const a = albums().find((x) => x.key === key);
      if (!a) { detail = null; return draw(); }
      content.replaceChildren(h('div.mu-back', h('button.btn.plain', { onclick: () => { detail = null; draw(); } }, h('span', { html: sym.chevronLeft }), view === 'recent' ? 'Recently Added' : 'Albums')), albumBlock(a));
    }
    const sorter = () => ({ title: (a, b) => a.title.localeCompare(b.title), artist: (a, b) => (a.artist || '').localeCompare(b.artist || '') || (a.album || '').localeCompare(b.album || '') || (a.track || 0) - (b.track || 0), album: (a, b) => (a.album || '').localeCompare(b.album || '') || (a.track || 0) - (b.track || 0), time: (a, b) => a.duration - b.duration }[sortKey]);
    function songTable(list, sortable, playlistId, numbered) {
      const th = (l, k) => h('div.mu-th' + (sortable && sortKey === k ? '.on' : ''), { onclick: () => { if (sortable) { sortKey = k; draw(); } } }, l);
      const rows = list.map((t, i) => {
        const r = h('div.mu-row' + (queue[qi] === t.id ? '.playing' : '') + (sel.has(t.id) ? '.sel' : ''), { 'data-id': t.id, draggable: true },
          h('span.mu-num', numbered ? (t.track || i + 1) : i + 1), h('span.mu-tt.ellipsis', t.title), numbered ? null : h('span.ellipsis.muted', t.artist), numbered ? null : h('span.ellipsis.muted', t.album), h('span.muted.mu-time', fmt(t.duration)));
        r.addEventListener('mousedown', (e) => { if (e.button === 2 && sel.has(t.id)) return; if (e.ctrlKey) { sel.has(t.id) ? sel.delete(t.id) : sel.add(t.id); } else { sel.clear(); sel.add(t.id); } $$('.mu-row', content).forEach((x) => x.classList.toggle('sel', sel.has(x.dataset.id))); });
        r.addEventListener('dblclick', () => playList(list, i));
        r.addEventListener('dragstart', (e) => { if (!sel.has(t.id)) { sel.clear(); sel.add(t.id); } e.dataTransfer.setData('text/liquid-tracks', JSON.stringify([...sel])); e.dataTransfer.setData('text/liquid-paths', JSON.stringify([...sel].map((id) => byId.get(id)?.path).filter(Boolean))); });
        r.addEventListener('contextmenu', (e) => {
          const ids = sel.has(t.id) ? [...sel] : [t.id];
          const ts = ids.map((id) => byId.get(id)).filter(Boolean);
          contextMenu(e, [{ label: 'Play', action: () => playList(list, i) }, { label: 'Play Next', action: () => playNext(ts) }, { label: 'Add to Up Next', action: () => addUpNext(ts) }, '-', addToMenu(ts),
            playlistId ? { label: 'Remove from Playlist', action: () => { editMeta((m) => { const p = m.playlists.find((x) => x.id === playlistId); if (p) p.ids = p.ids.filter((id) => !ids.includes(id)); }); draw(); } } : null,
            '-', { label: 'Go to Album', action: () => { view = 'albums'; detail = albumKey(t); drawSide(); draw(); } }, { label: 'Go to Artist', action: () => { view = 'artists'; detail = null; detailArtist = t.albumArtist || t.artist; drawSide(); draw(); } },
            { label: 'Show in Files', action: () => wm.open('files', { path: dirname(t.path), select: t.path }) }].filter(Boolean));
        });
        return r;
      });
      return h('div.mu-table' + (numbered ? '.numbered' : ''), numbered ? null : h('div.mu-row.head', h('span'), th('Title', 'title'), th('Artist', 'artist'), th('Album', 'album'), th('Time', 'time')), ...rows);
    }
    const addToMenu = (ts) => ({ label: 'Add to Playlist', submenu: [...meta().playlists.map((p) => ({ label: p.name, action: () => addToPlaylist(p.id, ts.map((t) => t.id)) })), meta().playlists.length ? '-' : null, { label: 'New Playlist…', action: () => newPlaylist(ts.map((t) => t.id)) }].filter(Boolean) });

    /* ---------------------------------------------- playlists */
    async function newPlaylist(ids = []) {
      const name = await prompt('New Playlist', 'Untitled Playlist', { ok: 'Create' }, win.el);
      if (!name) return;
      const id = Math.random().toString(36).slice(2, 9);
      editMeta((m) => m.playlists.push({ id, name: name.trim(), ids }));
      drawSide();
    }
    function addToPlaylist(id, ids) { editMeta((m) => { const p = m.playlists.find((x) => x.id === id); if (p) p.ids.push(...ids.filter((x) => !p.ids.includes(x))); }); if (view === 'pl:' + id) draw(); }
    async function renamePlaylist(id) { const p = meta().playlists.find((x) => x.id === id); const n = await prompt('Rename Playlist', p?.name || '', {}, win.el); if (n) { editMeta((m) => { m.playlists.find((x) => x.id === id).name = n.trim(); }); drawSide(); draw(); } }
    async function deletePlaylist(id) { if (!(await confirmDialog('Delete this playlist?', 'The songs stay in your library.', 'Delete', { danger: true }, win.el))) return; editMeta((m) => { m.playlists = m.playlists.filter((x) => x.id !== id); }); if (view === 'pl:' + id) view = 'albums'; drawSide(); draw(); }
    async function addFolder() {
      const f = await api.dialog.open({ title: 'Add a Folder to Your Music Library', directory: true }).catch(() => null);
      const d = Array.isArray(f) ? f[0] : f;
      if (!d) return;
      const places = await api.fs.places();
      editMeta((m) => { m.folders = [...new Set([...(m.folders || [places.music]), d])]; });
      load(true);
    }

    /* ---------------------------------------------- playing */
    function playList(list, i, shuf = false) {
      queue = list.map((t) => t.id);
      if (shuf) { shuffle = true; editMeta((m) => { m.shuffle = true; }); }
      order = null;
      if (shuffle) { const rest = queue.map((_, k) => k).filter((k) => k !== i); for (let k = rest.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [rest[k], rest[j]] = [rest[j], rest[k]]; } order = i >= 0 ? [i, ...rest] : rest; qi = order[0]; }
      else qi = Math.max(0, i);
      loadTrack(byId.get(queue[qi]), true);
    }
    const pos = () => (order ? order.indexOf(qi) : qi);
    const at = (p) => (order ? order[p] : p);
    function next(auto) {
      if (!queue.length) return;
      if (auto && repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
      let p = pos() + 1;
      if (p >= queue.length) { if (repeat === 'all' || !auto) p = 0; else { audio.pause(); audio.currentTime = 0; updateUi(); return; } }
      qi = at(p); loadTrack(byId.get(queue[qi]), true);
    }
    function prev() {
      if (!queue.length) return;
      if (audio.currentTime > 3) { audio.currentTime = 0; return; }
      const p = Math.max(0, pos() - 1); qi = at(p); loadTrack(byId.get(queue[qi]), true);
    }
    function playNext(ts) { if (qi < 0) return playList(ts, 0); const ins = ts.map((t) => t.id); queue.splice(qi + 1, 0, ...ins); if (order) { const p = pos(); order = order.map((k) => (k > qi ? k + ins.length : k)); order.splice(p + 1, 0, ...ins.map((_, k) => qi + 1 + k)); } drawQueue(); }
    function addUpNext(ts) { if (qi < 0) return playList(ts, 0); const start = queue.length; queue.push(...ts.map((t) => t.id)); if (order) order.push(...ts.map((_, k) => start + k)); drawQueue(); }
    function loadTrack(t, play, time = 0) {
      if (!t) return;
      audio.src = fileUrl(t.path);
      if (time) audio.addEventListener('loadedmetadata', () => { audio.currentTime = time; }, { once: true });
      if (play) audio.play().catch(() => {});
      lcdTitle.textContent = t.title; lcdSub.textContent = [t.artist, t.album].filter(Boolean).join(' — ');
      lcdArt.style.backgroundImage = ''; lcdArt.innerHTML = I.note;
      api.music.art(t.path).then((p) => {
        if (p && queue[qi] === t.id) { lcdArt.innerHTML = ''; lcdArt.style.backgroundImage = `url("${fileUrl(p)}")`; }
        setSession(t, p);
      }).catch(() => setSession(t, null));
      $$('.mu-row', content).forEach((r) => r.classList.toggle('playing', r.dataset.id === t.id));
      drawQueue(); saveLast(); updateUi();
    }
    function setSession(t, artPath) {
      if (!('mediaSession' in navigator)) return;
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || '', album: t.album || '', artwork: artPath ? [{ src: fileUrl(artPath), sizes: '500x500', type: 'image/jpeg' }] : [] });
    }
    if ('mediaSession' in navigator) {
      const ms = navigator.mediaSession;
      ms.setActionHandler('play', () => audio.play());
      ms.setActionHandler('pause', () => audio.pause());
      ms.setActionHandler('nexttrack', () => next());
      ms.setActionHandler('previoustrack', () => prev());
      try { ms.setActionHandler('seekto', (d) => { audio.currentTime = d.seekTime; }); } catch { /* older */ }
    }
    function toggle() { if (!audio.src) { const l = view === 'songs' ? tracks.filter(match).sort(sorter()) : tracks; if (l.length) playList(l, shuffle ? -1 : 0); return; } audio.paused ? audio.play() : audio.pause(); }
    function toggleShuffle() {
      shuffle = !shuffle; editMeta((m) => { m.shuffle = shuffle; });
      if (shuffle && queue.length) { const rest = queue.map((_, k) => k).filter((k) => k !== qi); for (let k = rest.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [rest[k], rest[j]] = [rest[j], rest[k]]; } order = [qi, ...rest]; } else order = null;
      updateUi(); drawQueue();
    }
    function cycleRepeat() { repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off'; editMeta((m) => { m.repeat = repeat; }); updateUi(); }
    function updateUi() {
      playBtn.innerHTML = audio.paused ? sym.play : sym.pause; playBtn.title = audio.paused ? 'Play' : 'Pause';
      shufBtn.classList.toggle('on', shuffle); repBtn.classList.toggle('on', repeat !== 'off'); repBtn.classList.toggle('one', repeat === 'one');
      lcd.classList.toggle('idle', !audio.src);
      if (!audio.src) { lcdTitle.textContent = 'Music'; lcdSub.textContent = tracks.length ? `${tracks.length} songs` : ''; }
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.src ? (audio.paused ? 'paused' : 'playing') : 'none';
    }
    const tickUi = () => {
      const d = audio.duration || 0, c = audio.currentTime || 0;
      bar.firstChild.style.width = d ? (c / d) * 100 + '%' : '0';
      tNow.textContent = fmt(c); tLeft.textContent = d ? '−' + fmt(d - c) : '';
    };
    audio.addEventListener('timeupdate', tickUi);
    audio.addEventListener('play', updateUi); audio.addEventListener('pause', () => { updateUi(); saveLast(); });
    audio.addEventListener('ended', () => next(true));
    audio.addEventListener('error', () => { if (audio.src) { lcdSub.textContent = 'This song can’t be played'; setTimeout(() => next(true), 1500); } });
    let saveT = 0;
    function saveLast() { clearTimeout(saveT); saveT = setTimeout(() => editMeta((m) => { m.last = { queue: queue.slice(0, 2000), qi, time: audio.currentTime || 0 }; }), 400); }
    setInterval(() => { if (!audio.paused) saveLast(); }, 15000);

    function drawQueue() {
      if (queuePanel.hidden) return;
      const upcoming = [];
      for (let p = pos() + 1; p < queue.length && upcoming.length < 200; p++) upcoming.push(byId.get(queue[at(p)]));
      const cur = byId.get(queue[qi]);
      queuePanel.replaceChildren(...[h('div.mu-q-head', h('b', 'Up Next'), h('button.btn.plain', { onclick: () => { queue = cur ? [cur.id] : []; qi = cur ? 0 : -1; order = null; drawQueue(); } }, 'Clear')),
        cur ? h('div.mu-q-row.cur', art(cur, '.tiny'), h('div', h('b.ellipsis', cur.title), h('small.ellipsis.muted', cur.artist))) : null,
        ...upcoming.filter(Boolean).map((t) => { const r = h('div.mu-q-row', art(t, '.tiny'), h('div', h('span.ellipsis', t.title), h('small.ellipsis.muted', t.artist))); r.addEventListener('dblclick', () => { qi = queue.indexOf(t.id); loadTrack(t, true); }); return r; }),
        !upcoming.length ? h('small.muted.mu-q-none', 'Nothing up next.') : null].filter(Boolean));
    }

    win.el.addEventListener('keydown', (e) => {
      if (e.target.closest('input')) return;
      if (e.key === ' ') { e.preventDefault(); toggle(); }
      if (e.ctrlKey && e.key === 'ArrowRight') { e.preventDefault(); next(); }
      if (e.ctrlKey && e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
      if (e.ctrlKey && e.key === 'f') { e.preventDefault(); search.focus(); }
    });
    win.on('close', () => { saveLast(); audio.pause(); audio.src = ''; });
    win.state = { toggle, next: () => next(), prev, toggleShuffle, cycleRepeat, newPlaylist, addFolder, reload: () => load(true), get shuffle() { return shuffle; }, get repeat() { return repeat !== 'off'; } };
    updateUi();
    load();
  },
});
