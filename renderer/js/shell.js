// Shell services shared by every component: lock screen, power, screenshots, opening files, shortcuts.
import { h, $, bus, sleep, isCmd, extOf } from './util.js';
import { sym, logo, appIcon, appIconSVG, IMAGE_EXT, VIDEO_EXT, AUDIO_EXT, TEXT_EXT } from './icons.js';
import { api, isNative } from './sys.js';
import { store } from './store.js';
import { wm } from './wm.js';
import { alertDialog, confirmDialog, closeMenu, menuIsOpen } from './menus.js';
import { notify, toggleNotificationCenter } from './notifications.js';
import { toggleControlCenter, closeControlCenter } from './controlcenter.js';
import { spotlight, closeSpotlight, launchpad, closeLaunchpad, switcherStep, switcherCommit, switcherCancel, switcherOpen, showHud } from './overlays.js';
import { editWidgets } from './desktop.js';
import { wallpaperFor, attachLens } from './theme.js';
import { status } from './status.js';
import { layer, isSession, session as S } from './layer.js';

// app windows and the desktop layer hand notifications to the shell, which shows them
const routedNotify = (n) => {
  if (isSession && layer !== 'shell') { const { action, ...rest } = n; S.send('shell:notify', rest); return; }
  notify(n);
};

export const shell = {
  info: null,
  home: '/',
  notify: routedNotify,
  spotlight,
  launchpad,
  toggleNotificationCenter,
  toggleControlCenter,
  editWidgets,
  mission: () => wm.mission(),
  openSettings: (pane) => wm.open('settings', { pane }),

  aboutApp(app) {
    alertDialog({ icon: appIconSVG(app.id), title: app.name, message: app.about || 'Version 1.0 — part of LiquidDesktop.', buttons: [{ label: 'OK', primary: true }] });
  },

  /** Open a path with the best built-in app, falling back to the system default. */
  async openPath(path, isDir) {
    const ext = isDir ? '' : extOf(path);
    if (ext === 'desktop') return api.apps.info(path).then((a) => (a?.exec ? api.apps.launch(a.exec, a.terminal) : api.fs.open(path))).catch(() => api.fs.open(path));
    const cat = isDir ? 'files' : IMAGE_EXT.has(ext) ? 'images' : VIDEO_EXT.has(ext) ? 'video' : AUDIO_EXT.has(ext) ? 'audio' : ext === 'pdf' ? 'pdf'
      : ext === 'html' || ext === 'htm' ? 'web' : TEXT_EXT.has(ext) ? 'text' : null;
    // another app picked in Settings › Default Apps
    if (cat && api.defaults?.get) {
      const pick = (await api.defaults.get().catch(() => ({})))?.[cat];
      if (pick) return api.apps.openWith(pick, [path]).catch(() => api.fs.open(path));
    }
    if (isDir) return wm.open('files', { path });
    if (cat === 'images' || cat === 'video' || cat === 'audio') return wm.open('preview', { path });
    if (cat === 'text') return wm.open('texteditor', { path });
    if (cat === 'web' || cat === 'pdf') return wm.open('browser', { url: 'file://' + path });
    return api.fs.open(path);
  },

  async emptyTrash() {
    if (await confirmDialog('Are you sure you want to permanently erase the items in the Trash?', 'You can’t undo this action.', 'Empty Trash', { danger: true, icon: appIconSVG('files') })) {
      await api.fs.emptyTrash(); bus.emit('fs-changed');
    }
  },

  async screenshot() { (await import('./screenshot.js')).screenshotNow(); },
  async screenshotTool() { (await import('./screenshot.js')).screenshotTool(); },

  async power(action) {
    const session = shell.info?.mode === 'session';
    const labels = {
      shutdown: ['Are you sure you want to shut down your computer now?', 'Shut Down'],
      restart: ['Are you sure you want to restart your computer now?', 'Restart'],
      logout: [`Are you sure you want to quit all applications and log out now?`, 'Log Out'],
      suspend: null,
    };
    if (action === 'suspend') { await shell.lock(); if (session) api.sys.power('suspend'); return; }
    const [title, ok] = labels[action];
    const msg = session ? 'If you do nothing, the system will continue in 60 seconds.' : 'Testing mode: this only quits/restarts LiquidDesktop, not your computer.';
    let n = 60;
    const p = alertDialog({ icon: logo('currentColor').replace('<svg', '<svg style="color:var(--accent)"'), title, message: msg,
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: ok, value: 'ok', primary: true, danger: action === 'shutdown' }] });
    const timer = setInterval(() => { n--; const m = document.querySelector('.global-alert-layer .alert p'); if (m && session) m.textContent = `If you do nothing, the system will continue in ${n} seconds.`; if (n <= 0) { clearInterval(timer); document.querySelector('.global-alert-layer .btn.primary, .global-alert-layer .btn.danger')?.click(); } }, 1000);
    const r = await p;
    clearInterval(timer);
    if (r.button !== 'ok') return;
    document.body.style.transition = 'opacity .6s'; document.body.style.opacity = '0';
    await sleep(600);
    api.sys.power(action);
  },

  // after a successful system/LiquidDesktop update: the new version starts at the next login
  async updatedPrompt() {
    if (shell._updPrompt) return;
    shell._updPrompt = true;
    const r = await alertDialog({ icon: logo('currentColor').replace('<svg', '<svg style="color:var(--accent)"'), title: 'Updates installed',
      message: 'Log out and back in to start using the updated software. Apps you have open will be closed.',
      buttons: [{ label: 'Later', value: 'later' }, { label: 'Log Out', value: 'ok', primary: true }] });
    shell._updPrompt = false;
    if (r.button !== 'ok') return;
    document.body.style.transition = 'opacity .6s'; document.body.style.opacity = '0';
    await sleep(600);
    api.sys.power('logout');
  },

  /* ---------------------------------------------- lock screen */
  locked: false,
  lock(atBoot = false) {
    if (shell.locked) return;
    shell.locked = true;
    bus.emit('lock', true);
    closeMenu(); closeControlCenter(); closeSpotlight(); closeLaunchpad();
    const info = shell.info || { fullName: 'User', user: 'user' };
    const initials = (info.fullName || info.user).split(/\s+/).map((s) => s[0]).join('').slice(0, 2).toUpperCase();
    const timeEl = h('div.l-time'), dateEl = h('div.l-date');
    const tick = () => {
      const d = new Date();
      timeEl.textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !store.get('clock24') }).replace(/\s?[AP]M/i, '');
      dateEl.textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    };
    tick();
    const t = setInterval(tick, 1000);
    const needPw = store.get('requirePassword') && isNative;
    const input = h('input', { type: 'password', placeholder: needPw ? 'Enter Password' : 'Press Enter to unlock' });
    const pw = h('div.pw.glass', input, h('button', { html: sym.chevronRight, onclick: () => submit() }));
    const hint = h('div.hint', atBoot ? `Welcome to LiquidDesktop` : '');
    const lockEl = h('div#lock', { style: { backgroundImage: `url("${wallpaperFor()}")` } }, dateEl, timeEl,
      h('div.l-user', h('div.avatar', store.get('userAvatar') ? h('img', { src: store.get('userAvatar'), style: { width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' } }) : initials), h('div.uname', info.fullName || info.user), pw, hint),
      h('div.l-actions',
        h('button.glass', { html: sym.moon, title: 'Sleep', onclick: () => shell.info?.mode === 'session' && api.sys.power('suspend') }),
        h('button.glass', { html: sym.restart, title: 'Restart', onclick: () => api.sys.power('restart') }),
        h('button.glass', { html: sym.power, title: 'Shut Down', onclick: () => api.sys.power('shutdown') })));
    lockEl.addEventListener('mousedown', () => setTimeout(() => input.focus()));
    const submit = async () => {
      if (needPw) {
        const r = await api.sys.checkPassword(input.value).catch(() => ({ ok: false }));
        if (!r.ok) { pw.classList.remove('shake'); void pw.offsetWidth; pw.classList.add('shake'); input.value = ''; hint.textContent = 'Incorrect password'; return; }
      }
      clearInterval(t);
      lockEl.classList.add('out');
      setTimeout(() => lockEl.remove(), 650);
      shell.locked = false;
      bus.emit('unlocked');
      bus.emit('lock', false);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); e.stopPropagation(); });
    document.body.append(lockEl);
    attachLens(pw, { strength: 20, edge: 12 });
    setTimeout(() => input.focus(), 100);
  },
};

/* ================================================================== keyboard shortcuts */
const inText = (e) => e.target.closest?.('input, textarea, [contenteditable="true"], .xterm');

function onKey(e) {
  if (shell.locked) return;
  const cmd = isCmd(e), k = e.key;
  const take = () => { e.preventDefault(); e.stopPropagation(); };
  // app switcher
  if (cmd && k === 'Tab') { take(); switcherStep(e.shiftKey ? -1 : 1); return; }
  if (switcherOpen() && k === 'Escape') { take(); switcherCancel(); return; }
  if (cmd && (k === ' ' || e.code === 'Space')) { take(); spotlight(); return; }
  if (k === 'F3' || (e.ctrlKey && k === 'ArrowUp' && !inText(e))) { take(); wm.mission(); return; }
  if (k === 'F4') { take(); launchpad(); return; }
  if (k === 'F11') { take(); wm.toggleDesktop(); return; }
  if (k === 'PrintScreen' || (cmd && e.shiftKey && (k === '#' || k === '3' || e.code === 'Digit3'))) { take(); shell.screenshot(); return; }
  if (e.metaKey && e.shiftKey && e.code === 'KeyS') { take(); shell.screenshotTool(); return; }
  if (e.ctrlKey && cmd && (k === 'q' || k === 'Q')) { take(); shell.lock(); return; }
  if (e.ctrlKey && e.shiftKey && (k === 'F' || k === 'f') && !e.altKey) { take(); api.shell.toggleFullscreen(); return; }
  if (e.ctrlKey && cmd && !e.shiftKey && (k === 'f' || k === 'F') && wm.focused) { take(); wm.focused.toggleFullscreen(); return; }
  if (e.ctrlKey && e.shiftKey && (k === 'I' || k === 'i')) { take(); api.shell.devtools(); return; }
  if (e.ctrlKey && (k === 'ArrowLeft' || k === 'ArrowRight') && (e.altKey || e.metaKey || !inText(e))) { take(); wm.switchSpace(wm.currentSpace + (k === 'ArrowLeft' ? -1 : 1)); return; }
  if (k === 'Escape') {
    if (wm.missionOpen) { take(); wm.closeMission(); return; }
    if (document.querySelector('#launcher-layer')) { take(); closeLaunchpad(); return; }
    if (document.querySelector('#spotlight-layer')) { take(); closeSpotlight(); return; }
  }
  const win = wm.focused;
  // window tiling: Alt+Shift+arrows / Super+Ctrl+arrows
  if (win && ((e.altKey && e.shiftKey) || (e.metaKey && e.ctrlKey))) {
    const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'fill', ArrowDown: 'center', F: 'fill', f: 'fill' };
    if (map[k]) { take(); win.tileTo(map[k]); return; }
  }
  if (!cmd || e.ctrlKey || e.shiftKey) return;
  switch (k.toLowerCase()) {
    case 'q': if (win) { take(); wm.quitApp(win.app.id); } break;
    case 'w': if (win) { take(); win.close(); } break;
    case 'm': if (win) { take(); win.minimize(); } break;
    case 'h': if (win) { take(); wm.appWindows(win.app.id).forEach((w) => w.minimize()); } break;
    case 'n': take(); wm.open(win ? win.app.id : 'files'); break;
    case ',': take(); if (win?.app?.settings) import('./apps/settings.js').then((m) => m.openAppSettings(win.app.settings)); else wm.open('settings'); break;
    case '`': if (win) { take(); const ws = wm.appWindows(win.app.id).filter((w) => !w.minimized); if (ws.length > 1) ws[(ws.indexOf(win) + 1) % ws.length].focus(); } break;
  }
}

