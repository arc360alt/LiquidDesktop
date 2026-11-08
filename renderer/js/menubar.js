// The menu bar: system menu, app menus, status items and clock. Transparent over the wallpaper (macOS 26).
import { h, $, bus } from './util.js';
import { sym, logo } from './icons.js';
import { showMenu, closeMenu } from './menus.js';
import { wm } from './wm.js';
import { store } from './store.js';
import { status } from './status.js';
import { shell } from './shell.js';
import { catalog } from './catalog.js';
import { api } from './sys.js';
import { isSession, session as S } from './layer.js';

let bar, appArea, statusArea, clockEl, battEl, wifiEl, openTitle = null;

function fmtClock(d = new Date()) {
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: store.get('showSeconds') ? '2-digit' : undefined, hour12: !store.get('clock24') });
  return `${day} ${time}`;
}

function editItems() {
  // in a session the focused app is another window, so ask the WM to run the command there
  const ex = (c) => () => (isSession ? S.send('wm:edit', c) : document.execCommand(c));
  return [
    { label: 'Undo', shortcut: '⌃Z', action: ex('undo') }, { label: 'Redo', shortcut: '⇧⌃Z', action: ex('redo') }, '-',
    { label: 'Cut', shortcut: '⌃X', action: ex('cut') }, { label: 'Copy', shortcut: '⌃C', action: ex('copy') },
    { label: 'Paste', shortcut: '⌃V', action: ex('paste') }, { label: 'Select All', shortcut: '⌃A', action: ex('selectAll') }, '-',
    { label: 'Emoji & Symbols', disabled: true },
  ];
}

function windowItems(win) {
  const items = [
    { label: 'Minimize', shortcut: '⌘M', disabled: !win, action: () => win.minimize() },
    { label: 'Zoom', disabled: !win, action: () => win.toggleMaximize() },
    { label: 'Fill', shortcut: '⌥⇧F', disabled: !win, action: () => win.tileTo('fill') },
    { label: 'Center', disabled: !win, action: () => win.tileTo('center') },
    { label: 'Move & Resize', disabled: !win, submenu: win ? [
      { label: 'Left', action: () => win.tileTo('left') }, { label: 'Right', action: () => win.tileTo('right') },
      { label: 'Top Left', action: () => win.tileTo('tl') }, { label: 'Top Right', action: () => win.tileTo('tr') },
      { label: 'Bottom Left', action: () => win.tileTo('bl') }, { label: 'Bottom Right', action: () => win.tileTo('br') }] : [] },
    { label: 'Full Screen', shortcut: '⌃⌘F', disabled: !win, action: () => win.toggleFullscreen() },
    '-', { label: 'Mission Control', shortcut: 'F3', action: () => wm.mission() },
    { label: 'Bring All to Front', action: () => win && wm.activate(win.app.id) }, '-',
  ];
  for (const w of wm.windows.filter((x) => win && x.app === win.app)) items.push({ label: w.title, checked: w === wm.focused, action: () => w.focus() });
  return items;
}

function appMenus() {
  const win = wm.focused;
  const app = win ? win.app : { id: 'files', name: 'Files', builtin: true };
  const custom = app.menus ? app.menus(win) : [];
  const has = (t) => custom.some((m) => m.title === t);
  const menus = [{
    title: app.name, bold: true, items: [
      { label: `About ${app.name}`, action: () => shell.aboutApp(app) }, '-',
      { label: 'System Settings…', shortcut: '⌘,', action: () => wm.open('settings') }, '-',
      { label: `Hide ${app.name}`, shortcut: '⌘H', disabled: !win, action: () => wm.appWindows(app.id).forEach((w) => w.minimize()) },
      { label: 'Hide Others', shortcut: '⌥⌘H', action: () => wm.hideOthers() }, '-',
      { label: `Quit ${app.name}`, shortcut: '⌘Q', disabled: !win, action: () => wm.quitApp(app.id) },
    ],
  }];
  if (!has('File')) menus.push({ title: 'File', items: [
    { label: 'New Window', shortcut: '⌘N', disabled: !app.builtin && !app.exec, action: () => (app.builtin ? wm.open(win ? app.id : 'files') : api.apps.launch(app.exec, app.terminal)) },
    '-', { label: 'Close Window', shortcut: '⌘W', disabled: !win, action: () => win.close() }] });
  if (!has('Edit')) menus.push({ title: 'Edit', items: editItems() });
  menus.push(...custom.filter((m) => m.title !== 'Window' && m.title !== 'Help'));
  if (!custom.some((m) => m.title === 'View')) menus.push({ title: 'View', items: [
    { label: 'Show Desktop', shortcut: 'F11', action: () => wm.toggleDesktop() },
    { label: 'Mission Control', shortcut: 'F3', action: () => wm.mission() },
    { label: 'Apps', shortcut: 'F4', action: () => shell.launchpad() },
    '-', { label: 'Enter Full Screen', disabled: !win, action: () => win.toggleFullscreen() }] });
  menus.push({ title: 'Window', items: windowItems(win) });
  menus.push({ title: 'Help', items: [
    { label: 'Keyboard Shortcuts', action: () => wm.open('settings', { pane: 'keyboard' }) },
    { label: 'About LiquidDesktop', action: () => wm.open('about') }] });
  return menus;
}

