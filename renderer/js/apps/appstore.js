// App Store — browse, install, update and remove apps from Flathub (flatpak) and Arch Linux (pacman).
// Back end: main/appstore.js.
import { h, $, $$, debounce, clamp, esc } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym } from '../icons.js';
import { api, isNative } from '../sys.js';
import { store } from '../store.js';
import { prompt, alertDialog, confirmDialog } from '../menus.js';
import { catalog } from '../catalog.js';
import { shell } from '../shell.js';

const S = api.store;
const FLATHUB_CATS = [
  ['audiovideo', 'Audio & Video', '#ff375f'], ['development', 'Developer Tools', '#5e5ce6'], ['education', 'Education', '#ff9f0a'], ['game', 'Games', '#30d158'],
  ['graphics', 'Graphics & Design', '#bf5af2'], ['network', 'Internet', '#0a84ff'], ['office', 'Productivity', '#ff9500'], ['science', 'Science', '#64d2ff'],
  ['system', 'System', '#8e8e93'], ['utility', 'Utilities', '#ac8e68'],
];
const ARCH_CAT = { audiovideo: ['AudioVideo', 'Audio', 'Video'], development: ['Development'], education: ['Education'], game: ['Game'], graphics: ['Graphics'],
  network: ['Network'], office: ['Office'], science: ['Science'], system: ['System', 'Settings'], utility: ['Utility'] };
const NAV = [
  ['discover', 'Discover', sym.star], ['play', 'Play', '<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2.5" y="7" width="19" height="11" rx="5.5"/><path d="M7 10.5v4M5 12.5h4"/><circle cx="16" cy="11.5" r=".9" fill="currentColor"/><circle cx="18" cy="13.5" r=".9" fill="currentColor"/></svg>'],
  ['create', 'Create', sym.pencil], ['work', 'Work', sym.doc], ['develop', 'Develop', sym.terminal], ['categories', 'Categories', sym.grid],
  ['updates', 'Updates', sym.download], ['installed', 'Installed', sym.drive],
];
const NAV_CAT = { play: 'game', create: 'graphics', work: 'office', develop: 'development' };
const FEATURED_ARCH = ['firefox', 'gimp', 'inkscape', 'krita', 'blender', 'vlc', 'obs-studio', 'libreoffice-fresh', 'thunderbird', 'audacity', 'kdenlive', 'steam', 'telegram-desktop', 'code', 'chromium', 'shotcut', 'handbrake', 'qbittorrent'];

/* ------------------------------------------------------------------ app model */
const fromFlathub = (x) => ({ source: 'flatpak', id: x.app_id || x.id, name: x.name, summary: x.summary || '', icon: x.icon || `https://dl.flathub.org/media/icons/128x128/${x.app_id || x.id}.png`,
  developer: x.developer_name || '', verified: x.verification_verified === true || x.verification_verified === 'True', installs: x.installs_last_month, category: x.main_categories });
const fromArch = (x) => ({ ...x, icon: x.icon ? 'file://' + x.icon : null, developer: x.developer || 'Arch Linux' });

const jobs = new Map();          // job id → handler
const busy = new Map();          // `${source}:${id}` → { percent, line }
if (isNative && S) S.onProgress((m) => jobs.get(m.job)?.(m));

registerApp({
  id: 'appstore', name: 'App Store', size: [1140, 760], minSize: [760, 480], overlayContent: true, hideTitle: true,
  keywords: ['software', 'install', 'flathub', 'flatpak', 'pacman', 'packages', 'store', 'apps'],
  about: 'Apps from Flathub and Arch Linux.',
  menus: (win) => [{ title: 'Store', items: [
    { label: 'Search', shortcut: '⌃F', action: () => win?.state?.search.focus() }, '-',
    { label: 'Check for Updates', action: () => win?.state?.go('updates') }, { label: 'Installed Apps', action: () => win?.state?.go('installed') }] }],
  open(win, args) { new Store(win, args); },
});

class Store {
  constructor(win, args) {
    this.win = win; win.state = this;
    this.history = [];
    this.installed = { pacman: new Set(), flatpak: new Map() };
    this.build();
    this.boot().then(() => this.go(args.page || 'discover', args));
    win.on('reopen', (a) => a?.page && this.go(a.page, a));
  }

