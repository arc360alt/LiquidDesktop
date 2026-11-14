// Browser — tabs, favorites, history, saved passwords, Chrome extensions, downloads and settings,
// built on Chromium <webview>s in the "persist:browser" session (back end: main/browser.js).
import { h, $, $$, esc, debounce, timeAgo, fmtSize, clamp } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym } from '../icons.js';
import { api, isNative } from '../sys.js';
import { wallpaperFor } from '../theme.js';
import { store, appData } from '../store.js';
import { showMenu, prompt, alertDialog, confirmDialog } from '../menus.js';
import { shell } from '../shell.js';

const B = api.browser;
const PARTITION = 'persist:browser';

const ENGINES = {
  duckduckgo: ['DuckDuckGo', 'https://duckduckgo.com/?q='], google: ['Google', 'https://www.google.com/search?q='],
  bing: ['Bing', 'https://www.bing.com/search?q='], brave: ['Brave Search', 'https://search.brave.com/search?q='],
  startpage: ['Startpage', 'https://www.startpage.com/do/search?q='], ecosia: ['Ecosia', 'https://www.ecosia.org/search?q='],
};
const DEFAULT_FAVS = [['DuckDuckGo', 'https://duckduckgo.com'], ['Wikipedia', 'https://wikipedia.org'], ['GitHub', 'https://github.com'],
  ['YouTube', 'https://youtube.com'], ['Reddit', 'https://reddit.com'], ['Hacker News', 'https://news.ycombinator.com'], ['Arch Wiki', 'https://wiki.archlinux.org'], ['MDN', 'https://developer.mozilla.org']]
  .map(([title, url]) => ({ title, url }));
const PAGES = { start: 'Start Page', settings: 'Settings', history: 'History', passwords: 'Passwords', extensions: 'Extensions', downloads: 'Downloads' };
const opt = (k, d) => (store.get(k) ?? d);
const favs = () => appData.get('browserFavs', DEFAULT_FAVS);
const setFavs = (l) => { appData.set('browserFavs', l); BrowserView.all.forEach((b) => b.refreshPages('start')); };
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const faviconFor = (u) => appData.get('browserFavicons', {})[hostOf(u)] || null;
const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;