function onKeyUp(e) {
  if ((e.key === 'Alt' || e.key === 'Meta') && switcherOpen()) switcherCommit();
}

/* volume / brightness / media keys */
function mediaKey(kind) {
  const v = status.s.volume, b = status.s.brightness;
  // 16 steps from silent to full, like a Mac
  const STEP = 100 / 16, step = (x, up) => Math.max(0, Math.min(100, Math.round((Math.round(x / STEP) + (up ? 1 : -1)) * STEP)));
  if (kind === 'volume-up' || kind === 'volume-down') {
    const nv = step(v?.level ?? 50, kind === 'volume-up');
    api.sys.setVolume(nv); if (v?.muted) api.sys.setMute(false);
    status.patch({ volume: { level: nv, muted: false } }); showHud({ kind: 'sound', value: nv });
  } else if (kind === 'mute') {
    const m = !v?.muted; api.sys.setMute(m); status.patch({ volume: { ...v, muted: m } }); showHud({ kind: 'sound', value: v?.level ?? 0, muted: m });
  } else if (kind === 'brightness-up' || kind === 'brightness-down') {
    if (b == null) {
      // no backlight to drive (desktop monitor, VM): dim the desktop instead, like the Control Center slider does
      const nb = Math.max(10, step(store.get('softBrightness') ?? 100, kind === 'brightness-up'));
      store.set('softBrightness', nb);
      const d = document.getElementById('desktop'); if (d) d.style.filter = nb >= 100 ? '' : `brightness(${0.35 + 0.65 * nb / 100})`;
      showHud({ kind: 'display', value: nb });
      return true;
    }
    const nb = Math.max(1, step(b, kind === 'brightness-up'));
    api.sys.setBrightness(nb); status.patch({ brightness: nb }); showHud({ kind: 'display', value: nb });
  } else if (kind.startsWith('media-')) api.sys.mediaCmd({ 'media-play': 'play-pause', 'media-next': 'next', 'media-prev': 'previous' }[kind]);
  return true;
}
function onMediaKey(e) {
  const map = { AudioVolumeUp: 'volume-up', AudioVolumeDown: 'volume-down', AudioVolumeMute: 'mute', BrightnessUp: 'brightness-up', BrightnessDown: 'brightness-down' };
  const kind = map[e.key] || map[e.code];
  if (kind && mediaKey(kind) !== false) e.preventDefault();
}

