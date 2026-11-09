// Spotlight, Apps (Launchpad), app switcher, and the volume/brightness HUD.
import { h, $, $$, bus, debounce, basename, dirname, clamp } from './util.js';
import { appIcon, sym, folderIcon, docIcon } from './icons.js';
import { catalog } from './catalog.js';
import { wm } from './wm.js';
import { api } from './sys.js';
import { store } from './store.js';
import { attachLens } from './theme.js';
import { shell } from './shell.js';

/* ================================================================== Spotlight */
let spot = null;

function safeCalc(q) {
  if (!/^[\d\s+\-*/().,%^e]+$/i.test(q) || !/\d/.test(q) || !/[+\-*/^%]/.test(q)) return null;
  try {
    const v = Function(`"use strict";return (${q.replace(/\^/g, '**').replace(/,/g, '')})`)();
    return typeof v === 'number' && isFinite(v) ? +v.toPrecision(12) : null;
  } catch { return null; }
}

const ACTIONS = [
  { title: 'Lock Screen', icon: sym.lock, run: () => shell.lock(), k: 'lock' },
  { title: 'Toggle Dark Mode', icon: sym.contrast, run: () => store.set('theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'), k: 'dark light theme appearance' },
  { title: 'Take Screenshot', icon: sym.camera, run: () => setTimeout(() => shell.screenshot(), 300), k: 'screenshot capture' },
  { title: 'Mission Control', icon: sym.layers, run: () => wm.mission(), k: 'mission spaces desktops windows' },
  { title: 'Show Desktop', icon: sym.desktop, run: () => wm.toggleDesktop(), k: 'desktop' },
  { title: 'Toggle Night Shift', icon: sym.nightshift, run: () => store.set('nightShift', !store.get('nightShift')), k: 'night shift warm' },
  { title: 'Toggle Do Not Disturb', icon: sym.moon, run: () => store.set('dnd', !store.get('dnd')), k: 'focus dnd do not disturb' },
  { title: 'Empty Trash', icon: sym.trash, run: () => shell.emptyTrash(), k: 'trash empty' },
  { title: 'Edit Widgets', icon: sym.widgets, run: () => shell.editWidgets(), k: 'widgets' },
  { title: 'New Desktop', icon: sym.plus, run: () => wm.addSpace(), k: 'space desktop add new' },
  { title: 'Restart LiquidDesktop', icon: sym.restart, run: () => shell.power('restart'), k: 'restart reboot' },
  { title: 'Shut Down', icon: sym.power, run: () => shell.power('shutdown'), k: 'shutdown power off' },
];

