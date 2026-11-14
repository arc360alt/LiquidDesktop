// Text Editor — plain text and code files on disk.
import { h, basename, dirname } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym } from '../icons.js';
import { api } from '../sys.js';
import { prompt, alertDialog } from '../menus.js';
import { shell } from '../shell.js';
import { bus } from '../util.js';
import { store } from '../store.js';

registerApp({
  id: 'texteditor', settings: 'texteditor', name: 'Text Editor', size: [760, 520], minSize: [360, 240], overlayContent: true,
  keywords: ['textedit', 'editor', 'code', 'txt'],
  about: 'Edit plain text and code.',
  menus: (win) => [{ title: 'File', items: [
    { label: 'New', shortcut: '⌘N', action: () => wm.open('texteditor') },
    { label: 'Open…', shortcut: '⌃O', action: () => win?.state?.openDialog() },
    { label: 'Save', shortcut: '⌃S', action: () => win?.state?.save() },
    { label: 'Save As…', shortcut: '⇧⌃S', action: () => win?.state?.save(true) }, '-',
    { label: 'Show in Files', action: () => win?.state?.path && wm.open('files', { path: dirname(win.state.path), select: win.state.path }) },
    { label: 'Close', shortcut: '⌘W', action: () => win?.close() }] },
    { title: 'Format', items: [{ label: 'Wrap Lines', checked: win?.state?.wrap, action: () => win?.state?.toggleWrap() }] }],
  open(win, args) {
    const ta = h('textarea', { spellcheck: false, wrap: 'off' });
    const pos = h('span'), info = h('span');
    win.body.append(h('div.texted', ta, h('div.status', pos, h('span.spacer'), info)));
    const st = { path: args.path || null, dirty: false, wrap: !!store.get('textWrap') };
    const look = () => { ta.wrap = st.wrap ? 'soft' : 'off'; ta.style.fontSize = (store.get('textFontSize') || 13) + 'px'; ta.style.tabSize = store.get('textTabSize') || 4; };
    look();
    const offS = store.on('change', (k) => { if (k === 'textWrap') st.wrap = !!store.get(k); if (['textWrap', 'textFontSize', 'textTabSize'].includes(k)) look(); });
    win.on('close', offS);
    win.state = st;
    win.toolbar.append(h('div.spacer'), h('div.tb-group',
      h('button.tb-btn', { html: sym.folder, title: 'Open…', onclick: () => st.openDialog() }),
      h('button.tb-btn', { html: '<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M5 4h11l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/></svg>', title: 'Save', onclick: () => st.save() })));
    const title = () => win.setTitle((st.path ? basename(st.path) : 'Untitled') + (st.dirty ? ' — Edited' : ''));
    const upd = () => {
      const v = ta.value, before = v.slice(0, ta.selectionStart).split('\n');
      pos.textContent = `Line ${before.length}, Column ${before[before.length - 1].length + 1}`;
      info.textContent = `${v.split('\n').length} lines · ${v.length} characters`;
    };
    st.toggleWrap = () => { st.wrap = !st.wrap; ta.wrap = st.wrap ? 'soft' : 'off'; };
    st.load = async (p) => {
      try { ta.value = await api.fs.read(p); st.path = p; st.dirty = false; title(); upd(); }
      catch (e) { alertDialog({ title: 'Can’t open file', message: e.message }, win.el); }
    };
    st.save = async (as) => {
      let p = st.path;
      if (!p || as) {
        const home = await api.fs.home();
        p = await prompt('Save As', p || home + '/Documents/Untitled.txt', { ok: 'Save', message: 'Full path of the file' }, win.el);
        if (!p) return false;
      }
      try { await api.fs.write(p, ta.value); st.path = p; st.dirty = false; title(); bus.emit('fs-changed'); return true; }
      catch (e) { alertDialog({ title: 'Can’t save', message: e.message }, win.el); return false; }
    };
    st.openDialog = async () => {
      const home = await api.fs.home();
      const p = await prompt('Open File', st.path ? dirname(st.path) + '/' : home + '/', { ok: 'Open', message: 'Path of the file to open' }, win.el);
      if (p) st.load(p);
    };
    win.beforeClose = async () => {
      if (!st.dirty) return true;
      const r = await alertDialog({ title: `Do you want to keep the changes you made to “${st.path ? basename(st.path) : 'Untitled'}”?`, message: 'Your changes will be lost if you don’t save them.',
        buttons: [{ label: 'Save', value: 'save', primary: true }, { label: 'Don’t Save', value: 'discard' }, { label: 'Cancel', value: 'cancel' }] }, win.el);
      if (r.button === 'save') return st.save();
      return r.button === 'discard';
    };
    ta.addEventListener('input', () => { if (!st.dirty) { st.dirty = true; title(); } upd(); });
    ta.addEventListener('keyup', upd); ta.addEventListener('click', upd);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, ' '.repeat(store.get('textTabSize') || 4)); }
      if (e.ctrlKey && e.key === 's') { e.preventDefault(); st.save(e.shiftKey); }
      if (e.ctrlKey && e.key === 'o') { e.preventDefault(); st.openDialog(); }
    });
    win.on('focus', () => ta.focus());
    if (st.path) st.load(st.path); else { title(); upd(); }
  },
});
