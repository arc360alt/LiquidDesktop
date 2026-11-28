// Files — a Finder-style file manager for the real filesystem.
import { h, $, $$, bus, basename, dirname, fmtSize, fmtDate, fileUrl, isCmd } from '../util.js';
import { playableMedia } from '../playable.js';
import { sym, folderIcon, docIcon, IMAGE_EXT, VIDEO_EXT, AUDIO_EXT, TEXT_EXT, appIconSVG, isArchive } from '../icons.js';
import { registerApp, wm } from '../wm.js';
import { api } from '../sys.js';
import { contextMenu, prompt, confirmDialog, showMenu, alertDialog, enhanceSelects as enhance } from '../menus.js';
import { shell } from '../shell.js';
import { store } from '../store.js';
import { sendToPhoneItem } from '../phone.js';

let clipboard = null; // { op: 'copy'|'cut', paths }

// Tags (colored dots on files) and Smart Folders (saved searches) — kept by main/finder.js and the store.
// Virtual places in a window's history: "tag:Red", "smart:<id>".
const SMART_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M13 11.3l.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z" fill="currentColor" stroke="none"/></svg>';
const TAB_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg>';
const KINDS = [['', 'Any Kind'], ['folders', 'Folders'], ['documents', 'Documents'], ['pdf', 'PDFs'], ['images', 'Images'], ['video', 'Movies'], ['audio', 'Music'], ['text', 'Text & Code'], ['archives', 'Archives']];
const DATES = [[0, 'Any Date'], [1, 'Today'], [7, 'Last 7 Days'], [30, 'Last 30 Days'], [365, 'This Year']];
let tagDb = { tags: [], files: {} };
const tagListeners = new Set();
let tagsLoaded = null;
function loadTags() {
  if (!api.tags) return Promise.resolve(tagDb);
  tagsLoaded ||= (async () => {
    api.tags.onChanged?.(async () => { tagDb = await api.tags.all().catch(() => tagDb); tagListeners.forEach((f) => f()); });
    tagDb = await api.tags.all().catch(() => tagDb);
    return tagDb;
  })();
  return tagsLoaded;
}
const tagColor = (n) => tagDb.tags.find((t) => t.name === n)?.color || '#8e8e93';
const tagDots = (p) => { const l = tagDb.files[p]; return l?.length ? h('span.f-tags', ...l.slice(0, 3).map((n) => h('i', { style: { background: tagColor(n) }, title: n }))) : null; };

registerApp({
  id: 'files', settings: 'files', name: 'Files', size: [920, 560], minSize: [520, 320], overlayContent: true, hideTitle: true,
  keywords: ['finder', 'file manager', 'folders'],
  about: 'Browse and manage the files on this computer.',
  menus: (win) => [
    { title: 'File', items: [
      { label: 'New Window', shortcut: '⌘N', action: () => wm.open('files', { path: win?.state?.realPath }) },
      { label: 'New Tab', shortcut: '⌘T', action: () => win?.state?.newTab() },
      { label: 'Close Tab', shortcut: '⌘W', disabled: !(win?.state?.tabs?.length > 1), action: () => win?.state?.closeTab() },
      { label: 'New Folder', shortcut: '⇧⌘N', action: () => win?.state?.newFolder() },
      { label: 'New Text File', action: () => win?.state?.newFile() }, '-',
      { label: 'Open in Terminal', action: () => wm.open('terminal', { cwd: win?.state?.path }) },
      { label: 'Get Info', action: () => win?.state?.info() },
      { label: 'Compress', action: () => win?.state?.compressSel() }, '-',
      { label: 'New Smart Folder', action: () => win?.state?.newSmart() },
      { label: 'Find…', shortcut: '⌘F', action: () => win?.state?.search.focus() }, '-',
      { label: 'Move to Trash', action: () => win?.state?.trashSel() },
      { label: 'Close Window', shortcut: '⌘W', action: () => win?.close() }] },
    { title: 'View', items: [
      { label: 'as Icons', checked: win?.state?.view === 'icons', action: () => win?.state?.setView('icons') },
      { label: 'as List', checked: win?.state?.view === 'list', action: () => win?.state?.setView('list') }, '-',
      { label: 'Show Hidden Files', checked: !!win?.state?.showHidden, shortcut: '⇧⌘.', action: () => win?.state?.toggleHidden() },
      { label: 'Show File Extensions', checked: store.get('filesShowExt') !== false, action: () => store.set('filesShowExt', store.get('filesShowExt') === false) }, '-',
      { label: 'Sort by Name', action: () => win?.state?.setSort('name') }, { label: 'Sort by Date Modified', action: () => win?.state?.setSort('mtime') },
      { label: 'Sort by Size', action: () => win?.state?.setSort('size') }, { label: 'Sort by Kind', action: () => win?.state?.setSort('ext') }] },
    { title: 'Go', items: [
      { label: 'Back', shortcut: '⌘[', action: () => win?.state?.back() }, { label: 'Forward', shortcut: '⌘]', action: () => win?.state?.forward() },
      { label: 'Enclosing Folder', shortcut: '⌘↑', action: () => win?.state?.up() }, '-',
      ...['home', 'desktop', 'documents', 'downloads', 'pictures'].map((k) => ({ label: k[0].toUpperCase() + k.slice(1), action: () => win?.state?.goPlace(k) })),
      { label: 'Computer', action: () => win?.state?.go('/') }, '-',
      { label: 'Go to Folder…', shortcut: '⇧⌘G', action: () => win?.state?.goTo() }] },
    { title: 'Window', items: [{ label: 'Show Next Tab', shortcut: '⌃Tab', action: () => win?.state?.stepTab(1) }, { label: 'Show Previous Tab', shortcut: '⌃⇧Tab', action: () => win?.state?.stepTab(-1) }] },
  ],
  open(win, args) { new FilesView(win, args); },
});

class FilesView {
  constructor(win, args) {
    this.win = win; win.state = this;
    this.view = store.get('filesView') || 'icons';
    this.showHidden = !!store.get('filesShowHidden');
    this.showExt = store.get('filesShowExt') !== false;
    this.sort = store.get('filesSort') || 'name';
    this.history = []; this.fwd = [];
    this.sel = new Set();
    this.items = [];
    this.filter = '';
    this.tabs = [];   // [{ path, history, fwd, sel, scroll }] — the one shown is this.tab
    this.tab = 0;
    this.build();
    loadTags().then(() => { this.renderSidebar(); this.renderItems(); });
    const offT = () => { this.renderSidebar(); if (this.virtual?.type === 'tag') this.refresh(true); else this.renderItems(); };
    tagListeners.add(offT);
    win.on('close', () => tagListeners.delete(offT));
    win.on('reopen', (a) => a?.path && this.go(a.path));
    api.fs.places().then((p) => {
      this.places = p;
      this.renderSidebar();
      this.tabs = [{ path: args.path || p.home, history: [], fwd: [], sel: [], scroll: 0 }];
      this.go(args.path || p.home, { select: args.select });
    });
    // external drives come and go: look every few seconds while this window is open
    this.drives = [];
    const pollDrives = async () => {
      if (!api.drives?.list || !this.places) return;
      const list = await api.drives.list().catch(() => null);
      if (!list) return;
      const key = JSON.stringify(list), had = JSON.stringify(this.drives);
      if (key === had) return;
      // a drive that was open here got pulled out: go home
      if (this.path && this.drives.some((d) => d.mounted && this.path.startsWith(d.mounted)) && !list.some((d) => d.mounted && this.path.startsWith(d.mounted))) this.go(this.places.home);
      this.drives = list;
      this.renderSidebar();
    };
    const driveTimer = setInterval(pollDrives, 3000);
    setTimeout(pollDrives, 300);
    win.on('close', () => clearInterval(driveTimer));
    this.pollDrives = pollDrives;
    const off = bus.on('fs-changed', () => this.refresh());
    const offS = store.on('change', (k) => {
      if (k === 'accent' || k === 'tintIcons') this.renderItems();   // folders follow the accent color
      if (k === 'filesShowHidden') { this.showHidden = !!store.get(k); this.renderItems(); }
      if (k === 'filesShowExt') { this.showExt = store.get(k) !== false; this.renderItems(); }
      if (k === 'filesSort') { this.sort = store.get(k); this.renderItems(); }
      if (k === 'filesFoldersFirst') this.renderItems();
      if (k === 'smartFolders') this.renderSidebar();
    });
    win.on('close', offS);
    win.on('close', off);
    win.on('focus', () => this.refresh());
  }

