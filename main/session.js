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
const fs = require('fs');
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
  // every monitor: the main one gets the full desktop + shell below; the others get their own wallpaper and
  // menu bar windows (made in relayout)
  const desktop = new BrowserWindow({ x: 0, y: 0, width: sw, height: sh, frame: false, show: false, resizable: false, skipTaskbar: true,
    backgroundColor: '#0b1220', type: 'desktop', webPreferences: prefs });
  fixedTitle(desktop, 'LiquidDesktop Desktop');
  wm.registerOwn(xidOf(desktop), { role: 'desktop' });
  desktop.loadFile(INDEX, { query: { mode: 'session', layer: 'desktop' } });

  const shell = new BrowserWindow({ x: 0, y: 0, width: sw, height: sh, frame: false, show: false, resizable: false, skipTaskbar: true,
    transparent: true, backgroundColor: '#00000000', hasShadow: false, type: 'dock', webPreferences: prefs });
  fixedTitle(shell, 'LiquidDesktop Shell');
  wm.registerOwn(xidOf(shell), { role: 'shell', primary: true });
  const extra = new Map();   // display id → { desktop, bar } on monitors other than the main one
  // The start-up screen (inside the shell page) is shown once per session. Whether it's done is kept here, in
  // the main process: a reload of the shell (after a crash) asks for it not to be shown at all, and if start-up
  // never reports back, it's taken down anyway, so it can't come back or stay up for good.
  let bootDone = false;
  const loadShell = () => shell.loadFile(INDEX, { query: { mode: 'session', layer: 'shell',
    login: bootDone || process.env.LIQUID_SKIP_LOGIN ? '0' : '1', boot: bootDone ? '0' : '1' } });
  ipcMain.on('shell:bootDone', (e) => { if (e.sender === shell.webContents) bootDone = true; });
  setTimeout(() => { if (!bootDone && !shell.isDestroyed()) { console.warn('[session] start-up screen still up after 25s: taking it down'); bootDone = true; shell.webContents.send('session:hideBoot'); } }, 25000);
  loadShell();
  if (process.env.LIQUID_DEBUG) for (const bw of [shell, desktop]) bw.webContents.on('console-message', (e) => console.log('[' + bw.getTitle() + ']', e.message));
  // links open in the default browser (Settings › Default Apps): LiquidDesktop's own unless another was picked
  const openLink = (url) => { if (!require('./defaultapps').openUrlExternally(url)) openApp('browser', { url }); };
  shell.webContents.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' }; });

  desktop.once('ready-to-show', () => desktop.showInactive());
  shell.once('ready-to-show', () => { shell.showInactive(); setTimeout(() => wm.setShellInput([], false), 50); });

  // A page of ours crashed (common without a GPU): log it and reload, the shell without its start-up screen.
  // A few times only: a page that keeps crashing isn't reloaded forever.
  const crashes = new Map();
  // crashes also go to ~/.config/LiquidDesktop/crashes.log (the session's own output ends up wherever the login
  // screen puts it), so they can be looked up and reported
  const crashLog = (line) => {
    console.error(line);
    try {
      const f = path.join(app.getPath('userData'), 'crashes.log');
      try { if (fs.statSync(f).size > 256 * 1024) fs.renameSync(f, f + '.old'); } catch { /* no log yet */ }
      fs.appendFileSync(f, `${new Date().toISOString()} ${line}\n`);
    } catch { /* not writable */ }
  };
  const recover = (name, bw, reload) => {
    bw.webContents.on('render-process-gone', (_e, d) => {
      crashLog(`[session] ${name} crashed: ${d.reason} (exit ${d.exitCode})`);
      if (bw.isDestroyed() || d.reason === 'clean-exit') return;
      const now = Date.now(), recent = (crashes.get(name) || []).filter((t) => now - t < 120000);
      recent.push(now); crashes.set(name, recent);
      if (recent.length > 3) { console.error(`[session] ${name} keeps crashing: not reloading it again`); return; }
      setTimeout(() => { if (!bw.isDestroyed()) reload(); }, 500 * recent.length);
    });
  };
  recover('shell', shell, loadShell);
  recover('desktop', desktop, () => desktop.loadFile(INDEX, { query: { mode: 'session', layer: 'desktop' } }));
  app.on('child-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return;
    // the GPU process restarted (a mode set on NVIDIA can do it): windows must draw again or they stay frozen
    if (d.type === 'GPU') for (const ms of [800, 2500]) setTimeout(() => { for (const bw of BrowserWindow.getAllWindows()) if (!bw.isDestroyed()) bw.webContents.invalidate(); }, ms);
    crashLog(`[session] ${d.type}${d.name ? ' (' + d.name + ')' : ''} process gone: ${d.reason} (exit ${d.exitCode})`);
  });

  const toShell = (ch, ...a) => { if (!shell.isDestroyed()) shell.webContents.send(ch, ...a); };
  const bars = () => [...extra.values()].map((x) => x.bar);
  const toLayers = (ch, ...a) => { for (const bw of [shell, desktop, ...bars(), ...appWindows.values()]) if (!bw.isDestroyed()) bw.webContents.send(ch, ...a); };
  // which shell window (main one or a monitor's menu bar) a message came from
  const shellOf = (e) => { for (const bw of [shell, ...bars()]) if (!bw.isDestroyed() && bw.webContents === e.sender) return xidOf(bw); return null; };

  /* ------------------------------------------------------------ built-in app windows */
  let appSeq = 100000;
  const starting = new Map();   // appId → a window that was created but isn't on screen yet
  function openApp(appId, args = {}, opts = {}) {
    // clicked again while it's still starting: show that window rather than starting another hidden one
    const waiting = starting.get(appId);
    if (waiting && !waiting.bw.isDestroyed() && Date.now() - waiting.at < 15000 && !Object.keys(args || {}).length) { waiting.show(); waiting.bw.focus(); return waiting.id; }
    const id = ++appSeq;
    const [w0, h0] = opts.size || [820, 540];
    // the window manager works in screen pixels, Electron in scaled (DIP) units
    const k = screen.getPrimaryDisplay().scaleFactor || 1, ap = wm.area();
    const a = { x: ap.x / k, y: ap.y / k, w: ap.w / k, h: ap.h / k };
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
    // shown at its first paint (ready-to-show). With some drivers (NVIDIA) that event comes late or not at all
    // for a hidden window, which left the app invisible until it was clicked again: so it's also shown once
    // the page has loaded, and after a few seconds at the latest.
    let shown = false;
    // (still counted as starting for a moment after it appears: the clicks that were waiting on it don't open more)
    const show = () => {
      if (shown || bw.isDestroyed()) return;
      shown = true; clearTimeout(late); bw.show();
      setTimeout(() => { if (starting.get(appId)?.id === id) starting.delete(appId); }, 1500);
    };
    const late = setTimeout(show, 3000);
    starting.set(appId, { id, bw, show, at: Date.now() });
    bw.once('ready-to-show', show);
    bw.webContents.once('did-finish-load', () => setTimeout(show, 120));
    bw.on('page-title-updated', (e, t) => { const mw = wm.windows.get(id); if (mw) { mw.title = t; wm.changed(mw); } });
    bw.on('closed', () => { appWindows.delete(id); clearTimeout(late); if (starting.get(appId)?.id === id) starting.delete(appId); });
    recover(`app ${appId}#${id}`, bw, () => bw.webContents.reload());
    bw.webContents.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' }; });
    bw.webContents.on('did-attach-webview', (_e, wc) => wc.setWindowOpenHandler(({ url }) => { bw.webContents.send('browser:newTab', url); return { action: 'deny' }; }));
    return id;
  }

  /* ------------------------------------------------------------ frames for native windows */
  wm.on('need-frame', (w, done) => {
    const fb = new BrowserWindow({ x: 0, y: 0, width: Math.max(200, w.w + EDGE * 2), height: TB, frame: false, show: false,
      backgroundColor: '#f6f6f8', focusable: false, skipTaskbar: true, webPreferences: { ...prefs, webviewTag: false } });
    fb.setTitle(w.title || 'Window');
    fb.on('page-title-updated', (e) => e.preventDefault());
    const xid = xidOf(fb);
    wm.registerOwn(xid, { role: 'frame', id: w.id });
    frames.set(w.id, fb);
    fb.loadFile(FRAME, { query: { id: String(w.id), layer: 'frame', mode: 'session' } });
    if (process.env.LIQUID_DEBUG) fb.webContents.on('console-message', (e) => console.log('[frame]', e.message));
    // the window can be gone by the time its frame has loaded (it opened and closed at once): then the frame
    // goes too, instead of staying behind as an empty title bar
    const gone = () => !wm.windows.has(w.id) || frames.get(w.id) !== fb;
    fb.webContents.once('did-finish-load', () => {
      if (gone()) { if (frames.get(w.id) === fb) frames.delete(w.id); if (!fb.isDestroyed()) fb.destroy(); done(null); return; }
      done(xid); sendFrame(w);
      setTimeout(() => { if (fb.isDestroyed()) return; if (gone()) { fb.destroy(); return; } fb.showInactive(); }, 30);
    });
  });
  wm.on('frame-gone', (w) => { const fb = frames.get(w.id); frames.delete(w.id); if (fb && !fb.isDestroyed()) fb.destroy(); });
  function sendFrame(w) {
    const fb = frames.get(w.id);
    if (fb && !fb.isDestroyed()) {
      fb.webContents.send('frame:update', { title: w.title, focused: wm.focused === w, maximized: !!w.maximized || !!w.tile, fullscreen: !!w.fullscreen });
      if (fb.getTitle() !== w.title) fb.setTitle(w.title);
      wm.raiseClient(w);   // the frame repaints after an update: keep the app's content on top
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
  // the preview is drawn by the shell window on that monitor, in its own coordinates
  wm.on('snap-preview', (r) => {
    const k = screen.getPrimaryDisplay().scaleFactor || 1;
    for (const bw of [shell, ...bars()]) if (!bw.isDestroyed()) {
      const b = bw.getBounds(), ox = Math.round(b.x * k), oy = Math.round(b.y * k);
      const mine = r && r[0] + r[2] / 2 >= ox && r[0] + r[2] / 2 < ox + b.width * k && r[1] + r[3] / 2 >= oy && r[1] + r[3] / 2 < oy + b.height * k;
      bw.webContents.send('session:snap', mine ? [r[0] - ox, r[1] - oy, r[2], r[3]] : null);
    }
  });
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
  handle('wm:pointer', async () => { const p = await wm.pointer(); return p ? { x: p.rootX, y: p.rootY, button: !!(p.keyMask & 0x100) } : null; });
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
  on('shell:regions', (input, modal, blur, e) => { const x = shellOf(e); if (x) { wm.setShellInput(input, modal, x); wm.setBlurRegions(blur, x); } });
  on('shell:focus', (onOff, e) => { const x = shellOf(e); if (x) wm.focusShell(onOff, x); });
  on('shell:workarea', (top, bottom, e) => { const x = shellOf(e); if (x) wm.setWorkarea(top, bottom, x); });
  on('shell:edges', (v, e) => { if (e.sender === shell.webContents) wm.setEdges(v); });
  on('wm:zoom', (id, mode) => wm.zoom(id, mode));
  on('shell:locked', (v) => { wm.setLocked(v); for (const b of bars()) if (!b.isDestroyed()) b.webContents.send('session:locked', v); });
  on('shell:notify', (n) => toShell('session:notify', n));
  on('shell:windowMenu', (id, x, y, kind, rel) => {
    // from a title bar: its coordinates are relative to the window (it sits inside the frame container)
    const w = rel && wm.windows.get(id);
    if (w) { const k = screen.getPrimaryDisplay().scaleFactor || 1, p = wm.prim(); x = Math.round((w.x - p.x) / k + x); y = Math.round((w.y - p.y) / k + y); }
    toShell('session:windowMenu', id, x, y, kind);
  });
  on('frame:op', (id, op, arg) => {
    ({ activate: () => wm.activate(id), close: () => wm.close(id), minimize: () => wm.minimize(id), toggleMaximize: () => wm.toggleMaximize(id), zoom: () => wm.zoom(id, arg),
      beginMove: () => wm.beginMove(id), beginResize: () => wm.beginResize(id, arg) })[op]?.();
  });

  // resolution / monitor changes: the main desktop + shell follow the primary display, every other display gets
  // its own wallpaper and menu bar, and the window manager learns where all of them are (in screen pixels)
  const pxOf = (d) => { const k = d.scaleFactor || 1, b = d.bounds; return { x: Math.round(b.x * k), y: Math.round(b.y * k), w: Math.round(b.width * k), h: Math.round(b.height * k) }; };
  const makeExtra = (d) => {
    const b = d.bounds, q = { mode: 'session', secondary: '1' };
    const dk = new BrowserWindow({ ...b, frame: false, show: false, resizable: false, skipTaskbar: true, backgroundColor: '#0b1220', type: 'desktop', webPreferences: prefs });
    fixedTitle(dk, 'LiquidDesktop Desktop');
    wm.registerOwn(xidOf(dk), { role: 'desktop', primary: false });
    dk.loadFile(INDEX, { query: { ...q, layer: 'desktop' } });
    dk.once('ready-to-show', () => dk.showInactive());
    const bar = new BrowserWindow({ ...b, frame: false, show: false, resizable: false, skipTaskbar: true, transparent: true, backgroundColor: '#00000000', hasShadow: false, type: 'dock', webPreferences: prefs });
    fixedTitle(bar, 'LiquidDesktop Shell');
    const bx = xidOf(bar);
    wm.registerOwn(bx, { role: 'shell', primary: false });
    bar.loadFile(INDEX, { query: { ...q, layer: 'shell', boot: '0', login: '0' } });
    bar.once('ready-to-show', () => { bar.showInactive(); setTimeout(() => wm.setShellInput([], false, bx), 50); });
    recover('desktop ' + d.id, dk, () => dk.loadFile(INDEX, { query: { ...q, layer: 'desktop' } }));
    recover('menu bar ' + d.id, bar, () => bar.loadFile(INDEX, { query: { ...q, layer: 'shell', boot: '0', login: '0' } }));
    return { desktop: dk, bar };
  };
  const relayout = () => {
    const all = screen.getAllDisplays(), pd = screen.getPrimaryDisplay(), b = pd.bounds;
    for (const bw of [desktop, shell]) if (!bw.isDestroyed()) bw.setBounds(b);
    const mons = all.map((d) => ({ ...pxOf(d), primary: d.id === pd.id }));
    const rw = Math.max(...mons.map((m) => m.x + m.w)), rh = Math.max(...mons.map((m) => m.y + m.h));
    // the other displays: add, move or remove their windows
    const want = new Set();
    for (const d of all) {
      if (d.id === pd.id) continue;
      want.add(d.id);
      if (!extra.has(d.id)) extra.set(d.id, makeExtra(d));
      const x = extra.get(d.id);
      for (const bw of [x.desktop, x.bar]) if (!bw.isDestroyed()) bw.setBounds(d.bounds);
    }
    for (const [id, x] of extra) if (!want.has(id)) { extra.delete(id); for (const bw of [x.desktop, x.bar]) if (!bw.isDestroyed()) bw.destroy(); }
    wm.setMonitors(mons, rw, rh);
    const pm = pxOf(pd);
    wm.setShellGeometry(xidOf(shell), { ox: pm.x, oy: pm.y, w: pm.w, h: pm.h });
    for (const [id, x] of extra) {
      const d = all.find((o) => o.id === id), m = pxOf(d);
      if (!x.bar.isDestroyed()) wm.setShellGeometry(xidOf(x.bar), { ox: m.x, oy: m.y, w: m.w, h: m.h });
    }
    // windows left on a monitor that's gone come back to one that's there; maximized / tiled / full-screen
    // windows are fitted again to their monitor
    for (const w of wm.windows.values()) {
      if (!wm.monAt(w.x + w.w / 2, w.y + 20, true)) { w.x = null; w.y = null; w.maximized = false; w.tile = null; w.fullscreen = false; wm.placeIfNeeded(w); continue; }
      if (w.fullscreen) { const m = wm.monOf(w); Object.assign(w, { x: m.x, y: m.y, w: m.w, h: m.h }); wm.applyGeometry(w); }
      else if (w.maximized || w.tile) wm.tile(w.id, w.tile || 'fill');
    }
    wm.restack();
    wm.changed();
    // A mode set (NVIDIA especially) can leave Chromium showing a stale frame: the window still takes clicks but
    // never repaints, so a dialog that opened meanwhile (Settings' "Keep these display settings?") was invisible
    // and swallowed every click. Make every window of ours draw a fresh frame, now and once the GPU has settled.
    // …and the shells' click-through shapes, which Chromium reset when they were resized
    const repaint = () => { wm.reapplyShellInput(); for (const bw of BrowserWindow.getAllWindows()) if (!bw.isDestroyed()) bw.webContents.invalidate(); };
    repaint(); for (const ms of [150, 600, 2000]) setTimeout(repaint, ms);
  };
  relayout();
  let relayoutTimer;
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, () => { clearTimeout(relayoutTimer); relayoutTimer = setTimeout(relayout, 300); });

  app.on('liquid-cursor-changed', () => wm.reloadCursor());

  app.on('before-quit', () => { for (const w of wm.windows.values()) if (w.kind !== 'app') wm.close(w.id); });
  return { wm, shell, desktop, getWindow: () => shell, openApp };
}

module.exports = { startSession };