export function spotlight() {
  if (spot) return closeSpotlight();
  let filter = 'all', results = [], sel = 0, fileResults = [], query = '';
  const input = h('input', { placeholder: 'Spotlight Search', spellcheck: false });
  const bar = h('div.bar.glass.panel.sheen', { html: sym.search }, input);
  const chips = h('div.chips');
  const list = h('div.results.glass.panel', { hidden: true });
  const box = h('div#spotlight', bar, chips, list);
  const layer = h('div#spotlight-layer', box);
  layer.addEventListener('mousedown', (e) => { if (!box.contains(e.target)) closeSpotlight(); });
  const chipDefs = [['all', 'All', sym.sparkles], ['apps', 'Apps', sym.grid], ['files', 'Files', sym.folder], ['actions', 'Actions', sym.controls]];
  const drawChips = () => {
    chips.innerHTML = '';
    for (const [k, l, ic] of chipDefs) chips.append(h('button.chip.glass.panel' + (filter === k ? '.on' : ''), { html: ic + `<span>${l}</span>`, onclick: () => { filter = k; drawChips(); update(); input.focus(); } }));
  };
  const score = (name, q) => { const n = name.toLowerCase(); if (n === q) return 100; if (n.startsWith(q)) return 80; if (n.split(/\s+/).some((w) => w.startsWith(q))) return 60; if (n.includes(q)) return 40; return 0; };

  const update = () => {
    query = input.value.trim();
    const q = query.toLowerCase();
    results = [];
    if (!q) { list.hidden = true; if (filter !== 'all') showAll(); return; }
    const calc = safeCalc(query);
    if (calc != null && filter === 'all') results.push({ sec: 'Calculator', title: String(calc), sub: query, calc: true, icon: sym.calc, run: () => api.clip.write(String(calc)), hint: 'Copy' });
    if (filter === 'all' || filter === 'apps') {
      const apps = catalog.all().map((a) => ({ a, s: Math.max(score(a.name, q), ...(a.keywords || []).map((k) => score(k, q) * 0.6)) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s || (y.a.builtin ? 1 : 0) - (x.a.builtin ? 1 : 0)).slice(0, filter === 'apps' ? 30 : 6);
      for (const { a } of apps) results.push({ sec: 'Applications', title: a.name, sub: a.builtin ? 'LiquidDesktop' : a.comment, app: a, run: () => catalog.launch(a), hint: 'Open' });
    }
    if (filter === 'all' || filter === 'actions') {
      for (const a of ACTIONS.filter((a) => score(a.title, q) || a.k.includes(q)).slice(0, 5)) results.push({ sec: 'Actions', title: a.title, icon: a.icon, run: a.run, hint: 'Run' });
      for (const [pane, label] of [['appearance', 'Appearance'], ['wallpaper', 'Wallpaper'], ['dock', 'Desktop & Dock'], ['display', 'Displays'], ['sound', 'Sound'], ['network', 'Wi-Fi'], ['keyboard', 'Keyboard Shortcuts']])
        if (score(label, q)) results.push({ sec: 'System Settings', title: label, icon: sym.gear, run: () => shell.openSettings(pane), hint: 'Settings' });
    }
    if (filter === 'all' || filter === 'files') for (const f of fileResults) results.push({ sec: 'Files', title: f.name, sub: dirname(f.path).replace(shell.home, '~'), file: f, run: () => shell.openPath(f.path, f.isDir), hint: 'Open' });
    if (filter === 'all' && /^(https?:\/\/|www\.)|\.\w{2,}(\/|$)/.test(query) && !/\s/.test(query)) results.unshift({ sec: 'Web', title: query, sub: 'Open in Browser', icon: sym.globe, run: () => wm.open('browser', { url: query }), hint: 'Open' });
    if (filter === 'all') results.push({ sec: 'Web', title: `Search the web for “${query}”`, icon: sym.globe, run: () => wm.open('browser', { url: 'https://duckduckgo.com/?q=' + encodeURIComponent(query) }), hint: 'Search' });
    sel = 0;
    draw();
  };
  const showAll = () => {
    // a chip with no query lists everything of that kind
    results = [];
    if (filter === 'apps') for (const a of catalog.all()) results.push({ sec: 'Applications', title: a.name, sub: a.builtin ? 'LiquidDesktop' : a.comment, app: a, run: () => catalog.launch(a), hint: 'Open' });
    if (filter === 'actions') for (const a of ACTIONS) results.push({ sec: 'Actions', title: a.title, icon: a.icon, run: a.run, hint: 'Run' });
    if (filter === 'files') { list.hidden = true; return; }
    sel = 0; draw();
  };
  const searchFiles = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2 || safeCalc(q) != null) { fileResults = []; return update(); }
    try { fileResults = (await api.fs.search(q)).slice(0, filter === 'files' ? 30 : 6); } catch { fileResults = []; }
    if (input.value.trim() === q) update();
  }, 180);

  const draw = () => {
    list.innerHTML = '';
    list.hidden = !results.length;
    let lastSec = null;
    results.forEach((r, i) => {
      if (r.sec !== lastSec) { list.append(h('div.sp-sec', r.sec)); lastSec = r.sec; }
      const ic = r.app ? appIcon(r.app) : r.file ? h('div', { style: { width: '28px', height: '28px' }, html: r.file.isDir ? folderIcon(r.file.name) : docIcon(r.file.ext) }) : h('span', { html: r.icon || '' });
      const row = h('div.sp-row' + (i === sel ? '.sel' : ''), h('div.ic', ic), h('div.t' + (r.calc ? '.sp-calc' : ''), r.title, r.sub ? h('small', r.sub) : null), h('span.hint', i === sel ? r.hint + ' ↩' : ''));
      row.addEventListener('mousemove', () => { if (sel !== i) { sel = i; draw(); } });
      row.addEventListener('click', () => { closeSpotlight(); r.run(); });
      list.append(row);
    });
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => { update(); searchFiles(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = clamp(sel + 1, 0, results.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = clamp(sel - 1, 0, results.length - 1); draw(); }
    else if (e.key === 'Enter') { const r = results[sel]; if (r) { closeSpotlight(); r.run(); } }
    else if (e.key === 'Escape') { e.preventDefault(); input.value ? (input.value = '', update()) : closeSpotlight(); }
    else if (e.key === 'Tab') { e.preventDefault(); const i = chipDefs.findIndex(([k]) => k === filter); filter = chipDefs[(i + (e.shiftKey ? chipDefs.length - 1 : 1)) % chipDefs.length][0]; drawChips(); input.value ? (update(), searchFiles()) : showAll(); }
  });
  drawChips();
  document.body.append(layer);
  attachLens(bar, { strength: 36, edge: 22 });
  spot = layer;
  setTimeout(() => input.focus(), 30);
}
export function closeSpotlight() { if (spot) { spot.remove(); spot = null; } }