/** Session mode: global shortcuts arrive from the X11 window manager. */
export function initSessionShell({ windowMenu }) {
  S.on('session:notify', (n) => notify(n));
  // an Android app couldn't open (Android turned off, not installed…)
  api.android?.onError?.((msg) => notify({ app: 'settings', title: 'Android', body: msg, action: () => shell.openSettings('android') }));
  S.on('session:windowMenu', (id, x, y, kind) => windowMenu(id, x, y, kind));
  S.on('session:shortcut', (name, arg) => {
    if (shell.locked && name !== 'lock') return;
    switch (name) {
      case 'spotlight': return spotlight();
      case 'launcher': return launchpad();
      case 'mission': return wm.mission();
      case 'lock': return shell.lock();
      case 'screenshot': return shell.screenshot();
      case 'screenshot-tool': return shell.screenshotTool();
      case 'switcher-next': return switcherStep(1);
      case 'switcher-prev': return switcherStep(-1);
      case 'switcher-commit': return switcherCommit();
      case 'switcher-cancel': return switcherCancel();
      case 'quit': { const w = wm.windows.find((x) => x.id === arg); if (w) wm.quitApp(w.app.id); return; }
      default: mediaKey(name);
    }
  });
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (wm.missionOpen) wm.closeMission();
    closeLaunchpad(); closeSpotlight();
  });
}

export function initShortcuts() {
  addEventListener('keydown', onKey, true);
  addEventListener('keydown', onMediaKey);
  addEventListener('keyup', onKeyUp, true);
  addEventListener('blur', () => switcherCommit());
}
