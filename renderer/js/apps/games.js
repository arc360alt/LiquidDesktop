// Games — every game on this computer in one place, like the Mac's Games app: Steam, Heroic (Epic, GOG), Lutris, and
// installed apps that are games (main/games.js). Home: what you played last, big, with Play; Continue Playing; your
// numbers. Library: covers, by launcher, searchable. A game's page: its art, Play, your time in it, and (Steam, with
// public game details) your achievements and how rare each one is.
import { h, $ } from '../util.js';
import { registerApp } from '../wm.js';
import { sym, appIcon } from '../icons.js';
import { api } from '../sys.js';
import { shell } from '../shell.js';

const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.8v14.4a1 1 0 0 0 1.5.9l11.3-7.2a1 1 0 0 0 0-1.8L8.5 3.9A1 1 0 0 0 7 4.8z"/></svg>';
const PAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 7h11a4.5 4.5 0 0 1 4.4 5.4l-1 4.6a2.6 2.6 0 0 1-4.5 1.2L14.2 16H9.8l-2.2 2.2a2.6 2.6 0 0 1-4.5-1.2l-1-4.6A4.5 4.5 0 0 1 6.5 7z"/><path d="M7.5 10v4M5.5 12h4"/><circle cx="16" cy="11" r=".9" fill="currentColor"/><circle cx="18" cy="13" r=".9" fill="currentColor"/></svg>';
const TROPHY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v3M8.5 20h7M9.5 17h5v3h-5z"/></svg>';
const HOME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/></svg>';
const GRID = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg>';