function normalize(q) {
  q = q.trim();
  if (!q) return null;
  if (/^liquid:\/\//i.test(q)) return q.toLowerCase();
  if (/^(https?|file|about|data|chrome-extension):/i.test(q)) return q;
  if (/^localhost(:\d+)?(\/|$)/.test(q) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(q)) return 'https://' + q;
  return ENGINES[opt('browserSearch', 'duckduckgo')][1] + encodeURIComponent(q);
}

/* ------------------------------------------------------------------ shared state across browser windows */
const downloads = new Map();
const closedTabs = [];
if (isNative && B) {
  B.on('browser:download', (d) => {
    const prev = downloads.get(d.id);
    downloads.set(d.id, d);
    if (d.state === 'completed' && prev?.state !== 'completed') shell.notify({ app: 'browser', title: 'Download finished', body: d.name });
    BrowserView.all.forEach((b) => { b.updateDownloads(); b.refreshPages('downloads'); });
  });
  B.on('browser:newTab', (url) => (BrowserView.last || BrowserView.all[0])?.newTab(url));
}

registerApp({
  id: 'browser', settings: 'browser', name: 'Browser', size: [1180, 760], minSize: [520, 360], overlayContent: true, hideTitle: true,
  keywords: ['web', 'internet', 'safari', 'chrome', 'firefox'],
  about: 'A Chromium-based browser with tabs, favorites, history, passwords and Chrome extensions.',
  menus: (win) => {
    const b = win?.state;
    return [
      { title: 'File', items: [
        { label: 'New Tab', shortcut: '⌃T', action: () => b?.newTab() }, { label: 'New Window', shortcut: '⌘N', action: () => wm.open('browser') },
        { label: 'Open Location…', shortcut: '⌃L', action: () => b?.focusUrl() }, '-',
        { label: 'Close Tab', shortcut: '⌃W', action: () => b?.closeTab() }, { label: 'Reopen Closed Tab', shortcut: '⇧⌃T', disabled: !closedTabs.length, action: () => b?.reopenTab() }] },
      { title: 'View', items: [
        { label: 'Reload Page', shortcut: '⌃R', action: () => b?.reload() }, '-',
        { label: 'Zoom In', shortcut: '⌃+', action: () => b?.zoom(0.5) }, { label: 'Zoom Out', shortcut: '⌃−', action: () => b?.zoom(-0.5) }, { label: 'Actual Size', shortcut: '⌃0', action: () => b?.zoom(0) }, '-',
        { label: 'Find…', shortcut: '⌃F', action: () => b?.find() }, { label: 'Developer Tools', shortcut: '⌃⇧I', action: () => b?.cur()?.wv?.openDevTools() }] },
      { title: 'History', items: [
        { label: 'Back', action: () => b?.back() }, { label: 'Forward', action: () => b?.forward() }, { label: 'Show All History', shortcut: '⌃H', action: () => b?.openPage('history') }, '-',
        ...appData.get('browserHistory', []).slice(0, 10).map((x) => ({ label: (x.title || x.url).slice(0, 60), action: () => b?.load(x.url) }))] },
      { title: 'Favorites', items: [
        { label: 'Add to Favorites', shortcut: '⌃D', action: () => b?.toggleFavorite() }, { label: 'Show Favorites', action: () => b?.openPage('start') }, '-',
        ...favs().slice(0, 12).map((f) => ({ label: f.title, action: () => b?.load(f.url) }))] },
      { title: 'Tools', items: [
        { label: 'Browser Settings', shortcut: '⌃,', action: () => b?.openPage('settings') }, { label: 'Passwords', action: () => b?.openPage('passwords') },
        { label: 'Extensions', action: () => b?.openPage('extensions') }, { label: 'Downloads', shortcut: '⌃J', action: () => b?.openPage('downloads') }, '-',
        { label: 'Clear Browsing Data…', action: () => b?.clearData() }] },
    ];
  },
  open(win, args) { new BrowserView(win, args); },
});

class BrowserView {
  static all = [];
  static last = null;

  constructor(win, args) {
    this.win = win; win.state = this;
    BrowserView.all.push(this);
    win.on('focus', () => (BrowserView.last = this));
    win.on('close', () => { BrowserView.all = BrowserView.all.filter((b) => b !== this); if (BrowserView.last === this) BrowserView.last = null; });
    this.tabs = []; this.active = -1;
    this.buildChrome();
    win.on('reopen', (a) => this.newTab(a?.url));
    this.newTab(args.url);
    BrowserView.last = this;
  }

  /* ---------------------------------------------- chrome (toolbar, tabs) */
  buildChrome() {
    const w = this.win;
    this.url = h('input.br-url', { placeholder: `Search ${ENGINES[opt('browserSearch', 'duckduckgo')][0]} or enter website`, spellcheck: false });
    this.url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { this.typing = false; this.load(this.url.value); this.url.blur(); } if (e.key === 'Escape') { this.typing = false; this.syncUrl(); this.url.blur(); } });
    this.url.addEventListener('input', () => (this.typing = true));
    this.url.addEventListener('focus', () => setTimeout(() => this.url.select()));
    this.url.addEventListener('blur', () => { this.typing = false; this.syncUrl(); });
    this.lock = h('span.br-lock');
    this.star = h('button.br-icon-btn', { title: 'Add to Favorites (Ctrl+D)', onclick: () => this.toggleFavorite() });
    this.key = h('button.br-icon-btn', { title: 'Saved passwords for this site', html: sym.lock, hidden: true, onclick: (e) => this.passwordMenu(e.currentTarget) });
    this.installPill = h('button.br-install', { hidden: true, onclick: () => this.installCurrentExtension() }, 'Add to Browser');
    this.urlbar = h('div.br-urlbar.no-drag', this.lock, this.url, this.installPill, this.key, this.star);
    this.backBtn = h('button.tb-btn', { html: sym.back, title: 'Back', onclick: () => this.back() });
    this.fwdBtn = h('button.tb-btn', { html: sym.forward, title: 'Forward', onclick: () => this.forward() });
    this.reloadBtn = h('button.tb-btn', { html: sym.refresh, title: 'Reload', onclick: () => this.reload() });
    this.dlBtn = h('button.tb-btn.br-dl', { html: sym.download, title: 'Downloads', hidden: true, onclick: (e) => this.downloadsMenu(e.currentTarget) });
    this.extBar = h('div.br-ext-bar');
    w.toolbar.append(
      h('div.tb-group', this.backBtn, this.fwdBtn),
      this.urlbar,
      this.extBar,
      h('div.tb-group', this.reloadBtn, this.dlBtn,
        h('button.tb-btn', { html: '<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M9 4h3a2 2 0 0 1 2 2v1h2a2 2 0 0 1 2 2v2h1a2 2 0 0 1 0 4h-1v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4h1a2 2 0 0 0 0-4H4V9a2 2 0 0 1 2-2h1V6a2 2 0 0 1 2-2z"/></svg>', title: 'Extensions', onclick: (e) => this.extensionsMenu(e.currentTarget) }),
        h('button.tb-btn', { html: sym.ellipsis, title: 'More', onclick: (e) => this.moreMenu(e.currentTarget) }),
        h('button.tb-btn', { html: sym.plus, title: 'New Tab (Ctrl+T)', onclick: () => this.newTab() })));
    this.tabBar = h('div.br-tabs');
    this.views = h('div.br-views');
    this.progress = h('div.br-progress', { style: { width: '0', opacity: 0 } });
    this.views.append(this.progress);
    this.root = h('div.browser', this.tabBar, this.views);
    w.body.append(this.root);
    w.dragRegion(this.tabBar);
    this.win.el.addEventListener('keydown', (e) => this.onKey(e));
    this.renderExtensionBar();
    this.updateDownloads();
  }

  onKey(e) {
    if (!e.ctrlKey) { if (e.key === 'F5') { e.preventDefault(); this.reload(); } return; }
    const k = e.key.toLowerCase();
    const map = {
      t: () => (e.shiftKey ? this.reopenTab() : this.newTab()), w: () => this.closeTab(), l: () => this.focusUrl(), r: () => this.reload(), d: () => this.toggleFavorite(),
      f: () => this.find(), h: () => this.openPage('history'), j: () => this.openPage('downloads'), ',': () => this.openPage('settings'),
      '=': () => this.zoom(0.5), '+': () => this.zoom(0.5), '-': () => this.zoom(-0.5), 0: () => this.zoom(0),
      tab: () => this.select((this.active + (e.shiftKey ? -1 : 1) + this.tabs.length) % this.tabs.length),
    };
    if (map[k]) { e.preventDefault(); map[k](); }
    else if (/^[1-9]$/.test(k)) { e.preventDefault(); this.select(Math.min(this.tabs.length, +k) - 1); }
  }

  cur() { return this.tabs[this.active]; }
  // the loading bar belongs to whichever tab is showing
  syncProgress() {
    const t = this.cur();
    if (t?.loading && !t.page) { this.progress.style.opacity = 1; this.progress.style.width = this.progress.style.width === '0px' || !this.progress.style.width ? '25%' : this.progress.style.width; }
    else { this.progress.style.opacity = 0; this.progress.style.width = '0'; }
  }
  focusUrl() { this.url.focus(); }

  /* ---------------------------------------------- tabs */
  newTab(input) {
    const tab = { id: Math.random().toString(36).slice(2), title: 'New Tab', url: '', wv: null, page: null, pageName: null, favicon: null, ready: false, loading: false };
    this.tabs.push(tab);
    this.select(this.tabs.length - 1);
    const home = opt('browserHome', '');
    const target = input || (home && home !== 'start' ? home : null);
    if (target) this.load(target); else { this.showPage(tab, 'start'); setTimeout(() => this.url.focus(), 60); }
    return tab;
  }
  closeTab(i = this.active) {
    const t = this.tabs[i];
    if (!t) return;
    if (t.url) closedTabs.push(t.url);
    t.loading = false;
    t.wv?.remove(); t.page?.remove();
    this.tabs.splice(i, 1);
    if (!this.tabs.length) return this.win.close();
    this.select(Math.min(i, this.tabs.length - 1));
  }
  reopenTab() { const u = closedTabs.pop(); if (u) this.newTab(u); }
  select(i) {
    if (i < 0 || i >= this.tabs.length) return;
    this.active = i;
    this.typing = false;
    this.tabs.forEach((t, j) => { if (t.wv) t.wv.style.visibility = j === i && !t.page ? 'visible' : 'hidden'; if (t.page) t.page.hidden = j !== i; });
    this.closeFind();
    this.syncProgress();
    this.renderTabs(); this.syncUrl();
    this.checkPasswordsForTab();
  }
  renderTabs() {
    this.tabBar.innerHTML = '';
    this.root.classList.toggle('has-tabs', this.tabs.length > 1);
    if (this.tabs.length < 2) { this.win.setTitle(this.cur()?.title || 'Browser'); return; }
    this.tabs.forEach((t, i) => {
      const close = h('button.br-tab-x', { html: sym.close, title: 'Close Tab' });
      const el = h('div.br-tab' + (i === this.active ? '.on' : ''), t.loading ? h('i.br-spin') : t.favicon ? h('img', { src: t.favicon, onerror: (e) => e.target.remove() }) : null, h('span', t.title || t.url || 'New Tab'), close);
      // the close button handles its own clicks; selecting on mousedown would re-render the tabs under it
      close.addEventListener('mousedown', (e) => e.stopPropagation());
      close.addEventListener('click', (e) => { e.stopPropagation(); this.closeTab(i); });
      el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); this.closeTab(i); } else if (e.button === 0) this.select(i); });
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu([
        { label: 'Reload Tab', action: () => { this.select(i); this.reload(); } }, { label: 'Duplicate Tab', action: () => this.newTab(t.url) },
        '-', { label: 'Close Tab', action: () => this.closeTab(i) }, { label: 'Close Other Tabs', action: () => { const keep = this.tabs[i]; [...this.tabs].forEach((x) => x !== keep && this.closeTab(this.tabs.indexOf(x))); } },
      ], e.clientX, e.clientY); });
      this.tabBar.append(el);
    });
    this.tabBar.append(h('button.br-add', { html: sym.plus, title: 'New Tab', onclick: () => this.newTab() }));
    this.win.setTitle(this.cur()?.title || 'Browser');
  }

  /* ---------------------------------------------- navigation */
  load(input) {
    const url = normalize(input);
    if (!url) return;
    const t = this.cur();
    if (url.startsWith('liquid://')) return this.showPage(t, url.slice(9).replace(/\/$/, '') || 'start');
    if (!isNative) { window.open(url, '_blank'); return; }
    t.page?.remove(); t.page = null; t.pageName = null;
    if (!t.wv) this.createWebview(t, url);
    else { try { t.wv.loadURL(url); } catch { t.wv.src = url; } }
    t.wv.style.visibility = 'visible';
    t.url = url;
    this.syncUrl();
  }
  createWebview(t, url) {
    const wv = document.createElement('webview');
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('partition', PARTITION);
    wv.setAttribute('webpreferences', 'contextIsolation=yes');
    t.wv = wv;
    this.views.append(wv);
    const isCur = () => this.cur() === t;
    const upd = () => { if (isCur()) this.syncUrl(); this.renderTabs(); };
    wv.addEventListener('dom-ready', () => {
      if (!t.ready) { t.ready = true; const z = opt('browserZoom', 0); if (z) wv.setZoomLevel(z); }
      upd();
    });
    wv.addEventListener('did-start-loading', () => { t.loading = true; if (isCur()) { this.progress.style.opacity = 1; this.progress.style.width = '25%'; } upd(); });
    wv.addEventListener('did-stop-loading', () => { t.loading = false; if (isCur()) { this.progress.style.width = '100%'; setTimeout(() => { this.progress.style.opacity = 0; this.progress.style.width = '0'; }, 300); } upd(); });
    wv.addEventListener('did-navigate', (e) => { t.url = e.url; this.checkPasswordsForTab(t); upd(); });
    wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) { t.url = e.url; upd(); } });
    wv.addEventListener('did-fail-load', (e) => { if (e.isMainFrame && e.errorCode !== -3) this.showError(t, e); });
    wv.addEventListener('page-title-updated', (e) => {
      t.title = e.title; this.renderTabs();
      if (!t.url.startsWith('http')) return;
      const hist = appData.get('browserHistory', []);
      if (hist[0]?.url === t.url) hist[0].title = e.title; else hist.unshift({ url: t.url, title: e.title, t: Date.now() });
      appData.set('browserHistory', hist.slice(0, 3000));
    });
    wv.addEventListener('page-favicon-updated', (e) => {
      t.favicon = e.favicons[0]; this.renderTabs();
      const map = appData.get('browserFavicons', {}); map[hostOf(t.url)] = t.favicon; appData.set('browserFavicons', map);
    });
    wv.addEventListener('focus', () => this.win.focus());
    wv.addEventListener('ipc-message', (e) => this.onPageMessage(t, e.channel, e.args[0]));
    wv.addEventListener('context-menu', (e) => this.pageMenu(t, e.params));
    wv.addEventListener('found-in-page', (e) => this.onFound(e.result));
    wv.addEventListener('enter-html-full-screen', () => !this.win.fullscreen && this.win.toggleFullscreen());
    wv.addEventListener('leave-html-full-screen', () => this.win.fullscreen && this.win.toggleFullscreen());
    wv.src = url;
  }
  back() { const w = this.cur()?.wv; if (w && this.cur().page) { this.cur().page.remove(); this.cur().page = null; this.cur().pageName = null; w.style.visibility = 'visible'; this.syncUrl(); return; } try { w?.goBack(); } catch { /* not ready */ } }
  forward() { try { this.cur()?.wv?.goForward(); } catch { /* not ready */ } }
  reload() { const t = this.cur(); if (t?.page) return this.showPage(t, t.pageName); try { t?.wv?.isLoading() ? t.wv.stop() : t?.wv?.reload(); } catch { /* not ready */ } }
  zoom(d) { const w = this.cur()?.wv; if (!w || !this.cur().ready) return; w.setZoomLevel(d === 0 ? 0 : clamp(w.getZoomLevel() + d, -5, 7)); }

  syncUrl() {
    const t = this.cur();
    if (!t) return;
    const ready = t.wv && t.ready;
    const shown = t.page ? `liquid://${t.pageName}` : t.url;
    if (!this.typing) this.url.value = t.pageName === 'start' ? '' : (shown || '').replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, '');
    this.lock.innerHTML = t.url.startsWith('https://') && !t.page ? sym.lock : '';
    let canBack = false, canFwd = false, loading = false;
    if (ready) { try { canBack = t.wv.canGoBack() || !!t.page; canFwd = t.wv.canGoForward(); loading = t.wv.isLoading(); } catch { /* guest gone */ } }
    this.backBtn.disabled = !canBack && !(t.page && t.wv); this.fwdBtn.disabled = !canFwd;
    this.reloadBtn.innerHTML = loading ? sym.close : sym.refresh;
    const isFav = !t.page && favs().some((f) => f.url.replace(/\/$/, '') === t.url.replace(/\/$/, ''));
    this.star.innerHTML = `<svg class="sym" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/></svg>`;
    this.star.classList.toggle('on', isFav);
    this.star.hidden = !!t.page || !t.url;
    const storeId = !t.page && t.url.match(/(chromewebstore\.google\.com\/detail\/[^/]+|chrome\.google\.com\/webstore\/detail\/[^/]+)\/([a-p]{32})/);
    this.installPill.hidden = !storeId;
    this.installPill.dataset.id = storeId ? storeId[2] : '';
  }

  /* ---------------------------------------------- internal pages (liquid://…) */
  openPage(name) {
    const existing = this.tabs.findIndex((t) => t.pageName === name);
    if (existing >= 0) { this.select(existing); return this.refreshPages(name); }
    const t = this.cur();
    if (t && !t.url && t.pageName === 'start') return this.showPage(t, name);
    this.newTab('liquid://' + name);
  }
  showPage(t, name) {
    if (!PAGES[name]) name = 'start';
    t.page?.remove();
    t.pageName = name;
    t.loading = false;
    t.title = PAGES[name];
    t.favicon = null;
    t.page = h('div.br-page' + (name === 'start' ? '.br-start' : ''));
    this.views.append(t.page);
    if (t.wv) t.wv.style.visibility = 'hidden';
    this.renderPage(t);
    this.select(this.tabs.indexOf(t));
  }
  refreshPages(name) { for (const t of this.tabs) if (t.pageName === name) this.renderPage(t); }
  renderPage(t) {
    const el = t.page;
    el.innerHTML = '';
    const fn = { start: this.pageStart, settings: this.pageSettings, history: this.pageHistory, passwords: this.pagePasswords, extensions: this.pageExtensions, downloads: this.pageDownloads }[t.pageName];
    fn.call(this, el, t);
  }
  pageHead(title, extra) { return h('div.br-page-head', h('h1', title), h('div.spacer'), extra || null); }

  pageStart(el) {
    el.style.backgroundImage = `url("${wallpaperFor(1400, 900)}")`;
    const grid = h('div.br-favs');
    if (opt('browserShowFavs', true)) {
      favs().forEach((f, i) => {
        const fi = faviconFor(f.url);
        const tile = h('div.br-fav', h('div.ic', { style: { background: `hsl(${hue(hostOf(f.url))} 55% 48%)` } }, fi ? h('img', { src: fi, onerror: (e) => e.target.replaceWith(f.title[0] || '?') }) : (f.title[0] || '?').toUpperCase()), h('span', f.title));
        tile.addEventListener('click', () => this.load(f.url));
        tile.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu([
          { label: 'Open in New Tab', action: () => this.newTab(f.url) }, '-',
          { label: 'Rename…', action: async () => { const n = await prompt('Favorite name', f.title, {}, this.win.el); if (n) { const l = favs(); l[i].title = n; setFavs(l); } } },
          { label: 'Edit Address…', action: async () => { const u = await prompt('Favorite address', f.url, {}, this.win.el); if (u) { const l = favs(); l[i].url = normalize(u); setFavs(l); } } },
          { label: 'Move Left', disabled: i === 0, action: () => { const l = favs(); [l[i - 1], l[i]] = [l[i], l[i - 1]]; setFavs(l); } },
          '-', { label: 'Remove from Favorites', danger: true, action: () => setFavs(favs().filter((_, j) => j !== i)) },
        ], e.clientX, e.clientY); });
        grid.append(tile);
      });
      const add = h('div.br-fav.add', h('div.ic', { html: sym.plus }), h('span', 'Add'));
      add.addEventListener('click', async () => {
        const u = await prompt('Add a favorite', '', { placeholder: 'example.com', ok: 'Add' }, this.win.el);
        if (!u) return;
        const url = normalize(u);
        const title = await prompt('Name', hostOf(url).split('.')[0].replace(/^\w/, (c) => c.toUpperCase()), { ok: 'Save' }, this.win.el);
        setFavs([...favs(), { title: title || hostOf(url), url }]);
      });
      grid.append(add);
    }
    const hist = appData.get('browserHistory', []).slice(0, 8);
    el.append(h('div.br-start-inner',
      opt('browserShowFavs', true) ? h('h2', 'Favorites') : null, opt('browserShowFavs', true) ? h('div.glass.panel.br-start-card', grid) : null,
      hist.length ? h('h2', 'Recently Visited') : null,
      hist.length ? h('div.glass.panel.br-start-card.br-recent', ...hist.map((x) => h('div.br-recent-row', { onclick: () => this.load(x.url) },
        faviconFor(x.url) ? h('img', { src: faviconFor(x.url), onerror: (e) => e.target.remove() }) : h('i'), h('span.ellipsis', x.title || x.url), h('small', hostOf(x.url))))) : null));
  }

  pageSettings(el) {
    const sel = (key, def, opts, after) => h('select.field.square', { style: { height: '28px', minWidth: '180px' }, onchange: (e) => { store.set(key, e.target.value); after?.(); } },
      ...opts.map(([v, l]) => h('option', { value: v, selected: opt(key, def) === v }, l)));
    const tog = (key, def) => h('label.toggle', h('input', { type: 'checkbox', checked: !!opt(key, def), onchange: (e) => store.set(key, e.target.checked) }), h('span'));
    const row = (label, ctl, sub) => h('div.row', h('div.label', label, sub ? h('small', sub) : null), ctl);
    const homeInput = h('input.field.square', { value: opt('browserHome', '') === 'start' ? '' : opt('browserHome', ''), placeholder: 'Start Page', style: { width: '220px' } });
    homeInput.addEventListener('change', () => store.set('browserHome', homeInput.value.trim() ? normalize(homeInput.value) : ''));
    el.append(h('div.br-page-inner',
      this.pageHead('Settings'),
      h('div.group-title', 'General'),
      h('div.group',
        row('Search engine', sel('browserSearch', 'duckduckgo', Object.entries(ENGINES).map(([k, [n]]) => [k, n]), () => (this.url.placeholder = `Search ${ENGINES[opt('browserSearch', 'duckduckgo')][0]} or enter website`))),
        row('New tabs open with', homeInput, 'Leave empty for the Start Page'),
        row('Show favorites on the Start Page', tog('browserShowFavs', true)),
        row('Default page zoom', sel('browserZoom', '0', [['-2', '67%'], ['-1', '80%'], ['0', '100%'], ['1', '120%'], ['2', '144%']].map(([v, l]) => [v, l]), () => store.set('browserZoom', Number(opt('browserZoom', 0)))))),
      h('div.group-title', 'Passwords'),
      h('div.group',
        row('Offer to save passwords', tog('browserOfferPasswords', true)),
        row('Fill in saved passwords automatically', tog('browserAutofill', true)),
        h('div.row.link', { onclick: () => this.openPage('passwords') }, h('div.label', 'Manage Passwords…'), h('span.muted', '›'))),
      h('div.group-title', 'Privacy'),
      h('div.group',
        h('div.row.link', { onclick: () => this.openPage('history') }, h('div.label', 'History…'), h('span.muted', '›')),
        h('div.row', h('div.label', 'Clear browsing data', h('small', 'History, cookies and site data, cached files')), h('button.btn', { onclick: () => this.clearData() }, 'Clear…'))),
      h('div.group-title', 'More'),
      h('div.group',
        h('div.row.link', { onclick: () => this.openPage('extensions') }, h('div.label', 'Extensions…'), h('span.muted', '›')),
        h('div.row.link', { onclick: () => this.openPage('downloads') }, h('div.label', 'Downloads…', h('small', 'Files are saved to your Downloads folder')), h('span.muted', '›')))));
  }

  pageHistory(el) {
    const q = h('input.field', { placeholder: 'Search History', style: { width: '240px' } });
    const list = h('div');
    const draw = () => {
      const s = q.value.trim().toLowerCase();
      const all = appData.get('browserHistory', []);
      const items = all.filter((x) => !s || (x.title || '').toLowerCase().includes(s) || x.url.toLowerCase().includes(s));
      list.innerHTML = '';
      if (!items.length) { list.append(h('div.br-empty', s ? 'No matching pages' : 'No history yet')); return; }
      let day = null, group = null;
      for (const x of items.slice(0, 600)) {
        const d = new Date(x.t).toDateString();
        if (d !== day) {
          day = d;
          const today = new Date().toDateString(), yest = new Date(Date.now() - 864e5).toDateString();
          list.append(h('div.group-title', d === today ? 'Today' : d === yest ? 'Yesterday' : new Date(x.t).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })));
          group = h('div.group'); list.append(group);
        }
        group.append(h('div.row.link.br-hist-row', { onclick: () => this.load(x.url) },
          h('span.muted', { style: { width: '62px', fontSize: '11.5px' } }, new Date(x.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })),
          faviconFor(x.url) ? h('img.br-row-ic', { src: faviconFor(x.url), onerror: (e) => e.target.remove() }) : h('i.br-row-ic'),
          h('div.label.ellipsis', x.title || x.url, h('small.ellipsis', x.url)),
          h('button.tb-btn', { html: sym.close, title: 'Remove', onclick: (e) => { e.stopPropagation(); appData.set('browserHistory', appData.get('browserHistory', []).filter((y) => !(y.url === x.url && y.t === x.t))); draw(); } })));
      }
    };
    q.addEventListener('input', debounce(draw, 120));
    el.append(h('div.br-page-inner', this.pageHead('History', h('div', { style: { display: 'flex', gap: '8px' } }, q,
      h('button.btn', { onclick: async () => { if (await confirmDialog('Clear all history?', 'This removes every page from your history.', 'Clear History', { danger: true }, this.win.el)) { appData.set('browserHistory', []); draw(); } } }, 'Clear History'))), list));
    draw();
  }

  async pagePasswords(el) {
    const q = h('input.field', { placeholder: 'Search Passwords', style: { width: '240px' } });
    const list = h('div.group');
    const note = h('p.muted', { style: { fontSize: '12px', margin: '0 4px 14px' } });
    el.append(h('div.br-page-inner', this.pageHead('Passwords', q), note, list));
    if (!isNative) { list.append(h('div.row', 'Passwords need the desktop app.')); return; }
    const st = await B.invoke('browser:pwStatus');
    note.textContent = st.encrypted ? 'Passwords are encrypted with your system keyring.' : 'No system keyring was found (install gnome-keyring or kwallet), so passwords are stored only obfuscated, readable by your user account.';
    const all = await B.invoke('browser:pwList');
    const draw = () => {
      const s = q.value.trim().toLowerCase();
      list.innerHTML = '';
      const items = all.filter((p) => !s || p.site.includes(s) || p.username.toLowerCase().includes(s)).sort((a, b) => a.site.localeCompare(b.site));
      if (!items.length) { list.append(h('div.row', h('span.muted', all.length ? 'No matches' : 'No saved passwords yet. When you sign in to a site, Browser offers to save it.'))); return; }
      for (const p of items) {
        const pw = h('span.br-pw', '•'.repeat(10));
        let shown = false;
        list.append(h('div.row',
          faviconFor('https://' + p.site) ? h('img.br-row-ic', { src: faviconFor('https://' + p.site), onerror: (e) => e.target.remove() }) : h('i.br-row-ic'),
          h('div.label', p.site, h('small', p.username || '(no username)')), pw,
          h('button.tb-btn', { html: sym.eye, title: 'Show', onclick: () => { shown = !shown; pw.textContent = shown ? p.password : '•'.repeat(10); } }),
          h('button.tb-btn', { html: sym.copy, title: 'Copy Password', onclick: () => { api.clip.write(p.password); shell.notify({ app: 'browser', title: 'Password copied', body: p.site }); } }),
          h('button.tb-btn', { html: sym.globe, title: 'Open Site', onclick: () => this.newTab(p.origin) }),
          h('button.tb-btn', { html: sym.trash, title: 'Delete', onclick: async () => { if (await confirmDialog(`Delete the password for ${p.site}?`, p.username, 'Delete', { danger: true }, this.win.el)) { await B.invoke('browser:pwDelete', p.id); all.splice(all.indexOf(p), 1); draw(); } } })));
      }
    };
    q.addEventListener('input', draw);
    draw();
  }

  async pageExtensions(el) {
    const input = h('input.field', { placeholder: 'Paste a Chrome Web Store link or extension ID', style: { flex: 1 } });
    const add = h('button.btn.primary', 'Add');
    const list = h('div.group');
    add.addEventListener('click', async () => {
      if (!input.value.trim()) return;
      add.disabled = true; add.textContent = 'Installing…';
      try { const e = await B.invoke('browser:extInstall', input.value.trim()); input.value = ''; shell.notify({ app: 'browser', title: 'Extension added', body: e.name }); }
      catch (err) { alertDialog({ title: 'Couldn’t add the extension', message: err.message }, this.win.el); }
      add.disabled = false; add.textContent = 'Add';
      this.refreshExtensions();
    });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && add.click());
    el.append(h('div.br-page-inner',
      this.pageHead('Extensions', h('div', { style: { display: 'flex', gap: '8px' } },
        h('button.btn', { onclick: () => this.newTab('https://chromewebstore.google.com/') }, 'Chrome Web Store'),
        h('button.btn', { onclick: async () => {
          const p = await prompt('Load an unpacked extension', (shell.home || '') + '/', { message: 'Folder that contains manifest.json', ok: 'Load' }, this.win.el);
          if (!p) return;
          try { await B.invoke('browser:extLoad', p); this.refreshExtensions(); } catch (err) { alertDialog({ title: 'Couldn’t load the extension', message: err.message }, this.win.el); }
        } }, 'Load Unpacked…'))),
      h('p.muted', { style: { fontSize: '12px', margin: '0 4px 12px' } }, 'Open an extension in the Chrome Web Store and press “Add to Browser” in the address bar, or paste its link here. Extensions that rely on Chrome-only APIs may not work fully.'),
      h('div.group', { style: { padding: '10px 14px', display: 'flex', gap: '8px' } }, input, add),
      h('div.group-title', 'Installed'), list));
    if (!isNative) { list.append(h('div.row', 'Extensions need the desktop app.')); return; }
    const exts = await B.invoke('browser:extList').catch(() => []);
    if (!exts.length) list.append(h('div.row', h('span.muted', 'No extensions installed.')));
    for (const e of exts) {
      list.append(h('div.row',
        e.icon ? h('img.br-ext-ic', { src: 'file://' + e.icon }) : h('i.br-ext-ic'),
        h('div.label', h('b', e.name), ' ', h('span.muted', e.version), h('small', e.description)),
        e.popup ? h('button.btn', { onclick: (ev) => this.openExtensionPopup(e, ev.currentTarget) }, 'Open') : null,
        e.options ? h('button.btn', { onclick: () => this.newTab(`chrome-extension://${e.id}/${e.options}`) }, 'Options') : null,
        h('button.btn', { onclick: async () => { if (await confirmDialog(`Remove “${e.name}”?`, '', 'Remove', { danger: true }, this.win.el)) { await B.invoke('browser:extRemove', e.id); this.refreshExtensions(); } } }, 'Remove')));
    }
  }

  async pageDownloads(el) {
    const list = h('div.group');
    el.append(h('div.br-page-inner', this.pageHead('Downloads', h('button.btn', { onclick: () => api.fs.places().then((p) => wm.open('files', { path: p.downloads })) }, 'Show Downloads Folder')), list));
    const items = [...downloads.values()];
    if (!items.length) { list.append(h('div.row', h('span.muted', 'Nothing downloaded in this session yet.'))); return; }
    for (const d of items) {
      const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
      list.append(h('div.row',
        h('div.label', d.name, h('small', d.state === 'completed' ? fmtSize(d.total || d.received) + ' — done' : d.state === 'progressing' ? `${fmtSize(d.received)} of ${d.total ? fmtSize(d.total) : '?'} (${pct}%)` : d.state)),
        d.state === 'completed' ? h('button.btn', { onclick: () => B.invoke('browser:openDownload', d.path) }, 'Open') : null,
        h('button.btn', { onclick: () => B.invoke('browser:showDownload', d.path) }, 'Show in Folder')));
    }
  }

  showError(t, e) {
    if (this.cur() !== t) return;
    t.page?.remove();
    t.pageName = null;
    t.page = h('div.br-page', h('div.br-error', h('div', { html: sym.globe, style: { width: '48px', height: '48px', opacity: 0.4 } }),
      h('h2', 'Can’t open this page'), h('p', `${hostOf(e.validatedURL)} — ${e.errorDescription || 'the page could not be loaded'}`),
      h('button.btn.primary', { onclick: () => { t.page.remove(); t.page = null; t.wv.style.visibility = 'visible'; t.wv.reload(); } }, 'Try Again')));
    this.views.append(t.page);
    t.wv.style.visibility = 'hidden';
  }

  /* ---------------------------------------------- favorites */
  toggleFavorite() {
    const t = this.cur();
    if (!t || t.page || !t.url) return;
    const key = t.url.replace(/\/$/, '');
    const l = favs();
    const i = l.findIndex((f) => f.url.replace(/\/$/, '') === key);
    if (i >= 0) l.splice(i, 1); else l.push({ title: (t.title || hostOf(t.url)).slice(0, 40), url: t.url });
    setFavs(l);
    this.syncUrl();
  }

  /* ---------------------------------------------- passwords */
  activeTabId() { const t = this.tabs.find((x, i) => i === this.active && x.wv && x.ready) || this.tabs.find((x) => x.wv && x.ready && x.url.startsWith('http')); try { return t ? t.wv.getWebContentsId() : null; } catch { return null; } }
  async onPageMessage(t, channel, data) {
    if (!isNative) return;
    if (channel === 'ext-active-tab?') { t.wv.send('ext-active-tab', this.activeTabId()); return; }
    if (channel === 'pw-request') {
      const creds = await B.invoke('browser:pwFor', data).catch(() => []);
      t.creds = creds;
      if (this.cur() === t) this.key.hidden = !creds.length;
      if (creds.length === 1 && opt('browserAutofill', true)) t.wv.send('pw-fill', creds[0]);
    }
    if (channel === 'pw-capture') {
      if (!opt('browserOfferPasswords', true) || !data.password) return;
      const never = appData.get('browserPwNever', []);
      const site = hostOf(data.origin);
      if (never.includes(site)) return;
      const known = await B.invoke('browser:pwKnown', data).catch(() => 'new');
      if (known === 'same') return;
      this.passwordPrompt(site, data, known === 'changed');
    }
  }
  passwordPrompt(site, data, update) {
    this.views.querySelector('.br-pw-bar')?.remove();
    const bar = h('div.br-pw-bar.glass.panel',
      h('span', { html: sym.lock, style: { width: '18px', display: 'flex' } }),
      h('div.label', h('b', update ? `Update the saved password for ${site}?` : `Save password for ${site}?`), h('small', data.username || '(no username)')),
      h('button.btn', { onclick: () => { appData.set('browserPwNever', [...appData.get('browserPwNever', []), site]); bar.remove(); } }, 'Never'),
      h('button.btn', { onclick: () => bar.remove() }, 'Not Now'),
      h('button.btn.primary', { onclick: async () => { await B.invoke('browser:pwSave', data); bar.remove(); this.checkPasswordsForTab(); } }, update ? 'Update' : 'Save'));
    this.views.append(bar);
    setTimeout(() => bar.isConnected && bar.remove(), 30000);
  }
  async checkPasswordsForTab(t = this.cur()) {
    if (!t || !isNative) return;
    if (t.page || !t.url.startsWith('http')) { if (this.cur() === t) this.key.hidden = true; return; }
    t.creds = await B.invoke('browser:pwFor', new URL(t.url).origin).catch(() => []);
    if (this.cur() === t) this.key.hidden = !t.creds.length;
  }
  passwordMenu(anchor) {
    const t = this.cur();
    const r = anchor.getBoundingClientRect();
    showMenu([{ header: 'Fill password' }, ...(t.creds || []).map((c) => ({ label: c.username || '(no username)', action: () => t.wv.send('pw-fill', c) })),
      '-', { label: 'Manage Passwords…', action: () => this.openPage('passwords') }], r.left, r.bottom + 6);
  }

  /* ---------------------------------------------- extensions */
  async renderExtensionBar() {
    this.extBar.innerHTML = '';
    if (!isNative) return;
    const exts = (await B.invoke('browser:extList').catch(() => [])).filter((e) => e.popup).slice(0, 5);
    for (const e of exts) {
      const b = h('button.br-ext-btn', { title: e.name, onclick: (ev) => this.openExtensionPopup(e, ev.currentTarget) }, e.icon ? h('img', { src: 'file://' + e.icon }) : e.name[0]);
      this.extBar.append(b);
    }
    this.extBar.hidden = !exts.length;
  }
  refreshExtensions() { BrowserView.all.forEach((b) => { b.renderExtensionBar(); b.refreshPages('extensions'); }); }
  async extensionsMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const exts = isNative ? await B.invoke('browser:extList').catch(() => []) : [];
    showMenu([
      ...(exts.length ? exts.map((e) => ({ label: e.name, icon: e.icon ? `<img src="file://${esc(e.icon)}" style="width:16px;height:16px">` : null,
        action: () => (e.popup ? this.openExtensionPopup(e, anchor) : e.options ? this.newTab(`chrome-extension://${e.id}/${e.options}`) : this.openPage('extensions')) })) : [{ label: 'No extensions installed', disabled: true }]),
      '-', { label: 'Manage Extensions…', action: () => this.openPage('extensions') }, { label: 'Chrome Web Store', action: () => this.newTab('https://chromewebstore.google.com/') },
    ], r.right - 220, r.bottom + 6, { minWidth: 220 });
  }
  openExtensionPopup(e, anchor) {
    this.closeExtensionPopup();
    const r = anchor.getBoundingClientRect(), wr = this.win.el.getBoundingClientRect();
    const wv = document.createElement('webview');
    wv.setAttribute('partition', PARTITION);
    wv.src = `chrome-extension://${e.id}/${e.popup}`;
    const pop = h('div.br-ext-popup.glass.panel', wv);
    pop.style.top = r.bottom - wr.top + 8 + 'px';
    pop.style.right = Math.max(8, wr.right - r.right - 8) + 'px';
    this.win.el.querySelector('.win-clip').append(pop);
    wv.addEventListener('ipc-message', (ev) => { if (ev.channel === 'ext-active-tab?') wv.send('ext-active-tab', this.activeTabId()); });
    // size the popup to the extension's own content (like Chrome does), and keep it fitted as it changes
    const fit = () => wv.executeJavaScript(`(() => { const d = document.documentElement, prev = d.style.width; d.style.width = 'max-content';
      const w = Math.ceil(d.getBoundingClientRect().width); d.style.width = prev; return [w, Math.ceil(Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0))]; })()`)
      .then(([w, hh]) => { pop.style.width = clamp(w, 120, 800) + 'px'; pop.style.height = clamp(hh, 40, 600) + 'px'; pop.style.opacity = 1; }).catch(() => { pop.style.opacity = 1; });
    pop.style.opacity = 0;
    wv.addEventListener('dom-ready', () => { fit(); setTimeout(fit, 250); setTimeout(fit, 800); });
    wv.addEventListener('did-stop-loading', fit);
    this.popup = pop;
    setTimeout(() => document.addEventListener('mousedown', this.popupOutside = (ev) => { if (!pop.contains(ev.target)) this.closeExtensionPopup(); }, true));
  }
  closeExtensionPopup() { this.popup?.remove(); this.popup = null; if (this.popupOutside) document.removeEventListener('mousedown', this.popupOutside, true); }
  async installCurrentExtension() {
    const id = this.installPill.dataset.id;
    if (!id) return;
    this.installPill.textContent = 'Adding…'; this.installPill.disabled = true;
    try { const e = await B.invoke('browser:extInstall', id); shell.notify({ app: 'browser', title: 'Extension added', body: e.name }); this.refreshExtensions(); }
    catch (err) { alertDialog({ title: 'Couldn’t add the extension', message: err.message }, this.win.el); }
    this.installPill.textContent = 'Add to Browser'; this.installPill.disabled = false;
  }

  /* ---------------------------------------------- downloads */
  updateDownloads() {
    const items = [...downloads.values()];
    this.dlBtn.hidden = !items.length;
    const active = items.filter((d) => d.state === 'progressing');
    const pct = active.length ? active.reduce((a, d) => a + (d.total ? d.received / d.total : 0), 0) / active.length : 1;
    this.dlBtn.style.setProperty('--p', Math.round(pct * 100) + '%');
    this.dlBtn.classList.toggle('busy', !!active.length);
  }
  downloadsMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const items = [...downloads.values()].slice(0, 8);
    showMenu([...items.map((d) => ({ label: d.name + (d.state === 'progressing' ? ` — ${d.total ? Math.round((d.received / d.total) * 100) : 0}%` : ''),
      action: () => (d.state === 'completed' ? B.invoke('browser:openDownload', d.path) : null) })), '-', { label: 'Show All Downloads', action: () => this.openPage('downloads') }],
    r.right - 260, r.bottom + 6, { minWidth: 260 });
  }

  /* ---------------------------------------------- page menus, find, misc */
  pageMenu(t, p) {
    const wr = t.wv.getBoundingClientRect();
    const x = wr.left + p.x, y = wr.top + p.y;
    const wv = t.wv;
    const items = [];
    if (p.linkURL) items.push({ label: 'Open Link in New Tab', action: () => this.newTab(p.linkURL) }, { label: 'Open Link in New Window', action: () => wm.open('browser', { url: p.linkURL }) },
      { label: 'Copy Link', action: () => api.clip.write(p.linkURL) }, '-');
    if (p.mediaType === 'image' && p.srcURL) items.push({ label: 'Open Image in New Tab', action: () => this.newTab(p.srcURL) }, { label: 'Save Image', action: () => wv.downloadURL(p.srcURL) },
      { label: 'Copy Image Address', action: () => api.clip.write(p.srcURL) }, '-');
    if (p.isEditable) items.push({ label: 'Cut', action: () => wv.cut() }, { label: 'Copy', action: () => wv.copy() }, { label: 'Paste', action: () => wv.paste() }, { label: 'Select All', action: () => wv.selectAll() }, '-');
    else if (p.selectionText) items.push({ label: 'Copy', action: () => wv.copy() }, { label: `Search for “${p.selectionText.trim().slice(0, 24)}”`, action: () => this.newTab(p.selectionText.trim()) }, '-');
    items.push({ label: 'Back', disabled: !wv.canGoBack(), action: () => wv.goBack() }, { label: 'Forward', disabled: !wv.canGoForward(), action: () => wv.goForward() }, { label: 'Reload', action: () => wv.reload() },
      '-', { label: 'Add Page to Favorites', action: () => this.toggleFavorite() }, { label: 'Inspect Element', action: () => wv.inspectElement(p.x, p.y) });
    showMenu(items, x, y);
  }
  find() {
    const t = this.cur();
    if (!t?.wv || t.page) return;
    if (this.findBar) { this.findBar.querySelector('input').select(); return; }
    const input = h('input.field', { placeholder: 'Find on page', style: { width: '200px', height: '28px' } });
    this.findCount = h('span.muted', { style: { fontSize: '11.5px', minWidth: '52px' } });
    const go = (fwd) => input.value ? t.wv.findInPage(input.value, { forward: fwd, findNext: true }) : t.wv.stopFindInPage('clearSelection');
    input.addEventListener('input', () => (input.value ? t.wv.findInPage(input.value) : t.wv.stopFindInPage('clearSelection')));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(!e.shiftKey); if (e.key === 'Escape') this.closeFind(); });
    this.findBar = h('div.br-find.glass.panel', input, this.findCount,
      h('button.tb-btn', { html: sym.chevronUp, onclick: () => go(false) }), h('button.tb-btn', { html: sym.chevronDown, onclick: () => go(true) }), h('button.tb-btn', { html: sym.close, onclick: () => this.closeFind() }));
    this.views.append(this.findBar);
    input.focus();
  }
  onFound(r) { if (this.findCount) this.findCount.textContent = r.matches ? `${r.activeMatchOrdinal} of ${r.matches}` : 'No matches'; }
  closeFind() { if (!this.findBar) return; this.findBar.remove(); this.findBar = null; try { this.cur()?.wv?.stopFindInPage('clearSelection'); } catch { /* not ready */ } }
  moreMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const t = this.cur();
    showMenu([
      { label: 'New Tab', shortcut: '⌃T', action: () => this.newTab() }, { label: 'New Window', action: () => wm.open('browser') }, '-',
      { label: 'History', shortcut: '⌃H', action: () => this.openPage('history') }, { label: 'Passwords', action: () => this.openPage('passwords') },
      { label: 'Downloads', shortcut: '⌃J', action: () => this.openPage('downloads') }, { label: 'Extensions', action: () => this.openPage('extensions') }, '-',
      { label: 'Find on Page…', shortcut: '⌃F', disabled: !t?.wv || !!t.page, action: () => this.find() },
      { label: 'Zoom', submenu: [{ label: 'Zoom In', action: () => this.zoom(0.5) }, { label: 'Zoom Out', action: () => this.zoom(-0.5) }, { label: 'Actual Size', action: () => this.zoom(0) }] },
      { label: 'Open in System Browser', disabled: !t?.url, action: () => api.apps.run(`xdg-open '${t.url.replace(/'/g, "'\\''")}'`) }, '-',
      { label: 'Settings', shortcut: '⌃,', action: () => this.openPage('settings') },
    ], r.right - 230, r.bottom + 6, { minWidth: 230 });
  }
  async clearData() {
    const r = await alertDialog({ title: 'Clear browsing data?', message: 'Choose what to remove.', buttons: [
      { label: 'History Only', value: 'history' }, { label: 'Cookies, Site Data & Cache', value: 'site' }, { label: 'Everything', value: 'all', danger: true }, { label: 'Cancel', value: 'cancel' }] }, this.win.el);
    if (r.button === 'cancel') return;
    if (r.button === 'history' || r.button === 'all') appData.set('browserHistory', []);
    if (r.button !== 'history' && isNative) await B.invoke('browser:clearData', ['cache', 'cookies']);
    this.refreshPages('history'); this.refreshPages('start');
    shell.notify({ app: 'browser', title: 'Browsing data cleared' });
  }
}
