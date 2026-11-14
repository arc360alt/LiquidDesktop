// Widget Creator — design your own desktop widgets: text with live {{placeholders}}, pictures, shapes,
// progress bars and rings, icons, a background, and data from the web. Saved to "My Widgets" in the widget
// gallery, and exported/imported as .ldwidget files to share (see customwidget.js for the format).
import { h, $$, clamp } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym } from '../icons.js';
import { api } from '../sys.js';
import { store } from '../store.js';
import { alertDialog } from '../menus.js';
import { FORMAT, SIZES, ICONS, customWidgets, saveCustom, validate, toFile, renderCustom, newId } from '../customwidget.js';

const PLACEHOLDERS = [['time', 'Time'], ['time24', 'Time (24-hour)'], ['date', 'Date'], ['weekday', 'Weekday'], ['day', 'Day of month'], ['month', 'Month'], ['year', 'Year'],
  ['battery', 'Battery %'], ['cpu', 'CPU %'], ['mem', 'Memory %'], ['weather.temp', 'Temperature'], ['weather.condition', 'Conditions'], ['weather.high', 'High'], ['weather.low', 'Low'], ['weather.city', 'City']];
const DEFAULTS = {
  text: { w: 84, h: 18, text: 'Text', size: 16, weight: 600, align: 'left', font: 'system' },
  image: { w: 40, h: 40, src: '', fit: 'cover', radius: 12 },
  shape: { w: 40, h: 30, shape: 'rect', fill: '#ffffff40', radius: 14 },
  progress: { w: 84, h: 8, style: 'bar', value: '{{battery}}', max: 100, color: '#30d158', track: '#ffffff40' },
  icon: { w: 22, h: 22, name: 'star', color: '#ffd60a' },
};
function starter() {
  return { format: FORMAT, version: 1, id: newId(), name: 'My Widget', author: '', size: 's',
    background: { type: 'gradient', color: '#1c1c1e', from: '#0a84ff', to: '#5e5ce6', angle: 135, image: '', dim: 0.25 }, textColor: '#ffffff', sources: [],
    elements: [
      { type: 'text', x: 9, y: 10, w: 82, h: 14, text: '{{weekday|upper}}', size: 12, weight: 700, align: 'left', font: 'system', color: '#ffffffcc' },
      { type: 'text', x: 9, y: 26, w: 86, h: 28, text: '{{time}}', size: 27, weight: 600, align: 'left', font: 'system' },
      { type: 'text', x: 9, y: 74, w: 82, h: 14, text: '{{weather.temp}}° {{weather.condition}}', size: 13, weight: 500, align: 'left', font: 'system' },
    ] };
}
// shrink pictures before embedding them (widgets live in your settings and get shared as files)
async function shrinkPicture(dataUrl, max = 720) {
  if (dataUrl.startsWith('data:image/svg') || dataUrl.startsWith('data:image/gif')) return dataUrl;
  const img = new Image(); img.src = dataUrl; await img.decode();
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL(/png/.test(dataUrl.slice(0, 20)) ? 'image/png' : 'image/jpeg', 0.86);
}