/* ================================================================== Applications (macOS 26-style launcher) */
// A compact glass panel near the top of the screen: search field, category pills, recently used apps,
// then every app A–Z. It replaces the old full-screen Launchpad.
let lp = null;
const CATS = [
  ['Productivity & Finance', ['Office', 'Finance', 'Calendar', 'ContactManagement', 'Presentation', 'Spreadsheet', 'WordProcessor']],
  ['Utilities', ['Utility', 'Accessories', 'FileManager', 'TextEditor', 'Archiving', 'Calculator', 'TerminalEmulator']],
  ['Social', ['Chat', 'InstantMessaging', 'Email', 'Network', 'WebBrowser', 'IRCClient', 'VideoConference']],
  ['Entertainment', ['AudioVideo', 'Audio', 'Video', 'Player', 'Music', 'TV']],
  ['Creativity', ['Graphics', '2DGraphics', '3DGraphics', 'Photography', 'RasterGraphics', 'VectorGraphics', 'AudioVideoEditing']],
  ['Developer Tools', ['Development', 'IDE', 'Debugger', 'RevisionControl', 'GUIDesigner']],
  ['Games', ['Game']],
  ['Education', ['Education', 'Science', 'Math']],
  ['System', ['System', 'Settings', 'Monitor', 'PackageManager', 'HardwareSettings', 'Security']],
];
const BUILTIN_CAT = { files: 'Utilities', terminal: 'Developer Tools', browser: 'Social', notes: 'Productivity & Finance', texteditor: 'Utilities', calculator: 'Utilities',
  preview: 'Creativity', calendar: 'Productivity & Finance', weather: 'Utilities', monitor: 'System', settings: 'System', about: 'System', appstore: 'Utilities' };
const catOf = (a) => (a.builtin ? [BUILTIN_CAT[a.id]] : CATS.filter(([, keys]) => (a.categories || []).some((c) => keys.includes(c))).map(([n]) => n));

