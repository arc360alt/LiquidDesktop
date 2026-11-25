// Journal — freeform pages (like the Mac's Freeform): an endless canvas to type on, draw on, and pin things to —
// text, sticky notes, to-do lists, Kanban boards, pictures, shapes and arrows — and a pen, highlighter and eraser.
// Pages are kept in ~/.local/share/LiquidDesktop/journal (main/journal.js); everything saves as you go.
//   Pan: scroll, or drag with the hand tool / middle button / Space held. Zoom: Ctrl+scroll, or the buttons.
//   Pictures: the Picture tool, drag them in, or paste. Delete removes what's selected; Ctrl+Z / Ctrl+Shift+Z.
import { h, $, $$, fileUrl } from '../util.js';
import { registerApp } from '../wm.js';
import { sym } from '../icons.js';
import { api } from '../sys.js';
import { contextMenu, confirmDialog } from '../menus.js';

const I = (p, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"${extra}>${p}</svg>`;
const ICON = {
  select: I('<path d="M5 3.5 18 11l-6 1.6-2.6 6z"/>'),
  hand: I('<path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5M14 10.5V5.5a1.5 1.5 0 0 1 3 0v8.5a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.7-2.3l-2.6-3.4a1.6 1.6 0 0 1 2.4-2.1L8 14"/>'),
  text: I('<path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6"/>'),
  sticky: I('<path d="M5 4h14v10l-5 6H5z"/><path d="M14 20v-6h5"/>'),
  todo: I('<rect x="4" y="4.5" width="5" height="5" rx="1.2"/><path d="m5 13.8 1.5 1.5 3-3M12 7h8M12 14h8"/>'),
  kanban: I('<rect x="3.5" y="4" width="5" height="15" rx="1.4"/><rect x="9.5" y="4" width="5" height="10" rx="1.4"/><rect x="15.5" y="4" width="5" height="12.5" rx="1.4"/>'),
  image: I('<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5"/>'),
  shape: I('<rect x="3.5" y="9" width="9.5" height="10" rx="1.5"/><circle cx="15.5" cy="8.5" r="5"/>'),
  pen: I('<path d="M4 20l1.2-4.6L15.8 4.8a2.2 2.2 0 0 1 3.1 3.1L8.4 18.5z"/><path d="m14 6.5 3.4 3.4"/>'),
  marker: I('<path d="m9.5 15.5-3 3H3.5l3-3M9 15l-3-3 9-9 6 6-9 9z" /><path d="M12 6l6 6"/>'),
  eraser: I('<path d="M8.5 20h11M4.7 15.6l9.9-9.9a2 2 0 0 1 2.8 0l2.4 2.4a2 2 0 0 1 0 2.8L13 18.6a2 2 0 0 1-1.4.6H8.3a2 2 0 0 1-1.4-.6l-2.2-2.2a1.2 1.2 0 0 1 0-1.8z"/><path d="m9.5 10.8 4.6 4.6"/>'),
  undo: I('<path d="M9 7 4.5 11.5 9 16"/><path d="M5 11.5h9.5a5 5 0 0 1 0 10H12"/>'),
  redo: I('<path d="m15 7 4.5 4.5L15 16"/><path d="M19 11.5H9.5a5 5 0 0 0 0 10H12"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'), minus: I('<path d="M5 12h14"/>'), fit: I('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
};
const STICKY = ['#ffe066', '#ffb3c7', '#a8e6a3', '#9fd3ff', '#d4b8ff', '#ffc98a'];
const INK = ['#1c1c1e', '#0a84ff', '#ff3b30', '#34c759', '#ff9500', '#af52de', '#ffffff'];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

registerApp({
  id: 'journal', name: 'Journal', size: [1100, 720], minSize: [640, 420], overlayContent: true, hideTitle: true, singleton: true,
  keywords: ['freeform', 'whiteboard', 'canvas', 'draw', 'kanban', 'board', 'diary', 'notes', 'sketch', 'todo'],
  about: 'Freeform pages: type, draw, and pin pictures, to-dos and boards.',
  menus: (win) => [{ title: 'File', items: [{ label: 'New Page', shortcut: '⌘N', action: () => win?.state?.newPage() }, '-', { label: 'Delete Page…', action: () => win?.state?.deletePage() }] },
    { title: 'Edit', items: [{ label: 'Undo', shortcut: '⌃Z', action: () => win?.state?.undo() }, { label: 'Redo', shortcut: '⇧⌃Z', action: () => win?.state?.redo() }, '-', { label: 'Delete', action: () => win?.state?.delSel() }, { label: 'Duplicate', shortcut: '⌃D', action: () => win?.state?.dupSel() }] },
    { title: 'View', items: [{ label: 'Zoom In', shortcut: '⌃+', action: () => win?.state?.zoomBy(1.2) }, { label: 'Zoom Out', shortcut: '⌃−', action: () => win?.state?.zoomBy(1 / 1.2) }, { label: 'Zoom to Fit', action: () => win?.state?.fit() }, { label: 'Actual Size', shortcut: '⌃0', action: () => win?.state?.zoomTo(1) }] }],
  open(win) {
    let ix = { pages: [] }, page = null, pageId = null;
    let tool = 'select', ink = INK[0], penSize = 3, sel = null, view = { x: 0, y: 0, z: 1 };
    const undoStack = [], redoStack = [];

    /* -------------------------------------------- layout */
    const list = h('div.jr-list');
    const side = h('div.sidebar.jr-side', h('div.jr-side-head', h('b', 'Journal'), h('button.tb-btn', { title: 'New Page', html: sym.compose, onclick: () => newPage() })), list);
    const strokesSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    strokesSvg.classList.add('jr-ink');
    const world = h('div.jr-world', strokesSvg);
    const stage = h('div.jr-stage', world);
    const title = h('input.jr-title', { placeholder: 'Untitled', spellcheck: false });
    const date = h('small.jr-date');
    const tools = h('div.jr-tools.glass');
    const inkBar = h('div.jr-inkbar.glass', { hidden: true });
    const zoomBox = h('div.jr-zoom.glass');
    const canvasPane = h('div.main-pane.jr-main', stage, h('div.jr-titlebar', title, date), tools, inkBar, zoomBox);
    win.body.append(side, canvasPane);

    /* -------------------------------------------- pages */
    const save = (() => {
      let t = null;
      return (now) => {
        clearTimeout(t);
        const go = async () => {
          if (!page) return;
          page.updated = Date.now();
          await api.journal.write(pageId, page).catch(() => {});
          const e = ix.pages.find((p) => p.id === pageId);
          if (e) { e.title = page.title || ''; e.updated = page.updated; e.preview = previewText(); }
          await api.journal.setIndex(ix).catch(() => {});
          drawList();
        };
        if (now) go(); else t = setTimeout(go, 500);
      };
    })();
    const previewText = () => {
      const t = page.items.map((it) => it.type === 'text' || it.type === 'sticky' ? (it.data.html || '').replace(/<[^>]+>/g, ' ') : it.type === 'todo' ? it.data.title : it.type === 'kanban' ? it.data.title : '').join(' ').replace(/\s+/g, ' ').trim();
      return t.slice(0, 80);
    };
    function drawList() {
      const groups = new Map();
      const now = new Date(); now.setHours(0, 0, 0, 0);
      for (const p of ix.pages.slice().sort((a, b) => b.updated - a.updated)) {
        const d = Math.floor((now - new Date(p.updated).setHours(0, 0, 0, 0)) / 864e5);
        const g = d <= 0 ? 'Today' : d < 7 ? 'Previous 7 Days' : d < 30 ? 'Previous 30 Days' : new Date(p.updated).toLocaleDateString([], { month: 'long', year: 'numeric' });
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(p);
      }
      list.replaceChildren();
      for (const [g, ps] of groups) {
        list.append(h('div.sb-sec', g));
        for (const p of ps) {
          const el = h('div.jr-page' + (p.id === pageId ? '.sel' : ''), { onmousedown: (e) => { if (e.button === 0) openPage(p.id); } },
            h('span.jr-dot', { style: { background: p.color || '#0a84ff' } }), h('div', h('b', p.title || 'Untitled'), h('small', p.preview || new Date(p.updated).toLocaleDateString())));
          el.addEventListener('contextmenu', (e) => contextMenu(e, [{ label: 'Color', submenu: STICKY.concat('#0a84ff').map((c) => ({ label: ' ', icon: `<span style="display:block;width:12px;height:12px;border-radius:50%;background:${c}"></span>`, action: () => { p.color = c; api.journal.setIndex(ix); drawList(); } })) },
            '-', { label: 'Delete Page…', danger: true, action: () => deletePage(p.id) }]));
          list.append(el);
        }
      }
      if (!ix.pages.length) list.append(h('div.jr-none', 'No pages yet'));
    }
    async function newPage() {
      const id = uid();
      const p = { id, title: '', items: [], strokes: [], created: Date.now(), updated: Date.now() };
      await api.journal.write(id, p);
      ix.pages.push({ id, title: '', updated: p.updated, color: STICKY[ix.pages.length % STICKY.length] });
      await api.journal.setIndex(ix);
      await openPage(id);
      title.focus();
    }
    async function deletePage(id = pageId) {
      const p = ix.pages.find((x) => x.id === id);
      if (!p || !(await confirmDialog(`Delete “${p.title || 'Untitled'}”?`, 'Its drawings, notes and pictures go too. This can’t be undone.', 'Delete', { danger: true }, win.el))) return;
      await api.journal.remove(id);
      ix.pages = ix.pages.filter((x) => x.id !== id);
      await api.journal.setIndex(ix);
      if (id === pageId) { page = null; pageId = null; const next = ix.pages.slice().sort((a, b) => b.updated - a.updated)[0]; if (next) await openPage(next.id); else await newPage(); }
      drawList();
    }
    async function openPage(id) {
      if (page) save(true);
      page = await api.journal.read(id) || { id, title: '', items: [], strokes: [] };
      page.items ||= []; page.strokes ||= [];
      pageId = id; sel = null; undoStack.length = 0; redoStack.length = 0;
      title.value = page.title || '';
      date.textContent = new Date(page.created || Date.now()).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      view = page.view || { x: 40, y: 90, z: 1 };
      render(); drawList();
    }
    title.addEventListener('input', () => { if (!page) return; page.title = title.value; save(); });
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });

    /* -------------------------------------------- history */
    const snap = () => JSON.stringify({ items: page.items, strokes: page.strokes });
    const commit = () => { undoStack.push(snap()); if (undoStack.length > 80) undoStack.shift(); redoStack.length = 0; };
    const restore = (s) => { const o = JSON.parse(s); page.items = o.items; page.strokes = o.strokes; sel = null; render(); save(); };
    const undo = () => { if (!undoStack.length) return; redoStack.push(snap()); restore(undoStack.pop()); };
    const redo = () => { if (!redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()); };

    /* -------------------------------------------- view (pan & zoom) */
    const applyView = () => { world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`; zoomLabel.textContent = Math.round(view.z * 100) + '%'; stage.style.backgroundPosition = `${view.x}px ${view.y}px`; stage.style.backgroundSize = `${24 * view.z}px ${24 * view.z}px`; if (page) { page.view = { ...view }; save(); } };
    const toWorld = (cx, cy) => { const r = stage.getBoundingClientRect(); return { x: (cx - r.left - view.x) / view.z, y: (cy - r.top - view.y) / view.z }; };
    const zoomAt = (f, cx, cy) => {
      const r = stage.getBoundingClientRect();
      const px = cx ?? r.left + r.width / 2, py = cy ?? r.top + r.height / 2;
      const w = toWorld(px, py);
      view.z = Math.max(0.15, Math.min(5, view.z * f));
      view.x = px - r.left - w.x * view.z; view.y = py - r.top - w.y * view.z;
      applyView();
    };
    const fit = () => {
      const r = stage.getBoundingClientRect();
      const boxes = page.items.map((it) => [it.x, it.y, it.x + it.w, it.y + it.h]).concat(page.strokes.map((s) => { const xs = s.points.map((p) => p[0]), ys = s.points.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }));
      if (!boxes.length) { view = { x: 40, y: 90, z: 1 }; applyView(); return; }
      const [x1, y1, x2, y2] = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
      view.z = Math.max(0.15, Math.min(1.5, Math.min((r.width - 120) / (x2 - x1 || 1), (r.height - 200) / (y2 - y1 || 1))));
      view.x = (r.width - (x2 - x1) * view.z) / 2 - x1 * view.z; view.y = 90 + (r.height - 160 - (y2 - y1) * view.z) / 2 - y1 * view.z;
      applyView();
    };
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY);
      else { view.x -= e.deltaX || (e.shiftKey ? e.deltaY : 0); view.y -= e.shiftKey ? 0 : e.deltaY; applyView(); }
    }, { passive: false });
    const zoomLabel = h('button.jr-zl', { title: 'Actual size', onclick: () => { view.z = 1; applyView(); } });
    zoomBox.append(h('button', { title: 'Zoom Out', html: ICON.minus, onclick: () => zoomAt(1 / 1.2) }), zoomLabel, h('button', { title: 'Zoom In', html: ICON.plus, onclick: () => zoomAt(1.2) }), h('button', { title: 'Zoom to Fit', html: ICON.fit, onclick: fit }));

    /* -------------------------------------------- tools */
    const TOOLS = [['select', 'Select (V)', ICON.select], ['hand', 'Move the page (H)', ICON.hand], '|', ['text', 'Text (T)', ICON.text], ['sticky', 'Sticky Note (S)', ICON.sticky], ['todo', 'To-Do List', ICON.todo], ['kanban', 'Board', ICON.kanban],
      ['image', 'Picture', ICON.image], ['shape', 'Shape', ICON.shape], '|', ['pen', 'Pen (P)', ICON.pen], ['marker', 'Highlighter', ICON.marker], ['eraser', 'Eraser (E)', ICON.eraser], '|', ['undo', 'Undo', ICON.undo], ['redo', 'Redo', ICON.redo]];
    function drawTools() {
      tools.replaceChildren(...TOOLS.map((t) => (t === '|' ? h('i.jr-sep') : h('button' + (tool === t[0] ? '.on' : ''), { title: t[1], html: t[2], onclick: (e) => pickTool(t[0], e.currentTarget) }))));
      inkBar.hidden = !['pen', 'marker'].includes(tool);
      inkBar.replaceChildren(...INK.map((c) => h('button.jr-swatch' + (ink === c ? '.on' : ''), { style: { background: c }, onclick: () => { ink = c; drawTools(); } })), h('i.jr-sep'),
        ...[2, 4, 8].map((s) => h('button.jr-size' + (penSize === s ? '.on' : ''), { onclick: () => { penSize = s; drawTools(); } }, h('i', { style: { width: s + 4 + 'px', height: s + 4 + 'px' } }))));
      stage.dataset.tool = tool;
    }
    function pickTool(t, btn) {
      if (t === 'undo') return undo();
      if (t === 'redo') return redo();
      if (['text', 'sticky', 'todo', 'kanban'].includes(t)) { addItem(t); return; }
      if (t === 'image') return pickImage();
      if (t === 'shape') {
        const r = btn.getBoundingClientRect();
        import('../menus.js').then(({ showMenu }) => showMenu([['rect', 'Rectangle'], ['round', 'Rounded Rectangle'], ['ellipse', 'Circle'], ['arrow', 'Arrow'], ['line', 'Line']].map(([k, l]) => ({ label: l, action: () => addItem('shape', { kind: k }) })), r.left, r.top - 200));
        return;
      }
      tool = t; sel = null; render(); drawTools();
    }
    // where new things go: the middle of what you're looking at (a little offset each time, so they don't stack exactly)
    // where new things go: near the middle of what you're looking at, in the first spot nothing else covers
    // (spiralling outwards), so a new note never lands on top of another
    const centre = (w, hh) => {
      const r = stage.getBoundingClientRect(), c = toWorld(r.left + r.width / 2, r.top + r.height / 2 + 20);
      const free = (x, y) => !page.items.some((i) => x < i.x + i.w + 16 && x + w + 16 > i.x && y < i.y + i.h + 16 && y + hh + 16 > i.y);
      const x0 = c.x - w / 2, y0 = c.y - hh / 2;
      for (let ring = 0; ring < 30; ring++) {
        const steps = Math.max(1, ring * 8);
        for (let k = 0; k < steps; k++) {
          const a = (k / steps) * Math.PI * 2, d = ring * 60;
          const x = Math.round(x0 + Math.cos(a) * d * 1.4), y = Math.round(y0 + Math.sin(a) * d);
          if (free(x, y)) return { x, y };
        }
      }
      return { x: Math.round(x0), y: Math.round(y0) };
    };
    function addItem(type, extra = {}, at) {
      if (!page) return;
      commit();
      const size = { text: [260, 60], sticky: [200, 200], todo: [260, 180], kanban: [620, 340], image: [320, 240], shape: [200, 140] }[type];
      const pos = at || centre(...size);
      const data = type === 'text' ? { html: '' } : type === 'sticky' ? { html: '', color: STICKY[page.items.filter((i) => i.type === 'sticky').length % STICKY.length] }
        : type === 'todo' ? { title: 'To Do', items: [{ text: '', done: false }] }
          : type === 'kanban' ? { title: 'Board', columns: [{ title: 'To Do', cards: [] }, { title: 'Doing', cards: [] }, { title: 'Done', cards: [] }] }
            : type === 'shape' ? { kind: extra.kind || 'rect', stroke: '#0a84ff', fill: extra.kind === 'arrow' || extra.kind === 'line' ? 'none' : 'rgba(10,132,255,.12)' } : extra;
      const it = { id: uid(), type, x: pos.x, y: pos.y, w: size[0], h: extra.h || size[1], z: Math.max(0, ...page.items.map((i) => i.z || 0)) + 1, data };
      if (type === 'image' && extra.w) { it.w = extra.w; it.h = extra.h; }
      page.items.push(it);
      tool = 'select'; sel = it.id;
      render(); drawTools(); save();
      // straight into typing
      setTimeout(() => { const el = $(`[data-id="${it.id}"] [contenteditable]`, world); if (el) { el.focus(); } }, 30);
      return it;
    }
    async function pickImage() {
      const files = await api.dialog?.open({ title: 'Add Pictures', multiple: true, filters: [{ name: 'Pictures', patterns: ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.bmp', '*.svg', '*.avif'] }] }).catch(() => null);
      for (const f of files || []) await addImageFile(f);
    }
    async function addImageFile(file, at, data) {
      try {
        const src = data ? await api.journal.addImageData(data) : await api.journal.addImage(file);
        const img = new Image(); img.src = fileUrl(src);
        await img.decode().catch(() => {});
        const k = Math.min(1, 420 / (img.naturalWidth || 420), 420 / (img.naturalHeight || 320));
        const w = Math.round((img.naturalWidth || 320) * k), hh = Math.round((img.naturalHeight || 240) * k);
        addItem('image', { src, w, h: hh }, at ? { x: at.x - w / 2, y: at.y - hh / 2 } : undefined);
      } catch (e) { import('../shell.js').then(({ shell }) => shell.notify({ app: 'journal', title: 'Journal', body: e.message })); }
    }

    /* -------------------------------------------- drawing the page */
    function render() {
      $$('.jr-item', world).forEach((e) => e.remove());
      drawStrokes();
      if (!page) return;
      for (const it of page.items.slice().sort((a, b) => (a.z || 0) - (b.z || 0))) world.append(itemEl(it));
      applyView();
      stage.classList.toggle('empty', !page.items.length && !page.strokes.length);
    }
    const strokePath = (pts) => {
      if (pts.length < 2) return `M${pts[0][0]} ${pts[0][1]}l0.01 0`;
      let d = `M${pts[0][0]} ${pts[0][1]}`;
      for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; d += ` Q${pts[i][0]} ${pts[i][1]} ${mx} ${my}`; }
      const l = pts[pts.length - 1];
      return d + ` L${l[0]} ${l[1]}`;
    };
    function drawStrokes() {
      strokesSvg.innerHTML = '';
      for (const s of page?.strokes || []) strokesSvg.append(strokeEl(s));
    }
    function strokeEl(s) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', strokePath(s.points));
      p.setAttribute('stroke', s.color); p.setAttribute('stroke-width', s.size); p.setAttribute('fill', 'none');
      p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
      if (s.tool === 'marker') { p.setAttribute('stroke-opacity', '0.35'); p.setAttribute('stroke-linecap', 'butt'); }
      return p;
    }

    function itemEl(it) {
      const el = h('div.jr-item.jr-' + it.type + (sel === it.id ? '.sel' : ''), { 'data-id': it.id, style: { left: it.x + 'px', top: it.y + 'px', width: it.w + 'px', height: it.h + 'px', zIndex: 10 + (it.z || 0) } });
      const changed = () => save();
      if (it.type === 'text' || it.type === 'sticky') {
        const ed = h('div.jr-ed', { contenteditable: 'true', spellcheck: true, 'data-ph': it.type === 'text' ? 'Type something' : 'Write a note' });
        ed.innerHTML = it.data.html || '';
        if (it.type === 'sticky') el.style.background = it.data.color;
        ed.addEventListener('focus', () => { commit(); select(it.id); });
        ed.addEventListener('input', () => { it.data.html = ed.innerHTML; if (it.type === 'text') { const need = ed.scrollHeight + 8; if (need > it.h) { it.h = need; el.style.height = need + 'px'; } } changed(); });
        el.append(ed);
      } else if (it.type === 'todo') {
        const t = h('div.jr-todo-title', { contenteditable: 'true', spellcheck: true }, it.data.title || '');
        t.addEventListener('input', () => { it.data.title = t.textContent; changed(); });
        const box = h('div.jr-todo-list');
        const drawTodos = (focusI) => {
          box.replaceChildren(...it.data.items.map((x, i) => {
            const txt = h('div.jr-todo-txt' + (x.done ? '.done' : ''), { contenteditable: 'true', spellcheck: true, 'data-ph': 'To-do' }, x.text);
            txt.addEventListener('input', () => { x.text = txt.textContent; changed(); });
            txt.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); it.data.items.splice(i + 1, 0, { text: '', done: false }); drawTodos(i + 1); grow(); changed(); }
              if (e.key === 'Backspace' && !txt.textContent && it.data.items.length > 1) { e.preventDefault(); commit(); it.data.items.splice(i, 1); drawTodos(Math.max(0, i - 1)); changed(); }
            });
            return h('div.jr-todo-row', h('button.jr-check' + (x.done ? '.on' : ''), { onclick: () => { commit(); x.done = !x.done; drawTodos(); changed(); } }), txt);
          }));
          if (focusI != null) setTimeout(() => { const e = box.children[focusI]?.querySelector('.jr-todo-txt'); if (e) { e.focus(); const r = document.createRange(); r.selectNodeContents(e); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); } }, 0);
        };
        const grow = () => { const need = 44 + it.data.items.length * 30 + 34; if (need > it.h) { it.h = need; el.style.height = need + 'px'; } };
        drawTodos();
        const done = it.data.items.filter((x) => x.done).length;
        el.append(h('div.jr-todo-head', t, h('small', `${done}/${it.data.items.length}`)), box, h('button.jr-add', { onclick: () => { commit(); it.data.items.push({ text: '', done: false }); drawTodos(it.data.items.length - 1); grow(); changed(); } }, '+ Add'));
      } else if (it.type === 'kanban') {
        const t = h('div.jr-kb-title', { contenteditable: 'true', spellcheck: true }, it.data.title || '');
        t.addEventListener('input', () => { it.data.title = t.textContent; changed(); });
        const cols = h('div.jr-kb-cols');
        const drawCols = () => {
          cols.replaceChildren(...it.data.columns.map((col, ci) => {
            const ct = h('div.jr-kb-ctitle', { contenteditable: 'true', spellcheck: true }, col.title);
            ct.addEventListener('input', () => { col.title = ct.textContent; changed(); });
            const cards = h('div.jr-kb-cards');
            col.cards.forEach((card, k) => {
              const c = h('div.jr-kb-card', { draggable: true },
                h('div.jr-kb-ctext', { contenteditable: 'true', spellcheck: true, 'data-ph': 'Card' }, card.text),
                h('button.jr-kb-del', { title: 'Delete card', html: '×', onclick: () => { commit(); col.cards.splice(k, 1); drawCols(); changed(); } }));
              const ed = c.firstChild;
              ed.addEventListener('input', () => { card.text = ed.textContent; changed(); });
              c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/jr-card', JSON.stringify([ci, k])); e.stopPropagation(); c.classList.add('dragging'); });
              c.addEventListener('dragend', () => c.classList.remove('dragging'));
              cards.append(c);
            });
            cards.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/jr-card')) { e.preventDefault(); cards.classList.add('over'); } });
            cards.addEventListener('dragleave', () => cards.classList.remove('over'));
            cards.addEventListener('drop', (e) => {
              e.preventDefault(); e.stopPropagation(); cards.classList.remove('over');
              const [fc, fk] = JSON.parse(e.dataTransfer.getData('text/jr-card') || '[]');
              if (fc == null) return;
              commit();
              const [moved] = it.data.columns[fc].cards.splice(fk, 1);
              // dropped between cards: there; else at the end
              const after = [...cards.children].find((x) => e.clientY < x.getBoundingClientRect().top + x.offsetHeight / 2);
              const at = after ? [...cards.children].indexOf(after) - (fc === ci && fk < [...cards.children].indexOf(after) ? 1 : 0) : col.cards.length;
              col.cards.splice(Math.max(0, at), 0, moved);
              drawCols(); changed();
            });
            return h('div.jr-kb-col', h('div.jr-kb-chead', ct, h('small', col.cards.length),
              h('button.jr-kb-cmenu', { html: '⋯', onclick: (e) => contextMenu(e, [{ label: 'Delete Column', danger: true, disabled: it.data.columns.length < 2, action: () => { commit(); it.data.columns.splice(ci, 1); drawCols(); changed(); } }]) })),
            cards, h('button.jr-add', { onclick: () => { commit(); col.cards.push({ text: '' }); drawCols(); changed(); setTimeout(() => { const all = cols.children[ci]?.querySelectorAll('.jr-kb-ctext'); all?.[all.length - 1]?.focus(); }, 0); } }, '+ Add Card'));
          }), h('button.jr-kb-addcol', { title: 'Add Column', onclick: () => { commit(); it.data.columns.push({ title: 'New Column', cards: [] }); it.w = Math.max(it.w, it.data.columns.length * 205 + 60); el.style.width = it.w + 'px'; drawCols(); changed(); } }, '+'));
        };
        drawCols();
        el.append(h('div.jr-kb-head', t), cols);
      } else if (it.type === 'image') {
        el.append(h('img', { src: it.data.src?.startsWith('data:') ? it.data.src : fileUrl(it.data.src), alt: '', draggable: false }));
      } else if (it.type === 'shape') {
        const k = it.data.kind;
        el.innerHTML = k === 'ellipse' ? `<svg width="100%" height="100%"><ellipse cx="${it.w / 2}" cy="${it.h / 2}" rx="${it.w / 2 - 2}" ry="${it.h / 2 - 2}" fill="${it.data.fill}" stroke="${it.data.stroke}" stroke-width="3"/></svg>`
          : k === 'arrow' || k === 'line' ? `<svg width="100%" height="100%" viewBox="0 0 ${it.w} ${it.h}"><defs><marker id="ah${it.id}" markerWidth="10" markerHeight="10" refX="7" refY="5" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="${it.data.stroke}"/></marker></defs><line x1="4" y1="${it.h - 4}" x2="${it.w - 8}" y2="8" stroke="${it.data.stroke}" stroke-width="3.5" stroke-linecap="round" ${k === 'arrow' ? `marker-end="url(#ah${it.id})"` : ''}/></svg>`
            : `<svg width="100%" height="100%"><rect x="2" y="2" width="${it.w - 4}" height="${it.h - 4}" rx="${k === 'round' ? 18 : 3}" fill="${it.data.fill}" stroke="${it.data.stroke}" stroke-width="3"/></svg>`;
      }
      // move by the edge (or anywhere on pictures and shapes); resize from the corner
      el.append(h('i.jr-grip', { title: 'Resize' }));
      el.addEventListener('pointerdown', (e) => onItemDown(e, it, el));
      el.addEventListener('contextmenu', (e) => { select(it.id); itemMenu(e, it); });
      return el;
    }
    function select(id) { sel = id; $$('.jr-item', world).forEach((e) => e.classList.toggle('sel', e.dataset.id === id)); }
    function itemMenu(e, it) {
      const items = [
        { label: 'Bring to Front', action: () => { commit(); it.z = Math.max(...page.items.map((i) => i.z || 0)) + 1; render(); save(); } },
        { label: 'Send to Back', action: () => { commit(); it.z = Math.min(...page.items.map((i) => i.z || 0)) - 1; render(); save(); } },
        { label: 'Duplicate', action: () => dup(it) }, '-',
      ];
      if (it.type === 'sticky') items.push({ label: 'Color', submenu: STICKY.map((c) => ({ label: ' ', icon: `<span style="display:block;width:12px;height:12px;border-radius:3px;background:${c}"></span>`, action: () => { commit(); it.data.color = c; render(); save(); } })) });
      if (it.type === 'shape') items.push({ label: 'Color', submenu: ['#0a84ff', '#ff3b30', '#34c759', '#ff9500', '#af52de', '#1c1c1e'].map((c) => ({ label: ' ', icon: `<span style="display:block;width:12px;height:12px;border-radius:3px;background:${c}"></span>`, action: () => { commit(); it.data.stroke = c; if (it.data.fill !== 'none') it.data.fill = c + '22'; render(); save(); } })) });
      items.push({ label: 'Delete', danger: true, action: () => del(it.id) });
      contextMenu(e, items);
    }
    const del = (id) => { if (!id) return; commit(); page.items = page.items.filter((i) => i.id !== id); sel = null; render(); save(); };
    const dup = (it) => { if (!it) return; commit(); const c = JSON.parse(JSON.stringify(it)); c.id = uid(); c.x += 30; c.y += 30; c.z = Math.max(...page.items.map((i) => i.z || 0)) + 1; page.items.push(c); sel = c.id; render(); save(); };

    /* -------------------------------------------- pointer: move, resize, draw, erase, pan */
    let spaceHeld = false;
    function onItemDown(e, it, el) {
      if (tool !== 'select' || e.button !== 0 || spaceHeld) return;
      const onText = e.target.closest('[contenteditable], button, .jr-kb-card');
      const grip = e.target.classList.contains('jr-grip');
      select(it.id);
      if (onText && !grip) return;   // typing, ticking, cards: theirs
      e.preventDefault(); e.stopPropagation();
      document.activeElement?.blur?.();
      commit();
      const sx = e.clientX, sy = e.clientY, ox = it.x, oy = it.y, ow = it.w, oh = it.h;
      const ratio = it.type === 'image' ? ow / oh : null;
      el.setPointerCapture(e.pointerId);
      const mv = (ev) => {
        const dx = (ev.clientX - sx) / view.z, dy = (ev.clientY - sy) / view.z;
        if (grip) { it.w = Math.max(60, Math.round(ow + dx)); it.h = ratio ? Math.round(it.w / ratio) : Math.max(40, Math.round(oh + dy)); el.style.width = it.w + 'px'; el.style.height = it.h + 'px'; }
        else { it.x = Math.round(ox + dx); it.y = Math.round(oy + dy); el.style.left = it.x + 'px'; el.style.top = it.y + 'px'; }
      };
      const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); if (it.type === 'shape' && grip) render(); if (it.x === ox && it.y === oy && it.w === ow && it.h === oh) undoStack.pop(); save(); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
    }
    stage.addEventListener('pointerdown', (e) => {
      if (!page) return;
      if (e.target.closest('.jr-item') && tool === 'select' && !spaceHeld && e.button === 0) return;
      // pan: hand tool, Space held, or the middle button
      if (tool === 'hand' || spaceHeld || e.button === 1) {
        e.preventDefault();
        const sx = e.clientX, sy = e.clientY, vx = view.x, vy = view.y;
        stage.setPointerCapture(e.pointerId); stage.classList.add('panning');
        const mv = (ev) => { view.x = vx + ev.clientX - sx; view.y = vy + ev.clientY - sy; applyView(); };
        const up = () => { stage.removeEventListener('pointermove', mv); stage.removeEventListener('pointerup', up); stage.classList.remove('panning'); };
        stage.addEventListener('pointermove', mv); stage.addEventListener('pointerup', up);
        return;
      }
      if (e.button !== 0) return;
      if (tool === 'pen' || tool === 'marker') {
        e.preventDefault();
        commit();
        const p0 = toWorld(e.clientX, e.clientY);
        const s = { id: uid(), tool, color: ink, size: tool === 'marker' ? penSize * 5 : penSize, points: [[Math.round(p0.x * 10) / 10, Math.round(p0.y * 10) / 10]] };
        const path = strokeEl(s);
        strokesSvg.append(path);
        stage.setPointerCapture(e.pointerId);
        const mv = (ev) => {
          const p = toWorld(ev.clientX, ev.clientY), last = s.points[s.points.length - 1];
          if (Math.hypot(p.x - last[0], p.y - last[1]) < 1.5 / view.z) return;
          s.points.push([Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
          path.setAttribute('d', strokePath(s.points));
        };
        const up = () => { stage.removeEventListener('pointermove', mv); stage.removeEventListener('pointerup', up); page.strokes.push(s); stage.classList.remove('empty'); save(); };
        stage.addEventListener('pointermove', mv); stage.addEventListener('pointerup', up);
        return;
      }
      if (tool === 'eraser') {
        e.preventDefault();
        commit();
        let erased = false;
        const hit = (ev) => {
          const p = toWorld(ev.clientX, ev.clientY), r = 8 / view.z;
          const before = page.strokes.length;
          page.strokes = page.strokes.filter((s) => !s.points.some((q) => Math.hypot(q[0] - p.x, q[1] - p.y) < r + s.size / 2));
          if (page.strokes.length !== before) { erased = true; drawStrokes(); }
        };
        hit(e);
        stage.setPointerCapture(e.pointerId);
        const up = () => { stage.removeEventListener('pointermove', hit); stage.removeEventListener('pointerup', up); if (!erased) undoStack.pop(); else save(); };
        stage.addEventListener('pointermove', hit); stage.addEventListener('pointerup', up);
        return;
      }
      // a click on empty page: nothing selected (double-click: a text box there)
      document.activeElement?.blur?.();
      select(null);
    });
    stage.addEventListener('dblclick', (e) => { if (tool === 'select' && !e.target.closest('.jr-item')) { const p = toWorld(e.clientX, e.clientY); addItem('text', {}, { x: p.x - 20, y: p.y - 20 }); } });

    // pictures dragged in, or pasted
    stage.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    stage.addEventListener('drop', async (e) => {
      if (!e.dataTransfer.files?.length) return;
      e.preventDefault();
      const at = toWorld(e.clientX, e.clientY);
      for (const f of e.dataTransfer.files) { const p = api.pathOf?.(f); if (p && /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(p)) { await addImageFile(p, at); at.x += 30; at.y += 30; } }
    });
    win.el.addEventListener('paste', (e) => {
      if (e.target.closest?.('[contenteditable], input')) {
        // pasting into text: plain text only (no foreign styles); pictures still become pictures
        const img = [...(e.clipboardData?.items || [])].find((x) => x.type.startsWith('image/'));
        if (!img) { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); return; }
      }
      const img = [...(e.clipboardData?.items || [])].find((x) => x.type.startsWith('image/'));
      if (!img) return;
      e.preventDefault();
      const r = new FileReader();
      r.onload = () => addImageFile(null, undefined, r.result);
      r.readAsDataURL(img.getAsFile());
    });

    win.el.addEventListener('keydown', (e) => {
      const typing = e.target.closest?.('[contenteditable], input, textarea');
      if (e.key === ' ' && !typing) { spaceHeld = true; stage.classList.add('space'); e.preventDefault(); }
      if (e.ctrlKey && (e.key === 'z' || e.key === 'Z') && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if (e.ctrlKey && e.key === 'y' && !typing) { e.preventDefault(); redo(); }
      if (e.ctrlKey && e.key === 'd' && sel) { e.preventDefault(); dup(page.items.find((i) => i.id === sel)); }
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomAt(1.2); }
      if (e.ctrlKey && e.key === '-') { e.preventDefault(); zoomAt(1 / 1.2); }
      if (e.ctrlKey && e.key === '0') { e.preventDefault(); view.z = 1; applyView(); }
      if (e.ctrlKey && e.key === 'n') { e.preventDefault(); newPage(); }
      if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); del(sel); }
      const keys = { v: 'select', h: 'hand', p: 'pen', e: 'eraser' };
      if (!e.ctrlKey && !e.altKey && keys[e.key]) { tool = keys[e.key]; drawTools(); }
      if (!e.ctrlKey && !e.altKey && e.key === 't') addItem('text');
      if (!e.ctrlKey && !e.altKey && e.key === 's') addItem('sticky');
      if (e.key === 'Escape') { select(null); tool = 'select'; drawTools(); }
    });
    win.el.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceHeld = false; stage.classList.remove('space'); } });

    win.state = { newPage, deletePage: () => deletePage(), undo, redo, delSel: () => del(sel), dupSel: () => dup(page?.items.find((i) => i.id === sel)), zoomBy: (f) => zoomAt(f), zoomTo: (z) => { view.z = z; applyView(); }, fit };
    win.on('close', () => save(true));

    (async () => {
      ix = await api.journal.index().catch(() => ({ pages: [] }));
      ix.pages ||= [];
      drawTools();
      const last = ix.pages.slice().sort((a, b) => b.updated - a.updated)[0];
      if (last) await openPage(last.id); else await newPage();
    })();
  },
});
