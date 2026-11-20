// The Print dialog (File › Print…, ⌘P in Text Editor, Notes, Preview and Browser): a sheet like the Mac's — a
// preview on the left; printer, copies, pages, paper, orientation, color and two-sided on the right; the PDF
// button saves instead. The document is one of { html } (laid out at paper size by main/printing.js),
// { file } (a PDF or picture on disk) or { pdf: async () => bytes } (the Browser's page), plus a title.
import { h, $, fileUrl } from './util.js';
import { api } from './sys.js';
import { store } from './store.js';
import { alertDialog } from './menus.js';
import { IMAGE_EXT } from './icons.js';

const ORIENT = {
  portrait: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6" y="3" width="12" height="18" rx="1.5"/><path d="M9 8h6M9 11h6M9 14h4"/></svg>',
  landscape: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M7 10h10M7 13h7"/></svg>',
};
const PAPERS = [['Letter', 'US Letter', 8.5, 11], ['A4', 'A4', 8.27, 11.69], ['Legal', 'US Legal', 8.5, 14], ['A5', 'A5', 5.83, 8.27]];
// the paper most people near you use: Letter in the US, Canada, Mexico and the Philippines, A4 elsewhere
const localPaper = () => store.get('printPaper') || (/-(US|CA|MX|PH)$/i.test(navigator.language) || navigator.language === 'en' ? 'Letter' : 'A4');