function systemMenu() {
  return [
    { label: 'About This Computer', action: () => wm.open('about') }, '-',
    { label: 'System Settings…', action: () => wm.open('settings') },
    { label: 'Apps', action: () => shell.launchpad() }, '-',
    { label: 'Force Quit…', shortcut: '⌥⌘⎋', action: () => wm.open('monitor') }, '-',
    { label: 'Sleep', action: () => shell.power('suspend') },
    { label: 'Restart…', action: () => shell.power('restart') },
    { label: 'Shut Down…', action: () => shell.power('shutdown') }, '-',
    { label: 'Lock Screen', shortcut: '⌃⌘Q', action: () => shell.lock() },
    { label: `Log Out ${shell.info?.fullName || ''}…`, shortcut: '⇧⌘Q', action: () => shell.power('logout') },
  ];
}

function openDropdown(item, items) {
  const r = item.getBoundingClientRect();
  item.classList.add('open');
  openTitle = item;
  showMenu(items, r.left, r.bottom + 4, { anchor: item, onClose: () => { item.classList.remove('open'); if (openTitle === item) openTitle = null; } });
}

function bindMenuTitle(item, getItems) {
  item.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    if (openTitle === item) { closeMenu(); return; }
    openDropdown(item, getItems());
  });
  item.addEventListener('mouseenter', () => {
    if (openTitle && openTitle !== item && openTitle.closest('#menubar')) { closeMenu(); openDropdown(item, getItems()); }
  });
}

function renderAppMenus() {
  appArea.innerHTML = '';
  for (const m of appMenus()) {
    const it = h('div.mb-item' + (m.bold ? '.bold' : ''), m.title);
    bindMenuTitle(it, () => m.items);
    appArea.append(it);
  }
}

function renderStatus() {
  const s = status.s;
  // battery
  if (s.battery && s.battery.percent != null) {
    battEl.hidden = false;
    const p = s.battery.percent;
    battEl.innerHTML = '';
    if (store.get('showBatteryPct')) battEl.append(h('span', `${p}%`));
    battEl.append(h('div.batt-icon' + (p <= 15 && !s.battery.charging ? '.low' : '') + (s.battery.charging ? '.charging' : ''), h('i', { style: { width: Math.max(8, p) + '%' } })));
  } else battEl.hidden = true;
  // network
  const w = s.wifi;
  wifiEl.innerHTML = !w ? sym.globe : w.wired && !w.ssid ? sym.ethernet : w.enabled && w.ssid ? sym.wifi : sym.wifiOff;
  wifiEl.title = w?.ssid || (w?.wired ? 'Ethernet' : 'Not connected');
}

export function initMenubar() {
  bar = $('#menubar');
  const logoItem = h('div.mb-item.mb-logo', { html: logo() });
  bindMenuTitle(logoItem, systemMenu);
  appArea = h('div', { style: { display: 'flex', gap: '2px' } });
  battEl = h('div.mb-item.mb-batt', { onclick: () => shell.toggleControlCenter('battery') });
  wifiEl = h('div.mb-item', { onclick: () => shell.toggleControlCenter('wifi') });
  const search = h('div.mb-item', { html: sym.search, title: 'Spotlight (Alt+Space)', onclick: () => shell.spotlight() });
  const cc = h('div.mb-item', { html: sym.controls, title: 'Control Center', onclick: (e) => { e.stopPropagation(); shell.toggleControlCenter(); } });
  clockEl = h('div.mb-item', { onclick: () => shell.toggleNotificationCenter() });
  statusArea = h('div#mb-status', battEl, wifiEl, search, cc, clockEl);
  bar.append(logoItem, appArea, statusArea);

  // only touch the DOM when the text changes, so the shell doesn't repaint every second
  const tick = () => { const t = fmtClock(); if (clockEl.textContent !== t) clockEl.textContent = t; };
  tick();
  setInterval(tick, 1000);
  renderAppMenus();
  bus.on('focus', renderAppMenus);
  bus.on('windows', () => {
    renderAppMenus();
    // give the bar a material when a window touches it so text stays readable
    const touching = wm.windows.some((w) => w.space === wm.currentSpace && !w.minimized && w.y <= 34 && !w.fullscreen);
    bar.classList.toggle('solid', touching);
  });
  bus.on('status', renderStatus);
  bus.on('wallpaper-luma', (l) => bar.classList.toggle('dark-text', l > 0.68));
  store.on('change', (k) => { if (['clock24', 'showSeconds'].includes(k)) tick(); if (k === 'showBatteryPct') renderStatus(); });
}
