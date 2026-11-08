// Browser — a compact, tabbed web browser built on Electron's <webview>.
import { h, $, $$ } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym } from '../icons.js';
import { api, isNative } from '../sys.js';
import { wallpaperFor } from '../theme.js';
import { store, appData } from '../store.js';

const FAVS = [
  ['DuckDuckGo', 'https://duckduckgo.com', '#de5833', 'D'], ['Wikipedia', 'https://wikipedia.org', '#3a3a3c', 'W'], ['GitHub', 'https://github.com', '#24292f', 'G'],
  ['YouTube', 'https://youtube.com', '#ff0033', '▶'], ['Reddit', 'https://reddit.com', '#ff4500', 'R'], ['Hacker News', 'https://news.ycombinator.com', '#ff6600', 'Y'],
  ['Arch Wiki', 'https://wiki.archlinux.org', '#1793d1', 'A'], ['MDN', 'https://developer.mozilla.org', '#000', 'M'],
];

function normalize(q) {
  q = q.trim();
  if (!q) return null;
  if (/^(https?|file|about|data):/i.test(q)) return q;
  if (/^localhost(:\d+)?(\/|$)/.test(q) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(q)) return 'https://' + q;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(q);
}

registerApp({
  id: 'browser', name: 'Browser', size: [1100, 700], minSize: [480, 320], overlayContent: true, hideTitle: true,
  keywords: ['web', 'internet', 'safari', 'chrome', 'firefox'],
  about: 'A compact web browser built on Chromium.',
  menus: (win) => [
    { title: 'File', items: [
      { label: 'New Tab', shortcut: '⌃T', action: () => win?.state?.newTab() },
      { label: 'New Window', shortcut: '⌘N', action: () => wm.open('browser') },
      { label: 'Open Location…', shortcut: '⌃L', action: () => win?.state?.focusUrl() }, '-',
      { label: 'Close Tab', shortcut: '⌃W', action: () => win?.state?.closeTab() }] },
    { title: 'View', items: [
      { label: 'Reload Page', shortcut: '⌃R', action: () => win?.state?.cur()?.wv?.reload() },
      { label: 'Zoom In', action: () => { const wv = win?.state?.cur()?.wv; wv?.setZoomLevel(wv.getZoomLevel() + 0.5); } },
      { label: 'Zoom Out', action: () => { const wv = win?.state?.cur()?.wv; wv?.setZoomLevel(wv.getZoomLevel() - 0.5); } },
      { label: 'Actual Size', action: () => win?.state?.cur()?.wv?.setZoomLevel(0) }, '-',
      { label: 'Developer Tools', action: () => win?.state?.cur()?.wv?.openDevTools() }] },
    { title: 'History', items: [
      { label: 'Back', action: () => win?.state?.cur()?.wv?.goBack() }, { label: 'Forward', action: () => win?.state?.cur()?.wv?.goForward() }, '-',
      ...appData.get('browserHistory', []).slice(0, 12).map((x) => ({ label: x.title || x.url, action: () => win?.state?.load(x.url) }))] },
  ],
  open(win, args) { new BrowserView(win, args); },
});