  build() {
    const w = this.win;
    this.search = h('input.field', { placeholder: 'Search', spellcheck: false, style: { width: '100%', height: '32px' } });
    this.search.addEventListener('input', debounce(() => { const q = this.search.value.trim(); if (q.length >= 2) this.go('search', { q }, true); else if (!q && this.page?.name === 'search') this.go('discover'); }, 350));
    this.search.addEventListener('keydown', (e) => { if (e.key === 'Enter' && this.search.value.trim()) this.go('search', { q: this.search.value.trim() }, true); });
    this.nav = h('div');
    this.side = h('div.sidebar.as-side', h('div.search-field', { html: sym.search, style: { width: '100%', marginBottom: '10px' } }, this.search), this.nav,
      h('div.spacer'), h('div.as-sources'));
    w.dragRegion(this.side);
    this.backBtn = h('button.tb-btn', { html: sym.back, title: 'Back', onclick: () => this.back() });
    w.toolbar.style.marginLeft = '180px';
    w.toolbar.append(h('div.tb-group.as-back', this.backBtn));
    this.content = h('div.as-content');
    this.main = h('div.main-pane.as-main', this.content);
    w.body.append(this.side, this.main);
    this.win.el.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'f') { e.preventDefault(); this.search.focus(); } });
    this.drawNav();
  }

  drawNav() {
    this.nav.innerHTML = '';
    for (const [id, label, icon] of NAV) {
      const el = h('div.sb-item' + (this.page?.name === id || (id === 'categories' && this.page?.name === 'category') ? '.sel' : ''), { html: icon, onclick: () => this.go(id) }, label,
        id === 'updates' && this.updateCount ? h('span.as-badge', this.updateCount) : null);
      this.nav.append(el);
    }
  }

  async boot() {
    if (!isNative) { this.caps = { flatpak: false, pacman: false, appstream: false }; return; }
    this.caps = await S.invoke('store:caps').catch(() => ({}));
    const src = this.side.querySelector('.as-sources');
    src.textContent = [this.caps.flatpak ? 'Flathub' : null, this.caps.pacman ? 'Arch Linux' : null].filter(Boolean).join(' · ') || 'No package sources found';
    await this.refreshInstalled();
    this.loadArch();
    S.invoke('store:updates').then((u) => { this.updateCount = u.pacman.length + u.flatpak.length; this.updatesCache = u; this.drawNav(); }).catch(() => {});
  }
  async refreshInstalled() {
    try {
      const i = await S.invoke('store:installed');
      this.installed = { pacman: new Set(i.pacman), flatpak: new Map(i.flatpak.map((f) => [f.id, f])) };
    } catch { /* keep the old state */ }
  }
  loadArch() { if (!this.archP) this.archP = this.caps?.appstream ? S.invoke('store:archApps').then((l) => l.map(fromArch)).catch(() => []) : Promise.resolve([]); return this.archP; }
  isInstalled(a) { return a.source === 'flatpak' ? this.installed.flatpak.has(a.id) : this.installed.pacman.has(a.pkg || a.id); }
  key(a) { return `${a.source}:${a.id}`; }

  /* ---------------------------------------------- navigation */
  go(name, args = {}, replaceSearch) {
    if (this.page && !(replaceSearch && this.page.name === 'search')) this.history.push(this.page);
    if (replaceSearch && this.page?.name === 'search') { /* keep one search entry in history */ }
    this.page = { name, args };
    if (name !== 'search' && name !== 'app') this.search.value = '';
    this.render();
  }
  back() { const p = this.history.pop(); if (p) { this.page = p; this.render(); } }
  async render() {
    const { name, args } = this.page;
    this.backBtn.disabled = !this.history.length;
    this.drawNav();
    const token = (this.token = Symbol());
    this.content.innerHTML = '';
    this.content.append(h('div.as-loading', h('i.br-spin'), 'Loading…'));
    this.main.scrollTop = 0; this.content.scrollTop = 0;
    let els;
    try {
      els = await ({ discover: () => this.pageDiscover(), categories: () => this.pageCategories(), category: () => this.pageCategory(args.cat), search: () => this.pageSearch(args.q),
        updates: () => this.pageUpdates(), installed: () => this.pageInstalled(), app: () => this.pageApp(args.app),
        play: () => this.pageCategory('game', 'Play'), create: () => this.pageCategory('graphics', 'Create'), work: () => this.pageCategory('office', 'Work'), develop: () => this.pageCategory('development', 'Develop') })[name]();
    } catch (err) {
      els = [h('div.as-empty', h('h2', 'Can’t connect to the App Store'), h('p', err.message), h('button.btn', { onclick: () => this.render() }, 'Try Again'))];
    }
    if (token !== this.token) return;
    this.content.innerHTML = '';
    this.content.append(...els.filter(Boolean));
    this.win.setTitle(name === 'app' ? args.app.name : name[0].toUpperCase() + name.slice(1));
  }

  /* ---------------------------------------------- building blocks */
  icon(a, size = 56) {
    const box = h('div.as-icon', { style: { width: size + 'px', height: size + 'px' } });
    if (a.icon) box.append(h('img', { src: a.icon, loading: 'lazy', onerror: (e) => { e.target.remove(); box.classList.add('none'); box.textContent = (a.name || '?')[0]; } }));
    else { box.classList.add('none'); box.textContent = (a.name || '?')[0].toUpperCase(); }
    return box;
  }
  sourceBadge(a) { return h('span.as-src' + (a.source === 'flatpak' ? '.fh' : '.arch'), a.source === 'flatpak' ? 'Flathub' : 'Arch Linux'); }

  getButton(a, big) {
    const b = h('button.as-get' + (big ? '.big' : ''));
    const k = this.key(a);
    const draw = () => {
      const job = busy.get(k);
      b.innerHTML = '';
      b.classList.toggle('busy', !!job);
      if (job) {
        const p = job.percent ?? 0;
        b.append(h('span.as-ring', { style: { '--p': p + '%' } }, h('i')));
        b.title = job.line || 'Working…';
      } else b.textContent = this.isInstalled(a) ? 'Open' : 'Get';
    };
    b.redraw = draw;
    b.dataset.key = k;
    b.addEventListener('click', (e) => { e.stopPropagation(); if (busy.has(k)) return; this.isInstalled(a) ? this.open(a) : this.install(a); });
    draw();
    return b;
  }
  redrawButtons(k) { for (const b of $$(`.as-get[data-key="${CSS.escape(k)}"]`, this.win.el)) b.redraw?.(); }

  card(a) {
    const el = h('div.as-card', this.icon(a, 58), h('div.as-card-t', h('b.ellipsis', a.name), h('small.ellipsis', a.summary || ''), this.sourceBadge(a)), this.getButton(a));
    el.addEventListener('click', () => this.go('app', { app: a }));
    return el;
  }
  shelf(title, apps, more) {
    if (!apps.length) return null;
    // macOS-style shelf: columns of three compact rows, scrolling sideways
    const cols = [];
    for (let i = 0; i < apps.length; i += 3) cols.push(h('div.as-col', ...apps.slice(i, i + 3).map((a) => this.card(a))));
    return h('section.as-shelf', h('div.as-shelf-head', h('h2', title), more ? h('button.btn.plain', { onclick: more }, 'See All') : null), h('div.as-scroller', ...cols));
  }
  grid(apps) { return h('div.as-grid', ...apps.map((a) => this.card(a))); }
  header(title, sub) { return h('div.as-head', sub ? h('small', sub) : null, h('h1', title)); }

  /* ---------------------------------------------- pages */
  async flathubList(path) { if (!this.caps?.flatpak && isNative) return []; const r = await S.invoke('store:flathub', path); return (r.hits || []).filter((x) => x.type !== 'runtime').map(fromFlathub); }

  async pageDiscover() {
    const [popular, trending, updated, arch] = await Promise.all([
      this.flathubList('collection/popular?page=1&per_page=30'), this.flathubList('collection/trending?page=1&per_page=21'),
      this.flathubList('collection/recently-updated?page=1&per_page=21'), this.loadArch()]);
    const archFeatured = FEATURED_ARCH.map((p) => arch.find((a) => a.pkg === p)).filter(Boolean);
    const games = popular.filter((a) => a.category === 'game').slice(0, 9);
    const hero = this.hero(popular.slice(0, 6));
    return [this.header('Discover', new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase()), hero,
      this.shelf('Popular Apps', popular.filter((a) => a.category !== 'game').slice(0, 18), () => this.go('category', { cat: 'popular' })),
      this.shelf('Trending Now', trending.slice(0, 15)),
      this.shelf('From Arch Linux', archFeatured, () => this.go('category', { cat: 'arch' })),
      this.shelf('Top Games', games, () => this.go('play')),
      this.shelf('New & Updated', updated.slice(0, 15))];
  }

  hero(apps) {
    if (!apps.length) return null;
    const box = h('div.as-hero');
    const dots = h('div.as-dots');
    let i = 0, timer;
    const slides = apps.map((a) => {
      const s = h('div.as-slide', h('div.as-slide-shade'), h('div.as-slide-info', this.icon(a, 72), h('div', h('small', a.verified ? 'EDITORS’ PICK' : 'POPULAR'), h('h2', a.name), h('p', a.summary)), this.getButton(a)));
      s.addEventListener('click', () => this.go('app', { app: a }));
      // the hero shows the app's first screenshot
      S?.invoke('store:flathub', `appstream/${a.id}`).then((d) => { const shot = d.screenshots?.[0]?.sizes?.find((z) => +z.width >= 1000) || d.screenshots?.[0]?.sizes?.[0]; if (shot) s.style.backgroundImage = `url("${shot.src}")`; }).catch(() => {});
      return s;
    });
    const show = (n) => { i = (n + slides.length) % slides.length; slides.forEach((s, j) => s.classList.toggle('on', j === i)); [...dots.children].forEach((d, j) => d.classList.toggle('on', j === i)); };
    slides.forEach((_, j) => dots.append(h('i', { onclick: (e) => { e.stopPropagation(); show(j); } })));
    box.append(...slides, dots);
    show(0);
    const tick = () => { if (!box.isConnected) return clearInterval(timer); if (!box.matches(':hover')) show(i + 1); };
    timer = setInterval(tick, 6000);
    return box;
  }

  async pageCategories() {
    return [this.header('Categories'), h('div.as-cats', ...FLATHUB_CATS.map(([id, label, color]) =>
      h('div.as-cat', { style: { background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 60%, #000))` }, onclick: () => this.go('category', { cat: id }) }, label)))];
  }

  async pageCategory(cat, title) {
    if (cat === 'arch') { const arch = await this.loadArch(); return [this.header('From Arch Linux'), this.grid(FEATURED_ARCH.map((p) => arch.find((a) => a.pkg === p)).filter(Boolean))]; }
    if (cat === 'popular') return [this.header('Popular Apps'), this.grid(await this.flathubList('collection/popular?page=1&per_page=60'))];
    const label = title || FLATHUB_CATS.find(([id]) => id === cat)?.[1] || cat;
    const [fh, arch] = await Promise.all([this.flathubList(`collection/category/${cat}?page=1&per_page=48`), this.loadArch()]);
    const archHits = arch.filter((a) => a.categories.some((c) => (ARCH_CAT[cat] || []).includes(c))).sort((x, y) => (FEATURED_ARCH.includes(y.pkg) - FEATURED_ARCH.includes(x.pkg)) || x.name.localeCompare(y.name)).slice(0, 30);
    return [this.header(label), fh.length ? h('h3.as-sub', 'On Flathub') : null, fh.length ? this.grid(fh) : null,
      archHits.length ? h('h3.as-sub', 'From Arch Linux') : null, archHits.length ? this.grid(archHits) : null];
  }

  async pageSearch(q) {
    const ql = q.toLowerCase();
    const [fh, arch, pkgs] = await Promise.all([
      this.caps?.flatpak ? S.invoke('store:flathubSearch', q).then((r) => (r.hits || []).filter((x) => x.type !== 'runtime').map(fromFlathub)).catch(() => []) : [],
      this.loadArch().then((l) => l.filter((a) => a.name.toLowerCase().includes(ql) || a.pkg.includes(ql) || a.keywords.some((k) => k.includes(ql)) || a.summary.toLowerCase().includes(ql))
        .sort((x, y) => (y.name.toLowerCase().startsWith(ql) - x.name.toLowerCase().startsWith(ql)) || x.name.localeCompare(y.name)).slice(0, 24)),
      this.caps?.pacman ? S.invoke('store:pacmanSearch', q).catch(() => []) : []]);
    const appPkgs = new Set(arch.map((a) => a.pkg));
    const others = pkgs.filter((p) => !appPkgs.has(p.pkg)).slice(0, 30);
    if (!fh.length && !arch.length && !others.length) return [this.header(`“${q}”`, 'SEARCH'), h('div.as-empty', h('h2', 'No Results'), h('p', 'Try a different name or keyword.'))];
    return [this.header(`“${q}”`, 'SEARCH RESULTS'),
      fh.length ? h('h3.as-sub', 'Flathub') : null, fh.length ? this.grid(fh.slice(0, 24)) : null,
      arch.length ? h('h3.as-sub', 'Arch Linux Apps') : null, arch.length ? this.grid(arch) : null,
      others.length ? h('h3.as-sub', 'Arch Linux Packages') : null,
      others.length ? h('div.group.as-pkgs', ...others.map((p) => {
        const a = { source: 'pacman', id: p.pkg, pkg: p.pkg, name: p.pkg, summary: p.summary, version: p.version, repo: p.repo, icon: null };
        const row = h('div.row.link', h('div.label', h('b', p.pkg), ' ', h('span.muted', `${p.version} · ${p.repo}`), h('small', p.summary)), this.getButton(a));
        row.addEventListener('click', () => this.go('app', { app: a }));
        return row;
      })) : null];
  }

  async pageUpdates() {
    const u = await S.invoke('store:updates');
    this.updatesCache = u; this.updateCount = u.pacman.length + u.flatpak.length; this.drawNav();
    const out = [this.header('Updates', u.pacman.length + u.flatpak.length ? `${u.pacman.length + u.flatpak.length} AVAILABLE` : 'UP TO DATE')];
    const updateAll = (source) => this.runJob({ source, action: 'update', name: source === 'flatpak' ? 'Flatpak apps' : 'System' }, () => this.render());
    if (u.flatpak.length) out.push(h('div.as-upd-head', h('h3.as-sub', 'Flathub'), h('button.btn.primary', { onclick: () => updateAll('flatpak') }, 'Update All')),
      h('div.group', ...u.flatpak.map((x) => h('div.row', this.icon({ name: x.name || x.id, icon: `https://dl.flathub.org/media/icons/128x128/${x.id}.png` }, 40), h('div.label', h('b', x.name || x.id), h('small', x.version ? `Version ${x.version}` : x.id)),
        h('button.as-get', { onclick: () => this.runJob({ source: 'flatpak', action: 'update', id: x.id, name: x.name }, () => this.render()) }, 'Update')))));
    if (u.pacman.length) out.push(h('div.as-upd-head', h('h3.as-sub', 'Arch Linux'), h('button.btn.primary', { onclick: () => updateAll('pacman') }, 'Update System')),
      h('p.muted', { style: { margin: '0 4px 8px', fontSize: '12px' } }, 'Arch packages update together (pacman -Syu), so the system never ends up half-updated.'),
      h('div.group', ...u.pacman.slice(0, 200).map((x) => h('div.row', h('div.label', h('b', x.pkg), h('small', `${x.from} → ${x.to}`))))));
    if (!u.pacmanAvailable && this.caps?.pacman) out.push(h('p.muted', 'Install pacman-contrib to check for Arch Linux updates.'));
    if (out.length === 1) out.push(h('div.as-empty', h('div', { html: sym.check, style: { width: '48px', height: '48px', color: '#34c759' } }), h('h2', 'Everything is up to date')));
    return out;
  }

  async pageInstalled() {
    await this.refreshInstalled();
    const arch = await this.loadArch();
    const fh = [...this.installed.flatpak.values()].map((f) => ({ source: 'flatpak', id: f.id, name: f.name || f.id, summary: f.version ? `Version ${f.version}` : '', icon: `https://dl.flathub.org/media/icons/128x128/${f.id}.png`, installation: f.installation }));
    const ar = arch.filter((a) => this.installed.pacman.has(a.pkg)).sort((x, y) => x.name.localeCompare(y.name));
    return [this.header('Installed'), fh.length ? h('h3.as-sub', `Flathub (${fh.length})`) : null, fh.length ? this.grid(fh) : null,
      ar.length ? h('h3.as-sub', `Arch Linux (${ar.length})`) : null, ar.length ? this.grid(ar) : null,
      !fh.length && !ar.length ? h('div.as-empty', h('h2', 'No apps found')) : null];
  }

  async pageApp(a) {
    let d = {}, info = {};
    if (a.source === 'flatpak') d = await S.invoke('store:flathub', `appstream/${a.id}`).catch(() => ({}));
    else info = await S.invoke('store:pacmanInfo', a.pkg || a.id).catch(() => ({}));
    if (a.source === 'pacman' && !a.description) { const arch = await this.loadArch(); const full = arch.find((x) => x.pkg === (a.pkg || a.id)); if (full) a = { ...full, ...a, icon: a.icon || full.icon, description: full.description, screenshots: full.screenshots }; }
    const shots = a.source === 'flatpak'
      ? (d.screenshots || []).map((s) => (s.sizes || []).find((z) => +z.width >= 1000) || (s.sizes || []).slice(-1)[0]).filter(Boolean).map((z) => z.src)
      : (a.screenshots || []);
    const desc = a.source === 'flatpak' ? (d.description || '') : (a.description || info.Description || a.summary || '');
    const release = a.source === 'flatpak' ? (d.releases || [])[0] : null;
    const installed = this.isInstalled(a);
    const facts = a.source === 'flatpak'
      ? [['Installs', a.installs ? Intl.NumberFormat('en', { notation: 'compact' }).format(a.installs) + '/mo' : '—'], ['Version', release?.version || '—'], ['License', d.is_free_license ? 'Free' : (d.project_license || '—').split(/[ =]/)[0].slice(0, 16)],
        ['Developer', (d.developer_name || a.developer || '—').slice(0, 18)], ['Category', (d.categories || [])[0] || '—']]
      : [['Repository', a.repo || info.Repository || '—'], ['Version', info.Version || a.version || '—'], ['Download', info['Download Size'] || '—'], ['Installed Size', info['Installed Size'] || '—'], ['License', (info.Licenses || '—').slice(0, 16)]];
    const descEl = h('div.as-desc');
    if (a.source === 'flatpak') descEl.innerHTML = sanitize(desc); else descEl.textContent = desc;
    return [
      h('div.as-app-head', this.icon(a, 128),
        h('div.as-app-t', h('h1', a.name), h('p', a.summary || d.summary || ''), h('small', [d.developer_name || a.developer, a.verified ? '✓ Verified' : null].filter(Boolean).join(' · ')),
          h('div.as-app-actions', this.getButton(a, true),
            installed ? h('button.btn', { onclick: () => this.remove(a) }, 'Uninstall') : null,
            (d.urls?.homepage || a.homepage || info.URL) ? h('button.btn.plain', { onclick: () => wm.open('browser', { url: d.urls?.homepage || a.homepage || info.URL }) }, 'Website') : null,
            this.sourceBadge(a)))),
      h('div.as-facts', ...facts.map(([k, v]) => h('div', h('small', k.toUpperCase()), h('b', v)))),
      shots.length ? h('div.as-shots', ...shots.map((src) => h('img', { src, loading: 'lazy', onclick: () => this.viewShot(src) }))) : null,
      desc ? h('section.as-section', h('h2', 'About'), descEl) : null,
      release?.description ? h('section.as-section', h('h2', 'What’s New'), h('small.muted', `Version ${release.version}${release.timestamp ? ' · ' + new Date(+release.timestamp * 1000).toLocaleDateString() : ''}`), (() => { const x = h('div.as-desc'); x.innerHTML = sanitize(release.description); return x; })()) : null,
      a.source === 'pacman' && info['Depends On'] ? h('section.as-section', h('h2', 'Information'), h('dl.kv.as-kv', ...['Packager', 'Build Date', 'Depends On', 'URL'].flatMap((k) => (info[k] ? [h('dt', k), h('dd', info[k])] : [])))) : null,
    ];
  }
  viewShot(src) {
    const layer = h('div.global-alert-layer', { style: { background: 'rgba(0,0,0,.7)' }, onclick: () => layer.remove() }, h('img', { src, style: { maxWidth: '92vw', maxHeight: '88vh', borderRadius: '14px', boxShadow: '0 20px 60px rgba(0,0,0,.5)' } }));
    document.body.append(layer);
  }

  /* ---------------------------------------------- actions */
  async ensureSudo() {
    const st = await S.invoke('store:sudoStatus');
    if (!st.needed) return true;
    for (let tries = 0; tries < 3; tries++) {
      const pw = await prompt('Enter your password', '', { type: 'password', ok: 'Authenticate', message: 'Installing system packages needs administrator rights (sudo).' }, this.win.el);
      if (pw == null) return false;
      if (await S.invoke('store:sudoCheck', pw)) return true;
      await alertDialog({ title: 'Incorrect password', message: 'Try again.' }, this.win.el);
    }
    return false;
  }
  runJob(job, after) {
    return new Promise(async (resolve) => {
      if (!isNative) { alertDialog({ title: 'The App Store needs the desktop app' }, this.win.el); return resolve(false); }
      if ((job.source === 'pacman' || job.installation === 'system') && !(await this.ensureSudo())) return resolve(false);
      const k = job.id ? `${job.source}:${job.id}` : `${job.source}:*`;
      busy.set(k, { percent: 0 });
      this.redrawButtons(k);
      let id;
      try { id = await S.invoke('store:job', job); } catch (err) { busy.delete(k); this.redrawButtons(k); alertDialog({ title: 'Couldn’t start', message: err.message }, this.win.el); return resolve(false); }
      jobs.set(id, async (m) => {
        if (!m.done) { busy.set(k, { percent: m.percent ?? busy.get(k)?.percent ?? 0, line: m.line }); this.redrawButtons(k); return; }
        jobs.delete(id); busy.delete(k);
        await this.refreshInstalled();
        this.redrawButtons(k);
        catalog.load(true);   // new apps show up in Apps, Spotlight and the Dock right away
        const verb = { install: 'installed', remove: 'removed', update: 'updated' }[job.action];
        if (m.ok) shell.notify({ app: 'appstore', title: `${job.name || job.id} ${verb}`, body: job.source === 'flatpak' ? 'From Flathub' : 'From Arch Linux' });
        else alertDialog({ title: `Couldn’t ${job.action} ${job.name || job.id}`, message: (m.error || 'Unknown error').slice(-500) }, this.win.el);
        if (job.action === 'update') S.invoke('store:updates').then((u) => { this.updateCount = u.pacman.length + u.flatpak.length; this.drawNav(); }).catch(() => {});
        after?.(m.ok);
        resolve(m.ok);
      });
    });
  }
  install(a) { return this.runJob({ source: a.source, action: 'install', id: a.pkg || a.id, name: a.name }, () => this.page.name === 'app' && this.render()); }
  async remove(a) {
    if (!(await confirmDialog(`Uninstall ${a.name}?`, a.source === 'flatpak' ? 'Its data in ~/.var/app stays unless you delete it.' : 'Removes the package and dependencies nothing else needs (pacman -Rns).', 'Uninstall', { danger: true }, this.win.el))) return;
    const inst = a.source === 'flatpak' ? this.installed.flatpak.get(a.id)?.installation : null;
    this.runJob({ source: a.source, action: 'remove', id: a.pkg || a.id, name: a.name, installation: inst }, () => this.render());
  }
  async open(a) {
    if (a.source === 'flatpak') return S.invoke('store:launchFlatpak', a.id);
    await catalog.load(true);
    const launch = a.launchable && catalog.native.find((x) => x.id === 'desktop:' + a.launchable);
    const byName = catalog.native.find((x) => x.name.toLowerCase() === (a.name || '').toLowerCase() || x.id.replace(/^desktop:|\.desktop$/g, '') === (a.pkg || a.id));
    const target = launch || byName;
    if (target) catalog.launch(target); else shell.notify({ app: 'appstore', title: `${a.name} is installed`, body: 'It has no app icon to open (it may be a command-line tool).' });
  }
}

// Flathub descriptions are AppStream markup (p, ul, li, em, code…); keep only those tags
function sanitize(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  const ok = new Set(['P', 'UL', 'OL', 'LI', 'EM', 'STRONG', 'B', 'I', 'CODE', 'BR']);
  const walk = (n) => {
    for (const c of [...n.childNodes]) {
      if (c.nodeType === 1) { if (!ok.has(c.tagName)) { c.replaceWith(...c.childNodes); walk(n); return; } [...c.attributes].forEach((at) => c.removeAttribute(at.name)); walk(c); }
    }
  };
  walk(t.content);
  return t.innerHTML;
}
