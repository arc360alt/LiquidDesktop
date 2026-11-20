// Clipboard History (Super+V, or Edit › Clipboard History): what you copied lately, newest first — pick one and
// it's pasted into the app you were in. Search, pin the ones you keep using, ⌃1…⌃9 for the first nine,
// ⇧Enter pastes without formatting. The history itself is kept by the main process (main/clipboard.js).
import { h, $, $$, fileUrl, timeAgo } from './util.js';
import { api } from './sys.js';
import { registry } from './wm.js';
import { isSession, session as S } from './layer.js';
import { contextMenu } from './menus.js';

let layerEl = null, target = null, saved = null;
const textLike = (a) => !!a && (a.isContentEditable || a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|url|email|)$/.test(a.type)));
const ICON = {
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 6h14M5 10.5h14M5 15h9M5 19.5h6"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg>',
  files: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14.5 3.2 20.8 9.5l-1.4 1.4-1-.6-3.6 3.6.4 4-1.4 1.4-3.5-3.5-4.6 4.6-1.4-.1-.1-1.4 4.6-4.6L5.3 10.4l1.4-1.4 4 .4 3.6-3.6-.6-1z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="5.5" y="4" width="13" height="17" rx="2.2"/><path d="M9 4V3h6v1"/></svg>',
};
const FILTERS = [['all', 'All'], ['text', 'Text'], ['link', 'Links'], ['image', 'Images'], ['pinned', 'Pinned']];

addEventListener('focusin', (e) => { if (textLike(e.target) && !e.target.closest('#clip-picker')) target = e.target; }, true);

export const clipOpen = () => !!layerEl;
export function closeClipboard() { close(); }
function close() {
  if (!layerEl) return;
  const l = layerEl; layerEl = null;
  l.classList.add('closing');
  setTimeout(() => l.remove(), 160);
}

/** Open the picker near `at` ({x, y}, CSS pixels), else near the pointer. Opening it again closes it. */
export async function openClipboard(at) {
  if (layerEl) { close(); return; }
  if (!api.cliph) return;
  const a = document.activeElement;
  if (textLike(a)) target = a;
  saved = null;
  if (target?.isContentEditable) { const sel = getSelection(); if (sel.rangeCount && target.contains(sel.anchorNode)) saved = { range: sel.getRangeAt(0).cloneRange() }; }
  else if (target && 'selectionStart' in target) saved = { start: target.selectionStart, end: target.selectionEnd };
  if (isSession && !at) {
    const p = await S.invoke('wm:pointer').catch(() => null);
    if (p) at = { x: p.x / (devicePixelRatio || 1) - screenLeft, y: p.y / (devicePixelRatio || 1) - screenTop };
  }
  build(at);
}

/** The testing window: put text straight into the field you were typing in (no other app to paste into). */
function insertHere(text) {
  const el = target;
  if (!el || !el.isConnected) return false;
  el.focus();
  if (saved?.range) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(saved.range); }
  else if (saved && 'selectionStart' in el) { try { el.setSelectionRange(saved.start, saved.end); } catch { /* not a text input */ } }
  if (!document.execCommand('insertText', false, text) && 'value' in el) {
    const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
    el.value = el.value.slice(0, s) + text + el.value.slice(e);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
}

