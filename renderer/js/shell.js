// Shell services shared by every component: lock screen, power, screenshots, opening files, shortcuts.
import { h, $, bus, sleep, isCmd, extOf } from './util.js';
import { sym, logo, appIcon, appIconSVG, IMAGE_EXT, TEXT_EXT } from './icons.js';
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
  openPath(path, isDir) {
    if (isDir) return wm.open('files', { path });
    const ext = extOf(path);
    if (ext === 'desktop') return api.apps.info(path).then((a) => (a?.exec ? api.apps.launch(a.exec, a.terminal) : api.fs.open(path))).catch(() => api.fs.open(path));
    if (IMAGE_EXT.has(ext)) return wm.open('preview', { path });
    if (TEXT_EXT.has(ext)) return wm.open('texteditor', { path });
    if (ext === 'html' || ext === 'htm' || ext === 'pdf') return wm.open('browser', { url: 'file://' + path });
    return api.fs.open(path);
  },

  async emptyTrash() {
    if (await confirmDialog('Are you sure you want to permanently erase the items in the Trash?', 'You can’t undo this action.', 'Empty Trash', { danger: true, icon: appIconSVG('files') })) {
      await api.fs.emptyTrash(); bus.emit('fs-changed');
    }
  },

  async screenshot() {
    const flash = $('#flash');
    flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
    try {
      const file = await api.sys.screenshot();
      if (file) routedNotify({ app: 'preview', title: 'Screenshot saved', body: file.replace(shell.home, '~'), action: () => wm.open('preview', { path: file }) });
    } catch (e) { routedNotify({ app: 'preview', title: 'Screenshot failed', body: e.message }); }
  },

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
      h('div.l-user', h('div.avatar', initials), h('div.uname', info.fullName || info.user), pw, hint),
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
    case ',': take(); wm.open('settings'); break;
    case '`': if (win) { take(); const ws = wm.appWindows(win.app.id).filter((w) => !w.minimized); if (ws.length > 1) ws[(ws.indexOf(win) + 1) % ws.length].focus(); } break;
  }
}

function onKeyUp(e) {
  if ((e.key === 'Alt' || e.key === 'Meta') && switcherOpen()) switcherCommit();
}

/* volume / brightness / media keys */
function mediaKey(kind) {
  const v = status.s.volume, b = status.s.brightness;
  if (kind === 'volume-up' || kind === 'volume-down') {
    const nv = Math.max(0, Math.min(100, (v?.level ?? 50) + (kind === 'volume-up' ? 6 : -6)));
    api.sys.setVolume(nv); status.patch({ volume: { level: nv, muted: false } }); showHud(sym.speaker, nv);
  } else if (kind === 'mute') {
    const m = !v?.muted; api.sys.setMute(m); status.patch({ volume: { ...v, muted: m } }); showHud(m ? sym.speakerMute : sym.speaker, m ? 0 : v?.level ?? 0);
  } else if (kind === 'brightness-up' || kind === 'brightness-down') {
    if (b == null) return false;
    const nb = Math.max(1, Math.min(100, b + (kind === 'brightness-up' ? 8 : -8)));
    api.sys.setBrightness(nb); status.patch({ brightness: nb }); showHud(sym.sun, nb);
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
  S.on('session:windowMenu', (id, x, y, kind) => windowMenu(id, x, y, kind));
  S.on('session:shortcut', (name, arg) => {
    if (shell.locked && name !== 'lock') return;
    switch (name) {
      case 'spotlight': return spotlight();
      case 'launcher': return launchpad();
      case 'mission': return wm.mission();
      case 'lock': return shell.lock();
      case 'screenshot': return shell.screenshot();
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
