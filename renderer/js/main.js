// LiquidDesktop boot. The same web app runs as the whole desktop in a window (layer "full"), or — in a real
// session — as separate layers that the X11 window manager stacks: desktop, shell, and one per app window.
import { $, bus, sleep } from './util.js';
import { logoBadge } from './icons.js';
import { api, isNative } from './sys.js';
import { store } from './store.js';
import { initTheme } from './theme.js';
import { wm, registry } from './wm.js';
import { catalog } from './catalog.js';
import { status } from './status.js';
import { initMenubar } from './menubar.js';
import { initDock } from './dock.js';
import { initControlCenter } from './controlcenter.js';
import { initNotifications, notify } from './notifications.js';
import { initDesktop } from './desktop.js';
import { shell, initShortcuts, initSessionShell } from './shell.js';
import { layer, params, isSession, session as S } from './layer.js';
import { enhanceSelects } from './menus.js';
enhanceSelects();

// built-in apps register themselves on import
import './apps/files.js';
import './apps/filepicker.js';
import './apps/appchooser.js';
import './apps/widgetcreator.js';
import './apps/terminal.js';
import './apps/browser.js';
import './apps/notes.js';
import './apps/texteditor.js';
import './apps/calculator.js';
import './apps/preview.js';
import './apps/calendar.js';
import './apps/weather.js';
import './apps/monitor.js';
import './apps/settings.js';
import './apps/about.js';
import './apps/appstore.js';

const progress = (p) => { const b = $('#boot .bar i'); if (b) b.style.width = p + '%'; };
const hideBoot = () => { const b = $('#boot'); if (!b) return; b.classList.add('out'); setTimeout(() => b.remove(), 700); };

async function common() {
  initTheme();
  shell.info = await api.sys.info().catch(() => ({ mode: 'browser', user: 'user', fullName: 'User' }));
  shell.home = shell.info.home || (await api.fs.home().catch(() => '/'));
  document.documentElement.dataset.mode = shell.info.mode;
}

/* ---------------------------------------------------------------- the whole desktop in one window */
async function bootFull() {
  $('#boot-logo').innerHTML = logoBadge();
  progress(10);
  await common();
  api.sys.onUpdated?.(() => shell.updatedPrompt());
  import('./notifications.js').then(({ notifyRemote, closeRemote }) => { api.notif?.onShow(notifyRemote); api.notif?.onClose(closeRemote); });
  progress(35);
  wm.init();
  initMenubar();
  initNotifications();
  initControlCenter();
  status.start();
  progress(55);
  await catalog.load();
  progress(75);
  initDock();
  await initDesktop();
  initShortcuts();
  api.shell.onOpenUrl?.((url) => wm.open('browser', { url }));
  progress(100);
  await sleep(450);
  hideBoot();
  welcome();
  browserWarning();
  autoUpdateCheck();
}

/* ---------------------------------------------------------------- session layers */
async function bootShell() {
  $('#boot-logo').innerHTML = logoBadge();
  progress(15);
  await common();
  api.sys.onUpdated?.(() => shell.updatedPrompt());
  import('./notifications.js').then(({ notifyRemote, closeRemote }) => { api.notif?.onShow(notifyRemote); api.notif?.onClose(closeRemote); });
  const { installSessionWM, windowMenu } = await import('./sessionwm.js');
  const { initShellShape } = await import('./shellshape.js');
  await catalog.load();
  progress(50);
  await installSessionWM();
  initMenubar();
  initNotifications();
  initControlCenter();
  status.start();
  initDock();
  initSessionShell({ windowMenu });
  initShellShape();
  progress(100);
  // LiquidDesktop's own login screen at startup — skipped when you just logged in through the LiquidDesktop
  // login screen (SDDM), so you don't type your password twice (Settings › Lock Screen)
  const bootLogin = store.get('bootLogin') || 'auto';
  let askLogin = store.get('requirePassword') && params.get('login') !== '0' && bootLogin !== 'never';
  if (askLogin && bootLogin === 'auto') { try { if ((await api.sddm.status()).usingOurs) askLogin = false; } catch { /* keep asking */ } }
  await sleep(500);
  hideBoot();
  if (askLogin) shell.lock(true);
  welcome();
  autoUpdateCheck();
}

async function bootDesktop() {
  $('#boot')?.remove();
  await common();
  const { installSessionWM } = await import('./sessionwm.js');
  await catalog.load();
  await installSessionWM();
  await initDesktop();
}