/** Wrap an app's content in a printable page (fonts, margins, colors that print). */
export function printableHtml(title, body, css = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page { margin: 0.6in; }
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font: 11pt/1.45 "Inter Variable", "Inter", system-ui, sans-serif; color: #000; background: #fff; margin: 0; }
    img { max-width: 100%; } pre { white-space: pre-wrap; word-break: break-word; font: 9.5pt/1.4 "JetBrains Mono", "DejaVu Sans Mono", monospace; margin: 0; }
    h1, h2, h3 { line-height: 1.2; } ${css}</style></head><body>${body}</body></html>`;
}
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Open the Print dialog over a window (container: the window's element, else the whole screen). */
export async function printDialog(doc, container) {
  if (!api.print) return alertDialog({ title: 'Printing isn’t available', message: 'Printing needs the LiquidDesktop app.' }, container);
  const st = await api.print.status().catch(() => ({ printers: [] }));
  const printers = (st.printers || []).filter((p) => p.accepting !== false);
  const ext = (doc.file || '').split('.').pop().toLowerCase();
  let opt = { printer: (printers.find((p) => p.default) || printers[0])?.name || '', copies: 1, pages: '', allPages: true, media: localPaper(), landscape: false, mono: false, twoSided: false };

  const layer = h(container ? 'div.alert-layer.pd-layer' : 'div.global-alert-layer.pd-layer');
  const preview = h('div.pd-preview');
  const page = h('div.pd-page');
  preview.append(page);
  const drawPreview = () => {
    const [, , w, hgt] = PAPERS.find((p) => p[0] === opt.media) || PAPERS[0];
    const [pw, ph] = opt.landscape ? [hgt, w] : [w, hgt];
    const scale = Math.min(240 / pw, 300 / ph);
    Object.assign(page.style, { width: pw * scale + 'px', height: ph * scale + 'px', filter: opt.mono ? 'grayscale(1)' : '' });
    if (doc.html) {
      // the page at real size (96 px per inch), shrunk into the preview
      let fr = $('iframe', page);
      if (!fr) { fr = h('iframe', { sandbox: '', srcdoc: doc.html.replace('<body>', '<body style="margin:0.6in">') }); page.append(fr); }
      Object.assign(fr.style, { width: pw * 96 + 'px', height: ph * 96 + 'px', transform: `scale(${(pw * scale) / (pw * 96)})` });
    } else if (doc.file && IMAGE_EXT.has(ext)) {
      if (!$('img', page)) page.append(h('img', { src: fileUrl(doc.file), alt: '' }));
    } else if (!$('.pd-doc', page)) page.append(h('div.pd-doc', h('b', ext === 'pdf' ? 'PDF' : 'DOC'), h('small', doc.title || '')));
  };

  const printerSel = printers.length
    ? h('select.field.square', { onchange: (e) => { opt.printer = e.target.value; checkDuplex(); } }, ...printers.map((p) => h('option', { value: p.name, selected: p.name === opt.printer }, (p.info || p.name) + (p.state === 'paused' ? ' (paused)' : ''))))
    : h('div.pd-none', h('span', 'No printers'), h('button.btn', { onclick: () => { close(); import('./shell.js').then(({ shell }) => shell.openSettings('printers')); } }, 'Add Printer…'));
  const copies = h('input.field.square', { type: 'number', min: 1, max: 999, value: 1, style: { width: '64px' }, oninput: (e) => { opt.copies = Math.max(1, +e.target.value || 1); } });
  const range = h('input.field.square', { placeholder: 'e.g. 1-3, 5', disabled: true, style: { width: '120px' }, oninput: (e) => { opt.pages = e.target.value; } });
  const pagesSeg = seg([['all', 'All'], ['range', 'Range']], 'all', (v) => { opt.allPages = v === 'all'; range.disabled = opt.allPages; if (!opt.allPages) range.focus(); });
  const paper = h('select.field.square', { onchange: (e) => { opt.media = e.target.value; drawPreview(); } }, ...PAPERS.map(([v, l]) => h('option', { value: v, selected: v === opt.media }, l)));
  const orient = h('div.pd-orient', ...['portrait', 'landscape'].map((o) => h('button' + (o === 'portrait' ? '.on' : ''), { title: o[0].toUpperCase() + o.slice(1), html: ORIENT[o], onclick: (e) => {
    opt.landscape = o === 'landscape'; orient.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); drawPreview();
  } })));
  const color = seg([['color', 'Color'], ['mono', 'Black & White']], 'color', (v) => { opt.mono = v === 'mono'; drawPreview(); });
  const duplex = h('input', { type: 'checkbox', onchange: (e) => { opt.twoSided = e.target.checked; } });
  const duplexRow = h('div.pd-row', h('span', 'Two-Sided'), h('label.toggle', duplex, h('span')));
  async function checkDuplex() {
    if (!opt.printer) { duplexRow.hidden = true; return; }
    const o = await api.print.options(opt.printer).catch(() => null);
    duplexRow.hidden = !o?.duplex;
    if (!o?.duplex) { duplex.checked = false; opt.twoSided = false; }
  }
  const status = h('small.pd-status');
  const printBtn = h('button.btn.primary', { disabled: !printers.length, onclick: () => go() }, 'Print');
  const pdfBtn = h('button.btn', { onclick: () => savePdf() }, 'Save as PDF…');
  const box = h('div.alert.glass.panel.sheen.pd-box',
    h('div.pd-main', preview,
      h('div.pd-opts',
        h('div.pd-row', h('span', 'Printer'), printerSel),
        h('div.pd-sep'),
        h('div.pd-row', h('span', 'Copies'), copies),
        h('div.pd-row', h('span', 'Pages'), pagesSeg, range),
        h('div.pd-sep'),
        h('div.pd-row', h('span', 'Paper Size'), paper),
        h('div.pd-row', h('span', 'Orientation'), orient),
        h('div.pd-row', h('span', 'Color'), color),
        duplexRow)),
    h('div.pd-foot', pdfBtn, status, h('div.spacer'), h('button.btn', { onclick: () => close() }, 'Cancel'), printBtn));
  layer.append(box);
  layer.addEventListener('mousedown', (e) => e.stopPropagation());
  (container || document.body).append(layer);
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === 'Enter' && !e.target.closest('input, select') && !printBtn.disabled) { e.preventDefault(); go(); }
  };
  document.addEventListener('keydown', key, true);
  let resolve;
  const result = new Promise((r) => (resolve = r));
  function close(v = false) { layer.remove(); document.removeEventListener('keydown', key, true); resolve(v); }
  drawPreview();
  checkDuplex();

  // what to send: html / file as they are, PDF bytes fetched now (the Browser's page)
  const payload = async () => (doc.pdf ? { pdf: await doc.pdf({ landscape: opt.landscape, pageSize: opt.media }), title: doc.title } : { html: doc.html, file: doc.file, title: doc.title });
  async function go() {
    if (!opt.allPages && opt.pages && !/^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/.test(opt.pages)) { status.textContent = 'Pages: numbers and ranges, like 1-3, 5'; range.focus(); return; }
    printBtn.disabled = true; status.textContent = 'Sending to the printer…';
    try {
      const r = await api.print.doc(opt.printer, await payload(), { copies: opt.copies, pages: opt.allPages ? '' : opt.pages, media: opt.media, landscape: opt.landscape, mono: opt.mono, twoSided: duplexRow.hidden ? undefined : opt.twoSided, title: doc.title, fit: !!doc.file && IMAGE_EXT.has(ext) });
      close(true);
      const p = printers.find((x) => x.name === opt.printer);
      import('./shell.js').then(({ shell }) => shell.notify?.({ app: 'settings', title: 'Printing', body: `${doc.title || 'Document'} — sent to ${p?.info || opt.printer}${r?.job ? '' : ''}.` }));
    } catch (e) { printBtn.disabled = false; status.textContent = e.message; }
  }
  async function savePdf() {
    const name = (doc.title || 'Document').replace(/\.[^.]+$/, '').replace(/[/\\]/g, '-') + '.pdf';
    const dest = await api.dialog?.save({ title: 'Save as PDF', name, filters: [{ name: 'PDF', patterns: ['*.pdf'] }] }).catch(() => null);
    const file = Array.isArray(dest) ? dest[0] : dest;
    if (!file) return;
    status.textContent = 'Saving…';
    try { await api.print.savePdf(await payload(), file, { landscape: opt.landscape, media: opt.media }); close(true); import('./shell.js').then(({ shell }) => shell.notify?.({ app: 'files', title: 'Saved as PDF', body: file.split('/').pop(), action: () => api.fs.reveal?.(file) })); }
    catch (e) { status.textContent = e.message; }
  }
  return result;
}

function seg(opts, cur, on) {
  const el = h('div.segmented.pd-seg');
  for (const [v, l] of opts) el.append(h('button' + (v === cur ? '.on' : ''), { onclick: (e) => { el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); on(v); } }, l));
  return el;
}