class BrowserView {
  constructor(win, args) {
    this.win = win; win.state = this;
    this.tabs = []; this.active = -1;
    this.url = h('input.field', { placeholder: 'Search or enter website name', spellcheck: false });
    this.url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { this.load(this.url.value); this.url.blur(); } if (e.key === 'Escape') { this.syncUrl(); this.url.blur(); } });
    this.url.addEventListener('focus', () => setTimeout(() => this.url.select()));
    this.back = h('button.tb-btn', { html: sym.back, onclick: () => this.cur()?.wv?.goBack() });
    this.fwd = h('button.tb-btn', { html: sym.forward, onclick: () => this.cur()?.wv?.goForward() });
    this.reload = h('button.tb-btn', { html: sym.refresh, onclick: () => { const wv = this.cur()?.wv; wv?.isLoading() ? wv.stop() : wv?.reload(); } });
    win.toolbar.append(h('div.tb-group', this.back, this.fwd), h('div.br-urlbar.no-drag', this.url), h('div.tb-group', this.reload,
      h('button.tb-btn', { html: sym.share, title: 'Open in system browser', onclick: () => { const u = this.cur()?.url; if (u) api.apps.run(`xdg-open '${u.replace(/'/g, "'\\''")}'`); } }),
      h('button.tb-btn', { html: sym.plus, title: 'New Tab', onclick: () => this.newTab() })));
    this.tabBar = h('div.br-tabs');
    this.views = h('div.br-views');
    this.progress = h('div.br-progress', { style: { width: '0', opacity: 0 } });
    this.views.append(this.progress);
    win.body.append(h('div.browser', this.tabBar, this.views));
    win.dragRegion(this.tabBar);
    win.on('reopen', (a) => a?.url && this.newTab(a.url));
    win.el.addEventListener('keydown', (e) => {
      if (!e.ctrlKey) return;
      if (e.key === 't') { e.preventDefault(); this.newTab(); }
      if (e.key === 'w') { e.preventDefault(); this.closeTab(); }
      if (e.key === 'l') { e.preventDefault(); this.focusUrl(); }
      if (e.key === 'r') { e.preventDefault(); this.cur()?.wv?.reload(); }
    });
    this.newTab(args.url);
  }
  cur() { return this.tabs[this.active]; }
  focusUrl() { this.url.focus(); }
  newTab(url) {
    const tab = { title: 'Start Page', url: '', wv: null, start: null, favicon: null };
    this.tabs.push(tab);
    this.select(this.tabs.length - 1);
    if (url) this.load(url); else { this.showStart(tab); setTimeout(() => this.url.focus(), 50); }
  }
  closeTab(i = this.active) {
    const t = this.tabs[i];
    if (!t) return;
    t.wv?.remove(); t.start?.remove();
    this.tabs.splice(i, 1);
    if (!this.tabs.length) return this.win.close();
    this.select(Math.min(i, this.tabs.length - 1));
  }
  select(i) {
    this.active = i;
    this.tabs.forEach((t, j) => { if (t.wv) t.wv.style.visibility = j === i ? 'visible' : 'hidden'; if (t.start) t.start.hidden = j !== i; });
    this.renderTabs(); this.syncUrl();
  }
  renderTabs() {
    this.tabBar.innerHTML = '';
    this.tabBar.hidden = this.tabs.length < 2;
    this.tabs.forEach((t, i) => {
      const el = h('div.br-tab' + (i === this.active ? '.on' : ''), t.favicon ? h('img', { src: t.favicon, onerror: (e) => e.target.remove() }) : null, h('span', t.title || t.url || 'New Tab'),
        h('button', { html: sym.close, onclick: (e) => { e.stopPropagation(); this.closeTab(i); } }));
      el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); this.closeTab(i); } else this.select(i); });
      this.tabBar.append(el);
    });
    this.tabBar.append(h('button.br-add', { html: sym.plus, onclick: () => this.newTab() }));
    this.win.setTitle(this.cur()?.title || 'Browser');
  }
  syncUrl() {
    const t = this.cur();
    if (document.activeElement !== this.url) this.url.value = t?.url ? t.url.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, '') : '';
    this.back.disabled = !t?.wv?.canGoBack?.(); this.fwd.disabled = !t?.wv?.canGoForward?.();
    this.reload.innerHTML = t?.wv?.isLoading?.() ? sym.close : sym.refresh;
  }
  showStart(tab) {
    const favs = h('div.br-favs.glass.panel');
    for (const [n, u, c, l] of FAVS) {
      const f = h('div.br-fav', h('div.ic', { style: { background: c } }, l), n);
      f.addEventListener('click', () => this.load(u));
      favs.append(f);
    }
    const hist = appData.get('browserHistory', []).slice(0, 6);
    tab.start = h('div.br-start', { style: { backgroundImage: `url("${wallpaperFor(1200, 800)}")` } }, h('h2', 'Favorites'), favs,
      hist.length ? h('div.glass.panel', { style: { marginTop: '18px', borderRadius: '22px', padding: '12px 16px', width: '100%', maxWidth: '640px', color: 'var(--on-glass)' } },
        h('div', { style: { fontWeight: 700, marginBottom: '6px' } }, 'Recently Visited'),
        ...hist.map((x) => h('div.ellipsis', { style: { padding: '4px 0', fontSize: '12.5px' }, onclick: () => this.load(x.url) }, x.title || x.url))) : null);
    this.views.append(tab.start);
  }
  load(q) {
    const url = normalize(q);
    if (!url) return;
    const t = this.cur();
    t.start?.remove(); t.start = null;
    if (!isNative) { window.open(url, '_blank'); return; }
    if (!t.wv) {
      const wv = document.createElement('webview');
      wv.setAttribute('allowpopups', '');
      wv.setAttribute('partition', 'persist:browser');
      t.wv = wv;
      this.views.append(wv);
      const upd = () => { if (this.cur() === t) this.syncUrl(); };
      wv.addEventListener('did-start-loading', () => { this.progress.style.opacity = 1; this.progress.style.width = '30%'; upd(); });
      wv.addEventListener('did-stop-loading', () => { this.progress.style.width = '100%'; setTimeout(() => { this.progress.style.opacity = 0; this.progress.style.width = '0'; }, 300); upd(); });
      wv.addEventListener('did-navigate', (e) => { t.url = e.url; upd(); });
      wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) { t.url = e.url; upd(); } });
      wv.addEventListener('page-title-updated', (e) => {
        t.title = e.title; this.renderTabs();
        const hist = appData.get('browserHistory', []).filter((x) => x.url !== t.url);
        hist.unshift({ url: t.url, title: e.title, t: Date.now() });
        appData.set('browserHistory', hist.slice(0, 100));
      });
      wv.addEventListener('page-favicon-updated', (e) => { t.favicon = e.favicons[0]; this.renderTabs(); });
      wv.addEventListener('focus', () => this.win.focus());
      wv.src = url;
    } else wv_load(t.wv, url);
    t.url = url;
    this.syncUrl();
  }
}
function wv_load(wv, url) { try { wv.loadURL(url); } catch { wv.src = url; } }