async function bootApp() {
  $('#boot')?.remove();
  await common();
  const appId = params.get('app');
  const args = JSON.parse(params.get('args') || '{}');
  wm.init();
  if (appId === 'settings') status.start();
  const win = wm.open(appId, args);
  // anything this window opens after itself (another app, a file…) becomes its own real window
  const { installSessionWM } = await import('./sessionwm.js');
  await installSessionWM();
  wm.windows = [win]; wm.mru = [win]; wm.focused = win;
  // keep the WM's menu bar in sync with this app's menus, and react to its state
  const myId = Number(params.get('wid'));
  const serialize = () => {
    const def = registry.get(appId);
    let seq = 0;
    actions.clear();
    const conv = (items) => (items || []).filter(Boolean).map((it) => {
      if (it === '-') return '-';
      if (it.header) return { header: it.header };
      const id = ++seq;
      if (it.action) actions.set(id, it.action);
      return { id, label: it.label, shortcut: it.shortcut, checked: it.checked, disabled: it.disabled, submenu: it.submenu ? conv(it.submenu) : undefined };
    });
    const menus = (def.menus ? def.menus(win) : []).map((m) => ({ title: m.title, items: conv(m.items) }));
    const key = JSON.stringify([win.title, menus]);
    if (key === lastSent) return;   // nothing new: don't wake the window manager
    lastSent = key;
    S.send('appwin:info', { title: win.title, menus });
  };
  const actions = new Map();
  let lastSent = '';
  S.on('appwin:menuAction', (id) => actions.get(id)?.());
  S.on('appwin:reopen', (a) => win.emit('reopen', a));
  S.on('appwin:close', () => win.close());
  S.on('appwin:openUrl', (url) => wm.open('browser', { url }));
  S.on('session:windows', (st) => {
    const me = st.windows.find((w) => w.id === myId);
    if (!me) return;
    win.maximized = me.maximized; win.fullscreen = me.fullscreen;
    const was = win.el.classList.contains('focused');
    win.el.classList.toggle('focused', me.focused);
    if (me.focused && !was) serialize();
  });
  win.on('title', serialize);
  addEventListener('mouseup', () => setTimeout(serialize, 50));
  serialize();
  initShortcuts();
}

// once a day, quietly check GitHub for a newer LiquidDesktop
function autoUpdateCheck() {
  if (!isNative || Date.now() - (store.get('lastUpdateCheck') || 0) < 864e5) return;
  setTimeout(async () => {
    try {
      const u = await api.sys.updateCheck();
      store.set('lastUpdateCheck', Date.now());
      if (!u.upToDate && u.current) notify({ app: 'settings', title: 'LiquidDesktop update available', body: `${u.behind || 'New'} change${u.behind === 1 ? '' : 's'} on GitHub. Click to update.`, timeout: 15000, action: () => wm.open('settings', { pane: 'general' }) });
    } catch { /* offline */ }
  }, 20000);
}

// Browser preview only (the installed desktop always runs on Chromium): Firefox and its forks (LibreWolf,
// Zen, Waterfox, Floorp…) don't support the SVG-filter backdrops the Liquid Glass blur and refraction use.
function browserWarning() {
  if (isNative || store.get('geckoWarningOff')) return;
  const gecko = /\bGecko\/\d/.test(navigator.userAgent) || (window.CSS?.supports?.('-moz-appearance', 'none') ?? false);
  if (!gecko) return;
  setTimeout(async () => {
    const { alertDialog } = await import('./menus.js');
    const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="#ff9f0a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:56px;height:56px"><path d="M10.3 3.9 1.8 18.6A2 2 0 0 0 3.5 21.6h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4.5M12 17.2v.3"/></svg>';
    const r = await alertDialog({
      icon, title: 'Your browser may not show Liquid Glass properly',
      message: 'You’re using a Firefox-based browser, which doesn’t fully support the blur and refraction effects LiquidDesktop is built on, so glass may look flat, sharp or wrong. For the proper effects, open this page in a Chromium-based browser such as Chrome, Edge, Brave, Vivaldi or Opera. (The installed desktop always shows them correctly.)',
      buttons: [{ label: 'Don’t Show Again', value: 'never' }, { label: 'OK', value: 'ok', primary: true }],
    });
    if (r.button === 'never') store.set('geckoWarningOff', true);
  }, 900);
}

function welcome() {
  if (store.get('welcomed')) return;
  store.set('welcomed', true);
  setTimeout(() => notify({ app: 'about', appName: 'LiquidDesktop', title: 'Welcome to LiquidDesktop', body: 'Alt+Space for Spotlight · F4 for Apps · F3 for Mission Control · click the clock for widgets.', timeout: 9000 }), 1500);
}

window.addEventListener('error', (e) => console.error('[LiquidDesktop]', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[LiquidDesktop]', e.reason));
addEventListener('dragover', (e) => e.preventDefault());
// slider knobs turn into glass while held (see .slider.dragging in base.css)
addEventListener('pointerdown', (e) => { if (e.target.matches?.('input.slider')) { const s = e.target; s.classList.add('dragging'); addEventListener('pointerup', () => s.classList.remove('dragging'), { once: true }); } }, true);
addEventListener('drop', (e) => e.preventDefault());

({ full: bootFull, shell: bootShell, desktop: bootDesktop, app: bootApp })[isSession ? layer : 'full']?.();
Object.assign(window, { liquid: { wm, store, shell, catalog, status, api } });