export function launchpad() {
  if (lp) return closeLaunchpad();
  let cat = null, sel = -1;
  const input = h('input', { placeholder: 'Applications', spellcheck: false });
  const more = h('button.lc-more', { html: sym.ellipsis, title: 'Options' });
  const pills = h('div.lc-pills');
  const body = h('div.lc-body');
  const panel = h('div#launcher.glass.panel.sheen', h('div.lc-head', h('span.lc-glyph', { html: sym.grid }), input, more), pills, body);
  const layerEl = h('div#launcher-layer', panel);
  layerEl.addEventListener('mousedown', (e) => { if (!panel.contains(e.target)) closeLaunchpad(); });
  more.addEventListener('click', (e) => {
    const r = more.getBoundingClientRect();
    import('./menus.js').then(({ showMenu }) => showMenu([
      { label: 'Open System Settings', action: () => { closeLaunchpad(); wm.open('settings'); } },
      { label: 'Reload App List', action: async () => { await catalog.load(); draw(); } },
      { label: 'Clear Recently Used', action: () => { import('./store.js').then(({ appData }) => { appData.set('recentApps', []); draw(); }); } },
    ], r.left, r.bottom + 6));
  });
  const tile = (a, i) => {
    const el = h('div.lc-app', { style: { animationDelay: Math.min(i, 30) * 6 + 'ms' } }, appIcon(a, 'icon'), h('span', a.name));
    el.addEventListener('click', () => { closeLaunchpad(); catalog.launch(a); });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const pinned = store.get('dockPinned');
      import('./menus.js').then(({ showMenu }) => showMenu([
        { label: 'Open', action: () => { closeLaunchpad(); catalog.launch(a); } },
        pinned.includes(a.id) ? { label: 'Remove from Dock', action: () => store.set('dockPinned', pinned.filter((p) => p !== a.id)) } : { label: 'Add to Dock', action: () => store.set('dockPinned', [...pinned, a.id]) },
      ], e.clientX, e.clientY));
    });
    return el;
  };
  let shown = [];
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    body.innerHTML = '';
    let apps = catalog.all().filter((a) => a.id !== 'about');
    if (cat) apps = apps.filter((a) => catOf(a).includes(cat));
    if (q) apps = apps.filter((a) => a.name.toLowerCase().includes(q) || (a.keywords || []).some((k) => k.toLowerCase().includes(q)) || (a.comment || '').toLowerCase().includes(q));
    apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const recent = !q && !cat ? catalog.recent().slice(0, 5) : [];
    shown = [...recent, ...apps];
    if (recent.length) {
      body.append(h('div.lc-grid', recent.map(tile)), h('div.lc-sep'));
    }
    if (apps.length) body.append(h('div.lc-grid', apps.map((a, i) => tile(a, i + recent.length))));
    else body.append(h('div.lc-empty', 'No Results'));
    sel = q ? 0 : -1;
    paintSel();
  };
  const paintSel = () => [...body.querySelectorAll('.lc-app')].forEach((el, i) => el.classList.toggle('sel', i === sel));
  const drawPills = () => {
    pills.innerHTML = '';
    for (const [name] of CATS) {
      if (!catalog.all().some((a) => catOf(a).includes(name))) continue;
      pills.append(h('button' + (cat === name ? '.on' : ''), { onclick: () => { cat = cat === name ? null : name; drawPills(); draw(); input.focus(); } }, name));
    }
  };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => {
    const n = body.querySelectorAll('.lc-app').length;
    if (e.key === 'Escape') { e.preventDefault(); input.value ? (input.value = '', draw()) : closeLaunchpad(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { if (!input.value || sel >= 0) { e.preventDefault(); sel = clamp(sel + (e.key === 'ArrowRight' ? 1 : -1), 0, n - 1); paintSel(); } }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = clamp(sel + (e.key === 'ArrowDown' ? 5 : -5), 0, n - 1); paintSel(); body.querySelectorAll('.lc-app')[sel]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { const el = body.querySelectorAll('.lc-app')[Math.max(0, sel)]; el?.click(); }
  });
  pills.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { pills.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  document.body.append(layerEl);
  lp = layerEl;
  drawPills(); draw();
  setTimeout(() => input.focus(), 40);
}
export function closeLaunchpad() { if (!lp) return; const l = lp; lp = null; l.firstChild.classList.add('closing'); setTimeout(() => l.remove(), 180); }

/* ================================================================== App switcher (Alt+Tab) */
let sw = null;
export function switcherStep(dir) {
  const apps = [];
  for (const w of wm.mru) if (!apps.includes(w.app.id)) apps.push(w.app.id);
  for (const id of wm.runningApps()) if (!apps.includes(id)) apps.push(id);
  if (!apps.length) return;
  if (!sw) {
    sw = { el: h('div#switcher.glass.panel.sheen'), apps, i: apps.length > 1 ? 1 : 0 };
    document.body.append(sw.el);
  } else sw.i = (sw.i + dir + sw.apps.length) % sw.apps.length;
  sw.el.innerHTML = '';
  sw.apps.forEach((id, i) => {
    const a = catalog.find(id);
    const it = h('div.sw-item' + (i === sw.i ? '.sel' : ''), appIcon(a, 'icon'), h('span', a.name));
    it.addEventListener('mouseenter', () => { sw.i = i; switcherStep(0); });
    it.addEventListener('click', () => switcherCommit());
    sw.el.append(it);
  });
}
export function switcherCommit() { if (!sw) return; const id = sw.apps[sw.i]; sw.el.remove(); sw = null; wm.activate(id); }
export function switcherCancel() { if (!sw) return; sw.el.remove(); sw = null; }
export const switcherOpen = () => !!sw;

/* ================================================================== HUD */
let hud, hudT;
export function showHud(icon, value) {
  if (!hud) { hud = h('div#hud.glass.panel', h('span.i'), h('div.track', h('i'))); document.body.append(hud); }
  hud.classList.remove('out');
  hud.querySelector('.i').innerHTML = icon;
  hud.querySelector('.track i').style.width = value + '%';
  clearTimeout(hudT);
  hudT = setTimeout(() => hud.classList.add('out'), 1300);
}
