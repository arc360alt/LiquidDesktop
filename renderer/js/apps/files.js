// Files — a Finder-style file manager for the real filesystem.
import { h, $, $$, bus, basename, dirname, fmtSize, fmtDate, fileUrl, isCmd } from '../util.js';
import { sym, folderIcon, docIcon, IMAGE_EXT, TEXT_EXT, appIconSVG } from '../icons.js';
import { registerApp, wm } from '../wm.js';
import { api } from '../sys.js';
import { contextMenu, prompt, confirmDialog, showMenu } from '../menus.js';
import { shell } from '../shell.js';
import { store } from '../store.js';

let clipboard = null; // { op: 'copy'|'cut', paths }

registerApp({
  id: 'files', name: 'Files', size: [920, 560], minSize: [520, 320], overlayContent: true, hideTitle: true,
  keywords: ['finder', 'file manager', 'folders'],
  about: 'Browse and manage the files on this computer.',
  menus: (win) => [
    { title: 'File', items: [
      { label: 'New Window', shortcut: '⌘N', action: () => wm.open('files', { path: win?.state?.path }) },
      { label: 'New Folder', shortcut: '⇧⌘N', action: () => win?.state?.newFolder() },
      { label: 'New Text File', action: () => win?.state?.newFile() }, '-',
      { label: 'Open in Terminal', action: () => wm.open('terminal', { cwd: win?.state?.path }) },
      { label: 'Get Info', action: () => win?.state?.info() }, '-',
      { label: 'Move to Trash', action: () => win?.state?.trashSel() },
      { label: 'Close Window', shortcut: '⌘W', action: () => win?.close() }] },
    { title: 'View', items: [
      { label: 'as Icons', checked: win?.state?.view === 'icons', action: () => win?.state?.setView('icons') },
      { label: 'as List', checked: win?.state?.view === 'list', action: () => win?.state?.setView('list') }, '-',
      { label: 'Show Hidden Files', checked: !!win?.state?.showHidden, shortcut: '⇧⌘.', action: () => win?.state?.toggleHidden() },
      { label: 'Sort by Name', action: () => win?.state?.setSort('name') }, { label: 'Sort by Date Modified', action: () => win?.state?.setSort('mtime') },
      { label: 'Sort by Size', action: () => win?.state?.setSort('size') }, { label: 'Sort by Kind', action: () => win?.state?.setSort('ext') }] },
    { title: 'Go', items: [
      { label: 'Back', shortcut: '⌘[', action: () => win?.state?.back() }, { label: 'Forward', shortcut: '⌘]', action: () => win?.state?.forward() },
      { label: 'Enclosing Folder', shortcut: '⌘↑', action: () => win?.state?.up() }, '-',
      ...['home', 'desktop', 'documents', 'downloads', 'pictures'].map((k) => ({ label: k[0].toUpperCase() + k.slice(1), action: () => win?.state?.goPlace(k) })),
      { label: 'Computer', action: () => win?.state?.go('/') }, '-',
      { label: 'Go to Folder…', shortcut: '⇧⌘G', action: () => win?.state?.goTo() }] },
  ],
  open(win, args) { new FilesView(win, args); },
});

