// Glass menus (dropdowns + context menus) and alert dialogs.
import { h, svg } from './util.js';
import { sym } from './icons.js';
import { attachLens } from './theme.js';

let openMenu = null;

/**
 * items: [{ label, shortcut, icon, action, disabled, checked, danger, submenu: [...] } | '-' | { header }]
 * Returns a close() function.
 */
export function showMenu(items, x, y, { onClose, anchor, minWidth, className } = {}) {
  closeMenu();
  const el = h('div.menu.glass.panel.lens-soft' + (className ? '.' + className : ''));
  if (minWidth) el.style.minWidth = minWidth + 'px';
  let sub = null;
  const close = () => {
    if (!el.isConnected) return;
    sub?.close();
    el.classList.add('closing');
    setTimeout(() => el.remove(), 140);
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', keys, true);
    if (openMenu?.el === el) openMenu = null;
    onClose?.();
  };
  const outside = (e) => { if (!el.contains(e.target) && !e.target.closest?.('.menu') && !(anchor && anchor.contains(e.target))) close(); };
  let active = -1;
  const rows = [];
  const keys = (e) => {
    if (sub && sub.handles(e)) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      const enabled = rows.filter((r) => !r.classList.contains('disabled'));
      if (!enabled.length) return;
      let i = enabled.indexOf(rows[active]);
      i = e.key === 'ArrowDown' ? (i + 1) % enabled.length : (i - 1 + enabled.length) % enabled.length;
      rows.forEach((r) => r.classList.remove('active'));
      active = rows.indexOf(enabled[i]); enabled[i].classList.add('active');
    } else if (e.key === 'Enter' && rows[active]) { e.preventDefault(); e.stopPropagation(); rows[active].click(); }
  };
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { el.append(h('div.menu-sep')); continue; }
    if (it.header) { el.append(h('div.menu-header', it.header)); continue; }
    if (it.element) { el.append(it.element); continue; }
    const row = h('div.menu-item' + (it.disabled ? '.disabled' : '') + (it.danger ? '.danger' : ''),
      it.checked !== undefined ? h('span.mi-check', it.checked ? '✓' : '') : null,
      it.icon ? h('span.mi-icon', { html: it.icon }) : null,
      h('span', it.label),
      it.shortcut ? h('span.mi-sc', it.shortcut) : null,
      it.submenu ? h('span.mi-sub', { html: '›' }) : null);
    rows.push(row);
    if (it.submenu) {
      row.addEventListener('mouseenter', () => {
        sub?.close();
        const r = row.getBoundingClientRect();
        sub = showSubmenu(it.submenu, r.right + 4, r.top - 5, close);
      });
    } else {
      row.addEventListener('mouseenter', () => { sub?.close(); sub = null; });
      row.addEventListener('click', (e) => { e.stopPropagation(); if (it.disabled) return; closeMenu(true); setTimeout(() => it.action?.(), 0); });
    }
    el.append(row);
  }
  document.body.append(el);
  const r = el.getBoundingClientRect();
  if (x + r.width > innerWidth - 6) x = Math.max(6, innerWidth - r.width - 6);
  if (y + r.height > innerHeight - 6) y = Math.max(6, innerHeight - r.height - 6);
  el.style.left = x + 'px'; el.style.top = y + 'px';
  setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', keys, true); });
  openMenu = { el, close };
  return close;
}

function showSubmenu(items, x, y, closeParent) {
  const el = h('div.menu.glass.panel');
  const rows = [];
  for (const it of items) {
    if (it === '-') { el.append(h('div.menu-sep')); continue; }
    const row = h('div.menu-item' + (it.disabled ? '.disabled' : ''),
      it.checked !== undefined ? h('span.mi-check', it.checked ? '✓' : '') : null,
      it.icon ? h('span.mi-icon', { html: it.icon }) : null, h('span', it.label));
    row.addEventListener('click', (e) => { e.stopPropagation(); if (it.disabled) return; closeParent(); setTimeout(() => it.action?.(), 0); });
    rows.push(row); el.append(row);
  }
  document.body.append(el);
  const r = el.getBoundingClientRect();
  if (x + r.width > innerWidth - 6) x = x - r.width - 220;
  if (y + r.height > innerHeight - 6) y = innerHeight - r.height - 6;
  el.style.left = x + 'px'; el.style.top = y + 'px';
  return { close: () => el.remove(), handles: () => false };
}

