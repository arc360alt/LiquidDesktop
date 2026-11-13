// The Open / Save dialog that every app in the session gets (through the desktop portal, see main/portal.js):
// a compact, macOS Tahoe-style file browser with Favorites, a path bar, filters, "Save As" and New Folder.
import { h, $$, fmtSize, fmtDate } from '../util.js';
import { registerApp } from '../wm.js';
import { sym, folderIcon, docIcon } from '../icons.js';
import { api } from '../sys.js';
import { confirmDialog, prompt } from '../menus.js';

const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\[!/g, '[^') + '$', 'i');
// a few common MIME types, for filters that only give those
const MIME_EXT = { 'image/': /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?)$/i, 'video/': /\.(mp4|mkv|webm|mov|avi|m4v)$/i, 'audio/': /\.(mp3|flac|ogg|wav|m4a|opus|aac)$/i,
  'text/': /\.(txt|md|csv|log|json|xml|html?|css|js|ts|py|sh|c|h|cpp|rs|go|java|toml|ya?ml|ini|conf)$/i, 'application/pdf': /\.pdf$/i, 'application/zip': /\.zip$/i };

registerApp({
  id: 'filepicker', name: 'Open', hidden: true, size: [780, 500], minSize: [560, 360], overlayContent: true, hideTitle: true, className: 'picker-win',
  open(win, args = {}) {
    const saving = args.kind === 'save', dirMode = !!args.directory;
    let cwd = '', sel = new Set(), filterIdx = 0, back = [], fwd = [], done = false, items = [], places = null;
    const filters = (args.filters || []).length ? args.filters : [];
    if (args.currentFilter) { const i = filters.findIndex((f) => f.name === args.currentFilter); if (i >= 0) filterIdx = i; }

    const finish = (paths) => {
      if (done) return;
      done = true;
      api.picker?.done(args.req, paths ? { paths, filter: filters[filterIdx] || null } : null).catch(() => {});
      win.close();
    };
    win.on('close', () => { if (!done) { done = true; api.picker?.done(args.req, null).catch(() => {}); } });

    /* ---- layout */
    const side = h('div.sidebar.pk-side');
    const list = h('div.pk-list');
    const pathbar = h('div.pk-path');
    const nameField = h('input.field', { value: args.name || '', placeholder: 'Name', spellcheck: false });
    const filterSel = filters.length > 1 ? h('select.field.square', { onchange: (e) => { filterIdx = +e.target.value; draw(); } }, ...filters.map((f, i) => h('option', { value: i, selected: i === filterIdx }, f.name))) : null;
    const okBtn = h('button.btn.primary', { onclick: () => accept() }, args.accept || (saving ? 'Save' : dirMode ? 'Choose' : 'Open'));
    const foot = h('div.pk-foot',
      saving ? h('div.pk-saveas', h('span', 'Save As:'), nameField) : h('div.pk-hint', dirMode ? 'Choose a folder' : args.multiple ? 'Select one or more files' : ''),
      ...[h('div.spacer'), filterSel, h('button.btn', { onclick: () => finish(null) }, 'Cancel'), okBtn].filter(Boolean));
    const main = h('div.pk-main', h('div.pk-head', h('div.pk-title', args.title || 'Open'), pathbar), list, foot);
    win.body.append(h('div.pk', side, main));
    win.dragRegion(side);
    win.toolbar.append(...[
      h('div.tb-group', h('button.tb-btn', { html: sym.back, title: 'Back', onclick: () => back.length && go(back.pop(), 'back') }), h('button.tb-btn', { html: sym.forward, title: 'Forward', onclick: () => fwd.length && go(fwd.pop(), 'fwd') })),
      h('div.spacer'),
      (saving || dirMode) ? h('div.tb-group', h('button.tb-btn', { html: sym.folderPlus, title: 'New Folder', onclick: newFolder })) : null].filter(Boolean));

    /* ---- sidebar */
    async function drawSide() {
      places = await api.fs.places().catch(() => null);
      if (!places) return;
      const item = (label, icon, p) => h('div.sb-item', { 'data-path': p, onclick: () => go(p) }, h('span', { html: icon }), label);
      side.innerHTML = '';
      side.append(h('div.sb-sec', 'Favorites'),
        item('Home', sym.home, places.home), item('Desktop', sym.desktop, places.desktop), item('Documents', sym.doc, places.documents),
        item('Downloads', sym.download, places.downloads), item('Pictures', sym.photo, places.pictures), item('Music', sym.music, places.music), item('Videos', sym.video, places.videos),
        h('div.sb-sec', 'Locations'), item('Computer', sym.drive, '/'));
      // external drives (USB sticks…): opened (mounted) when clicked
      const drives = await api.drives?.list().catch(() => []) || [];
      for (const d of drives) {
        side.append(h('div.sb-item', { 'data-path': d.mounted || '', onclick: async () => {
          const where = d.mounted || await api.drives.mount(d.device).catch(() => null);
          if (where) { go(where); if (!d.mounted) drawSide(); }
        } }, h('span', { html: sym.drive }), d.name));
      }
      markSide();
    }
    const markSide = () => $$('.sb-item', side).forEach((el) => el.classList.toggle('sel', el.dataset.path === cwd));

    /* ---- listing */
    const visible = (f) => {
      if (f.hidden) return false;
      if (f.isDir) return true;
      if (dirMode) return true;                     // shown, but can't be chosen
      const flt = filters[filterIdx];
      if (!flt || (!flt.patterns.length && !flt.mimes.length)) return true;
      if (flt.patterns.some((p) => globToRe(p).test(f.name))) return true;
      return flt.mimes.some((m) => m === '*/*' || (MIME_EXT[m] || MIME_EXT[m.replace(/\/.*$/, '/')])?.test(f.name));
    };
    async function go(p, how) {
      try { items = await api.fs.list(p); } catch { return; }
      if (cwd && how !== 'back' && how !== 'fwd') { back.push(cwd); fwd = []; } else if (how === 'back') fwd.push(cwd); else if (how === 'fwd') back.push(cwd);
      cwd = p; sel = new Set();
      draw(); markSide();
    }
    function draw() {
      // path bar: each folder on the way is a button
      pathbar.innerHTML = '';
      const parts = cwd.split('/').filter(Boolean);
      pathbar.append(h('button', { onclick: () => go('/') }, h('span', { html: sym.drive }), '/'));
      parts.forEach((p, i) => pathbar.append(h('i', { html: sym.chevronRight }), h('button', { onclick: () => go('/' + parts.slice(0, i + 1).join('/')) }, p)));
      pathbar.scrollLeft = 1e6;
      const shown = items.filter(visible).sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      list.innerHTML = '';
      if (!shown.length) list.append(h('div.pk-empty', 'This folder is empty'));
      for (const f of shown) {
        const choosable = dirMode ? f.isDir : !f.isDir;
        const row = h('div.pk-row' + (choosable || f.isDir ? '' : '.dim') + (sel.has(f.path) ? '.sel' : ''),
          h('div.pk-ic', { html: f.isDir ? folderIcon(f.name) : docIcon(f.ext) }), h('span.pk-name', f.name),
          h('span.pk-date', fmtDate(f.mtime)), h('span.pk-size', f.isDir ? '--' : fmtSize(f.size)));
        row.addEventListener('click', (e) => {
          if (!choosable && !f.isDir) return;
          if (saving && !f.isDir) nameField.value = f.name;
          if (f.isDir && !dirMode) { sel = new Set([f.path]); }
          else if (args.multiple && (e.ctrlKey || e.metaKey)) sel.has(f.path) ? sel.delete(f.path) : sel.add(f.path);
          else sel = new Set([f.path]);
          $$('.pk-row', list).forEach((r, i) => r.classList.toggle('sel', sel.has(shown[i].path)));
          updateOk();
        });
        row.addEventListener('dblclick', () => { if (f.isDir) go(f.path); else if (!saving && choosable) finish([f.path]); });
        list.append(row);
      }
      updateOk();
    }
    function updateOk() {
      if (saving) okBtn.disabled = !nameField.value.trim();
      else if (dirMode) okBtn.disabled = false;                 // the selected folder, or the current one
      else okBtn.disabled = ![...sel].some((p) => !items.find((x) => x.path === p)?.isDir);
    }
    nameField.addEventListener('input', updateOk);
    nameField.addEventListener('keydown', (e) => { if (e.key === 'Enter') accept(); });
    win.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      else if (e.key === 'Enter' && e.target !== nameField) { e.preventDefault(); const one = [...sel][0]; const it = items.find((x) => x.path === one); if (it?.isDir && !dirMode) go(it.path); else accept(); }
      else if (e.key === 'Backspace' && e.target === document.body) go(cwd.replace(/\/[^/]+\/?$/, '') || '/');
    });

    async function accept() {
      if (saving) {
        const name = nameField.value.trim();
        if (!name || name.includes('/')) return;
        const target = (cwd.endsWith('/') ? cwd : cwd + '/') + name;
        if (await api.fs.exists(target).catch(() => false)) {
          if (!(await confirmDialog(`“${name}” already exists. Do you want to replace it?`, 'A file with the same name already exists in this folder. Replacing it will overwrite its current contents.', 'Replace', { danger: true }))) return;
        }
        return finish([target]);
      }
      if (dirMode) { const d = [...sel].find((p) => items.find((x) => x.path === p)?.isDir); return finish([d || cwd]); }
      const files = [...sel].filter((p) => !items.find((x) => x.path === p)?.isDir);
      if (files.length) finish(args.multiple ? files : [files[0]]);
    }
    async function newFolder() {
      const name = await prompt('New Folder', 'untitled folder', { ok: 'Create' }, win.el);
      if (!name) return;
      try { const p = await api.fs.mkdir(cwd, name); await go(cwd); sel = new Set([p]); draw(); } catch { /* not allowed here */ }
    }

    drawSide().then(async () => {
      const start = args.folder || (args.files?.[0] && args.files[0].replace(/\/[^/]+$/, '')) || places?.home || '/';
      await go(start).catch(() => {});
      if (!cwd) await go(places?.home || '/');
      if (saving) { nameField.focus(); const dot = nameField.value.lastIndexOf('.'); nameField.setSelectionRange(0, dot > 0 ? dot : nameField.value.length); }
    });
  },
});