function build(at) {
  const W = 380, H = 470;
  let data = { items: [] }, filter = 'all', query = '', cur = 0, shown = [];
  const search = h('input.ej-search', { placeholder: 'Search Clipboard', spellcheck: false, autocomplete: 'off' });
  const list = h('div.clp-list');
  const chips = h('div.clp-chips');
  const foot = h('div.clp-foot');
  const panel = h('div#clip-picker.glass.panel',
    h('div.clp-title', h('span', { html: ICON.clip }), h('b', 'Clipboard'), h('small', 'Super+V')),
    h('div.ej-top', h('span.ej-sicon', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.6-4.6"/></svg>' }), search),
    chips, list, foot);
  layerEl = h('div#clip-layer', panel);
  layerEl.addEventListener('mousedown', (e) => { if (!panel.contains(e.target) && !e.target.closest('.menu')) close(); });
  document.body.append(layerEl);
  const x = Math.round(Math.max(8, Math.min(innerWidth - W - 8, (at?.x ?? innerWidth / 2 - W / 2) - 20)));
  let y = Math.round((at?.y ?? innerHeight / 4) + 18);
  if (y + H > innerHeight - 8) y = Math.max(36, (at?.y ?? innerHeight) - H - 18);
  Object.assign(panel.style, { left: x + 'px', top: y + 'px', width: W + 'px', height: H + 'px' });

  const appName = (it) => {
    const a = it.app;
    if (!a) return '';
    if (a.appId) return registry.get(a.appId)?.name || a.appId;
    return (a.wmClass || '').replace(/[-_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  };
  const matches = (it) => {
    if (filter === 'pinned' && !it.pinned) return false;
    if (filter === 'text' && !(it.kind === 'text' || it.kind === 'color' || it.kind === 'files')) return false;
    if (filter === 'link' && it.kind !== 'link') return false;
    if (filter === 'image' && it.kind !== 'image') return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return (it.text || '').toLowerCase().includes(q) || appName(it).toLowerCase().includes(q) || (it.kind === 'image' && 'image picture screenshot'.includes(q));
  };
  const preview = (it) => {
    if (it.kind === 'image') return h('div.clp-img', h('img', { src: fileUrl(it.file) + '?' + it.id, alt: '' }));
    const t = it.text.replace(/\s+/g, ' ').trim();
    if (it.kind === 'files') {
      const names = it.text.split(/\r?\n/).filter(Boolean).map((u) => decodeURIComponent(u.replace(/^file:\/\//, '')).split('/').pop());
      return h('div.clp-text', names.length === 1 ? names[0] : `${names.length} files — ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`);
    }
    return h('div.clp-text' + (it.kind === 'link' ? '.link' : ''), t.length > 220 ? t.slice(0, 220) + '…' : t);
  };
  const badge = (it) => {
    if (it.kind === 'color') return h('span.clp-kind.swatch', { style: { background: it.text.trim() } });
    if (it.kind === 'image') return null;
    return h('span.clp-kind', { html: ICON[it.kind] || ICON.text });
  };
  function draw() {
    chips.replaceChildren(...FILTERS.map(([k, l]) => h('button' + (filter === k ? '.on' : ''), { onclick: () => { filter = k; cur = 0; draw(); } }, l)));
    shown = data.items.filter(matches);
    if (cur >= shown.length) cur = Math.max(0, shown.length - 1);
    list.replaceChildren();
    if (!data.enabled) list.append(h('div.clp-empty', h('b', 'Clipboard History is off'), h('p', 'Turn it on in Settings › Keyboard to keep what you copy.'), h('button.btn', { onclick: () => { close(); import('./shell.js').then(({ shell }) => shell.openSettings('keyboard')); } }, 'Open Settings')));
    else if (!shown.length) list.append(h('div.clp-empty', h('b', data.items.length ? 'No Results' : 'Nothing copied yet'), h('p', data.items.length ? '' : 'Copy some text or a picture and it shows up here.')));
    shown.forEach((it, i) => {
      const row = h('div.clp-item' + (i === cur ? '.cur' : '') + (it.kind === 'image' ? '.image' : ''),
        badge(it), h('div.clp-body', preview(it), h('small', [it.kind === 'image' ? `${it.w} × ${it.h}` : null, appName(it), timeAgo(it.t)].filter(Boolean).join(' · '))),
        h('div.clp-side', i < 9 ? h('kbd', '⌃' + (i + 1)) : null,
          h('div.clp-acts',
            h('button' + (it.pinned ? '.on' : ''), { title: it.pinned ? 'Unpin' : 'Pin', html: ICON.pin, onmousedown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); api.cliph.pin(it.id, !it.pinned); } }),
            h('button', { title: 'Delete', html: ICON.trash, onmousedown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); api.cliph.remove(it.id); } }))),
        it.pinned ? h('span.clp-pinned', { html: ICON.pin }) : null);
      row.addEventListener('mousemove', () => { if (cur !== i) { cur = i; mark(); } });
      row.addEventListener('click', (e) => pick(it, e.shiftKey));
      row.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Paste', action: () => pick(it) },
        it.kind !== 'image' && it.html ? { label: 'Paste as Plain Text', action: () => pick(it, true) } : null,
        { label: 'Copy', action: () => { api.cliph.use(it.id, { paste: false }); close(); } }, '-',
        { label: it.pinned ? 'Unpin' : 'Pin', action: () => api.cliph.pin(it.id, !it.pinned) },
        { label: 'Delete', danger: true, action: () => api.cliph.remove(it.id) },
      ].filter(Boolean)));
      list.append(row);
    });
    const count = data.items.length;
    foot.replaceChildren(h('small', data.enabled ? `${count} item${count === 1 ? '' : 's'}` : 'Off'), h('div.spacer'),
      h('button.btn.plain', { disabled: !count, onclick: () => api.cliph.clear(true) }, 'Clear'),
      h('button.btn.plain', { onclick: () => { close(); import('./shell.js').then(({ shell }) => shell.openSettings('keyboard')); } }, 'Settings…'));
  }
  const mark = () => $$('.clp-item', list).forEach((r, i) => { r.classList.toggle('cur', i === cur); if (i === cur) r.scrollIntoView({ block: 'nearest' }); });
  async function pick(it, plain = false) {
    if (!it) return;
    close();
    if (isSession) { await api.cliph.use(it.id, { paste: true, plain }); return; }
    // the testing window: there's no other app; text goes into the field you were in, anything else is copied
    await api.cliph.use(it.id, { paste: false, plain });
    if (it.kind !== 'image') insertHere(it.text);
  }
  async function reload() {
    if (!layerEl) return;
    data = await api.cliph.list().catch(() => ({ items: [], enabled: true }));
    draw();
  }
  search.addEventListener('input', () => { query = search.value.trim(); cur = 0; draw(); });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(0, Math.min(shown.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1))); mark(); return; }
    if (e.key === 'Enter') { e.preventDefault(); pick(shown[cur], e.shiftKey); return; }
    if (e.ctrlKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); pick(shown[+e.key - 1]); return; }
    if (e.ctrlKey && (e.key === 'p' || e.key === 'P') && shown[cur]) { e.preventDefault(); api.cliph.pin(shown[cur].id, !shown[cur].pinned); return; }
    if (e.key === 'Delete' && shown[cur] && (!search.value || e.target !== search)) { e.preventDefault(); api.cliph.remove(shown[cur].id); return; }
    if (e.key === 'Tab') { e.preventDefault(); const i = FILTERS.findIndex(([k]) => k === filter); filter = FILTERS[(i + (e.shiftKey ? FILTERS.length - 1 : 1)) % FILTERS.length][0]; cur = 0; draw(); }
  });
  hookChanges(reload);
  draw();
  reload();
  setTimeout(() => search.focus(), 30);
}

let hooked = false, onChange = null;
function hookChanges(fn) {
  onChange = fn;
  if (hooked || !api.cliph?.onChanged) return;
  hooked = true;
  api.cliph.onChanged(() => onChange?.());
}