export function closeMenu(all) { if (openMenu) openMenu.close(); }
export const menuIsOpen = () => !!openMenu;

/** Context menu helper. */
export function contextMenu(e, items) {
  e.preventDefault(); e.stopPropagation();
  return showMenu(items, e.clientX, e.clientY);
}

/**
 * Alert dialog (glass, centered). Attach to a window element or the whole screen.
 * opts: { title, message, icon (html), input: { value, placeholder, select }, buttons: [{label, value, primary, danger}] }
 * Resolves with { button, value }.
 */
export function alertDialog(opts, container) {
  return new Promise((resolve) => {
    const layer = h(container ? 'div.alert-layer' : 'div.global-alert-layer');
    let input = null;
    const done = (button) => { layer.remove(); document.removeEventListener('keydown', key, true); resolve({ button, value: input?.value }); };
    const btns = (opts.buttons || [{ label: 'OK', value: 'ok', primary: true }]).map((b) =>
      h('button.btn' + (b.primary ? '.primary' : '') + (b.danger ? '.danger' : ''), { onclick: () => done(b.value ?? b.label) }, b.label));
    if (opts.input) {
      input = h('input.field.square', { value: opts.input.value || '', placeholder: opts.input.placeholder || '', type: opts.input.type || 'text' });
    }
    const box = h('div.alert.glass.panel.sheen',
      opts.icon ? h('div.a-icon', { html: opts.icon }) : null,
      h('h3', opts.title || ''), opts.message ? h('p', opts.message) : null, input,
      h('div.a-btns' + (btns.length > 2 ? '.stack' : ''), btns));
    layer.append(box);
    layer.addEventListener('mousedown', (e) => e.stopPropagation());
    (container || document.body).append(layer);
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(opts.cancelValue ?? 'cancel'); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); const p = (opts.buttons || []).find((b) => b.primary); done(p ? (p.value ?? p.label) : 'ok'); }
    };
    document.addEventListener('keydown', key, true);
    if (input) setTimeout(() => {
      input.focus();
      if (opts.input.select === 'stem') { const i = input.value.lastIndexOf('.'); input.setSelectionRange(0, i > 0 ? i : input.value.length); }
      else input.select();
    }, 50);
  });
}

export const prompt = async (title, value, opts = {}, container) => {
  const r = await alertDialog({ title, message: opts.message, icon: opts.icon, input: { value, placeholder: opts.placeholder, select: opts.select, type: opts.type },
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: opts.ok || 'OK', value: 'ok', primary: true }] }, container);
  return r.button === 'ok' ? r.value : null;
};
export const confirmDialog = async (title, message, ok = 'OK', opts = {}, container) => {
  const r = await alertDialog({ title, message, icon: opts.icon, buttons: [{ label: 'Cancel', value: 'cancel' }, { label: ok, value: 'ok', primary: !opts.danger, danger: opts.danger }] }, container);
  return r.button === 'ok';
};

/**
 * Every <select> opens a Liquid Glass menu instead of the native (unthemed, often unreadable) list.
 * The <select> stays the source of truth: picking an item sets its value and fires input/change.
 */
export function enhanceSelects(root = document) {
  const open = (sel) => {
    if (sel.disabled) return;
    const r = sel.getBoundingClientRect();
    const items = [];
    for (const node of sel.children) {
      if (node.tagName === 'OPTGROUP') {
        items.push({ header: node.label });
        for (const o of node.children) items.push(item(sel, o));
      } else if (node.tagName === 'OPTION') items.push(item(sel, node));
    }
    showMenu(items, r.left, r.bottom + 4, { minWidth: Math.max(160, r.width), className: 'select-menu' });
    // put the chosen item near the field, like macOS
  };
  const item = (sel, o) => ({
    label: o.textContent, checked: o.selected, disabled: o.disabled,
    action: () => {
      if (sel.value === o.value) return;
      sel.value = o.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    },
  });
  root.addEventListener('mousedown', (e) => {
    const sel = e.target.closest?.('select');
    if (!sel || e.button !== 0) return;
    e.preventDefault();
    sel.focus();
    open(sel);
  }, true);
  root.addEventListener('keydown', (e) => {
    const sel = e.target.closest?.('select');
    if (!sel) return;
    if (e.key === 'Enter' || e.key === ' ' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) { e.preventDefault(); open(sel); }
  }, true);
}
