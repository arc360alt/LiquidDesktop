// Notes — rich-text notes with a floating glass sidebar, saved automatically.
import { h, $$, timeAgo, debounce } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym } from '../icons.js';
import { appData } from '../store.js';
import { confirmDialog } from '../menus.js';

const load = () => appData.get('notes', [{ id: 1, html: '<h2>Welcome to Notes</h2><div>Notes save automatically. Use the toolbar for <b>bold</b>, <i>italic</i>, lists and checklists.</div>', t: Date.now() }]);
const save = (notes) => appData.set('notes', notes);
const titleOf = (html) => {
  // block elements become line breaks, so the first line is the title
  const d = document.createElement('div');
  d.innerHTML = html.replace(/<(br|\/(div|p|h\d|li))\b[^>]*>/gi, '\n$&');
  const t = d.textContent.split('\n').map((l) => l.trim()).filter(Boolean);
  return { title: t[0] || 'New Note', preview: t.slice(1).join(' ') || 'No additional text' };
};

registerApp({
  id: 'notes', name: 'Notes', size: [860, 540], minSize: [480, 300], overlayContent: true, hideTitle: true,
  keywords: ['memo', 'text', 'write'],
  about: 'Quick notes that stay with you.',
  menus: (win) => [{ title: 'Format', items: [
    { label: 'Title', action: () => document.execCommand('formatBlock', false, 'h2') }, { label: 'Body', action: () => document.execCommand('formatBlock', false, 'div') }, '-',
    { label: 'Bold', shortcut: '⌃B', action: () => document.execCommand('bold') }, { label: 'Italic', shortcut: '⌃I', action: () => document.execCommand('italic') },
    { label: 'Underline', shortcut: '⌃U', action: () => document.execCommand('underline') }, { label: 'Strikethrough', action: () => document.execCommand('strikeThrough') }, '-',
    { label: 'Bulleted List', action: () => document.execCommand('insertUnorderedList') }, { label: 'Numbered List', action: () => document.execCommand('insertOrderedList') }] }],
  open(win) {
    let notes = load(), cur = notes[0]?.id;
    const list = h('div.sidebar', { style: { width: '250px' } });
    win.dragRegion(list);
    const editor = h('div.note-editor', { contenteditable: 'true', spellcheck: true });
    const search = h('input.field', { placeholder: 'Search', style: { width: '150px', height: '34px' } });
    win.toolbar.style.marginLeft = '180px';
    const fmt = (c, v) => h('button.tb-btn', { onmousedown: (e) => { e.preventDefault(); document.execCommand(c, false, v); persist(); } });
    const bold = fmt('bold'); bold.innerHTML = '<b style="font-size:15px">B</b>';
    const ital = fmt('italic'); ital.innerHTML = '<i style="font-size:15px;font-family:serif">I</i>';
    const head = fmt('formatBlock', 'h2'); head.innerHTML = '<span style="font-size:14px;font-weight:600">Aa</span>';
    const ul = fmt('insertUnorderedList'); ul.innerHTML = sym.list;
    const check = h('button.tb-btn', { html: '<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M8 12.3l2.7 2.7L16 9.5" stroke-linecap="round" stroke-linejoin="round"/></svg>', onmousedown: (e) => { e.preventDefault(); document.execCommand('insertHTML', false, '<div><input type="checkbox"> </div>'); persist(); } });
    win.toolbar.append(h('div.tb-group', h('button.tb-btn', { html: sym.trash, title: 'Delete', onclick: () => del() })), h('div.spacer'),
      h('div.tb-group', head, bold, ital, ul, check), h('div.tb-group', h('button.tb-btn', { html: sym.compose, title: 'New Note', onclick: () => add() })),
      h('div.search-field', { html: sym.search }, search));
    const items = h('div');
    list.append(items);
    win.body.append(list, h('div.main-pane', editor));
    const draw = () => {
      const q = search.value.toLowerCase();
      items.innerHTML = '';
      const groups = {};
      for (const n of notes.slice().sort((a, b) => b.t - a.t)) {
        const { title, preview } = titleOf(n.html);
        if (q && !(title + preview).toLowerCase().includes(q)) continue;
        const age = Date.now() - n.t;
        const g = age < 864e5 ? 'Today' : age < 7 * 864e5 ? 'Previous 7 Days' : 'Earlier';
        (groups[g] ||= []).push(h('div.note-item' + (n.id === cur ? '.sel' : ''), { onclick: () => { cur = n.id; open(); } },
          h('b', title), h('small', new Date(n.t).toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' }) + '  ' + preview)));
      }
      for (const [g, els] of Object.entries(groups)) items.append(h('div.sb-sec', g), ...els);
      if (!notes.length) items.append(h('div.sb-sec', 'No Notes'));
    };
    const open = () => {
      const n = notes.find((x) => x.id === cur);
      editor.innerHTML = n ? n.html : '';
      editor.contentEditable = n ? 'true' : 'false';
      draw();
      if (n) { editor.focus(); const r = document.createRange(); r.selectNodeContents(editor); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); }
    };
    const persist = debounce(() => {
      const n = notes.find((x) => x.id === cur);
      if (!n) return;
      // checkbox state lives in an attribute so it survives serialisation
      editor.querySelectorAll('input[type=checkbox]').forEach((c) => c.toggleAttribute('checked', c.checked));
      n.html = editor.innerHTML; n.t = Date.now();
      save(notes); draw();
    }, 300);
    const add = () => { const n = { id: Date.now(), html: '', t: Date.now() }; notes.push(n); cur = n.id; save(notes); open(); };
    const del = async () => {
      if (!cur || !(await confirmDialog('Delete this note?', 'This can’t be undone.', 'Delete', { danger: true }, win.el))) return;
      notes = notes.filter((x) => x.id !== cur); save(notes); cur = notes.sort((a, b) => b.t - a.t)[0]?.id; open();
    };
    editor.addEventListener('input', persist);
    editor.addEventListener('change', persist);
    search.addEventListener('input', draw);
    win.el.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'n') { e.preventDefault(); add(); } });
    open();
  },
});