registerApp({
  id: 'widgetcreator', name: 'Widget Creator', size: [1120, 720], minSize: [900, 560], overlayContent: true, hideTitle: true, className: 'wc-win',
  keywords: ['widgets', 'design', 'custom widget', 'ldwidget'],
  open(win, args = {}) {
    let spec = args.id && customWidgets()[args.id] ? structuredClone(customWidgets()[args.id]) : starter();
    let sel = spec.elements.length ? 0 : -1, selSource = -1, dirty = false;
    const SCALE = 1.6;

    /* ---- layout */
    const left = h('div.wc-left'), right = h('div.wc-right'), canvasWrap = h('div.wc-canvas');
    win.body.append(h('div.wc', left, h('div.wc-center', canvasWrap, h('div.wc-help', 'Click to select · drag to move · drag the corner to resize · arrow keys nudge · hold Alt to ignore snapping')), right));
    win.dragRegion(left);
    const nameField = h('input.field', { value: spec.name, style: { width: '180px', height: '30px' }, oninput: (e) => { spec.name = e.target.value.slice(0, 60); dirty = true; } });
    const sizeSeg = h('div.wc-seg');
    const snapSel = h('select.field.square', { title: 'Snapping while dragging (hold Alt to move freely)', onchange: (e) => store.set('wcSnap', e.target.value) },
      ...[['smart', 'Snap: Smart'], ['grid', 'Snap: Grid'], ['off', 'Snap: Off']].map(([v, l]) => h('option', { value: v, selected: (store.get('wcSnap') || 'smart') === v }, l)));
    win.toolbar.append(h('div.spacer'), nameField, sizeSeg, snapSel, h('div.spacer'),
      h('div.tb-group', h('button.tb-btn', { title: 'Import a .ldwidget file', onclick: importFile, html: sym.download }), h('button.tb-btn', { title: 'Export as a .ldwidget file', onclick: exportFile, html: sym.share })),
      h('button.btn', { onclick: () => save(false) }, 'Save'), h('button.btn.primary', { onclick: () => save(true) }, 'Add to Desktop'));

    const change = (fn) => { fn?.(); dirty = true; drawPreview(); drawLeft(); };

    /* ---- preview (the real renderer, scaled up) with a selection box */
    let previewEl = null;
    function drawPreview() {
      previewEl?.stopCustom?.();
      canvasWrap.innerHTML = '';
      const [W, H] = SIZES[spec.size];
      previewEl = h('div.widget.glass.sheen.' + spec.size, { style: { width: W + 'px', height: H + 'px' } });
      renderCustom(previewEl, spec, { preview: true });
      const holder = h('div.wc-holder', { style: { width: W * SCALE + 'px', height: H * SCALE + 'px' } }, h('div.wc-scale', { style: { transform: `scale(${SCALE})` } }, previewEl));
      // invisible hit boxes on top of every element
      spec.elements.forEach((e, i) => {
        const box = h('div.wc-hit' + (i === sel ? '.sel' : ''), { style: { left: e.x + '%', top: e.y + '%', width: e.w + '%', height: e.h + '%' } });
        if (i === sel) box.append(h('i.wc-handle'));
        box.addEventListener('mousedown', (ev) => startDrag(ev, i, ev.target.classList.contains('wc-handle')));
        holder.append(box);
      });
      holder.addEventListener('mousedown', (ev) => { if (ev.target === holder) { sel = -1; selSource = -1; drawAll(); } });
      canvasWrap.append(holder);
      sizeSeg.innerHTML = '';
      for (const [k, l] of [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']]) sizeSeg.append(h('button' + (spec.size === k ? '.on' : ''), { onclick: () => change(() => { spec.size = k; }) }, l));
    }
    // Snapping while dragging (Snap menu in the toolbar; hold Alt to drag freely):
    //   grid  — positions and sizes land on a grid (every 5% of the widget)
    //   smart — edges and centres line up with the widget's edges and centre and with the other elements,
    //           and guide lines show what lined up
    const GRID = 5, NEAR = 2;
    function snapAxis(pos, size, targets, resize) {
      // the element's edges/centre as offsets from `pos`; when resizing only the far edge moves
      const pts = resize ? [[size, 'end']] : [[0, 'start'], [size / 2, 'mid'], [size, 'end']];
      let best = null;
      for (const [off] of pts) for (const t of targets) {
        const d = t - (pos + off);
        if (Math.abs(d) <= NEAR && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line: t };
      }
      return best;
    }
    function startDrag(ev, i, resize) {
      ev.preventDefault(); ev.stopPropagation();
      if (sel !== i) { sel = i; selSource = -1; drawAll(); }
      const e = spec.elements[i], [W, H] = SIZES[spec.size];
      const sx = ev.clientX, sy = ev.clientY, o = { x: e.x, y: e.y, w: e.w, h: e.h };
      const others = spec.elements.filter((_, k) => k !== i);
      const tx = [0, 50, 100, ...others.flatMap((q) => [q.x, q.x + q.w / 2, q.x + q.w])], ty = [0, 50, 100, ...others.flatMap((q) => [q.y, q.y + q.h / 2, q.y + q.h])];
      const mv = (m) => {
        const dx = ((m.clientX - sx) / (W * SCALE)) * 100, dy = ((m.clientY - sy) / (H * SCALE)) * 100;
        const mode = m.altKey ? 'off' : store.get('wcSnap') || 'smart';
        const g = (v) => Math.round(v / GRID) * GRID;
        let guides = [];
        if (resize) {
          let w = o.w + dx, hh = o.h + dy;
          if (mode === 'grid') { w = g(e.x + w) - e.x; hh = g(e.y + hh) - e.y; }
          if (mode === 'smart') {
            const bx = snapAxis(e.x, w, tx, true), by = snapAxis(e.y, hh, ty, true);
            if (bx) { w += bx.d; guides.push(['v', bx.line]); }
            if (by) { hh += by.d; guides.push(['h', by.line]); }
          }
          e.w = clamp(Math.round(w * 10) / 10, 2, 200); e.h = clamp(Math.round(hh * 10) / 10, 2, 200);
        } else {
          let x = o.x + dx, y = o.y + dy;
          if (mode === 'grid') { x = g(x); y = g(y); }
          if (mode === 'smart') {
            const bx = snapAxis(x, e.w, tx), by = snapAxis(y, e.h, ty);
            if (bx) { x += bx.d; guides.push(['v', bx.line]); }
            if (by) { y += by.d; guides.push(['h', by.line]); }
          }
          e.x = clamp(Math.round(x * 10) / 10, -50, 150); e.y = clamp(Math.round(y * 10) / 10, -50, 150);
        }
        dirty = true; drawPreview(); drawRight();
        const holder = canvasWrap.querySelector('.wc-holder');
        if (mode === 'grid') holder?.classList.add('grid');
        for (const [kind, at] of guides) holder?.append(h('i.wc-guide.' + kind, { style: kind === 'v' ? { left: at + '%' } : { top: at + '%' } }));
      };
      const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); drawPreview(); };
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
    }
    win.el.addEventListener('keydown', (ev) => {
      if (sel < 0 || ev.target.matches('input, textarea, select')) return;
      const e = spec.elements[sel], step = ev.shiftKey ? 5 : 0.5;
      const k = { ArrowLeft: ['x', -step], ArrowRight: ['x', step], ArrowUp: ['y', -step], ArrowDown: ['y', step] }[ev.key];
      if (k) { ev.preventDefault(); e[k[0]] += k[1]; dirty = true; drawPreview(); drawRight(); }
      if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); change(() => { spec.elements.splice(sel, 1); sel = Math.min(sel, spec.elements.length - 1); }); drawRight(); }
    });

    /* ---- left: elements and data sources */
    const TYPE_ICON = { text: 'T', image: '▧', shape: '◼', progress: '▬', icon: '★' };
    function drawLeft() {
      left.innerHTML = '';
      left.append(h('div.wc-sec', 'Elements'));
      const add = h('div.wc-add', ...Object.keys(DEFAULTS).map((t) => h('button', { title: 'Add ' + t, onclick: () => change(() => { spec.elements.push({ type: t, x: 8, y: 8 + (spec.elements.length * 7) % 70, ...structuredClone(DEFAULTS[t]) }); sel = spec.elements.length - 1; selSource = -1; drawRight(); }) }, h('b', TYPE_ICON[t]), t[0].toUpperCase() + t.slice(1))));
      left.append(add);
      const list = h('div.wc-list');
      spec.elements.forEach((e, i) => {
        const lbl = e.type === 'text' ? (e.text || 'Text') : e.type === 'icon' ? `Icon: ${e.name}` : e.type[0].toUpperCase() + e.type.slice(1);
        list.append(h('div.wc-item' + (i === sel ? '.sel' : ''), { onclick: () => { sel = i; selSource = -1; drawAll(); } },
          h('b', TYPE_ICON[e.type]), h('span', lbl),
          h('button', { title: 'Bring forward', onclick: (ev) => { ev.stopPropagation(); if (i < spec.elements.length - 1) change(() => { [spec.elements[i], spec.elements[i + 1]] = [spec.elements[i + 1], spec.elements[i]]; sel = i + 1; }); } }, '↑'),
          h('button', { title: 'Delete', onclick: (ev) => { ev.stopPropagation(); change(() => { spec.elements.splice(i, 1); if (sel >= spec.elements.length) sel = spec.elements.length - 1; }); drawRight(); } }, '×')));
      });
      if (!spec.elements.length) list.append(h('div.wc-none', 'Add something above'));
      left.append(list);
      left.append(h('div.wc-item' + (sel < 0 && selSource < 0 ? '.sel' : ''), { onclick: () => { sel = -1; selSource = -1; drawAll(); } }, h('b', '◐'), h('span', 'Background & Colors')));
      left.append(h('div.wc-sec', 'Data from the Web'));
      spec.sources.forEach((s, i) => left.append(h('div.wc-item' + (i === selSource ? '.sel' : ''), { onclick: () => { selSource = i; sel = -1; drawAll(); } }, h('b', '⇣'), h('span', s.id),
        h('button', { title: 'Delete', onclick: (ev) => { ev.stopPropagation(); change(() => { spec.sources.splice(i, 1); selSource = -1; }); drawRight(); } }, '×'))));
      left.append(h('button.btn.wc-addsrc', { onclick: () => change(() => { const n = spec.sources.length + 1; spec.sources.push({ id: 'data' + n, url: 'https://', every: 300, type: 'json' }); selSource = spec.sources.length - 1; sel = -1; drawRight(); }) }, '+ Add Data Source'));
    }

    /* ---- right: the inspector */
    const row = (label, ctl) => h('div.wc-row', h('label', label), ctl);
    const num = (obj, key, min, max, stepv = 1, after) => h('input.field', { type: 'number', value: Math.round(obj[key] * 10) / 10, min, max, step: stepv, oninput: (e) => { obj[key] = +e.target.value; dirty = true; drawPreview(); after?.(); } });
    const color = (obj, key, def = '#ffffff') => {
      const v = obj[key] || def, base = v.slice(0, 7), alpha = v.length === 9 ? parseInt(v.slice(7), 16) / 255 : 1;
      const pick = h('input', { type: 'color', value: base });
      const a = h('input.slider', { type: 'range', min: 0, max: 100, value: Math.round(alpha * 100), title: 'Opacity' });
      const paint = () => a.style.setProperty('--v', a.value + '%'); paint();
      const set = () => { const al = Math.round((a.value / 100) * 255); obj[key] = pick.value + (al >= 255 ? '' : al.toString(16).padStart(2, '0')); dirty = true; drawPreview(); };
      pick.addEventListener('input', set); a.addEventListener('input', () => { paint(); set(); });
      return h('div.wc-color', pick, a);
    };
    const select = (obj, key, opts, after) => h('select.field.square', { onchange: (e) => { const o = opts.find((x) => String(x[0]) === e.target.value); obj[key] = o[0]; dirty = true; drawPreview(); drawLeft(); after?.(); } }, ...opts.map(([v, l]) => h('option', { value: v, selected: obj[key] === v }, l)));
    const seg = (obj, key, opts, after) => h('div.wc-seg.small', ...opts.map(([v, l]) => h('button' + (obj[key] === v ? '.on' : ''), { onclick: () => { obj[key] = v; dirty = true; drawPreview(); drawRight(); after?.(); } }, l)));
    function geometry(e) { return h('div.wc-geo', row('X', num(e, 'x', -50, 150, 0.5)), row('Y', num(e, 'y', -50, 150, 0.5)), row('Width', num(e, 'w', 1, 200, 0.5)), row('Height', num(e, 'h', 1, 200, 0.5))); }
    async function choosePicture(target, key) {
      const files = await api.dialog?.open({ title: 'Choose a Picture', filters: [{ name: 'Pictures', patterns: ['*.png', '*.jpg', '*.jpeg', '*.webp', '*.gif', '*.svg', '*.avif'] }] }).catch(() => null);
      if (!files?.length) return;
      try { target[key] = await shrinkPicture(await api.fs.readDataUrl(files[0])); change(); drawRight(); } catch (err) { alertDialog({ title: 'Couldn’t use that picture', message: err.message }, win.el); }
    }
    let lastFetch = null;
    function drawRight() {
      right.innerHTML = '';
      if (selSource >= 0) {
        const s = spec.sources[selSource];
        const out = h('div.wc-json');
        const test = async () => {
          out.textContent = 'Loading…';
          try {
            const text = await api.net.fetch(s.url);
            const data = s.type === 'json' ? JSON.parse(text) : text;
            lastFetch = { id: s.id, data };
            out.innerHTML = '';
            out.append(h('small.wc-muted', 'Click a value to put it in the selected text:'));
            const walk = (v, path, depth) => {
              if (depth > 4 || out.childElementCount > 120) return;
              if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v).slice(0, 40)) walk(x, Array.isArray(v) ? `${path}[${k}]` : path ? `${path}.${k}` : k, depth + 1); return; }
              const ph = `{{${s.id}${path ? '.' + path : ''}}}`;
              out.append(h('div.wc-jrow', { title: 'Insert ' + ph, onclick: () => insert(ph) }, h('code', path || '(text)'), h('span', String(v).slice(0, 60))));
            };
            walk(data, '', 0);
          } catch (err) { out.textContent = 'Couldn’t load it: ' + err.message; }
        };
        right.append(h('div.wc-sec', 'Data Source'),
          row('Name', h('input.field', { value: s.id, oninput: (e) => { const v = e.target.value.replace(/[^\w]/g, '').slice(0, 30); if (/^[a-zA-Z_]/.test(v)) { s.id = v; dirty = true; drawLeft(); } } })),
          row('Address', h('input.field', { value: s.url, placeholder: 'https://api.example.com/data', oninput: (e) => { s.url = e.target.value.trim(); dirty = true; } })),
          row('Format', seg(s, 'type', [['json', 'JSON'], ['text', 'Text']])),
          row('Refresh', select(s, 'every', [[60, 'Every minute'], [300, 'Every 5 minutes'], [900, 'Every 15 minutes'], [1800, 'Every 30 minutes'], [3600, 'Every hour'], [86400, 'Once a day']])),
          h('button.btn', { onclick: test }, 'Test'), out,
          h('p.wc-muted', `Use it in text as {{${s.id}}} or a field like {{${s.id}.price}}. Only public web addresses work.`));
        return;
      }
      if (sel < 0) {
        const b = spec.background;
        right.append(h('div.wc-sec', 'Background'), row('Style', seg(b, 'type', [['glass', 'Glass'], ['color', 'Color'], ['gradient', 'Gradient'], ['image', 'Picture']])));
        if (b.type === 'color') right.append(row('Color', color(b, 'color', '#1c1c1e')));
        if (b.type === 'gradient') right.append(row('From', color(b, 'from')), row('To', color(b, 'to')), row('Angle', num(b, 'angle', 0, 360, 5)));
        if (b.type === 'image') right.append(row('Picture', h('button.btn', { onclick: () => choosePicture(b, 'image') }, b.image ? 'Change…' : 'Choose…')), row('Darken', (() => { const r = h('input.slider', { type: 'range', min: 0, max: 80, value: Math.round(b.dim * 100) }); const p = () => r.style.setProperty('--v', (r.value / 80) * 100 + '%'); p(); r.addEventListener('input', () => { p(); b.dim = r.value / 100; dirty = true; drawPreview(); }); return r; })()));
        right.append(h('div.wc-sec', 'Text'), row('Default color', color(spec, 'textColor')), row('Author', h('input.field', { value: spec.author || '', placeholder: 'Your name (shown when shared)', oninput: (e) => { spec.author = e.target.value.slice(0, 60); dirty = true; } })));
        return;
      }
      const e = spec.elements[sel];
      right.append(h('div.wc-sec', e.type[0].toUpperCase() + e.type.slice(1)));
      if (e.type === 'text') {
        const ta = h('textarea.field.wc-text', { value: e.text, rows: 3, oninput: (ev) => { e.text = ev.target.value; caret = ev.target.selectionEnd; dirty = true; drawPreview(); drawLeft(); } });
        textBox = ta;
        for (const ev of ['keyup', 'mouseup', 'select']) ta.addEventListener(ev, () => (caret = ta.selectionEnd));
        right.append(ta,
          row('Insert', h('select.field.square', { onchange: (ev) => { if (ev.target.value) insert(`{{${ev.target.value}}}`); ev.target.value = ''; } }, h('option', { value: '' }, 'Placeholder…'), ...PLACEHOLDERS.map(([v, l]) => h('option', { value: v }, l)),
            ...spec.sources.map((s) => h('option', { value: s.id }, `Data: ${s.id}`)))),
          row('Size', num(e, 'size', 6, 200)), row('Weight', select(e, 'weight', [[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Heavy']])),
          row('Font', select(e, 'font', [['system', 'System'], ['rounded', 'Rounded'], ['mono', 'Monospaced'], ['serif', 'Serif']])),
          row('Align', seg(e, 'align', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']])), row('Color', color(e, 'color', spec.textColor || '#ffffff')),
          h('p.wc-muted', 'Filters: {{cpu|round}}, {{data.price|fixed:2}}, {{weekday|upper}}, {{x|default:none}}'));
      }
      if (e.type === 'image') right.append(row('Picture', h('button.btn', { onclick: () => choosePicture(e, 'src') }, e.src ? 'Change…' : 'Choose…')),
        row('Or web address', h('input.field', { value: e.src?.startsWith('https://') ? e.src : '', placeholder: 'https://…', onchange: (ev) => { if (/^https:\/\//.test(ev.target.value)) { e.src = ev.target.value; change(); } } })),
        row('Fit', seg(e, 'fit', [['cover', 'Fill'], ['contain', 'Fit']])), row('Corners', num(e, 'radius', 0, 200)));
      if (e.type === 'shape') right.append(row('Shape', seg(e, 'shape', [['rect', 'Rectangle'], ['circle', 'Circle']])), row('Fill', color(e, 'fill')), row('Corners', num(e, 'radius', 0, 200)));
      if (e.type === 'progress') right.append(row('Style', seg(e, 'style', [['bar', 'Bar'], ['ring', 'Ring']])),
        row('Value', h('input.field', { value: e.value, placeholder: '{{battery}}', oninput: (ev) => { e.value = ev.target.value; dirty = true; drawPreview(); } })), row('Maximum', num(e, 'max', 1, 1e9)),
        row('Color', color(e, 'color', '#30d158')), row('Track', color(e, 'track', '#ffffff40')));
      if (e.type === 'icon') right.append(h('div.wc-icons', ...Object.entries(ICONS).map(([n, svg]) => h('button' + (e.name === n ? '.on' : ''), { title: n, html: svg, onclick: () => { e.name = n; change(); drawRight(); } }))), row('Color', color(e, 'color', '#ffd60a')));
      right.append(h('div.wc-sec', 'Position & Size (%)'), geometry(e));
    }
    // put a placeholder where the cursor was in the text box (or at the end), and keep it editable there
    let textBox = null, caret = null;
    function insert(ph) {
      const e = spec.elements[sel];
      if (!e || e.type !== 'text') { alertDialog({ title: 'Select a text element first', message: `Then click a value to insert ${ph}.` }, win.el); return; }
      const cur = e.text === 'Text' ? '' : e.text || '';
      const at = caret == null || caret > cur.length ? cur.length : caret;
      e.text = cur.slice(0, at) + ph + cur.slice(at);
      caret = at + ph.length;
      change(); drawRight();
      if (textBox) { textBox.focus(); textBox.setSelectionRange(caret, caret); }
    }
    function drawAll() { drawLeft(); drawPreview(); drawRight(); }

    /* ---- save / import / export */
    function save(toDesktop) {
      try { spec = validate(spec); } catch (err) { return alertDialog({ title: 'Can’t save this widget', message: err.message }, win.el); }
      saveCustom(spec); dirty = false;
      if (toDesktop) {
        const list = store.get('widgets') || [];
        if (!list.some((w) => w.type === 'custom:' + spec.id)) store.set('widgets', [...list, { id: 'w' + Date.now(), type: 'custom:' + spec.id, x: 36, y: 48 }]);
      }
      import('../notifications.js').then(({ notify }) => notify({ app: 'widgetcreator', title: `“${spec.name}” saved`, body: toDesktop ? 'It’s on your desktop and in My Widgets.' : 'Find it under My Widgets in the widget gallery.' }));
      drawAll();
    }
    async function exportFile() {
      let s; try { s = validate(spec); } catch (err) { return alertDialog({ title: 'Can’t export', message: err.message }, win.el); }
      const p = await api.dialog?.save({ title: 'Export Widget', name: `${s.name.replace(/[/\\]/g, '-')}.ldwidget`, filters: [{ name: 'LiquidDesktop widget', patterns: ['*.ldwidget'] }] }).catch(() => null);
      if (!p?.[0]) return;
      await api.fs.write(p[0], toFile(s));
      import('../notifications.js').then(({ notify }) => notify({ app: 'widgetcreator', title: 'Widget exported', body: p[0] }));
    }
    async function importFile() {
      const files = await api.dialog?.open({ title: 'Import Widget', filters: [{ name: 'LiquidDesktop widgets', patterns: ['*.ldwidget', '*.json'] }] }).catch(() => null);
      if (!files?.length) return;
      try { spec = validate(await api.fs.read(files[0])); spec.id = newId(); nameField.value = spec.name; sel = spec.elements.length ? 0 : -1; selSource = -1; dirty = true; drawAll(); }
      catch (err) { alertDialog({ title: 'Couldn’t import the widget', message: err.message }, win.el); }
    }
    win.on('close', () => previewEl?.stopCustom?.());
    drawAll();
  },
});