  build() {
    const w = this.win;
    this.sidebar = h('div.sidebar');
    w.dragRegion(this.sidebar);
    this.backBtn = h('button.tb-btn', { html: sym.back, title: 'Back', onclick: () => this.back() });
    this.fwdBtn = h('button.tb-btn', { html: sym.forward, title: 'Forward', onclick: () => this.forward() });
    this.titleEl = h('div.win-title', { style: { fontSize: '15px', fontWeight: 700 } });
    this.viewBtns = { icons: h('button.tb-btn', { html: sym.icons, title: 'Icons', onclick: () => this.setView('icons') }), list: h('button.tb-btn', { html: sym.list, title: 'List', onclick: () => this.setView('list') }) };
    this.search = h('input.field', { placeholder: 'Search', style: { width: '170px', height: '34px' } });
    this.search.addEventListener('input', () => { this.filter = this.search.value.trim().toLowerCase(); this.renderItems(); });
    this.search.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && this.search.value.trim().length > 1) this.runSearch({ text: this.search.value.trim() });
      if (e.key === 'Escape') this.endSearch();
    });
    w.toolbar.style.marginLeft = '150px';
    w.toolbar.append(
      h('div.tb-group', this.backBtn, this.fwdBtn), this.titleEl, h('div.spacer'),
      h('div.tb-group', this.viewBtns.icons, this.viewBtns.list),
      h('div.tb-group', h('button.tb-btn', { html: sym.folderPlus, title: 'New Folder', onclick: () => this.newFolder() }),
        h('button.tb-btn', { html: sym.share, title: 'Open in Terminal', onclick: () => wm.open('terminal', { cwd: this.realPath }) }),
        h('button.tb-btn', { html: sym.ellipsis, title: 'More', onclick: (e) => this.moreMenu(e.currentTarget) })),
      h('div.search-field', { html: sym.search }, this.search));
    this.view_ = h('div.files-view', { tabindex: 0 });
    this.pathbar = h('div.pathbar');
    this.tabBar = h('div.f-tabs', { hidden: true });
    this.scopeBar = h('div.f-scope', { hidden: true });
    this.main = h('div.main-pane', this.tabBar, this.scopeBar, this.view_, this.pathbar);
    // tabs: Ctrl+T, Ctrl+W, Ctrl+Tab — anywhere in the window
    w.el.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.target.closest?.('input.rename-input, .path-input')) return;
      const k = e.key.toLowerCase();
      if (k === 't') { e.preventDefault(); this.newTab(); }
      else if (k === 'w' && this.tabs.length > 1) { e.preventDefault(); e.stopPropagation(); this.closeTab(); }
      else if (e.key === 'Tab') { e.preventDefault(); this.stepTab(e.shiftKey ? -1 : 1); }
      else if (/^[1-9]$/.test(e.key) && this.tabs.length > 1) { e.preventDefault(); this.switchTab(Math.min(this.tabs.length - 1, +e.key - 1)); }
    }, true);
    w.body.append(this.sidebar, this.main);
    this.view_.addEventListener('mousedown', (e) => this.rubberBand(e));
    // middle-click a folder: open it in a new tab
    this.view_.addEventListener('auxclick', (e) => { if (e.button !== 1) return; const el = e.target.closest('[data-path]'); const f = el && this.visible().find((x) => x.path === el.dataset.path); if (f?.isDir) { e.preventDefault(); this.newTab(f.path, true); } });
    // the path bar: a click anywhere but a folder's name turns it into a field to type a path in
    this.pathbar.addEventListener('click', (e) => { if (!e.target.closest('.crumb') && !this.pathbar.querySelector('input')) this.editPath(); });
    this.view_.addEventListener('contextmenu', (e) => { if (!e.target.closest('.f-item, tr')) this.bgMenu(e); });
    this.view_.addEventListener('keydown', (e) => this.onKey(e));
    this.view_.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/liquid-paths')) e.preventDefault(); });
    this.view_.addEventListener('drop', (e) => { if (!e.target.closest('.f-item, tr')) this.dropOn(e, this.path); });
  }

  /* ---------------------------------------------- navigation */
  async go(path, { push = true, select } = {}) {
    const virt = /^(tag|smart):/.test(path);
    if (!virt) { try { await api.fs.list(path); } catch (e) { shell.notify({ app: 'files', title: 'Can’t open folder', body: e.message }); return; } }
    if (push && this.path && this.path !== path) { this.history.push(this.path); this.fwd = []; }
    this.path = path;
    this.virtual = virt ? { type: path.slice(0, path.indexOf(':')), id: path.slice(path.indexOf(':') + 1) } : null;
    this.sel.clear();
    this.search.value = ''; this.filter = ''; this.searchResults = null; this.searchQ = null; this.searchFrom = null;
    if (this.virtual?.type === 'smart') { const sf = (store.get('smartFolders') || []).find((x) => x.id === this.virtual.id); this.searchQ = sf ? { ...sf.query } : null; }
    this.drawScope();
    if (select) this.sel.add(select);
    await this.refresh(true);
    this.view_.focus();
  }
  back() { if (!this.history.length) return; this.fwd.push(this.path); this.go(this.history.pop(), { push: false }); }
  forward() { if (!this.fwd.length) return; this.history.push(this.path); this.go(this.fwd.pop(), { push: false }); }
  up() { if (this.virtual) return; if (this.path !== '/') this.go(dirname(this.path), { select: this.path }); }
  /** The folder this window is really in (a tag or Smart Folder has none: home). */
  get realPath() { return this.virtual ? this.places?.home : this.path; }
  goPlace(k) { if (this.places) this.go(this.places[k]); }
  async goTo() { const p = await prompt('Go to the folder:', this.path, {}, this.win.el); if (p) this.go(p.replace(/^~/, this.places.home)); }
  get isTrash() { return this.places && this.path === this.places.trash; }

  async refresh(force) {
    if (!this.path) return;
    if (this.searchQ && !this.virtual && !force) return;   // showing search results: the folder isn't shown
    let items;
    if (this.virtual?.type === 'tag') items = await api.tags.files(this.virtual.id).catch(() => []);
    else if (this.virtual?.type === 'smart') items = this.searchQ ? await api.search.query({ ...this.searchQ, limit: 500 }).catch(() => []) : [];
    else { try { items = await api.fs.list(this.path); } catch { return; } }
    const sig = items.map((i) => i.name + i.mtime + i.size).join('|');
    if (!force && sig === this.sig) return;
    this.sig = sig;
    this.items = items;
    this.renderItems();
    this.renderChrome();
  }

  renderChrome() {
    const smart = this.virtual?.type === 'smart' ? (store.get('smartFolders') || []).find((x) => x.id === this.virtual.id) : null;
    const name = this.virtual ? (smart?.name || this.virtual.id) : this.isTrash ? 'Trash' : this.path === this.places?.home ? 'Home' : basename(this.path);
    if (this.tabs[this.tab]) this.tabs[this.tab].path = this.path;
    this.drawTabs();
    this.titleEl.textContent = name;
    this.win.setTitle(name);
    this.backBtn.disabled = !this.history.length; this.fwdBtn.disabled = !this.fwd.length;
    for (const [k, b] of Object.entries(this.viewBtns)) b.classList.toggle('on', k === this.view);
    $$('.sb-item', this.sidebar).forEach((el) => el.classList.toggle('sel', el.dataset.path === this.path));
    // path bar
    this.pathbar.innerHTML = '';
    if (this.virtual) {
      this.pathbar.append(h('span.crumb', { html: `<span style="width:14px;height:14px;display:inline-flex">${this.virtual.type === 'tag' ? `<i style="display:block;width:10px;height:10px;margin:2px;border-radius:50%;background:${tagColor(this.virtual.id)}"></i>` : SMART_ICON}</span>` }, this.virtual.type === 'tag' ? `Tag: ${name}` : `Smart Folder: ${name}`));
      this.status = h('span.status'); this.pathbar.append(this.status); this.updateStatus();
      return;
    }
    const parts = this.path.split('/').filter(Boolean);
    const crumbs = [['/', 'Computer']];
    parts.forEach((p, i) => crumbs.push(['/' + parts.slice(0, i + 1).join('/'), p]));
    crumbs.forEach(([p, n], i) => {
      if (i) this.pathbar.append(h('span.chev', '›'));
      const c = h('span.crumb', { html: (i === crumbs.length - 1 ? '' : '') + `<span style="width:14px;height:14px;display:inline-flex">${p === '/' ? sym.drive : folderIcon(n)}</span>` }, n);
      c.addEventListener('click', () => this.go(p));
      c.addEventListener('dragover', (e) => e.preventDefault());
      c.addEventListener('drop', (e) => this.dropOn(e, p));
      this.pathbar.append(c);
    });
    this.status = h('span.status');
    this.pathbar.append(this.status);
    this.updateStatus();
  }
  /* ---------------------------------------------- typing a path */
  editPath() {
    const home = this.places?.home || '';
    const tilde = (p) => (home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p);
    const expand = (p) => (home ? p.replace(/^~(?=\/|$)/, home) : p);
    const input = h('input.field.path-input', { value: tilde(this.path) + (this.path === '/' ? '' : '/'), spellcheck: false, autocomplete: 'off' });
    const pop = h('div.path-suggest.glass.panel');
    pop.hidden = true;
    this.pathbar.replaceChildren(input);
    this.main.append(pop);
    const listing = new Map();   // folder → its subfolders (asked once per folder while typing)
    let items = [], cur = -1, seq = 0, closed = false;
    const close = () => { if (closed) return; closed = true; pop.remove(); this.renderChrome(); };
    const draw = () => {
      pop.replaceChildren(...items.map((p, i) => h('div.ps-item' + (i === cur ? '.on' : ''), { onmousedown: (e) => { e.preventDefault(); pick(p, true); } },
        h('span', { html: `<span style="width:14px;height:14px;display:inline-flex">${folderIcon(basename(p))}</span>` }), h('span.ps-name', tilde(p)))));
      pop.hidden = !items.length;
    };
    const suggest = async () => {
      const my = ++seq, text = expand(input.value);
      const i = text.lastIndexOf('/');
      if (i < 0) { items = []; draw(); return; }
      const dir = text.slice(0, i) || '/', part = text.slice(i + 1).toLowerCase();
      if (!listing.has(dir)) {
        try { listing.set(dir, (await api.fs.list(dir)).filter((f) => f.isDir).map((f) => f.path)); } catch { listing.set(dir, []); }
      }
      if (my !== seq) return;   // typed on meanwhile
      items = listing.get(dir).filter((p) => { const n = basename(p).toLowerCase(); return n.startsWith(part) && (part.startsWith('.') || !n.startsWith('.')); })
        .sort((a, b) => a.localeCompare(b)).slice(0, 8);
      if (items.length === 1 && items[0] === text.replace(/\/+$/, '')) items = [];
      cur = -1; draw();
    };
    const pick = (p, open) => { input.value = tilde(p) + '/'; if (open) go(); else { input.focus(); suggest(); } };
    const go = async () => {
      const target = expand(input.value.trim()).replace(/(.)\/+$/, '$1') || '/';
      close();
      let st = null;
      try { st = await api.fs.stat(target); } catch { st = null; }
      if (!st) { shell.notify({ app: 'files', title: 'Can’t open', body: `“${target}” doesn’t exist.` }); return; }
      if (st.isDir) this.go(target); else this.go(dirname(target), { select: target });
    };
    input.addEventListener('input', suggest);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(); this.view_.focus(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (cur >= 0 && items[cur]) pick(items[cur], true); else go(); }
      else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); cur = cur <= 0 ? items.length - 1 : cur - 1; draw(); }
      else if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); cur = (cur + 1) % items.length; draw(); }
      else if (e.key === 'Tab' && items.length) { e.preventDefault(); pick(items[cur >= 0 ? cur : 0], false); }
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    suggest();
  }

  /* ---------------------------------------------- selecting by dragging a box over empty space */
  rubberBand(e) {
    if (e.button !== 0 || e.target.closest('.f-item, tbody tr, thead, button, input')) return;
    const toggle = e.ctrlKey || e.metaKey, add = toggle || e.shiftKey;
    const before = add ? new Set(this.sel) : new Set();
    if (!add) { this.sel.clear(); this.paintSel(); }
    const view = this.view_, vr0 = view.getBoundingClientRect();
    // measured in the view's scrolled content, so the box stays put while the view scrolls
    const sx = e.clientX - vr0.left + view.scrollLeft, sy = e.clientY - vr0.top + view.scrollTop;
    let band = null, last = null;
    const update = () => {
      if (!last) return;
      const vr = view.getBoundingClientRect();
      const cx = Math.max(0, Math.min(last.clientX - vr.left, vr.width)) + view.scrollLeft, cy = Math.max(0, Math.min(last.clientY - vr.top, vr.height)) + view.scrollTop;
      const x = Math.min(sx, cx), y = Math.min(sy, cy), w = Math.abs(cx - sx), hh = Math.abs(cy - sy);
      if (!band) { if (w + hh < 4) return; band = h('div.f-band'); view.append(band); }
      Object.assign(band.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: hh + 'px' });
      const L = x - view.scrollLeft + vr.left, T = y - view.scrollTop + vr.top;
      this.sel = new Set(before);
      for (const el of $$('[data-path]', view)) {
        const r = (el.querySelector('.cell') || el).getBoundingClientRect();
        if (r.right > L && r.left < L + w && r.bottom > T && r.top < T + hh) {
          if (toggle && before.has(el.dataset.path)) this.sel.delete(el.dataset.path); else this.sel.add(el.dataset.path);
        }
      }
      this.paintSel();
    };
    const mv = (ev) => { last = ev; update(); };
    // near the top or bottom edge: scroll, and keep growing the box
    const scroller = setInterval(() => {
      if (!last || !band) return;
      const vr = view.getBoundingClientRect();
      const d = last.clientY < vr.top + 30 ? -12 : last.clientY > vr.bottom - 30 ? 12 : 0;
      if (d) { view.scrollTop += d; update(); }
    }, 30);
    const up = () => { clearInterval(scroller); if (band) band.remove(); removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  }

  updateStatus() {
    if (!this.status) return;
    const n = this.visible().length;
    this.status.textContent = (this.sel.size ? `${this.sel.size} of ` : '') + `${n} item${n === 1 ? '' : 's'}`;
  }

  // an external drive in the sidebar: click to open (mounting it first if needed), ⏏ to eject
  driveItem(d) {
    const EJECT = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5 4.5 14h15z"/><rect x="4.5" y="16.5" width="15" height="3" rx="1"/></svg>';
    const open = async () => {
      let where = d.mounted;
      if (!where) {
        el.classList.add('busy');
        where = await api.drives.mount(d.device).catch((e) => { alertDialog({ title: `“${d.name}” couldn’t be opened`, message: e.message }, this.win.el); return null; });
        el.classList.remove('busy');
        this.pollDrives?.();
      }
      if (where) this.go(where);
    };
    const eject = async (e) => {
      e?.stopPropagation();
      if (d.mounted && this.path?.startsWith(d.mounted)) this.go(this.places.home);
      el.classList.add('busy');
      const r = await api.drives.eject(d.device).then(() => true).catch((err) => { alertDialog({ title: `“${d.name}” couldn’t be ejected`, message: err.message }, this.win.el); return false; });
      el.classList.remove('busy');
      if (r) shell.notify({ app: 'files', title: 'Safe to remove', body: `“${d.name}” can be unplugged now.` });
      this.pollDrives?.();
    };
    const el = h('div.sb-item.sb-drive' + (d.mounted ? '' : '.unmounted'), { 'data-path': d.mounted || '', title: `${d.name} · ${fmtSize(d.size)} · ${d.fstype}${d.mounted ? '' : ' · not open yet'}`, html: sym.drive },
      h('span.ellipsis', d.name),
      d.removable || d.mounted ? h('button.sb-eject', { title: 'Eject', html: EJECT, onclick: eject }) : null);
    el.addEventListener('click', open);
    el.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Open', action: open },
      d.mounted ? { label: 'Open in New Window', action: () => wm.open('files', { path: d.mounted }) } : null,
      d.mounted ? { label: 'Open in Terminal', action: () => wm.open('terminal', { cwd: d.mounted }) } : null, '-',
      { label: 'Eject', action: eject },
    ].filter(Boolean)));
    if (d.mounted) {
      el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/liquid-paths')) { e.preventDefault(); el.classList.add('drop'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (e) => { el.classList.remove('drop'); this.dropOn(e, d.mounted); });
    }
    return el;
  }

  renderSidebar() {
    const p = this.places;
    if (!p) return;   // (tags can arrive before the places do)
    const item = (icon, label, path) => {
      const el = h('div.sb-item', { 'data-path': path, html: icon }, label);
      el.addEventListener('click', () => this.go(path));
      el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/liquid-paths')) { e.preventDefault(); el.classList.add('drop'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (e) => { el.classList.remove('drop'); this.dropOn(e, path); });
      el.addEventListener('contextmenu', (e) => contextMenu(e, [{ label: 'Open in New Window', action: () => wm.open('files', { path }) }, { label: 'Open in Terminal', action: () => wm.open('terminal', { cwd: path }) }]));
      return el;
    };
    this.sidebar.innerHTML = '';
    this.sidebar.append(
      h('div.sb-sec', 'Favorites'),
      item(sym.home, 'Home', p.home), item(sym.desktop, 'Desktop', p.desktop), item(sym.doc, 'Documents', p.documents),
      item(sym.download, 'Downloads', p.downloads), item(sym.photo, 'Pictures', p.pictures), item(sym.music, 'Music', p.music), item(sym.video, 'Videos', p.videos),
      h('div.sb-sec', 'Locations'),
      item(sym.drive, 'Computer', '/'),
      ...(this.drives || []).map((d) => this.driveItem(d)),
      item(sym.trash, 'Trash', p.trash),
      ...this.smartItems(),
      h('div.sb-sec', 'Tags'),
      ...tagDb.tags.map((t) => this.tagItem(t)));
    $$('.sb-item', this.sidebar).forEach((el) => el.classList.toggle('sel', el.dataset.path === this.path));
  }
  tagItem(t) {
    const el = h('div.sb-item.sb-tag', { 'data-path': 'tag:' + t.name }, h('i.sb-tagdot', { style: { background: t.color } }), h('span.ellipsis', t.name));
    el.addEventListener('click', () => this.go('tag:' + t.name));
    // drop files on a tag: they get it
    el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/liquid-paths')) { e.preventDefault(); el.classList.add('drop'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => { el.classList.remove('drop'); e.preventDefault(); api.tags.toggle(JSON.parse(e.dataTransfer.getData('text/liquid-paths') || '[]'), t.name, true); });
    el.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Open in New Tab', action: () => this.newTab('tag:' + t.name, true) },
      { label: `Rename “${t.name}”…`, action: async () => { const n = await prompt('Rename Tag', t.name, {}, this.win.el); if (n && n.trim() && n.trim() !== t.name) api.tags.define({ oldName: t.name, name: n.trim() }).catch((err) => alertDialog({ title: 'Couldn’t rename', message: err.message }, this.win.el)); } },
      { label: 'Color', submenu: ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#af52de', '#ff2d55', '#8e8e93'].map((c) => ({ label: ' ', icon: `<span style="display:block;width:12px;height:12px;border-radius:50%;background:${c}"></span>`, checked: t.color === c, action: () => api.tags.define({ oldName: t.name, color: c }) })) }, '-',
      { label: `Delete Tag “${t.name}”`, danger: true, action: async () => { if (await confirmDialog(`Delete the tag “${t.name}”?`, 'It’s taken off every file that has it. The files stay.', 'Delete', { danger: true }, this.win.el)) api.tags.define({ remove: t.name }); } },
      { label: 'New Tag…', action: () => this.newTag() }]));
    return el;
  }
  async newTag(paths) {
    const n = await prompt('New Tag', '', { placeholder: 'Name', ok: 'Create' }, this.win.el);
    if (!n?.trim()) return;
    try { await api.tags.define({ name: n.trim(), color: ['#5ac8fa', '#ff2d55', '#a2845e', '#30b0c7'][tagDb.tags.length % 4] }); if (paths?.length) await api.tags.toggle(paths, n.trim(), true); } catch (err) { alertDialog({ title: 'Couldn’t add the tag', message: err.message }, this.win.el); }
  }
  smartItems() {
    const list = store.get('smartFolders') || [];
    if (!list.length) return [];
    return [h('div.sb-sec', 'Smart Folders'), ...list.map((sf) => {
      const el = h('div.sb-item', { 'data-path': 'smart:' + sf.id, html: SMART_ICON }, h('span.ellipsis', sf.name));
      el.addEventListener('click', () => this.go('smart:' + sf.id));
      el.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Open in New Tab', action: () => this.newTab('smart:' + sf.id, true) },
        { label: 'Rename…', action: async () => { const n = await prompt('Rename Smart Folder', sf.name, {}, this.win.el); if (n?.trim()) store.set('smartFolders', (store.get('smartFolders') || []).map((x) => (x.id === sf.id ? { ...x, name: n.trim() } : x))); this.renderChrome(); } },
        { label: 'Delete Smart Folder', danger: true, action: () => { store.set('smartFolders', (store.get('smartFolders') || []).filter((x) => x.id !== sf.id)); if (this.path === 'smart:' + sf.id) this.go(this.places.home); } }]));
      return el;
    })];
  }

  /* ---------------------------------------------- searching (and Smart Folders: saved searches) */
  // Enter in the search field searches this folder and everything in it — names and, with "Contents", what's
  // inside files. The bar under the toolbar narrows it down (where, kind, date) and saves it as a Smart Folder.
  runSearch(q) {
    if (!this.searchQ && !this.virtual) this.searchFrom = this.path;
    this.searchQ = { text: '', contents: true, kind: '', days: 0, dir: this.realPath, ...(this.searchQ || {}), ...q };
    this.drawScope();
    this.doSearch();
  }
  async doSearch() {
    const q = this.searchQ; if (!q) return;
    const my = (this.searchSeq = (this.searchSeq || 0) + 1);
    this.view_.innerHTML = ''; this.view_.append(h('div.empty-state', { style: { height: '100%', gap: '8px' } }, h('div.spinner'), 'Searching…'));
    const res = await api.search.query({ ...q, limit: 500 }).catch(() => []);
    if (my !== this.searchSeq) return;
    this.searchResults = res; this.renderItems();
  }
  endSearch() {
    this.search.value = ''; this.filter = ''; this.searchResults = null;
    if (this.virtual?.type === 'smart') { this.drawScope(); this.refresh(true); return; }
    this.searchQ = null; this.searchFrom = null; this.drawScope(); this.renderItems(); this.view_.focus();
  }
  drawScope() {
    const q = this.searchQ;
    const smart = this.virtual?.type === 'smart';
    this.scopeBar.hidden = !q;
    this.main.classList.toggle('has-scope', !!q);
    if (!q) return;
    const segBtn = (on, label, fn) => h('button' + (on ? '.on' : ''), { onclick: fn }, label);
    const home = this.places?.home;
    const here = this.searchFrom && !/^(tag|smart):/.test(this.searchFrom) && this.searchFrom !== home ? this.searchFrom : null;
    const sel = (opts, val, fn) => h('select.field.square', { onchange: (e) => fn(e.target.value) }, ...opts.map(([v, l]) => h('option', { value: v, selected: String(val) === String(v) }, l)));
    this.scopeBar.replaceChildren(...[
      h('span.f-scope-l', 'Search:'),
      h('div.segmented', segBtn(q.dir === home, 'Home', () => this.runSearch({ dir: home })), ...(here || (q.dir && q.dir !== home) ? [segBtn(q.dir !== home, `“${basename(here || q.dir)}”`, () => this.runSearch({ dir: here || q.dir }))] : [])),
      h('div.segmented', segBtn(!q.contents, 'Name', () => this.runSearch({ contents: false })), segBtn(!!q.contents, 'Contents', () => this.runSearch({ contents: true }))),
      sel(KINDS, q.kind, (v) => this.runSearch({ kind: v })),
      sel(DATES, q.days, (v) => this.runSearch({ days: +v })),
      h('span.spacer'),
      smart ? h('button.btn', { onclick: () => this.saveSmart(true) }, 'Save Changes') : h('button.btn', { onclick: () => this.saveSmart() }, 'Save…'),
      smart ? null : h('button.f-scope-x', { title: 'End search', html: sym.close, onclick: () => this.endSearch() })].filter(Boolean));
    enhance(this.scopeBar);
  }
  async saveSmart(update) {
    const q = { ...this.searchQ };
    if (update && this.virtual?.type === 'smart') { store.set('smartFolders', (store.get('smartFolders') || []).map((x) => (x.id === this.virtual.id ? { ...x, query: q } : x))); return; }
    const name = await prompt('Save as a Smart Folder', q.text || KINDS.find((k) => k[0] === q.kind)?.[1] || 'Smart Folder', { ok: 'Save', message: 'It shows up in the sidebar and stays up to date: the search runs again each time you open it.' }, this.win.el);
    if (!name?.trim()) return;
    const id = Math.random().toString(36).slice(2, 9);
    store.set('smartFolders', [...(store.get('smartFolders') || []), { id, name: name.trim(), query: q }]);
    this.go('smart:' + id);
  }
  newSmart() { this.runSearch({ text: this.search.value.trim(), kind: 'documents', days: 7, contents: false }); this.search.focus(); }

  /* ---------------------------------------------- tabs */
  saveTab() { const t = this.tabs[this.tab]; if (t) Object.assign(t, { path: this.path, history: this.history, fwd: this.fwd, sel: [...this.sel], scroll: this.view_.scrollTop, searchQ: this.virtual ? null : this.searchQ, searchFrom: this.searchFrom, searchText: this.search.value }); }
  newTab(path = this.realPath, background = false) {
    this.saveTab();
    this.tabs.splice(this.tab + 1, 0, { path, history: [], fwd: [], sel: [], scroll: 0 });
    if (background) { this.drawTabs(); return; }
    this.switchTab(this.tab + 1, true);
  }
  async switchTab(i, saved) {
    if (i === this.tab && !saved) return;
    if (!saved) this.saveTab();
    this.tab = i;
    const t = this.tabs[i];
    this.history = t.history; this.fwd = t.fwd;
    await this.go(t.path, { push: false });
    this.sel = new Set(t.sel || []); this.paintSel();
    if (t.searchQ) { this.searchFrom = t.searchFrom; this.searchQ = t.searchQ; this.search.value = t.searchText || ''; this.drawScope(); this.doSearch(); }
    requestAnimationFrame(() => { this.view_.scrollTop = t.scroll || 0; });
    this.drawTabs();
  }
  closeTab(i = this.tab) {
    if (this.tabs.length < 2) return this.win.close();
    const showing = i === this.tab;
    this.tabs.splice(i, 1);
    if (i < this.tab) this.tab--;
    this.tab = Math.min(this.tab, this.tabs.length - 1);
    if (showing) this.switchTab(this.tab, true); else this.drawTabs();
  }
  stepTab(d) { if (this.tabs.length > 1) this.switchTab((this.tab + d + this.tabs.length) % this.tabs.length); }
  drawTabs() {
    const many = this.tabs.length > 1;
    this.tabBar.hidden = !many;
    this.main.classList.toggle('has-tabs', many);
    if (!many) return;
    const label = (p) => (p.startsWith('tag:') ? p.slice(4) : p.startsWith('smart:') ? ((store.get('smartFolders') || []).find((x) => x.id === p.slice(6))?.name || 'Smart Folder') : p === this.places?.home ? 'Home' : p === this.places?.trash ? 'Trash' : basename(p) || 'Computer');
    this.tabBar.replaceChildren(...this.tabs.map((t, i) => {
      const el = h('div.f-tab' + (i === this.tab ? '.on' : ''), { title: t.path }, h('button.f-tab-x', { title: 'Close Tab', html: sym.close, onclick: (e) => { e.stopPropagation(); this.closeTab(i); } }), h('span.ellipsis', label(t.path)));
      el.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest('.f-tab-x')) this.switchTab(i); });
      el.addEventListener('auxclick', (e) => { if (e.button === 1) this.closeTab(i); });
      el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/liquid-paths') && !/^(tag|smart):/.test(t.path)) { e.preventDefault(); el.classList.add('drop'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (e) => { el.classList.remove('drop'); this.dropOn(e, t.path); });
      return el;
    }), h('button.f-tab-add', { title: 'New Tab', html: TAB_PLUS, onclick: () => this.newTab() }));
  }

  /* ---------------------------------------------- items */
  visible() {
    if (this.searchResults) return this.searchResults;
    let list = this.items.filter((i) => this.showHidden || !i.hidden);
    if (this.filter) list = list.filter((i) => i.name.toLowerCase().includes(this.filter));
    const s = this.sort;
    const ff = store.get('filesFoldersFirst') !== false;
    list.sort((a, b) => (ff ? b.isDir - a.isDir : 0) || (s === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : s === 'mtime' ? b.mtime - a.mtime : s === 'size' ? b.size - a.size : (a.ext || '').localeCompare(b.ext || '') || a.name.localeCompare(b.name)));
    return list;
  }
  iconFor(f, size = 60) {
    const box = h('div.fi');
    if (f.isDir) box.innerHTML = folderIcon(f.name);
    else if (IMAGE_EXT.has(f.ext) && size > 20) box.append(h('img.thumb', { src: fileUrl(f.path), loading: 'lazy', onerror: (e) => { box.innerHTML = docIcon(f.ext); } }));
    else box.innerHTML = docIcon(f.ext);
    return box;
  }
  renderItems() {
    const list = this.visible();
    this.view_.innerHTML = '';
    if (!list.length) {
      this.view_.append(h('div.empty-state', { style: { height: '100%' } }, this.isTrash ? 'Trash is Empty' : this.filter || this.searchResults ? 'No Results' : this.virtual?.type === 'tag' ? `Nothing is tagged “${this.virtual.id}” yet. Right-click a file and pick the tag.` : this.virtual ? 'No Results' : 'This folder is empty'));
      this.updateStatus();
      return;
    }
    if (this.isTrash) this.view_.append(h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 6px 10px' } }, h('b', 'Trash'), h('button.btn', { onclick: () => shell.emptyTrash() }, 'Empty')));
    if (this.view === 'icons') {
      const grid = h('div.files-grid');
      for (const f of list) {
        const el = h('div.f-item' + (f.hidden ? '.hidden-file' : ''), { draggable: true }, this.iconFor(f), h('div.nm', { title: f.name + (f.match === 'contents' ? ' — the text inside matches' : '') }, this.displayName(f)), tagDots(f.path));
        this.bindItem(el, f);
        grid.append(el);
      }
      this.view_.append(grid);
      // once laid out, and again when the window (so the column width) changes
      this.nameFit?.disconnect();
      this.nameFit = new ResizeObserver(() => this.fitNames(grid));
      this.nameFit.observe(grid);
    } else {
      const tb = h('tbody');
      const th = (label, key) => h('th', { onclick: () => this.setSort(key), style: { cursor: 'default' } }, label + (this.sort === key ? ' ▾' : ''));
      const table = h('table.files-list', h('thead', h('tr', th('Name', 'name'), th('Date Modified', 'mtime'), th('Size', 'size'), th('Kind', 'ext'))), tb);
      for (const f of list) {
        const tr = h('tr', { draggable: true }, h('td', h('div.cell', { title: f.name }, this.iconFor(f, 18), this.displayName(f), tagDots(f.path))), h('td.muted', fmtDate(f.mtime)), h('td.muted', f.isDir ? '--' : fmtSize(f.size)), h('td.muted', f.isDir ? 'Folder' : (f.ext ? f.ext.toUpperCase() + ' file' : 'Document')));
        this.bindItem(tr, f);
        tb.append(tr);
      }
      this.view_.append(table);
    }
    this.paintSel();
  }
  bindItem(el, f) {
    el.dataset.path = f.path;
    if (clipboard?.op === 'cut' && clipboard.paths.includes(f.path)) el.classList.add('cut');
    el.addEventListener('mousedown', (e) => {
      if (e.button === 2 && this.sel.has(f.path)) return;
      if (e.shiftKey && this.lastSel) {
        const list = this.visible().map((x) => x.path);
        const a = list.indexOf(this.lastSel), b = list.indexOf(f.path);
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.sel.add(list[i]);
      } else if (e.ctrlKey || e.metaKey) { this.sel.has(f.path) ? this.sel.delete(f.path) : this.sel.add(f.path); }
      else if (!this.sel.has(f.path) || e.button === 0) { if (!this.sel.has(f.path)) { this.sel.clear(); } this.sel.add(f.path); }
      this.lastSel = f.path;
      this.paintSel();
    });
    el.addEventListener('click', (e) => { if (!e.shiftKey && !e.ctrlKey && !e.metaKey) { this.sel.clear(); this.sel.add(f.path); this.paintSel(); } });
    el.addEventListener('dblclick', () => this.openItem(f));
    el.addEventListener('contextmenu', (e) => this.itemMenu(e, f));
    el.addEventListener('dragstart', (e) => {
      if (!this.sel.has(f.path)) { this.sel.clear(); this.sel.add(f.path); this.paintSel(); }
      e.dataTransfer.setData('text/liquid-paths', JSON.stringify([...this.sel]));
      e.dataTransfer.setData('text/plain', [...this.sel].join('\n'));
      e.dataTransfer.effectAllowed = 'copyMove';
    });
    if (f.isDir) {
      el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/liquid-paths') && !this.sel.has(f.path)) { e.preventDefault(); el.classList.add('drop'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (e) => { el.classList.remove('drop'); e.stopPropagation(); this.dropOn(e, f.path); });
    }
  }
  paintSel() {
    for (const el of $$('[data-path]', this.view_)) el.classList.toggle('sel', this.sel.has(el.dataset.path));
    this.updateStatus();
  }
  selected() { const all = this.visible(); return all.filter((f) => this.sel.has(f.path)); }

  openItem(f) {
    if (f.isDir) return this.go(f.path);   // (going somewhere ends a search)
    shell.openPath(f.path, false);
  }

  /* ---------------------------------------------- operations */
  async dropOn(e, dir) {
    e.preventDefault();
    if (/^(tag|smart):/.test(dir)) return;
    const paths = JSON.parse(e.dataTransfer.getData('text/liquid-paths') || '[]');
    const copy = e.ctrlKey || e.altKey;
    for (const p of paths) {
      if (p === dir || dirname(p) === dir || dir.startsWith(p + '/')) continue;
      try { copy ? await api.fs.copy(p, dir) : await api.fs.move(p, dir); } catch (err) { shell.notify({ app: 'files', title: copy ? 'Copy failed' : 'Move failed', body: err.message }); }
    }
    bus.emit('fs-changed');
  }
  async newFolder() {
    if (this.virtual || this.searchQ) return;
    const p = await api.fs.mkdir(this.path, 'untitled folder').catch((e) => shell.notify({ app: 'files', title: 'Can’t create folder', body: e.message }));
    if (!p) return;
    await this.refresh(true);
    this.sel = new Set([p]); this.paintSel();
    this.renameInline(p);
    bus.emit('fs-changed');
  }
  async newFile() {
    if (this.virtual || this.searchQ) return;
    const p = await api.fs.newFile(this.path, 'untitled.txt').catch((e) => shell.notify({ app: 'files', title: 'Can’t create file', body: e.message }));
    if (!p) return;
    await this.refresh(true);
    this.sel = new Set([p]); this.paintSel(); this.renameInline(p);
  }
  renameInline(path) {
    const el = $(`[data-path="${CSS.escape(path)}"] .nm`, this.view_) || $(`[data-path="${CSS.escape(path)}"] .cell`, this.view_);
    if (!el) return;
    const old = basename(path);
    const input = h('input.rename-input', { value: old });
    const orig = el.innerHTML;
    if (el.classList.contains('cell')) { el.lastChild.remove(); el.append(input); input.style.textAlign = 'left'; } else { el.innerHTML = ''; el.append(input); }
    input.focus();
    const dot = old.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : old.length);
    let done = false;
    const commit = async (save) => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (save && v && v !== old) {
        try { const np = await api.fs.rename(path, v); this.sel = new Set([np]); } catch (e) { shell.notify({ app: 'files', title: 'Can’t rename', body: e.message }); }
      }
      el.innerHTML = orig;
      this.refresh(true); bus.emit('fs-changed');
      this.view_.focus();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') commit(true); if (e.key === 'Escape') commit(false); });
    input.addEventListener('blur', () => commit(true));
    input.addEventListener('mousedown', (e) => e.stopPropagation());
  }
  async trashSel() {
    const sel = this.selected();
    if (!sel.length) return;
    if (this.isTrash) {
      if (!(await confirmDialog(`Delete ${sel.length} item${sel.length > 1 ? 's' : ''} immediately?`, 'You can’t undo this action.', 'Delete', { danger: true }, this.win.el))) return;
    }
    for (const f of sel) { try { this.isTrash ? await api.fs.remove(f.path) : await api.fs.trash(f.path); } catch (e) { shell.notify({ app: 'files', title: 'Can’t move to Trash', body: e.message }); } }
    bus.emit('fs-changed');
  }
  compressSel(sel = this.selected()) {
    if (!sel.length) return;
    wm.open('archive', { compress: sel.map((x) => x.path) });
  }
  copySel(op) { clipboard = { op, paths: this.selected().map((f) => f.path) }; api.clip.write(clipboard.paths.join('\n')); this.renderItems(); }
  async paste() {
    if (!clipboard || this.virtual || this.searchQ) return;
    for (const p of clipboard.paths) {
      try { clipboard.op === 'cut' ? await api.fs.move(p, this.path) : await api.fs.copy(p, this.path); } catch (e) { shell.notify({ app: 'files', title: 'Paste failed', body: e.message }); }
    }
    if (clipboard.op === 'cut') clipboard = null;
    bus.emit('fs-changed');
  }
  async info(f = this.selected()[0]) {
    f = f || { path: this.path, name: basename(this.path), isDir: true };
    const st = await api.fs.stat(f.path).catch(() => null);
    const icon = f.isDir ? folderIcon(f.name) : docIcon(f.ext);
    const { alertDialog } = await import('../menus.js');
    const tags = tagDb.files[f.path] || [];
    alertDialog({ icon, title: f.name, message: `${f.isDir ? 'Folder' : (f.ext || '').toUpperCase() + ' file'}${st && !st.isDir ? ' · ' + fmtSize(st.size) : ''}\nModified ${st ? fmtDate(st.mtime) : '—'}${tags.length ? '\nTags: ' + tags.join(', ') : ''}\n${f.path}` }, this.win.el);
  }
  quickLook() {
    const f = this.selected()[0];
    if (!f) return;
    $('.quicklook')?.remove();
    const body = h('div.ql-body');
    const ql = h('div.quicklook.glass.panel', h('div.ql-head', h('span.spacer.ellipsis', f.name), h('button.btn', { onclick: () => { ql.remove(); this.openItem(f); } }, 'Open'), h('button.tb-btn', { html: sym.close, onclick: () => ql.remove() })), body);
    if (f.isDir) body.innerHTML = `<div style="width:160px">${folderIcon(f.name)}</div>`;
    else if (IMAGE_EXT.has(f.ext)) body.append(h('img', { src: fileUrl(f.path) }));
    else if (VIDEO_EXT.has(f.ext)) body.append(playableMedia(f.path, { className: 'ql-media' }).el);
    else if (AUDIO_EXT.has(f.ext)) body.append(h('audio', { src: fileUrl(f.path), controls: true, autoplay: true }));
    else if (TEXT_EXT.has(f.ext)) { const pre = h('pre', 'Loading…'); body.append(pre); api.fs.read(f.path).then((t) => (pre.textContent = t.slice(0, 200000))).catch((e) => (pre.textContent = e.message)); }
    else body.innerHTML = `<div style="width:160px">${docIcon(f.ext)}</div>`;
    document.body.append(ql);
    const close = (e) => { if (e.type === 'keydown' && e.key !== ' ' && e.key !== 'Escape') return; e.preventDefault(); ql.remove(); removeEventListener('keydown', close, true); };
    setTimeout(() => addEventListener('keydown', close, true));
  }

  onKey(e) {
    const cmd = e.ctrlKey || e.metaKey;
    const sel = this.selected();
    if (e.key === 'Enter' && sel.length === 1) { e.preventDefault(); this.openItem(sel[0]); }
    else if (e.key === 'F2' && sel.length === 1) { e.preventDefault(); this.renameInline(sel[0].path); }
    else if (e.key === 'Delete' || (cmd && e.key === 'Backspace')) { e.preventDefault(); this.trashSel(); }
    else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) { e.preventDefault(); this.up(); }
    else if (e.key === ' ') { e.preventDefault(); this.quickLook(); }
    else if (cmd && e.key === 'a') { e.preventDefault(); this.sel = new Set(this.visible().map((f) => f.path)); this.paintSel(); }
    else if (cmd && e.key === 'c') { e.preventDefault(); this.copySel('copy'); }
    else if (cmd && e.key === 'x') { e.preventDefault(); this.copySel('cut'); }
    else if (cmd && e.key === 'v') { e.preventDefault(); this.paste(); }
    else if (cmd && e.shiftKey && (e.key === 'N' || e.key === 'n')) { e.preventDefault(); this.newFolder(); }
    else if (cmd && e.key === 'h') { e.preventDefault(); this.toggleHidden(); }
    else if (cmd && e.key === 'f') { e.preventDefault(); this.search.focus(); }
    else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const list = this.visible();
      if (!list.length) return;
      let i = list.findIndex((f) => f.path === this.lastSel);
      const cols = this.view === 'icons' ? Math.max(1, Math.floor((this.view_.clientWidth - 28) / 102)) : 1;
      const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
      i = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + d));
      this.sel = new Set([list[i].path]); this.lastSel = list[i].path; this.paintSel();
      $(`[data-path="${CSS.escape(list[i].path)}"]`, this.view_)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key.length === 1 && !cmd && !e.altKey) {
      // type-to-select
      this.typed = (Date.now() - (this.typedAt || 0) < 800 ? this.typed : '') + e.key.toLowerCase();
      this.typedAt = Date.now();
      const f = this.visible().find((x) => x.name.toLowerCase().startsWith(this.typed));
      if (f) { this.sel = new Set([f.path]); this.lastSel = f.path; this.paintSel(); $(`[data-path="${CSS.escape(f.path)}"]`, this.view_)?.scrollIntoView({ block: 'nearest' }); }
    }
  }

  setView(v) { this.view = v; store.set('filesView', v); this.renderItems(); this.renderChrome(); }
  setSort(s) { this.sort = s; this.renderItems(); }
  // a name as shown: without its extension when View › Show File Extensions is off
  displayName(f) {
    const ext = !f.isDir && f.ext && f.name.length > f.ext.length + 1 ? f.name.slice(-(f.ext.length + 1)) : '';
    return ext && !this.showExt ? f.name.slice(0, -ext.length) : f.name;
  }
  // Icon view has room for two lines of name. A longer name keeps its first line and the END of the name on the
  // second (shortened in the middle, like macOS), so the extension — "….mp4" — is always visible.
  fitNames(grid) {
    const first = grid.querySelector('.nm');
    if (!first) return;
    const cs = getComputedStyle(first);
    const width = first.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
    if (width <= 20) return;
    const ctx = (FilesView.measure ||= document.createElement('canvas').getContext('2d'));
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;   // (cs.font can be empty)
    const w = (t) => ctx.measureText(t).width;
    if (grid.dataset.fitWidth === String(width)) return;
    grid.dataset.fitWidth = width;
    for (const el of grid.querySelectorAll('.nm')) {
      const text = (el.dataset.full ??= el.textContent);
      if (el.textContent !== text) el.textContent = text;
      if (w(text) <= width) continue;
      // line 1: as many words as fit (or characters, for one long word)
      let cut = 0;
      for (let i = 1; i <= text.length; i++) { if (w(text.slice(0, i)) > width) break; cut = i; }
      const sp = text.lastIndexOf(' ', cut);
      if (sp > 0 && cut < text.length) cut = sp + 1;
      const line1 = text.slice(0, cut), rest = text.slice(cut);
      if (w(rest) <= width) continue;   // fits on two lines as it is
      // line 2: the end of the name, with the middle taken out
      const dot = rest.lastIndexOf('.');
      const keep = Math.max(dot >= 0 ? rest.length - dot + 6 : 6, 6);
      let head = rest.length - keep;
      while (head > 0 && w(rest.slice(0, head) + '…' + rest.slice(-keep)) > width) head--;
      let tail = rest.slice(-keep);
      while (head === 0 && tail.length > 1 && w('…' + tail) > width) tail = tail.slice(1);
      el.textContent = '';
      el.append(h('div', line1.trimEnd()), h('div', rest.slice(0, head) + '…' + tail));
    }
  }
  toggleHidden() { this.showHidden = !this.showHidden; this.renderItems(); }

  itemMenu(e, f) {
    const sel = this.selected();
    const many = sel.length > 1;
    contextMenu(e, [
      { label: 'Open', action: () => sel.forEach((x) => this.openItem(x)) },
      !f.isDir ? { label: 'Open With', submenu: [
        { label: 'Text Editor', action: () => wm.open('texteditor', { path: f.path }) },
        { label: 'Preview', action: () => wm.open('preview', { path: f.path }) },
        { label: 'Browser', action: () => wm.open('browser', { url: 'file://' + f.path }) },
        { label: 'System Default App', action: () => api.fs.open(f.path) }] } : { label: 'Open in New Window', action: () => wm.open('files', { path: f.path }) },
      f.isDir ? { label: 'Open in New Tab', action: () => this.newTab(f.path, true) } : null,
      f.isDir ? { label: 'Open in Terminal', action: () => wm.open('terminal', { cwd: f.path }) } : null,
      this.searchQ || this.virtual ? { label: 'Show in Enclosing Folder', action: () => this.go(dirname(f.path), { select: f.path }) } : null,
      '-',
      { label: this.isTrash ? 'Delete Immediately' : 'Move to Trash', danger: this.isTrash, action: () => this.trashSel() }, '-',
      { label: 'Get Info', action: () => this.info(f) },
      { label: 'Rename', disabled: many, action: () => this.renameInline(f.path) },
      { label: 'Quick Look', action: () => this.quickLook() },
      !f.isDir && isArchive(f.path) && !many ? { label: 'Expand', action: () => wm.open('archive', { path: f.path }) } : null,
      { label: many ? `Compress ${sel.length} Items` : `Compress “${f.name}”`, action: () => this.compressSel(sel) },
      // Share: to your phone (KDE Connect), when one is paired
      sendToPhoneItem(sel.map((x) => x.path), (p) => sel.find((x) => x.path === p)?.isDir, shell.notify), '-',
      { label: 'Copy', action: () => this.copySel('copy') }, { label: 'Cut', action: () => this.copySel('cut') },
      { label: 'Copy Path', action: () => api.clip.write(sel.map((x) => x.path).join('\n')) }, '-',
      { label: 'Duplicate', action: async () => { for (const x of sel) await api.fs.copy(x.path, dirname(x.path)).catch(() => {}); bus.emit('fs-changed'); } }, '-',
      // tags: a row of colored dots, like Finder's (click one to put the tag on, or take it off)
      { grid: tagDb.tags.slice(0, 8).map((t) => { const on = sel.every((x) => (tagDb.files[x.path] || []).includes(t.name)); return { title: (on ? 'Remove ' : 'Add ') + t.name, icon: `<span class="mt-dot${on ? ' on' : ''}" style="--c:${t.color}"></span>`, action: () => api.tags.toggle(sel.map((x) => x.path), t.name, !on) }; }) },
      { label: 'Tags', submenu: [...tagDb.tags.map((t) => ({ label: t.name, icon: `<span style="display:block;width:10px;height:10px;border-radius:50%;background:${t.color}"></span>`, checked: sel.every((x) => (tagDb.files[x.path] || []).includes(t.name)), action: () => api.tags.toggle(sel.map((x) => x.path), t.name, !sel.every((x) => (tagDb.files[x.path] || []).includes(t.name))) })), '-', { label: 'New Tag…', action: () => this.newTag(sel.map((x) => x.path)) }] },
    ].filter(Boolean));
  }
  bgMenu(e) {
    if (this.virtual || this.searchQ) return contextMenu(e, [{ label: 'View as Icons', checked: this.view === 'icons', action: () => this.setView('icons') }, { label: 'View as List', checked: this.view === 'list', action: () => this.setView('list') }]);
    contextMenu(e, [
      { label: 'New Folder', action: () => this.newFolder() },
      { label: 'New Text File', action: () => this.newFile() }, '-',
      { label: 'Paste', disabled: !clipboard, action: () => this.paste() }, '-',
      { label: 'Open in Terminal', action: () => wm.open('terminal', { cwd: this.path }) },
      { label: 'Get Info', action: () => this.info({ path: this.path, name: basename(this.path), isDir: true }) }, '-',
      { label: 'View as Icons', checked: this.view === 'icons', action: () => this.setView('icons') },
      { label: 'View as List', checked: this.view === 'list', action: () => this.setView('list') },
      { label: 'Show Hidden Files', checked: this.showHidden, action: () => this.toggleHidden() },
      { label: 'Show File Extensions', checked: this.showExt, action: () => store.set('filesShowExt', !this.showExt) },
      { label: 'Sort By', submenu: [['Name', 'name'], ['Date Modified', 'mtime'], ['Size', 'size'], ['Kind', 'ext']].map(([l, k]) => ({ label: l, checked: this.sort === k, action: () => this.setSort(k) })) },
    ]);
  }
  moreMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    showMenu([
      { label: 'New Folder', action: () => this.newFolder() }, { label: 'New Text File', action: () => this.newFile() }, '-',
      { label: 'Show Hidden Files', checked: this.showHidden, action: () => this.toggleHidden() },
      { label: 'Go to Folder…', action: () => this.goTo() },
      { label: 'New Tab', action: () => this.newTab() },
      { label: 'New Smart Folder', action: () => this.newSmart() },
      { label: 'Copy Current Path', disabled: !!this.virtual, action: () => api.clip.write(this.path) },
    ], r.left, r.bottom + 6);
  }
}