class FilesView {
  constructor(win, args) {
    this.win = win; win.state = this;
    this.view = store.get('filesView') || 'icons';
    this.showHidden = false;
    this.sort = 'name';
    this.history = []; this.fwd = [];
    this.sel = new Set();
    this.items = [];
    this.filter = '';
    this.build();
    win.on('reopen', (a) => a?.path && this.go(a.path));
    api.fs.places().then((p) => {
      this.places = p;
      this.renderSidebar();
      this.go(args.path || p.home, { select: args.select });
    });
    const off = bus.on('fs-changed', () => this.refresh());
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
      if (e.key === 'Enter' && this.search.value.trim().length > 1) {
        const res = await api.fs.search(this.search.value.trim(), this.path, 200);
        this.searchResults = res; this.renderItems();
      }
      if (e.key === 'Escape') { this.search.value = ''; this.filter = ''; this.searchResults = null; this.renderItems(); this.view_.focus(); }
    });
    w.toolbar.style.marginLeft = '150px';
    w.toolbar.append(
      h('div.tb-group', this.backBtn, this.fwdBtn), this.titleEl, h('div.spacer'),
      h('div.tb-group', this.viewBtns.icons, this.viewBtns.list),
      h('div.tb-group', h('button.tb-btn', { html: sym.folderPlus, title: 'New Folder', onclick: () => this.newFolder() }),
        h('button.tb-btn', { html: sym.share, title: 'Open in Terminal', onclick: () => wm.open('terminal', { cwd: this.path }) }),
        h('button.tb-btn', { html: sym.ellipsis, title: 'More', onclick: (e) => this.moreMenu(e.currentTarget) })),
      h('div.search-field', { html: sym.search }, this.search));
    this.view_ = h('div.files-view', { tabindex: 0 });
    this.pathbar = h('div.pathbar');
    this.main = h('div.main-pane', this.view_, this.pathbar);
    w.body.append(this.sidebar, this.main);
    this.view_.addEventListener('mousedown', (e) => { if (e.target === this.view_ || e.target.classList.contains('files-grid')) { this.sel.clear(); this.paintSel(); } });
    this.view_.addEventListener('contextmenu', (e) => { if (!e.target.closest('.f-item, tr')) this.bgMenu(e); });
    this.view_.addEventListener('keydown', (e) => this.onKey(e));
    this.view_.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/liquid-paths')) e.preventDefault(); });
    this.view_.addEventListener('drop', (e) => { if (!e.target.closest('.f-item, tr')) this.dropOn(e, this.path); });
  }

  /* ---------------------------------------------- navigation */
  async go(path, { push = true, select } = {}) {
    try { await api.fs.list(path); } catch (e) { shell.notify({ app: 'files', title: 'Can’t open folder', body: e.message }); return; }
    if (push && this.path && this.path !== path) { this.history.push(this.path); this.fwd = []; }
    this.path = path;
    this.sel.clear();
    this.search.value = ''; this.filter = ''; this.searchResults = null;
    if (select) this.sel.add(select);
    await this.refresh(true);
    this.view_.focus();
  }
  back() { if (!this.history.length) return; this.fwd.push(this.path); this.go(this.history.pop(), { push: false }); }
  forward() { if (!this.fwd.length) return; this.history.push(this.path); this.go(this.fwd.pop(), { push: false }); }
  up() { if (this.path !== '/') this.go(dirname(this.path), { select: this.path }); }
  goPlace(k) { if (this.places) this.go(this.places[k]); }
  async goTo() { const p = await prompt('Go to the folder:', this.path, {}, this.win.el); if (p) this.go(p.replace(/^~/, this.places.home)); }
  get isTrash() { return this.places && this.path === this.places.trash; }

  async refresh(force) {
    if (!this.path) return;
    let items;
    try { items = await api.fs.list(this.path); } catch { return; }
    const sig = items.map((i) => i.name + i.mtime + i.size).join('|');
    if (!force && sig === this.sig) return;
    this.sig = sig;
    this.items = items;
    this.renderItems();
    this.renderChrome();
  }

  renderChrome() {
    const name = this.isTrash ? 'Trash' : this.path === this.places?.home ? 'Home' : basename(this.path);
    this.titleEl.textContent = name;
    this.win.setTitle(name);
    this.backBtn.disabled = !this.history.length; this.fwdBtn.disabled = !this.fwd.length;
    for (const [k, b] of Object.entries(this.viewBtns)) b.classList.toggle('on', k === this.view);
    $$('.sb-item', this.sidebar).forEach((el) => el.classList.toggle('sel', el.dataset.path === this.path));
    // path bar
    this.pathbar.innerHTML = '';
    const parts = this.path.split('/').filter(Boolean);
    const crumbs = [['/', 'Computer']];
    parts.forEach((p, i) => crumbs.push(['/' + parts.slice(0, i + 1).join('/'), p]));
    crumbs.forEach(([p, n], i) => {
      if (i) this.pathbar.append(h('span.chev', '›'));
      const c = h('span', { html: (i === crumbs.length - 1 ? '' : '') + `<span style="width:14px;height:14px;display:inline-flex">${p === '/' ? sym.drive : folderIcon(n)}</span>` }, n);
      c.addEventListener('click', () => this.go(p));
      c.addEventListener('dragover', (e) => e.preventDefault());
      c.addEventListener('drop', (e) => this.dropOn(e, p));
      this.pathbar.append(c);
    });
    this.status = h('span.status');
    this.pathbar.append(this.status);
    this.updateStatus();
  }
  updateStatus() {
    if (!this.status) return;
    const n = this.visible().length;
    this.status.textContent = (this.sel.size ? `${this.sel.size} of ` : '') + `${n} item${n === 1 ? '' : 's'}`;
  }

  renderSidebar() {
    const p = this.places;
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
      item(sym.drive, 'Computer', '/'), item(sym.trash, 'Trash', p.trash),
      h('div.sb-sec', 'Tags'),
      ...[['Red', '#ff3b30'], ['Orange', '#ff9500'], ['Green', '#34c759'], ['Blue', '#0a84ff'], ['Purple', '#af52de']].map(([n, c]) =>
        h('div.sb-item', { style: { opacity: 0.85 } }, h('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: c, margin: '0 3px' } }), n)));
  }

  /* ---------------------------------------------- items */
  visible() {
    if (this.searchResults) return this.searchResults;
    let list = this.items.filter((i) => this.showHidden || !i.hidden);
    if (this.filter) list = list.filter((i) => i.name.toLowerCase().includes(this.filter));
    const s = this.sort;
    list.sort((a, b) => (b.isDir - a.isDir) || (s === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : s === 'mtime' ? b.mtime - a.mtime : s === 'size' ? b.size - a.size : (a.ext || '').localeCompare(b.ext || '') || a.name.localeCompare(b.name)));
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
      this.view_.append(h('div.empty-state', { style: { height: '100%' } }, this.isTrash ? 'Trash is Empty' : this.filter || this.searchResults ? 'No Results' : 'This folder is empty'));
      this.updateStatus();
      return;
    }
    if (this.isTrash) this.view_.append(h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 6px 10px' } }, h('b', 'Trash'), h('button.btn', { onclick: () => shell.emptyTrash() }, 'Empty')));
    if (this.view === 'icons') {
      const grid = h('div.files-grid');
      for (const f of list) {
        const el = h('div.f-item' + (f.hidden ? '.hidden-file' : ''), { draggable: true }, this.iconFor(f), h('div.nm', f.name));
        this.bindItem(el, f);
        grid.append(el);
      }
      this.view_.append(grid);
    } else {
      const tb = h('tbody');
      const th = (label, key) => h('th', { onclick: () => this.setSort(key), style: { cursor: 'default' } }, label + (this.sort === key ? ' ▾' : ''));
      const table = h('table.files-list', h('thead', h('tr', th('Name', 'name'), th('Date Modified', 'mtime'), th('Size', 'size'), th('Kind', 'ext'))), tb);
      for (const f of list) {
        const tr = h('tr', { draggable: true }, h('td', h('div.cell', this.iconFor(f, 18), f.name)), h('td.muted', fmtDate(f.mtime)), h('td.muted', f.isDir ? '--' : fmtSize(f.size)), h('td.muted', f.isDir ? 'Folder' : (f.ext ? f.ext.toUpperCase() + ' file' : 'Document')));
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
    if (f.isDir) return this.go(f.path);
    shell.openPath(f.path, false);
  }

  /* ---------------------------------------------- operations */
  async dropOn(e, dir) {
    e.preventDefault();
    const paths = JSON.parse(e.dataTransfer.getData('text/liquid-paths') || '[]');
    const copy = e.ctrlKey || e.altKey;
    for (const p of paths) {
      if (p === dir || dirname(p) === dir || dir.startsWith(p + '/')) continue;
      try { copy ? await api.fs.copy(p, dir) : await api.fs.move(p, dir); } catch (err) { shell.notify({ app: 'files', title: copy ? 'Copy failed' : 'Move failed', body: err.message }); }
    }
    bus.emit('fs-changed');
  }
  async newFolder() {
    const p = await api.fs.mkdir(this.path, 'untitled folder').catch((e) => shell.notify({ app: 'files', title: 'Can’t create folder', body: e.message }));
    if (!p) return;
    await this.refresh(true);
    this.sel = new Set([p]); this.paintSel();
    this.renameInline(p);
    bus.emit('fs-changed');
  }
  async newFile() {
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
  copySel(op) { clipboard = { op, paths: this.selected().map((f) => f.path) }; api.clip.write(clipboard.paths.join('\n')); this.renderItems(); }
  async paste() {
    if (!clipboard) return;
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
    alertDialog({ icon, title: f.name, message: `${f.isDir ? 'Folder' : (f.ext || '').toUpperCase() + ' file'}${st && !st.isDir ? ' · ' + fmtSize(st.size) : ''}\nModified ${st ? fmtDate(st.mtime) : '—'}\n${f.path}` }, this.win.el);
  }
  quickLook() {
    const f = this.selected()[0];
    if (!f) return;
    $('.quicklook')?.remove();
    const body = h('div.ql-body');
    const ql = h('div.quicklook.glass.panel', h('div.ql-head', h('span.spacer.ellipsis', f.name), h('button.btn', { onclick: () => { ql.remove(); this.openItem(f); } }, 'Open'), h('button.tb-btn', { html: sym.close, onclick: () => ql.remove() })), body);
    if (f.isDir) body.innerHTML = `<div style="width:160px">${folderIcon(f.name)}</div>`;
    else if (IMAGE_EXT.has(f.ext)) body.append(h('img', { src: fileUrl(f.path) }));
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
      f.isDir ? { label: 'Open in Terminal', action: () => wm.open('terminal', { cwd: f.path }) } : null,
      '-',
      { label: this.isTrash ? 'Delete Immediately' : 'Move to Trash', danger: this.isTrash, action: () => this.trashSel() }, '-',
      { label: 'Get Info', action: () => this.info(f) },
      { label: 'Rename', disabled: many, action: () => this.renameInline(f.path) },
      { label: 'Quick Look', action: () => this.quickLook() }, '-',
      { label: 'Copy', action: () => this.copySel('copy') }, { label: 'Cut', action: () => this.copySel('cut') },
      { label: 'Copy Path', action: () => api.clip.write(sel.map((x) => x.path).join('\n')) }, '-',
      { label: 'Duplicate', action: async () => { for (const x of sel) await api.fs.copy(x.path, this.path).catch(() => {}); bus.emit('fs-changed'); } },
      { label: 'Make Alias on Desktop', disabled: true },
    ].filter(Boolean));
  }
  bgMenu(e) {
    contextMenu(e, [
      { label: 'New Folder', action: () => this.newFolder() },
      { label: 'New Text File', action: () => this.newFile() }, '-',
      { label: 'Paste', disabled: !clipboard, action: () => this.paste() }, '-',
      { label: 'Open in Terminal', action: () => wm.open('terminal', { cwd: this.path }) },
      { label: 'Get Info', action: () => this.info({ path: this.path, name: basename(this.path), isDir: true }) }, '-',
      { label: 'View as Icons', checked: this.view === 'icons', action: () => this.setView('icons') },
      { label: 'View as List', checked: this.view === 'list', action: () => this.setView('list') },
      { label: 'Show Hidden Files', checked: this.showHidden, action: () => this.toggleHidden() },
      { label: 'Sort By', submenu: [['Name', 'name'], ['Date Modified', 'mtime'], ['Size', 'size'], ['Kind', 'ext']].map(([l, k]) => ({ label: l, checked: this.sort === k, action: () => this.setSort(k) })) },
    ]);
  }
  moreMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    showMenu([
      { label: 'New Folder', action: () => this.newFolder() }, { label: 'New Text File', action: () => this.newFile() }, '-',
      { label: 'Show Hidden Files', checked: this.showHidden, action: () => this.toggleHidden() },
      { label: 'Go to Folder…', action: () => this.goTo() },
      { label: 'Copy Current Path', action: () => api.clip.write(this.path) },
    ], r.left, r.bottom + 6);
  }
}