const dur = (s) => { const hrs = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return !s ? 'Not played yet' : hrs ? `${hrs} hr${hrs === 1 ? '' : 's'}${hrs < 10 && m ? ` ${m} min` : ''}` : `${m} min`; };
const ago = (t) => {
  if (!t) return 'Never';
  const d = Math.floor((Date.now() - t) / 864e5);
  return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : d < 7 ? `${d} days ago` : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', ...(new Date(t).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
};
const gb = (b) => (b ? (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`) : '');
const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;

/** A game's cover: Steam's art (falling back to its other sizes), the launcher's, or a tile made from its icon/name. */
function cover(g, cls = '') {
  const tile = () => {
    const t = h('div.gm-tile', { style: { background: `linear-gradient(160deg, hsl(${hue(g.name)} 55% 42%), hsl(${(hue(g.name) + 40) % 360} 60% 22%))` } });
    if (g.icon) t.append(appIcon({ id: g.id, name: g.name, icon: g.icon }, 'gm-tile-ic'));
    t.append(h('b', g.name));
    return t;
  };
  const urls = [g.cover, g.coverAlt].filter(Boolean);
  const box = h('div.gm-cover' + cls);
  if (!urls.length) { box.append(tile()); return box; }
  const img = h('img', { src: urls[0], alt: '', loading: 'lazy', draggable: false });
  let i = 0;
  img.onerror = () => { i++; if (urls[i]) img.src = urls[i]; else img.replaceWith(tile()); };
  box.append(img);
  return box;
}

registerApp({
  id: 'games', name: 'Games', size: [1040, 680], minSize: [720, 480], overlayContent: true, hideTitle: true, singleton: true,
  keywords: ['steam', 'heroic', 'lutris', 'epic', 'gog', 'play', 'achievements', 'library'],
  about: 'All your games, from every launcher, in one place.',
  open(win) {
    let lib = { games: [], launchers: [], sources: [] }, view = 'home', filter = 'all', sort = 'recent', query = '', current = null;
    const side = h('div.sidebar.gm-side');
    const main = h('div.main-pane.gm-main');
    win.body.append(side, main);
    win.el.classList.add('gm-win');

    const play = async (g, btn) => {
      if (btn) { btn.disabled = true; btn.lastChild.textContent = 'Starting…'; setTimeout(() => { btn.disabled = false; btn.lastChild.textContent = 'Play'; }, 4000); }
      try { await api.games.launch(g.id); } catch (e) { shell.notify({ app: 'games', title: g.name, body: e.message }); }
    };
    const playBtn = (g, cls = '') => { const b = h('button.gm-play' + cls, { onclick: (e) => { e.stopPropagation(); play(g, b); } }, h('span', { html: PLAY }), h('span', 'Play')); return b; };

    function drawSide() {
      const item = (id, icon, label, count) => h('div.sb-item' + (view === id || (id === 'library' && view === 'game') ? '.sel' : ''), { onmousedown: (e) => { if (e.button === 0) { view = id; draw(); } } },
        h('span.gm-sb-ic', { html: icon }), label, count != null ? h('span.count', count) : null);
      const bySource = lib.sources.map((s) => h('div.sb-item' + (view === 'library' && filter === s ? '.sel' : ''), { onmousedown: (e) => { if (e.button === 0) { view = 'library'; filter = s; draw(); } } },
        h('span.gm-src-dot', { style: { background: `hsl(${hue(s)} 65% 55%)` } }), s, h('span.count', lib.games.filter((g) => g.sourceName === s).length)));
      side.replaceChildren(h('div.gm-side-top'),
        item('home', HOME, 'Home'), item('library', GRID, 'Library', lib.games.length), item('achievements', TROPHY, 'Achievements'),
        lib.sources.length > 1 ? h('div.sb-sec', 'Launchers') : null, ...(lib.sources.length > 1 ? bySource : []),
        lib.launchers.length ? h('div.sb-sec', 'Open a Launcher') : null,
        ...lib.launchers.map((l) => h('div.sb-item', { onclick: () => api.apps.launch(l.exec) }, appIcon({ id: l.id, name: l.name, icon: l.icon }, 'gm-launcher-ic'), l.name)));
    }

    /* ---------------- Home */
    function home() {
      const played = lib.games.filter((g) => g.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed);
      const top = played[0] || lib.games[0];
      if (!top) return [h('div.gm-empty', h('span', { html: PAD }), h('h2', 'No games yet'), h('p', 'Games you install with Steam, Heroic (Epic, GOG), Lutris, or the App Store show up here.'))];
      const total = lib.games.reduce((a, g) => a + (g.playtime || 0), 0);
      const most = lib.games.slice().sort((a, b) => (b.playtime || 0) - (a.playtime || 0))[0];
      const hero = h('div.gm-hero', { onclick: () => openGame(top) },
        h('div.gm-hero-bg', top.hero ? h('img', { src: top.hero, alt: '', onerror: (e) => { e.target.src = top.header || top.cover || ''; } }) : cover(top)),
        h('div.gm-hero-fade'),
        h('div.gm-hero-body', h('small', top.lastPlayed ? 'Continue Playing' : 'In Your Library'), h('h1', top.name),
          h('div.gm-hero-meta', [top.sourceName, top.playtime ? dur(top.playtime) + ' played' : null, top.lastPlayed ? 'Last played ' + ago(top.lastPlayed).toLowerCase() : null].filter(Boolean).join(' · ')),
          playBtn(top, '.big')));
      const row = (title, list) => (list.length ? [h('div.gm-sec', h('h2', title)), h('div.gm-row', ...list.map(card))] : []);
      return [hero,
        h('div.gm-stats', stat(lib.games.length, lib.games.length === 1 ? 'game' : 'games'), stat(dur(total).replace('Not played yet', '0 min'), 'played in total'),
          most?.playtime ? stat(most.name, 'played the most', true) : null, stat(lib.sources.length, lib.sources.length === 1 ? 'launcher' : 'launchers')),
        ...row('Continue Playing', played.slice(1, 9)),
        ...row('Not Played Yet', lib.games.filter((g) => !g.lastPlayed && !g.playtime).slice(0, 8))];
    }
    const stat = (v, label, small) => h('div.gm-stat', h('b' + (small ? '.small' : ''), String(v)), h('small', label));
    const card = (g) => {
      const el = h('div.gm-card', { onclick: () => openGame(g), ondblclick: () => play(g) }, cover(g), h('div.gm-card-t', h('b', g.name), h('small', g.lastPlayed ? ago(g.lastPlayed) : g.sourceName)));
      el.append(h('button.gm-card-play', { title: 'Play', html: PLAY, onclick: (e) => { e.stopPropagation(); play(g); } }));
      return el;
    };

    /* ---------------- Library */
    function library() {
      const search = h('input.field.gm-search', { placeholder: 'Search games', value: query, oninput: (e) => { query = e.target.value; drawGrid(); } });
      const chips = h('div.gm-chips', ...['all', ...lib.sources].map((s) => h('button' + (filter === s ? '.on' : ''), { onclick: () => { filter = s; draw(); } }, s === 'all' ? 'All' : s)));
      const sortSel = h('select.field.square', { onchange: (e) => { sort = e.target.value; drawGrid(); } }, ...[['recent', 'Recently Played'], ['name', 'Name'], ['time', 'Most Played'], ['size', 'Size']].map(([v, l]) => h('option', { value: v, selected: sort === v }, l)));
      const grid = h('div.gm-grid');
      function drawGrid() {
        const q = query.trim().toLowerCase();
        const list = lib.games.filter((g) => (filter === 'all' || g.sourceName === filter) && (!q || g.name.toLowerCase().includes(q)))
          .sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : sort === 'time' ? (a, b) => (b.playtime || 0) - (a.playtime || 0) : sort === 'size' ? (a, b) => (b.size || 0) - (a.size || 0) : (a, b) => (b.lastPlayed - a.lastPlayed) || a.name.localeCompare(b.name));
        grid.replaceChildren(...list.map(card), ...(list.length ? [] : [h('div.gm-none', q ? 'No games match.' : 'No games here.')]));
      }
      drawGrid();
      setTimeout(() => search.focus(), 50);
      return [h('div.gm-head', h('h1', filter === 'all' ? 'Library' : filter), h('div.spacer'), search, sortSel), chips, grid];
    }

    /* ---------------- a game */
    function openGame(g) { current = g; view = 'game'; draw(); main.scrollTop = 0; }
    function gamePage() {
      const g = current;
      const ach = h('div.gm-ach', h('div.gm-ach-load', h('span.spinner'), 'Loading achievements…'));
      if (g.source === 'steam') loadAchievements(g, ach); else ach.replaceChildren();
      return [
        h('div.gm-banner', h('div.gm-hero-bg', g.hero ? h('img', { src: g.hero, alt: '', onerror: (e) => { e.target.src = g.header || g.cover || ''; } }) : cover(g)), h('div.gm-hero-fade'),
          h('button.gm-back', { html: sym.chevronLeft, title: 'Back', onclick: () => { view = 'library'; draw(); } }),
          h('div.gm-hero-body', g.logo ? h('img.gm-logo', { src: g.logo, alt: g.name, onerror: (e) => e.target.replaceWith(h('h1', g.name)) }) : h('h1', g.name), playBtn(g, '.big'))),
        h('div.gm-facts',
          fact('Played', dur(g.playtime)), fact('Last played', ago(g.lastPlayed)), g.size ? fact('Size', gb(g.size)) : null, fact('From', g.sourceName),
          g.storeUrl ? h('button.btn.gm-store', { onclick: () => api.fs.open(g.storeUrl) }, 'Store Page') : null),
        ach];
    }
    const fact = (k, v) => h('div.gm-fact', h('small', k), h('b', v));
    async function loadAchievements(g, box) {
      const a = await api.games.achievements(g.id).catch((e) => ({ available: false, reason: e.message }));
      if (current !== g) return;
      if (!a.available) { box.replaceChildren(a.reason ? h('div.gm-ach-none', h('span', { html: TROPHY }), h('p', a.reason)) : ''); return; }
      const pct = Math.round((a.done / a.total) * 100);
      const C = 2 * Math.PI * 26;
      const ring = h('div.gm-ring', { html: `<svg viewBox="0 0 60 60"><circle cx="30" cy="30" r="26" fill="none" stroke="rgba(128,128,128,.25)" stroke-width="6"/><circle cx="30" cy="30" r="26" fill="none" stroke="#ffd60a" stroke-width="6" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - a.done / a.total)}" transform="rotate(-90 30 30)"/></svg>` }, h('b', pct + '%'));
      const sorted = a.list.slice().sort((x, y) => (y.done - x.done) || (y.at - x.at) || ((x.rarity ?? 100) - (y.rarity ?? 100)));
      const rare = a.list.filter((x) => x.done && x.rarity != null).sort((x, y) => x.rarity - y.rarity)[0];
      box.replaceChildren(
        h('div.gm-ach-head', ring, h('div', h('h2', 'Achievements'), h('p', `${a.done} of ${a.total} unlocked${rare ? ` · rarest: ${rare.name} (${rare.rarity.toFixed(1)}% of players)` : ''}`))),
        h('div.gm-ach-list', ...sorted.map((x) => h('div.gm-ach-item' + (x.done ? '' : '.locked'),
          h('img', { src: x.icon, alt: '', loading: 'lazy' }),
          h('div.gm-ach-t', h('b', x.name), h('small', x.desc || (x.done ? '' : 'Hidden until unlocked'))),
          h('div.gm-ach-r', x.rarity != null ? h('span.gm-rarity' + (x.rarity < 10 ? '.rare' : ''), `${x.rarity.toFixed(1)}%`) : null, x.done && x.at ? h('small', ago(x.at)) : null)))));
    }

    /* ---------------- every achievement, across Steam games */
    function achievementsView() {
      const steam = lib.games.filter((g) => g.source === 'steam');
      const box = h('div.gm-ach-all');
      if (!steam.length) box.append(h('div.gm-ach-none', h('span', { html: TROPHY }), h('p', 'Achievements come from Steam games. None are installed.')));
      for (const g of steam) {
        const row = h('div.gm-ach-game', { onclick: () => openGame(g) }, cover(g, '.small'), h('div.gm-ach-gt', h('b', g.name), h('small', 'Loading…')), h('div.gm-bar', h('i')));
        box.append(row);
        api.games.achievements(g.id).then((a) => {
          if (!row.isConnected) return;
          if (!a.available) { row.querySelector('small').textContent = a.reason?.includes('private') ? 'Profile game details are private' : 'No achievements'; row.classList.add('none'); return; }
          row.querySelector('small').textContent = `${a.done} of ${a.total}`;
          row.querySelector('.gm-bar i').style.width = (a.done / a.total) * 100 + '%';
        }).catch(() => {});
      }
      return [h('div.gm-head', h('h1', 'Achievements')), box];
    }

    function draw() {
      drawSide();
      const kids = view === 'home' ? home() : view === 'library' ? library() : view === 'achievements' ? achievementsView() : view === 'game' && current ? gamePage() : home();
      main.replaceChildren(h('div.gm-page' + (view === 'game' || view === 'home' ? '.full' : ''), ...kids.filter(Boolean)));
      win.setTitle(view === 'game' && current ? current.name : 'Games');
    }
    async function load(force) {
      main.replaceChildren(h('div.gm-empty', h('span.spinner'), h('p', 'Finding your games…')));
      lib = await api.games.library(force).catch(() => ({ games: [], launchers: [], sources: [] }));
      draw();
    }
    win.toolbar.append(h('div.spacer'), h('div.tb-group', h('button.tb-btn', { title: 'Refresh', html: sym.refresh || sym.restart, onclick: () => load(true) })));
    load();
    void $;
  },
});
