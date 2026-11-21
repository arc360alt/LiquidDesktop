// "Open With": pick the app that opens a file or link, asked for by the desktop portal (main/portal.js)
// when a browser opens a download, a Flatpak app opens a file, and so on.
import { h, $$ } from '../util.js';
import { registerApp } from '../wm.js';
import { appIcon, docIcon, sym } from '../icons.js';
import { api } from '../sys.js';
import { catalog } from '../catalog.js';

const idOf = (app) => app.id.replace(/^desktop:/, '').replace(/\.desktop$/, '');

registerApp({
  id: 'appchooser', name: 'Open With', hidden: true, size: [440, 560], minSize: [380, 420], overlayContent: true, hideTitle: true, className: 'ac-win',
  async open(win, args = {}) {
    let done = false, sel = args.last || args.choices?.[0] || '', showAll = false, filter = '';
    const finish = (choice) => { if (done) return; done = true; api.appchooser?.done(args.req, choice).catch(() => {}); win.close(); };
    win.on('close', () => { if (!done) { done = true; api.appchooser?.done(args.req, null).catch(() => {}); } });

    if (!catalog.native.length) await catalog.load();
    const all = catalog.native;
    const byId = new Map(all.map((a) => [idOf(a), a]));
    const suggested = (args.choices || []).map((c) => byId.get(c) || { id: 'desktop:' + c + '.desktop', name: c.split('.').pop(), builtin: false }).filter(Boolean);
    const ext = (args.filename || '').includes('.') ? args.filename.split('.').pop().toLowerCase() : '';

    const list = h('div.ac-list');
    const search = h('input.field', { placeholder: 'Search apps', oninput: (e) => { filter = e.target.value.toLowerCase(); draw(); } });
    const ok = h('button.btn.primary', { onclick: () => sel && finish(sel) }, 'Open');
    const head = h('div.ac-head',
      h('div.ac-file', { html: args.filename ? docIcon(ext) : sym.globe }),
      h('div', h('b', args.filename || args.uri || 'Choose an app'), h('small.muted', args.contentType ? `Choose an app to open this ${args.contentType.split('/')[0] === 'text' ? 'file' : args.contentType}` : 'Choose an app to open it')));
    const toggle = h('button.ac-more', { onclick: () => { showAll = !showAll; draw(); } });
    win.body.append(h('div.ac', head, h('div.search-field', { html: sym.search }, search), list, toggle,
      h('div.ac-foot', h('div.spacer'), h('button.btn', { onclick: () => finish(null) }, 'Cancel'), ok)));
    win.dragRegion(head);

    function row(app) {
      const id = idOf(app);
      const el = h('div.ac-row' + (id === sel ? '.sel' : ''), appIcon(app, 'ac-ic'), h('span', app.name), id === args.last ? h('small.muted', 'Last used') : null);
      el.addEventListener('click', () => { sel = id; $$('.ac-row', list).forEach((r) => r.classList.toggle('sel', r === el)); ok.disabled = false; });
      el.addEventListener('dblclick', () => finish(id));
      return el;
    }
    function draw() {
      list.innerHTML = '';
      const match = (a) => !filter || a.name.toLowerCase().includes(filter);
      const sug = suggested.filter(match);
      if (sug.length) { list.append(h('div.ac-sec', 'Suggested')); sug.forEach((a) => list.append(row(a))); }
      if (showAll || filter || !sug.length) {
        const others = all.filter((a) => match(a) && !suggested.some((s) => idOf(s) === idOf(a)));
        if (others.length) { list.append(h('div.ac-sec', 'All Apps')); others.forEach((a) => list.append(row(a))); }
      }
      if (!list.childElementCount) list.append(h('div.ac-none.muted', 'No apps match'));
      toggle.textContent = showAll ? 'Show Suggested Apps Only' : 'Show All Apps';
      toggle.hidden = !!filter || !sug.length;
      ok.disabled = !sel;
    }
    win.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      if (e.key === 'Enter' && sel) { e.preventDefault(); finish(sel); }
    });
    draw();
    search.focus();
  },
});
