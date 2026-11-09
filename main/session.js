// Session mode: LiquidDesktop as the real desktop on an X11 display.
//
//   desktop layer  — the web UI's wallpaper, widgets and desktop icons (bottom of the stack)
//   app windows    — each built-in web app opens as its own real window
//   native apps    — any Linux app; its window is put inside a frame drawn by the web UI
//   shell layer    — the web UI's menu bar, Dock and popovers, on top, shaped to just those parts
//
// All of it is the same web app (renderer/index.html) loaded with a different ?layer=.
const { BrowserWindow, ipcMain, screen, desktopCapturer, app } = require('electron');
const path = require('path');
const { WindowManager, TB, EDGE } = require('./wm');

const INDEX = path.join(__dirname, '..', 'renderer', 'index.html');
const FRAME = path.join(__dirname, '..', 'renderer', 'frame.html');

const xidOf = (bw) => { const b = bw.getNativeWindowHandle(); return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0); };

async function startSession({ preload }) {
  await require('./displays').restoreSaved().catch(() => {});
  require('./input').watchDevices().catch(() => {});
  const wm = new WindowManager();
  await wm.start();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().bounds;
  const prefs = { preload, contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: true, spellcheck: false };
  const appWindows = new Map();   // session id → BrowserWindow
  const frames = new Map();       // session id → frame BrowserWindow
  const fixedTitle = (bw, t) => { bw.setTitle(t); bw.on('page-title-updated', (e) => e.preventDefault()); };

  /* ------------------------------------------------------------ layers */
  const desktop = new BrowserWindow({ x: 0, y: 0, width: sw, height: sh, frame: false, show: false, resizable: false, skipTaskbar: true,
    backgroundColor: '#0b1220', type: 'desktop', webPreferences: prefs });
  fixedTitle(desktop, 'LiquidDesktop Desktop');
  wm.registerOwn(xidOf(desktop), { role: 'desktop' });
  desktop.loadFile(INDEX, { query: { mode: 'session', layer: 'desktop' } });

  const shell = new BrowserWindow({ x: 0, y: 0, width: sw, height: sh, frame: false, show: false, resizable: false, skipTaskbar: true,
    transparent: true, backgroundColor: '#00000000', hasShadow: false, type: 'dock', webPreferences: prefs });
  fixedTitle(shell, 'LiquidDesktop Shell');
  wm.registerOwn(xidOf(shell), { role: 'shell' });
  shell.loadFile(INDEX, { query: { mode: 'session', layer: 'shell', login: process.env.LIQUID_SKIP_LOGIN ? '0' : '1' } });
  if (process.env.LIQUID_DEBUG) for (const bw of [shell, desktop]) bw.webContents.on('console-message', (e) => console.log('[' + bw.getTitle() + ']', e.message));
  shell.webContents.setWindowOpenHandler(({ url }) => { openApp('browser', { url }); return { action: 'deny' }; });

  desktop.once('ready-to-show', () => desktop.showInactive());
  shell.once('ready-to-show', () => { shell.showInactive(); setTimeout(() => wm.setShellInput([], false), 50); });

  const toShell = (ch, ...a) => { if (!shell.isDestroyed()) shell.webContents.send(ch, ...a); };
  const toLayers = (ch, ...a) => { for (const bw of [shell, desktop, ...appWindows.values()]) if (!bw.isDestroyed()) bw.webContents.send(ch, ...a); };

  /* ------------------------------------------------------------ built-in app windows */
  let appSeq = 100000;
  function openApp(appId, args = {}, opts = {}) {
    const id = ++appSeq;
    const [w0, h0] = opts.size || [820, 540];
    const a = wm.area();
    const n = appWindows.size % 7;
    const w = Math.min(w0, a.w - 20), h = Math.min(h0, a.h - 20);
    const bw = new BrowserWindow({
      x: Math.round(a.x + (a.w - w) / 2 + n * 26 - 60), y: Math.round(a.y + Math.max(10, (a.h - h) / 3) + n * 26), width: w, height: h,
      minWidth: opts.minSize?.[0], minHeight: opts.minSize?.[1], frame: false, transparent: true, backgroundColor: '#00000000', show: false,
      title: opts.name || appId, webPreferences: prefs,
    });
    appWindows.set(id, bw);
    const xid = xidOf(bw);
    wm.registerOwn(xid, { role: 'app', id, appId, title: opts.name || appId, minW: opts.minSize?.[0], minH: opts.minSize?.[1], resizable: opts.resizable, webContents: bw.webContents });
    bw.loadFile(INDEX, { query: { mode: 'session', layer: 'app', app: appId, wid: String(id), args: JSON.stringify(args || {}) } });
    bw.once('ready-to-show', () => bw.show());
    bw.on('page-title-updated', (e, t) => { const mw = wm.windows.get(id); if (mw) { mw.title = t; wm.changed(mw); } });
    bw.on('closed', () => appWindows.delete(id));
    bw.webContents.setWindowOpenHandler(({ url }) => { openApp('browser', { url }); return { action: 'deny' }; });
    bw.webContents.on('did-attach-webview', (_e, wc) => wc.setWindowOpenHandler(({ url }) => { bw.webContents.send('browser:newTab', url); return { action: 'deny' }; }));
    return id;
  }

  /* ------------------------------------------------------------ frames for native windows */
  wm.on('need-frame', (w, done) => {
    const fb = new BrowserWindow({ x: 0, y: 0, width: Math.max(200, w.w + EDGE * 2), height: Math.max(80, w.h + TB + EDGE), frame: false, show: false,
      backgroundColor: '#f6f6f8', focusable: false, skipTaskbar: true, webPreferences: { ...prefs, webviewTag: false } });
    fb.setTitle(w.title || 'Window');
    fb.on('page-title-updated', (e) => e.preventDefault());
    const xid = xidOf(fb);
    wm.registerOwn(xid, { role: 'frame', id: w.id });
    frames.set(w.id, fb);
    fb.loadFile(FRAME, { query: { id: String(w.id), layer: 'frame', mode: 'session' } });
    if (process.env.LIQUID_DEBUG) fb.webContents.on('console-message', (e) => console.log('[frame]', e.message));
    fb.webContents.once('did-finish-load', () => { done(xid); sendFrame(w); setTimeout(() => !fb.isDestroyed() && fb.showInactive(), 30); });
  });
  wm.on('frame-gone', (w) => { const fb = frames.get(w.id); frames.delete(w.id); if (fb && !fb.isDestroyed()) fb.destroy(); });
  function sendFrame(w) {
    const fb = frames.get(w.id);
    if (fb && !fb.isDestroyed()) {
      fb.webContents.send('frame:update', { title: w.title, focused: wm.focused === w, maximized: !!w.maximized || !!w.tile, fullscreen: !!w.fullscreen });
      if (fb.getTitle() !== w.title) fb.setTitle(w.title);
    }
  }

  /* ------------------------------------------------------------ WM → web UI */
  let pending = false;
  const broadcast = () => {
    if (pending) return;
    pending = true;
    setImmediate(() => {
      pending = false;
      const st = wm.state();
      toLayers('session:windows', st);
      for (const w of wm.windows.values()) if (w.kind === 'native') sendFrame(w);
    });
  };
  wm.on('changed', broadcast);
  wm.on('shortcut', (name) => toShell('session:shortcut', name));
  wm.on('outside-click', (p) => toShell('session:outside', p));
  wm.on('edge', (side) => toShell('session:edge', side));
  wm.on('snap-preview', (r) => toShell('session:snap', r));
  wm.on('quit-app', (w) => toShell('session:shortcut', 'quit', w.id));
  wm.on('close-app-window', (w) => { const bw = appWindows.get(w.id); if (bw && !bw.isDestroyed()) bw.webContents.send('appwin:close'); });

  /* ------------------------------------------------------------ web UI → WM */
  const on = (ch, fn) => ipcMain.on(ch, (e, ...a) => { try { fn(...a, e); } catch (err) { console.error('[session]', ch, err); } });
  // for messages from a window about itself: the sender comes first, since the other arguments are optional
  const onSelf = (ch, fn) => ipcMain.on(ch, (e, ...a) => { try { fn(e, ...a); } catch (err) { console.error('[session]', ch, err); } });
  const handle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => fn(...a, e));
  const idOfSender = (e) => { for (const [id, bw] of appWindows) if (!bw.isDestroyed() && bw.webContents === e.sender) return id; return null; };

  handle('wm:state', () => wm.state());
  on('wm:activate', (id) => wm.activate(id));
  on('wm:close', (id) => wm.close(id));
  on('wm:minimize', (id) => wm.minimize(id));
  on('wm:restore', (id) => wm.restore(id));
  on('wm:toggleMaximize', (id) => wm.toggleMaximize(id));
  on('wm:tile', (id, kind) => wm.tile(id, kind));
  on('wm:fullscreen', (id, onOff) => { const w = wm.windows.get(id); if (w) wm.setFullscreen(id, onOff ?? !w.fullscreen); });
  on('wm:beginMove', (id) => wm.beginMove(id));
  on('wm:beginResize', (id, dir) => wm.beginResize(id, dir));
  on('wm:moveToSpace', (id, i) => wm.moveToSpace(id, i));
  on('wm:switchSpace', (i) => wm.switchSpace(i));
  on('wm:setSpaces', (n) => wm.setSpaces(n));
  on('wm:toggleDesktop', () => wm.toggleDesktop());
  on('wm:openApp', (appId, args, opts) => openApp(appId, args, opts));
  on('wm:reopen', (id, args) => { const bw = appWindows.get(id); if (bw) bw.webContents.send('appwin:reopen', args); });
  on('wm:menuAction', (id, actionId) => { const bw = appWindows.get(id); if (bw) bw.webContents.send('appwin:menuAction', actionId); });
  on('wm:edit', (cmd) => {
    const w = wm.focused;
    const bw = w && appWindows.get(w.id);
    if (bw && ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].includes(cmd)) bw.webContents[cmd]();
  });
  handle('wm:thumbnails', async () => {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 640, height: 400 } });
    const out = {};
    for (const s of sources) {
      const xid = Number(s.id.split(':')[1]);
      const w = wm.byXid.get(xid);
      if (w) out[w.id] = s.thumbnail.toDataURL();
    }
    return out;
  });
  // app windows tell the WM about themselves
  onSelf('appwin:info', (e, info) => {
    const id = idOfSender(e);
    const w = id && wm.windows.get(id);
    if (!w) return;
    let changed = false;
    if (info.title && info.title !== w.title) { w.title = info.title; changed = true; }
    if (info.menus) { const m = JSON.stringify(info.menus); if (m !== w.menusKey) { w.menusKey = m; w.menus = info.menus; changed = true; } }
    if (changed) wm.changed(w);
  });
  onSelf('appwin:self', (e, op, arg) => {
    const id = idOfSender(e);
    if (!id) return;
    ({ activate: () => wm.activate(id), minimize: () => wm.minimize(id), toggleMaximize: () => wm.toggleMaximize(id), tile: () => wm.tile(id, arg),
      fullscreen: () => { const w = wm.windows.get(id); if (w) wm.setFullscreen(id, !w.fullscreen); }, zoom: () => wm.zoom(id, arg), beginMove: () => wm.beginMove(id),
      beginResize: () => wm.beginResize(id, arg), moveToSpace: () => wm.moveToSpace(id, arg) })[op]?.();
  });
  handle('appwin:id', (e) => idOfSender(e));
  // the shell
  on('shell:regions', (input, modal, blur) => { wm.setShellInput(input, modal); wm.setBlurRegions(blur); });
  on('shell:focus', (onOff) => wm.focusShell(onOff));
  on('shell:workarea', (top, bottom) => wm.setWorkarea(top, bottom));
  on('shell:edges', (e) => wm.setEdges(e));
  on('wm:zoom', (id, mode) => wm.zoom(id, mode));
  on('shell:locked', (v) => wm.setLocked(v));
  on('shell:notify', (n) => toShell('session:notify', n));
  on('shell:windowMenu', (id, x, y, kind) => toShell('session:windowMenu', id, x, y, kind));
  on('frame:op', (id, op, arg) => {
    ({ activate: () => wm.activate(id), close: () => wm.close(id), minimize: () => wm.minimize(id), toggleMaximize: () => wm.toggleMaximize(id), zoom: () => wm.zoom(id, arg),
      beginMove: () => wm.beginMove(id), beginResize: () => wm.beginResize(id, arg) })[op]?.();
  });

  // resolution / monitor changes: the desktop and shell layers follow the primary display
  const relayout = () => {
    const b = screen.getPrimaryDisplay().bounds;
    for (const bw of [desktop, shell]) if (!bw.isDestroyed()) bw.setBounds(b);
    wm.sw = b.width; wm.sh = b.height;
    wm.setCardinal(wm.root, '_NET_DESKTOP_GEOMETRY', [b.width, b.height]);
    wm.updateWorkarea();
    for (const w of wm.windows.values()) if (w.maximized || w.tile || w.fullscreen) { if (w.fullscreen) Object.assign(w, { x: 0, y: 0, w: b.width, h: b.height }); else wm.tile(w.id, w.tile || 'fill'); wm.applyGeometry(w); }
    wm.changed();
  };
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, () => setTimeout(relayout, 300));

  app.on('liquid-cursor-changed', () => wm.reloadCursor());

  app.on('before-quit', () => { for (const w of wm.windows.values()) if (w.kind !== 'app') wm.close(w.id); });
  return { wm, shell, desktop, getWindow: () => shell, openApp };
}

module.exports = { startSession };
