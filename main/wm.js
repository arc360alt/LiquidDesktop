// LiquidDesktop window manager — a small X11 WM in plain JavaScript (node `x11`, no native modules).
//
// The UI is the LiquidDesktop web app. This module only does the X11 plumbing so that web UI can be a
// real desktop: it stacks the web layers (desktop at the bottom, menu bar/Dock/popovers on top), and wraps
// every normal Linux app window in a frame window whose title bar is drawn by the web app, so native
// apps automatically get the macOS-style chrome. Moving, resizing, focus, tiling, Spaces, minimize and
// keyboard shortcuts are handled here and reported to the web UI.
const x11 = require('x11');
const { loadCursor } = require('./xcursor');
const { EventEmitter } = require('events');
const EM = x11.eventMask;

const ATOM_NAMES = ['WM_PROTOCOLS', 'WM_DELETE_WINDOW', 'WM_TAKE_FOCUS', 'WM_STATE', 'WM_CHANGE_STATE', 'WM_TRANSIENT_FOR', 'WM_CLASS', 'WM_NAME',
  'WM_NORMAL_HINTS', 'UTF8_STRING', '_NET_SUPPORTED', '_NET_SUPPORTING_WM_CHECK', '_NET_WM_NAME', '_NET_CLIENT_LIST', '_NET_CLIENT_LIST_STACKING',
  '_NET_ACTIVE_WINDOW', '_NET_WM_WINDOW_TYPE', '_NET_WM_WINDOW_TYPE_DOCK', '_NET_WM_WINDOW_TYPE_DESKTOP', '_NET_WM_WINDOW_TYPE_DIALOG',
  '_NET_WM_WINDOW_TYPE_UTILITY', '_NET_WM_WINDOW_TYPE_SPLASH', '_NET_WM_WINDOW_TYPE_NOTIFICATION', '_NET_WM_WINDOW_TYPE_TOOLBAR',
  '_NET_WM_WINDOW_TYPE_MENU', '_NET_WM_WINDOW_TYPE_DROPDOWN_MENU', '_NET_WM_WINDOW_TYPE_POPUP_MENU', '_NET_WM_WINDOW_TYPE_TOOLTIP',
  '_NET_WM_WINDOW_TYPE_COMBO', '_NET_WM_WINDOW_TYPE_DND', '_NET_WM_WINDOW_TYPE_NORMAL', '_NET_WM_STATE', '_NET_WM_STATE_FULLSCREEN',
  '_NET_WM_STATE_MAXIMIZED_VERT', '_NET_WM_STATE_MAXIMIZED_HORZ', '_NET_WM_STATE_HIDDEN', '_NET_WM_STATE_FOCUSED', '_NET_WM_MOVERESIZE',
  '_NET_CLOSE_WINDOW', '_NET_FRAME_EXTENTS', '_NET_REQUEST_FRAME_EXTENTS', '_NET_WORKAREA', '_NET_NUMBER_OF_DESKTOPS', '_NET_CURRENT_DESKTOP',
  '_NET_WM_DESKTOP', '_NET_DESKTOP_GEOMETRY', '_NET_WM_PID', '_MOTIF_WM_HINTS', 'ATOM', 'CARDINAL', 'WINDOW', 'STRING'];

const ANY_MODIFIER = 0x8000, ANY_BUTTON = 0;
const SHIFT = 1, LOCK = 2, CTRL = 4, ALT = 8, NUMLOCK = 16, SUPER = 64;
const BUTTON1 = 0x100;
const TB = 36;          // title bar height of native frames
const EDGE = 4;         // resize border around native frames

// keysyms used for global shortcuts
const KS = { space: 0x20, Tab: 0xff09, F3: 0xffc0, F4: 0xffc1, F11: 0xffc8, q: 0x71, w: 0x77, m: 0x6d, f: 0x66, 3: 0x33, Print: 0xff61,
  Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, F4alt: 0xffc1, Alt_L: 0xffe9, Alt_R: 0xffea, Super_L: 0xffeb, Super_R: 0xffec,
  VolUp: 0x1008ff13, VolDown: 0x1008ff11, Mute: 0x1008ff12, BrightUp: 0x1008ff02, BrightDown: 0x1008ff03, Play: 0x1008ff14, Next: 0x1008ff17, Prev: 0x1008ff16 };

const SHORTCUTS = [
  ['spotlight', ALT, 'space'], ['spotlight', SUPER, 'space'],
  ['switcher-next', ALT, 'Tab'], ['switcher-prev', ALT | SHIFT, 'Tab'], ['switcher-next', SUPER, 'Tab'],
  ['mission', 0, 'F3'], ['mission', CTRL, 'Up'], ['launcher', 0, 'F4'], ['desktop', 0, 'F11'],
  ['lock', CTRL | ALT, 'q'], ['lock', CTRL | SUPER, 'q'], ['screenshot', 0, 'Print'], ['screenshot', ALT | SHIFT, '3'],
  ['close', ALT, 'w'], ['close', ALT, 'F4alt'], ['minimize', ALT, 'm'], ['quit', ALT, 'q'], ['fullscreen', CTRL | ALT, 'f'],
  ['tile-left', ALT | SHIFT, 'Left'], ['tile-right', ALT | SHIFT, 'Right'], ['tile-fill', ALT | SHIFT, 'Up'], ['tile-center', ALT | SHIFT, 'Down'],
  ['space-left', CTRL | ALT, 'Left'], ['space-right', CTRL | ALT, 'Right'],
  ['volume-up', 0, 'VolUp'], ['volume-down', 0, 'VolDown'], ['mute', 0, 'Mute'], ['brightness-up', 0, 'BrightUp'], ['brightness-down', 0, 'BrightDown'],
  ['media-play', 0, 'Play'], ['media-next', 0, 'Next'], ['media-prev', 0, 'Prev'],
];

class WindowManager extends EventEmitter {
  constructor() {
    super();
    this.windows = new Map();      // id → managed window
    this.byXid = new Map();        // client xid or frame xid → managed window
    this.ours = new Map();         // xid → { role, id?, appId? } for windows LiquidDesktop itself created
    this.stack = [];               // managed windows, bottom → top
    this.others = new Set();       // unmanaged mapped windows we must keep above (notifications, foreign docks)
    this.focused = null;
    this.space = 0;
    this.spaces = 2;
    this.workarea = { top: 30, bottom: 80 };
    this.seq = 0;
    this.locked = false;
    this.showingDesktop = false;
  }

  /* ================================================================ connection */
  start() {
    return new Promise((resolve, reject) => {
      x11.createClient({ display: process.env.DISPLAY }, (err, display) => {
        if (err) return reject(err);
        this.display = display;
        this.X = display.client;
        this.root = display.screen[0].root;
        this.sw = display.screen[0].pixel_width;
        this.sh = display.screen[0].pixel_height;
        this.X.on('error', (e) => { if (process.env.LIQUID_WM_DEBUG) console.warn('[wm] X error', e.message || e); });
        this.X.on('event', (ev) => { try { this.onEvent(ev); } catch (e) { console.error('[wm] event handler', ev.name, e); } });
        this.internAtoms().then(() => this.becomeWM()).then(resolve, reject);
      });
    });
  }

  internAtoms() {
    this.A = {};
    return Promise.all(ATOM_NAMES.map((n) => new Promise((res) => this.X.InternAtom(false, n, (e, a) => { this.A[n] = a; res(); }))));
  }

  async becomeWM() {
    const X = this.X, A = this.A;
    await new Promise((resolve, reject) => {
      X.ChangeWindowAttributes(this.root, { eventMask: EM.SubstructureRedirect | EM.SubstructureNotify | EM.PropertyChange }, (err) => {
        if (err) reject(new Error('Another window manager is already running on this display.')); else resolve();
      });
      // ChangeWindowAttributes has no reply; a round-trip tells us whether it failed
      X.GetInputFocus(() => resolve());
    });
    // _NET_SUPPORTING_WM_CHECK window
    this.check = X.AllocID();
    X.CreateWindow(this.check, this.root, -10, -10, 1, 1, 0, 0, 0, 0, { overrideRedirect: 1 });
    const win32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
    X.ChangeProperty(0, this.root, A._NET_SUPPORTING_WM_CHECK, A.WINDOW, 32, win32(this.check));
    X.ChangeProperty(0, this.check, A._NET_SUPPORTING_WM_CHECK, A.WINDOW, 32, win32(this.check));
    X.ChangeProperty(0, this.check, A._NET_WM_NAME, A.UTF8_STRING, 8, Buffer.from('LiquidDesktop'));
    const supported = ['_NET_SUPPORTED', '_NET_SUPPORTING_WM_CHECK', '_NET_WM_NAME', '_NET_CLIENT_LIST', '_NET_CLIENT_LIST_STACKING', '_NET_ACTIVE_WINDOW',
      '_NET_WM_WINDOW_TYPE', '_NET_WM_STATE', '_NET_WM_STATE_FULLSCREEN', '_NET_WM_STATE_MAXIMIZED_VERT', '_NET_WM_STATE_MAXIMIZED_HORZ', '_NET_WM_STATE_HIDDEN',
      '_NET_WM_MOVERESIZE', '_NET_CLOSE_WINDOW', '_NET_FRAME_EXTENTS', '_NET_REQUEST_FRAME_EXTENTS', '_NET_WORKAREA', '_NET_NUMBER_OF_DESKTOPS', '_NET_CURRENT_DESKTOP', '_NET_WM_DESKTOP'];
    X.ChangeProperty(0, this.root, A._NET_SUPPORTED, A.ATOM, 32, Buffer.concat(supported.map((n) => win32(A[n]))));
    this.setCardinal(this.root, '_NET_NUMBER_OF_DESKTOPS', [this.spaces]);
    this.setCardinal(this.root, '_NET_CURRENT_DESKTOP', [0]);
    this.setCardinal(this.root, '_NET_DESKTOP_GEOMETRY', [this.sw, this.sh]);
    this.updateWorkarea();
    // an input-only "catcher" below the shell: while a popover is open, clicks outside it land here
    this.catcher = X.AllocID();
    X.CreateWindow(this.catcher, this.root, 0, 0, this.sw, this.sh, 0, 0, x11.InputOnly, 0, { overrideRedirect: 1, eventMask: EM.ButtonPress });
    // Shape extension, for the shell's drawable/clickable regions
    await new Promise((res) => X.require('shape', (err, Shape) => { this.Shape = err ? null : Shape; res(); }));
    // a normal arrow on the desktop and window edges (the bare X server shows an "X")
    try { this.cursor = await loadCursor(X, this.root); X.ChangeWindowAttributes(this.root, { cursor: this.cursor }); } catch (e) { console.warn('[wm] cursor', e.message); }
    // 32-bit visual for the invisible "blur windows" placed behind each glass surface
    const d32 = this.display.screen[0].depths && this.display.screen[0].depths[32];
    const v32 = d32 && Object.values(d32).find((v) => v.class === 4);
    if (v32) { this.argbVisual = v32.vid; this.argbColormap = X.AllocID(); X.CreateColormap(this.argbColormap, this.root, v32.vid, 0); }
    this.blurPool = [];
    await this.setupKeys();
    await this.adoptExisting();
  }

  /* ================================================================ helpers */
  setCardinal(wid, prop, values) {
    const b = Buffer.alloc(4 * values.length);
    values.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
    this.X.ChangeProperty(0, wid, this.A[prop], this.A[prop.includes('WINDOW') && prop !== '_NET_WM_WINDOW_TYPE' ? 'WINDOW' : 'CARDINAL'], 32, b);
  }
  setWindows(wid, prop, xids) {
    const b = Buffer.alloc(4 * xids.length);
    xids.forEach((v, i) => b.writeUInt32LE(v, i * 4));
    this.X.ChangeProperty(0, wid, this.A[prop], this.A.WINDOW, 32, b);
  }
  getProp(wid, prop, type = 0, len = 1024) {
    return new Promise((res) => this.X.GetProperty(0, wid, typeof prop === 'number' ? prop : this.A[prop], type, 0, len, (e, p) => res(e || !p ? null : p)));
  }
  async getAtoms(wid, prop) {
    const p = await this.getProp(wid, prop, this.A.ATOM);
    if (!p || !p.data) return [];
    const out = [];
    for (let i = 0; i + 4 <= p.data.length; i += 4) out.push(p.data.readUInt32LE(i));
    return out;
  }
  async getCardinals(wid, prop, type) {
    const p = await this.getProp(wid, prop, type || 0);
    if (!p || !p.data) return [];
    const out = [];
    for (let i = 0; i + 4 <= p.data.length; i += 4) out.push(p.data.readUInt32LE(i));
    return out;
  }
  geometry(wid) { return new Promise((res) => this.X.GetGeometry(wid, (e, g) => res(e ? null : g))); }
  attrs(wid) { return new Promise((res) => this.X.GetWindowAttributes(wid, (e, a) => res(e ? null : a))); }
  pointer() { return new Promise((res) => this.X.QueryPointer(this.root, (e, p) => res(e ? null : p))); }

  async getTitle(wid) {
    const n = await this.getProp(wid, '_NET_WM_NAME', this.A.UTF8_STRING);
    if (n && n.data && n.data.length) return n.data.toString('utf8');
    const o = await this.getProp(wid, 'WM_NAME');
    return o && o.data ? o.data.toString('latin1') : '';
  }
  async getClass(wid) {
    const p = await this.getProp(wid, 'WM_CLASS', this.A.STRING);
    if (!p || !p.data) return ['', ''];
    const [inst = '', cls = ''] = p.data.toString('latin1').split('\0');
    return [inst, cls];
  }

  sendClientMessage(wid, type, data) {
    const b = Buffer.alloc(32);
    b.writeUInt8(33, 0); b.writeUInt8(32, 1); b.writeUInt16LE(0, 2);
    b.writeUInt32LE(wid, 4); b.writeUInt32LE(type, 8);
    data.forEach((v, i) => b.writeUInt32LE(v >>> 0, 12 + i * 4));
    this.X.SendEvent(wid, 0, 0, b);
  }
  // ICCCM: tell a client where it is after we move it without resizing it
  sendConfigureNotify(w) {
    const g = this.clientRect(w);
    const b = Buffer.alloc(32);
    b.writeUInt8(22, 0);
    b.writeUInt32LE(w.client, 4); b.writeUInt32LE(w.client, 8); b.writeUInt32LE(0, 12);
    b.writeInt16LE(g.x, 16); b.writeInt16LE(g.y, 18); b.writeUInt16LE(g.w, 20); b.writeUInt16LE(g.h, 22);
    b.writeUInt16LE(0, 24); b.writeUInt8(0, 26);
    this.X.SendEvent(w.client, 0, EM.StructureNotify, b);
  }

  /* ================================================================ our own windows */
  /** Register a window LiquidDesktop created, before it is shown. role: shell | desktop | frame | app */
  registerOwn(xid, info) { this.ours.set(xid, info); }

  /* ================================================================ events */
  onEvent(ev) {
    switch (ev.name) {
      case 'MapRequest': return this.onMapRequest(ev.wid);
      case 'ConfigureRequest': return this.onConfigureRequest(ev);
      case 'UnmapNotify': return this.onUnmap(ev.wid);
      case 'DestroyNotify': return this.onDestroy(ev.wid);
      case 'PropertyNotify': return this.onProperty(ev);
      case 'ClientMessage': return this.onClientMessage(ev);
      case 'ButtonPress': return this.onButtonPress(ev);
      case 'KeyPress': return this.onKey(ev, true);
      case 'KeyRelease': return this.onKey(ev, false);
      case 'MappingNotify': return this.setupKeys();
    }
  }

  async onMapRequest(wid) {
    const own = this.ours.get(wid);
    if (own) {
      if (own.role === 'shell') { this.shell = wid; this.X.MapWindow(wid); this.restack(); return; }
      if (own.role === 'desktop') { this.desktop = wid; this.X.MapWindow(wid); this.restack(); return; }
      if (own.role === 'frame') { this.X.MapWindow(wid); return; }
      if (own.role === 'app') {
        let w = this.windows.get(own.id);
        if (!w) w = await this.manageApp(wid, own);
        this.showWindow(w);
        return;
      }
    }
    const existing = this.byXid.get(wid);
    if (existing) { this.restore(existing.id); return; }
    this.manageNative(wid);
  }

  onConfigureRequest(ev) {
    const w = this.byXid.get(ev.wid);
    const M = ev.mask;
    if (!w) {
      // unmanaged or one of our layer windows: do what it asks
      const opts = {};
      if (M & 1) opts.x = ev.x; if (M & 2) opts.y = ev.y; if (M & 4) opts.width = ev.width; if (M & 8) opts.height = ev.height;
      if (Object.keys(opts).length) this.X.ConfigureWindow(ev.wid, opts);
      return;
    }
    if (w.fullscreen || w.maximized) { if (w.kind === 'native') this.sendConfigureNotify(w); return; }
    const c = this.clientRect(w);
    const nx = M & 1 ? ev.x : c.x, ny = M & 2 ? ev.y : c.y, nw = M & 4 ? ev.width : c.w, nh = M & 8 ? ev.height : c.h;
    this.setClientRect(w, nx, ny, nw, nh);
    if (w.kind === 'native' && !(M & 12)) this.sendConfigureNotify(w);
  }

  onUnmap(wid) {
    const w = this.byXid.get(wid);
    if (!w || wid !== w.client) return;
    if (w.ignoreUnmaps > 0) { w.ignoreUnmaps--; return; }
    if (w.kind === 'app') return; // our own windows report closing through DestroyNotify
    this.unmanage(w, true);
  }
  onDestroy(wid) {
    this.ours.delete(wid);
    this.others.delete(wid);
    const w = this.byXid.get(wid);
    if (w && wid === w.client) this.unmanage(w, false);
  }

  async onProperty(ev) {
    const w = this.byXid.get(ev.wid);
    if (!w || ev.wid !== w.client) return;
    if (ev.atom === this.A._NET_WM_NAME || ev.atom === this.A.WM_NAME) {
      const t = await this.getTitle(w.client);
      if (t && t !== w.title) { w.title = t; this.changed(w); }
    }
  }

  onClientMessage(ev) {
    const A = this.A, d = ev.data || [];
    const w = this.byXid.get(ev.wid);
    if (ev.message_type === A._NET_ACTIVE_WINDOW && w) this.activate(w.id);
    else if (ev.message_type === A._NET_CLOSE_WINDOW && w) this.close(w.id);
    else if (ev.message_type === A.WM_CHANGE_STATE && w && d[0] === 3) this.minimize(w.id);
    else if (ev.message_type === A._NET_WM_STATE && w) {
      // data: action (0 remove, 1 add, 2 toggle), prop1, prop2
      const props = [d[1], d[2]];
      const set = (cur) => (d[0] === 2 ? !cur : d[0] === 1);
      if (props.includes(A._NET_WM_STATE_FULLSCREEN)) this.setFullscreen(w.id, set(w.fullscreen));
      if (props.includes(A._NET_WM_STATE_MAXIMIZED_VERT) || props.includes(A._NET_WM_STATE_MAXIMIZED_HORZ)) { if (set(w.maximized) !== !!w.maximized) this.toggleMaximize(w.id); }
      if (props.includes(A._NET_WM_STATE_HIDDEN) && set(w.minimized)) this.minimize(w.id);
    } else if (ev.message_type === A._NET_WM_MOVERESIZE && w) {
      const dir = d[2];
      if (dir === 8) this.beginMove(w.id);
      else if (dir >= 0 && dir <= 7) this.beginResize(w.id, ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'][dir]);
    } else if (ev.message_type === A._NET_REQUEST_FRAME_EXTENTS) {
      this.setCardinal(ev.wid, '_NET_FRAME_EXTENTS', [EDGE, EDGE, TB, EDGE]);
    }
  }

  onButtonPress(ev) {
    if (ev.wid === this.catcher) { this.emit('outside-click', { x: ev.rootx, y: ev.rooty }); this.X.AllowEvents(2, 0); return; }
    const w = this.byXid.get(ev.wid);
    if (w) {
      const mods = ev.buttons & (ALT | SUPER);
      if (mods && (ev.keycode === 1 || ev.keycode === 3)) {
        // Alt/Super + drag moves (left button) or resizes (right button) from anywhere in the window
        this.X.AllowEvents(1, 0); // AsyncPointer: swallow the click
        this.activate(w.id);
        if (ev.keycode === 1) this.beginMove(w.id); else this.beginResize(w.id, 'se');
        return;
      }
      if (this.focused !== w) this.activate(w.id);
    }
    this.X.AllowEvents(2, 0); // ReplayPointer: let the app get its click
  }

  /* ================================================================ managing windows */
  newWindow(props) {
    const w = { id: ++this.seq, space: this.space, minimized: false, maximized: false, fullscreen: false, tile: null, ignoreUnmaps: 0, title: '', ...props };
    this.windows.set(w.id, w);
    this.byXid.set(w.client, w);
    if (w.frame && w.frame !== w.client) this.byXid.set(w.frame, w);
    return w;
  }

  async manageApp(xid, own) {
    const g = (await this.geometry(xid)) || { xPos: 100, yPos: 100, width: 800, height: 500 };
    const w = this.newWindow({ id: own.id, kind: 'app', client: xid, frame: xid, appId: own.appId, title: own.title || own.appId,
      x: g.xPos, y: g.yPos, w: g.width, h: g.height, minW: own.minW || 200, minH: own.minH || 120, protocols: new Set(), wc: own.webContents, resizable: own.resizable !== false });
    this.seq = Math.max(this.seq, own.id);
    this.X.ChangeWindowAttributes(xid, { eventMask: EM.PropertyChange | EM.StructureNotify });
    this.grabClicks(xid);
    this.placeIfNeeded(w);
    return w;
  }

  async manageNative(wid) {
    const at = await this.attrs(wid);
    if (!at || at.overrideRedirect) { this.X.MapWindow(wid); return; }
    const types = await this.getAtoms(wid, '_NET_WM_WINDOW_TYPE');
    const A = this.A;
    const unmanagedTypes = [A._NET_WM_WINDOW_TYPE_DOCK, A._NET_WM_WINDOW_TYPE_DESKTOP, A._NET_WM_WINDOW_TYPE_NOTIFICATION, A._NET_WM_WINDOW_TYPE_SPLASH,
      A._NET_WM_WINDOW_TYPE_TOOLTIP, A._NET_WM_WINDOW_TYPE_MENU, A._NET_WM_WINDOW_TYPE_DROPDOWN_MENU, A._NET_WM_WINDOW_TYPE_POPUP_MENU,
      A._NET_WM_WINDOW_TYPE_COMBO, A._NET_WM_WINDOW_TYPE_DND];
    if (types.some((t) => unmanagedTypes.includes(t))) {
      this.X.MapWindow(wid);
      if (!types.includes(A._NET_WM_WINDOW_TYPE_DESKTOP)) this.others.add(wid);
      this.restack();
      return;
    }
    const [g, title, cls, hints, motif, transient, protocols, states] = await Promise.all([
      this.geometry(wid), this.getTitle(wid), this.getClass(wid), this.getCardinals(wid, 'WM_NORMAL_HINTS'),
      this.getCardinals(wid, '_MOTIF_WM_HINTS'), this.getCardinals(wid, 'WM_TRANSIENT_FOR'), this.getAtoms(wid, 'WM_PROTOCOLS'), this.getAtoms(wid, '_NET_WM_STATE')]);
    if (!g) return;
    // apps that draw their own title bar (GTK headerbars, Electron frameless…) are not framed
    const csd = motif.length >= 3 && (motif[0] & 2) && motif[2] === 0;
    const minW = hints.length > 6 && (hints[0] & 16) ? hints[5] : 120, minH = hints.length > 6 && (hints[0] & 16) ? hints[6] : 60;
    const hasPos = hints.length && (hints[0] & 5);
    const w = this.newWindow({
      kind: csd ? 'csd' : 'native', client: wid, frame: wid, title: title || cls[1] || 'Window', wmClass: cls,
      protocols: new Set(protocols), minW: Math.max(80, minW), minH: Math.max(40, minH), transientFor: transient[0] || 0,
      x: g.xPos, y: g.yPos, w: g.width, h: g.height, resizable: true, dialog: types.includes(A._NET_WM_WINDOW_TYPE_DIALOG) || !!transient[0],
    });
    this.X.ChangeWindowAttributes(wid, { eventMask: EM.PropertyChange | EM.StructureNotify, borderPixel: 0 });
    this.X.ConfigureWindow(wid, { borderWidth: 0 });
    this.X.ChangeSaveSet(true, wid);
    if (!csd) {
      // ask the web UI for a frame (a window whose title bar it draws), then put the app inside it
      let frameXid;
      try { frameXid = await this.requestFrame(w); } catch (e) { console.error('[wm] frame', e); }
      if (!this.windows.has(w.id)) return; // vanished while we waited
      if (frameXid) {
        w.frame = frameXid;
        this.byXid.set(frameXid, w);
        w.ignoreUnmaps++;           // reparenting a mapped window unmaps it
        this.X.ReparentWindow(wid, frameXid, EDGE, TB);
      } else w.kind = 'csd';
    }
    // initial size/position: frame wraps the client's requested size
    const cw = g.width, ch = g.height;
    if (w.kind === 'native') { w.w = cw + EDGE * 2; w.h = ch + TB + EDGE; } else { w.w = cw; w.h = ch; }
    if (!hasPos || w.dialog) { w.x = null; w.y = null; } else { w.x = g.xPos; w.y = Math.max(this.workarea.top, g.yPos); }
    this.placeIfNeeded(w);
    this.X.MapWindow(wid);
    this.grabClicks(w.frame);
    this.setState(w, 1);
    this.setCardinal(wid, '_NET_FRAME_EXTENTS', w.kind === 'native' ? [EDGE, EDGE, TB, EDGE] : [0, 0, 0, 0]);
    this.setCardinal(wid, '_NET_WM_DESKTOP', [w.space]);
    this.showWindow(w);
    if (states.includes(A._NET_WM_STATE_FULLSCREEN)) this.setFullscreen(w.id, true);
    else if (states.includes(A._NET_WM_STATE_MAXIMIZED_VERT) && states.includes(A._NET_WM_STATE_MAXIMIZED_HORZ)) this.toggleMaximize(w.id);
  }

  requestFrame(w) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('frame timeout')), 8000);
      this.emit('need-frame', w, (xid) => { clearTimeout(t); resolve(xid); });
    });
  }

  placeIfNeeded(w) {
    const a = this.area();
    w.w = Math.min(w.w, a.w); w.h = Math.min(w.h, a.h);
    if (w.x == null || w.y == null || w.x < 0 || w.y < a.y - 1 || w.x + 40 > this.sw || w.y + 40 > this.sh) {
      const parent = w.transientFor && this.byXid.get(w.transientFor);
      if (parent) { w.x = parent.x + (parent.w - w.w) / 2; w.y = parent.y + Math.min(60, (parent.h - w.h) / 2); }
      else {
        const n = [...this.windows.values()].filter((o) => o !== w && o.space === this.space && !o.minimized).length;
        const off = (n % 7) * 28;
        w.x = a.x + (a.w - w.w) / 2 + off - 60; w.y = a.y + Math.max(8, (a.h - w.h) / 3) + off;
      }
    }
    w.x = Math.round(Math.max(a.x, Math.min(w.x, a.x + a.w - w.w))); w.y = Math.round(Math.max(a.y, w.y));
    this.applyGeometry(w);
  }

  unmanage(w, withdrawn) {
    if (!this.windows.has(w.id)) return;
    this.windows.delete(w.id);
    for (const [k, v] of this.byXid) if (v === w) this.byXid.delete(k);
    this.stack = this.stack.filter((x) => x !== w);
    if (withdrawn && w.kind === 'native' && w.frame !== w.client) {
      this.X.ReparentWindow(w.client, this.root, w.x, w.y);
      this.X.ChangeSaveSet(false, w.client);
      this.setState(w, 0);
    }
    if (w.frame !== w.client) this.emit('frame-gone', w);
    if (this.focused === w) { this.focused = null; this.focusTop(); }
    this.updateClientList();
    this.emit('changed');
  }

  setState(w, state) {
    const b = Buffer.alloc(8); b.writeUInt32LE(state, 0); b.writeUInt32LE(0, 4);
    this.X.ChangeProperty(0, w.client, this.A.WM_STATE, this.A.WM_STATE, 32, b);
  }

  grabClicks(xid) {
    // sync grab: we see the click first (to focus/raise), then replay it to the app
    this.X.GrabButton(xid, false, EM.ButtonPress, 0, 1, 0, 0, ANY_BUTTON, ANY_MODIFIER);
  }

  /* ================================================================ geometry */
  area() { return { x: 0, y: this.workarea.top, w: this.sw, h: this.sh - this.workarea.top - this.workarea.bottom }; }

  clientRect(w) {
    if (w.kind === 'native') return { x: w.x + EDGE, y: w.y + TB, w: w.w - EDGE * 2, h: w.h - TB - EDGE };
    return { x: w.x, y: w.y, w: w.w, h: w.h };
  }
  setClientRect(w, x, y, cw, ch) {
    if (w.kind === 'native') { w.x = x - EDGE; w.y = y - TB; w.w = cw + EDGE * 2; w.h = ch + TB + EDGE; }
    else { w.x = x; w.y = y; w.w = cw; w.h = ch; }
    this.applyGeometry(w);
  }
  applyGeometry(w) {
    const full = w.fullscreen;
    if (w.kind === 'native') {
      const inset = full ? { l: 0, t: 0 } : { l: EDGE, t: TB };
      this.X.ConfigureWindow(w.frame, { x: w.x, y: w.y, width: Math.max(1, w.w), height: Math.max(1, w.h) });
      this.X.ConfigureWindow(w.client, { x: inset.l, y: inset.t, width: Math.max(1, w.w - (full ? 0 : EDGE * 2)), height: Math.max(1, w.h - (full ? 0 : TB + EDGE)) });
      this.sendConfigureNotify(w);
    } else {
      this.X.ConfigureWindow(w.client, { x: w.x, y: w.y, width: Math.max(1, w.w), height: Math.max(1, w.h) });
    }
  }

  tileRect(kind) {
    const a = this.area(), g = 6, hw = (a.w - g * 3) / 2, hh = (a.h - g * 3) / 2;
    return {
      fill: [a.x + g, a.y + g, a.w - g * 2, a.h - g * 2], left: [a.x + g, a.y + g, hw, a.h - g * 2], right: [a.x + g * 2 + hw, a.y + g, hw, a.h - g * 2],
      tl: [a.x + g, a.y + g, hw, hh], tr: [a.x + g * 2 + hw, a.y + g, hw, hh], bl: [a.x + g, a.y + g * 2 + hh, hw, hh], br: [a.x + g * 2 + hw, a.y + g * 2 + hh, hw, hh],
      center: [a.x + a.w * 0.15, a.y + a.h * 0.08, a.w * 0.7, a.h * 0.84],
    }[kind];
  }

  /* ================================================================ actions */
  showWindow(w) {
    if (w.space !== this.space) return;
    if (w.minimized) return;
    this.X.MapWindow(w.frame);
    if (!this.stack.includes(w)) this.stack.push(w);
    this.activate(w.id);
    this.updateClientList();
  }

  activate(id) {
    const w = this.windows.get(id);
    if (!w || this.locked) return;
    if (w.space !== this.space) this.switchSpace(w.space);
    if (w.minimized) return this.restore(id);
    if (this.showingDesktop) this.toggleDesktop();
    this.stack = this.stack.filter((x) => x !== w);
    this.stack.push(w);
    // transient dialogs ride along on top of their parent
    for (const d of [...this.windows.values()]) if (d.transientFor === w.client && !d.minimized) { this.stack = this.stack.filter((x) => x !== d); this.stack.push(d); }
    this.focused = w;
    this.restack();
    this.focusClient(w);
    this.emit('changed');
  }

  focusClient(w) {
    const target = w.client;
    if (w.protocols && w.protocols.has(this.A.WM_TAKE_FOCUS)) this.sendClientMessage(target, this.A.WM_PROTOCOLS, [this.A.WM_TAKE_FOCUS, 0]);
    this.X.SetInputFocus(target, 1);
    this.setWindows(this.root, '_NET_ACTIVE_WINDOW', [target]);
  }

  focusTop() {
    const top = [...this.stack].reverse().find((w) => w.space === this.space && !w.minimized);
    if (top) this.activate(top.id);
    else { this.focused = null; if (this.desktop) this.X.SetInputFocus(this.desktop, 1); this.emit('changed'); }
  }

  /** Give the keyboard to the shell (Spotlight, Apps search, lock screen), or hand it back. */
  focusShell(on) {
    if (on && this.shell) this.X.SetInputFocus(this.shell, 1);
    else if (this.focused) this.focusClient(this.focused);
  }

  restack() {
    const X = this.X;
    const order = [];
    if (this.desktop) order.push(this.desktop);
    for (const w of this.stack) if (w.space === this.space && !w.minimized) order.push(w.frame);
    for (const o of this.others) order.push(o);
    if (this.catcherOn) order.push(this.catcher);
    for (const b of this.blurPool || []) if (b.mapped) order.push(b.id);
    if (this.shell) order.push(this.shell);
    for (const xid of order) X.ConfigureWindow(xid, { stackMode: 0 });
    this.setWindows(this.root, '_NET_CLIENT_LIST_STACKING', this.stack.map((w) => w.client));
  }

  updateClientList() { this.setWindows(this.root, '_NET_CLIENT_LIST', [...this.windows.values()].map((w) => w.client)); }

  close(id) {
    const w = this.windows.get(id);
    if (!w) return;
    if (w.kind === 'app') { this.emit('close-app-window', w); return; }
    if (w.protocols.has(this.A.WM_DELETE_WINDOW)) this.sendClientMessage(w.client, this.A.WM_PROTOCOLS, [this.A.WM_DELETE_WINDOW, 0]);
    else this.X.KillClient(w.client);
  }

  minimize(id) {
    const w = this.windows.get(id);
    if (!w || w.minimized) return;
    w.minimized = true;
    if (w.frame === w.client) w.ignoreUnmaps++;
    this.X.UnmapWindow(w.frame);
    this.setState(w, 3);
    if (this.focused === w) { this.focused = null; this.focusTop(); }
    this.emit('changed');
  }

  restore(id) {
    const w = this.windows.get(id);
    if (!w) return;
    if (w.space !== this.space) this.switchSpace(w.space);
    if (w.minimized) { w.minimized = false; this.X.MapWindow(w.frame); this.setState(w, 1); }
    this.activate(id);
  }

  toggleMaximize(id) {
    const w = this.windows.get(id);
    if (!w || !w.resizable) return;
    if (w.fullscreen) return this.setFullscreen(id, false);
    if (w.maximized || w.tile) {
      const r = w.restoreRect || { x: w.x + 60, y: w.y + 60, w: w.w * 0.7, h: w.h * 0.7 };
      w.maximized = false; w.tile = null;
      Object.assign(w, r);
      this.applyGeometry(w);
    } else this.tile(id, 'fill');
    this.emit('changed');
  }

  tile(id, kind) {
    const w = this.windows.get(id);
    if (!w || !w.resizable) return;
    if (w.fullscreen) this.setFullscreen(id, false);
    if (!w.maximized && !w.tile) w.restoreRect = { x: w.x, y: w.y, w: w.w, h: w.h };
    const [x, y, ww, hh] = this.tileRect(kind).map(Math.round);
    Object.assign(w, { x, y, w: ww, h: hh, tile: kind === 'center' ? null : kind, maximized: kind === 'fill' });
    this.applyGeometry(w);
    this.emit('changed');
  }

  setFullscreen(id, on) {
    const w = this.windows.get(id);
    if (!w || !!w.fullscreen === on) return;
    if (on) {
      w.preFull = { x: w.x, y: w.y, w: w.w, h: w.h };
      Object.assign(w, { fullscreen: true, x: 0, y: 0, w: this.sw, h: this.sh });
    } else Object.assign(w, { fullscreen: false }, w.preFull || {});
    this.applyGeometry(w);
    const b = Buffer.alloc(on ? 4 : 0); if (on) b.writeUInt32LE(this.A._NET_WM_STATE_FULLSCREEN);
    this.X.ChangeProperty(0, w.client, this.A._NET_WM_STATE, this.A.ATOM, 32, b);
    this.activate(id);
    this.emit('changed');
  }

  moveToSpace(id, space) {
    const w = this.windows.get(id);
    if (!w) return;
    w.space = space;
    this.setCardinal(w.client, '_NET_WM_DESKTOP', [space]);
    this.syncSpaceVisibility();
    this.emit('changed');
  }

  switchSpace(i) {
    i = Math.max(0, Math.min(this.spaces - 1, i));
    if (i === this.space) return;
    this.space = i;
    this.setCardinal(this.root, '_NET_CURRENT_DESKTOP', [i]);
    this.syncSpaceVisibility();
    this.focusTop();
    this.emit('changed');
  }
  setSpaces(n) {
    this.spaces = Math.max(1, n);
    for (const w of this.windows.values()) if (w.space >= this.spaces) w.space = this.spaces - 1;
    if (this.space >= this.spaces) this.space = this.spaces - 1;
    this.setCardinal(this.root, '_NET_NUMBER_OF_DESKTOPS', [this.spaces]);
    this.syncSpaceVisibility();
    this.emit('changed');
  }
  syncSpaceVisibility() {
    for (const w of this.windows.values()) {
      const visible = w.space === this.space && !w.minimized && !this.showingDesktop;
      if (visible && w.hidden) { w.hidden = false; this.X.MapWindow(w.frame); }
      if (!visible && !w.hidden && !w.minimized) { w.hidden = true; if (w.frame === w.client) w.ignoreUnmaps++; this.X.UnmapWindow(w.frame); }
    }
    this.restack();
  }

  toggleDesktop() {
    this.showingDesktop = !this.showingDesktop;
    this.syncSpaceVisibility();
    if (!this.showingDesktop) this.focusTop();
    this.emit('changed');
  }

  /* ================================================================ interactive move / resize */
  // The pointer is polled rather than grabbed: the button press already belongs to the window that was
  // clicked (often a Chromium title bar), and polling works no matter who holds the implicit grab.
  async beginMove(id) {
    const w = this.windows.get(id);
    if (!w || w.fullscreen || this.dragging) return;
    const p0 = await this.pointer();
    if (!p0) return;
    this.dragging = true;
    let start = { px: p0.rootX, py: p0.rootY, x: w.x, y: w.y };
    let snap = null, moved = false;
    const tick = async () => {
      const p = await this.pointer();
      if (!p || !(p.keyMask & BUTTON1)) return end();
      const dx = p.rootX - start.px, dy = p.rootY - start.py;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!moved) {
        moved = true;
        if (w.maximized || w.tile) {   // tear a tiled window off at its old size, under the pointer
          const r = w.restoreRect || { w: w.w * 0.7, h: w.h * 0.7 };
          const rel = (start.px - w.x) / w.w;
          w.maximized = false; w.tile = null; w.w = r.w; w.h = r.h;
          start = { px: p.rootX, py: p.rootY, x: Math.round(p.rootX - r.w * rel), y: w.y };
          this.emit('changed');
        }
      }
      w.x = start.x + (p.rootX - start.px);
      w.y = Math.max(this.workarea.top, start.y + (p.rootY - start.py));
      this.applyGeometry(w);
      const edge = 3, corner = this.sh * 0.18;
      snap = p.rootY <= this.workarea.top - 2 ? 'fill'
        : p.rootX <= edge ? (p.rootY < corner + this.workarea.top ? 'tl' : p.rootY > this.sh - corner ? 'bl' : 'left')
          : p.rootX >= this.sw - edge - 1 ? (p.rootY < corner + this.workarea.top ? 'tr' : p.rootY > this.sh - corner ? 'br' : 'right') : null;
      this.emit('snap-preview', snap ? this.tileRect(snap) : null);
    };
    let busy = false;
    const timer = setInterval(async () => { if (busy) return; busy = true; try { await tick(); } finally { busy = false; } }, 16);
    const end = () => {
      clearInterval(timer);
      this.dragging = false;
      this.emit('snap-preview', null);
      if (snap) { w.restoreRect = { x: start.x, y: start.y, w: w.w, h: w.h }; this.tile(id, snap); }
      else this.emit('changed');
    };
  }

  async beginResize(id, dir) {
    const w = this.windows.get(id);
    if (!w || w.fullscreen || !w.resizable || this.dragging) return;
    const p0 = await this.pointer();
    if (!p0) return;
    this.dragging = true;
    w.tile = null; w.maximized = false;
    const f = { x: w.x, y: w.y, w: w.w, h: w.h };
    const extraW = w.kind === 'native' ? EDGE * 2 : 0, extraH = w.kind === 'native' ? TB + EDGE : 0;
    const minW = w.minW + extraW, minH = w.minH + extraH;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      const p = await this.pointer();
      busy = false;
      if (!p || !(p.keyMask & BUTTON1)) { clearInterval(timer); this.dragging = false; this.emit('changed'); return; }
      const dx = p.rootX - p0.rootX, dy = p.rootY - p0.rootY;
      let { x, y, w: ww, h: hh } = f;
      if (dir.includes('e')) ww = Math.max(minW, f.w + dx);
      if (dir.includes('s')) hh = Math.max(minH, f.h + dy);
      if (dir.includes('w')) { ww = Math.max(minW, f.w - dx); x = f.x + f.w - ww; }
      if (dir.includes('n')) { hh = Math.max(minH, f.h - dy); y = f.y + f.h - hh; if (y < this.workarea.top) { hh -= this.workarea.top - y; y = this.workarea.top; } }
      Object.assign(w, { x, y, w: ww, h: hh });
      this.applyGeometry(w);
    }, 16);
  }

  /* ================================================================ shell layer */
  /**
   * The shell (menu bar, Dock, popovers) is one transparent fullscreen window. It always draws everywhere,
   * but only these rects take clicks — everything else passes through to the apps below. While a popover
   * is open (modal) the whole screen is clickable, so a click outside it can close it.
   */
  setShellInput(rects, modal) {
    if (!this.shell || !this.Shape) return;
    const r = modal ? [[0, 0, this.sw, this.sh]] : rects.length ? rects : [[0, 0, 1, 1]];
    this.Shape.Rectangles(this.Shape.Op.Set, this.Shape.Kind.Input, this.shell, 0, 0, r);
  }

  /**
   * Blur behind glass: one invisible, click-through window per glass surface, stacked just under the
   * shell. picom blurs what is behind each of them, with rounded corners chosen by the window's name.
   * regions: [{ x, y, w, h, r }] — r is one of the radius buckets listed in session/picom.conf.
   */
  setBlurRegions(regions) {
    if (!this.argbVisual || !this.shell) return;
    const X = this.X;
    let restack = false;
    regions.forEach((g, i) => {
      let b = this.blurPool[i];
      if (!b) {
        b = { id: X.AllocID(), mapped: false, geo: '', name: '' };
        X.CreateWindow(b.id, this.root, g.x, g.y, Math.max(1, g.w), Math.max(1, g.h), 0, 32, x11.InputOutput, this.argbVisual,
          { backgroundPixel: 0, borderPixel: 0, overrideRedirect: 1, colormap: this.argbColormap });
        if (this.Shape) this.Shape.Rectangles(this.Shape.Op.Set, this.Shape.Kind.Input, b.id, 0, 0, []);
        this.blurPool[i] = b;
      }
      const name = 'LiquidBlur r' + g.r;
      if (b.name !== name) { b.name = name; X.ChangeProperty(0, b.id, this.A.WM_NAME, this.A.STRING, 8, Buffer.from(name)); }
      const geo = `${g.x},${g.y},${g.w},${g.h}`;
      if (b.geo !== geo) { b.geo = geo; X.ConfigureWindow(b.id, { x: g.x, y: g.y, width: Math.max(1, g.w), height: Math.max(1, g.h) }); }
      if (!b.mapped) { b.mapped = true; X.MapWindow(b.id); restack = true; }
    });
    for (let i = regions.length; i < this.blurPool.length; i++) {
      const b = this.blurPool[i];
      if (b.mapped) { b.mapped = false; b.geo = ''; X.UnmapWindow(b.id); }
    }
    if (restack) for (const b of this.blurPool) if (b.mapped) X.ConfigureWindow(b.id, { sibling: this.shell, stackMode: 1 });
  }

  setWorkarea(top, bottom) {
    this.workarea = { top, bottom };
    this.updateWorkarea();
  }
  updateWorkarea() {
    const a = this.area();
    const vals = [];
    for (let i = 0; i < this.spaces; i++) vals.push(a.x, a.y, a.w, a.h);
    this.setCardinal(this.root, '_NET_WORKAREA', vals);
  }
  setLocked(on) { this.locked = on; if (on) this.focusShell(true); else this.focusTop(); }

  /* ================================================================ keyboard */
  async setupKeys() {
    const X = this.X, d = this.display;
    const min = d.min_keycode, max = d.max_keycode;
    const map = await new Promise((res) => X.GetKeyboardMapping(min, max - min + 1, (e, m) => res(e ? [] : m)));
    this.keycodeOf = {};
    this.keysymOf = {};
    map.forEach((syms, i) => {
      const code = min + i;
      this.keysymOf[code] = syms[0];
      for (const s of syms) if (s && !(s in this.keycodeOf)) this.keycodeOf[s] = code;
    });
    this.grabbed = [];
    for (const [name, mods, key] of SHORTCUTS) {
      const code = this.keycodeOf[KS[key]];
      if (!code) continue;
      for (const extra of [0, LOCK, NUMLOCK, LOCK | NUMLOCK]) X.GrabKey(this.root, true, mods | extra, code, 1, 1);
      this.grabbed.push({ name, mods, code });
    }
    if (process.env.LIQUID_WM_DEBUG) console.log('[wm] grabbed', this.grabbed.length, 'shortcuts');
  }

  onKey(ev, down) {
    const code = ev.keycode, mods = ev.buttons & (SHIFT | CTRL | ALT | SUPER);
    if (process.env.LIQUID_WM_DEBUG) console.log('[wm] key', down ? 'down' : 'up', code, 'mods', ev.buttons);
    const sym = this.keysymOf[code];
    if (this.switching) {
      // while Alt+Tab is held we own the keyboard; releasing Alt/Super picks the app
      if (!down && [KS.Alt_L, KS.Alt_R, KS.Super_L, KS.Super_R].includes(sym)) {
        this.switching = false; this.X.UngrabKeyboard(0); this.emit('shortcut', 'switcher-commit');
      } else if (down && sym === KS.Tab) this.emit('shortcut', mods & SHIFT ? 'switcher-prev' : 'switcher-next');
      else if (down && sym === 0xff1b) { this.switching = false; this.X.UngrabKeyboard(0); this.emit('shortcut', 'switcher-cancel'); }
      return;
    }
    if (!down) return;
    const hit = this.grabbed.find((g) => g.code === code && g.mods === mods);
    if (!hit) return;
    if (this.locked && hit.name !== 'lock') return;
    if (hit.name.startsWith('switcher')) {
      this.switching = true;
      this.X.GrabKeyboard(this.root, false, 0, 1, 1);
    }
    const w = this.focused;
    switch (hit.name) {
      case 'close': if (w) this.close(w.id); return;
      case 'minimize': if (w) this.minimize(w.id); return;
      case 'quit': if (w) this.emit('quit-app', w); return;
      case 'fullscreen': if (w) this.setFullscreen(w.id, !w.fullscreen); return;
      case 'tile-left': case 'tile-right': case 'tile-fill': case 'tile-center': if (w) this.tile(w.id, hit.name.slice(5)); return;
      case 'space-left': this.switchSpace(this.space - 1); return;
      case 'space-right': this.switchSpace(this.space + 1); return;
      case 'desktop': this.toggleDesktop(); return;
    }
    this.emit('shortcut', hit.name);
  }

  /* ================================================================ startup */
  async adoptExisting() {
    const tree = await new Promise((res) => this.X.QueryTree(this.root, (e, t) => res(e ? { children: [] } : t)));
    for (const wid of tree.children) {
      if (wid === this.check || wid === this.catcher) continue;
      const a = await this.attrs(wid);
      if (a && !a.overrideRedirect && a.mapState === 2) this.manageNative(wid);
    }
  }

  /* ================================================================ snapshot for the web UI */
  snapshot() {
    const order = this.stack.map((w) => w.id);
    return [...this.windows.values()].map((w) => ({
      id: w.id, kind: w.kind, appId: w.appId || null, title: w.title, wmClass: w.wmClass || null, menus: w.menus || null,
      x: w.x, y: w.y, w: w.w, h: w.h, minimized: w.minimized, maximized: !!w.maximized, fullscreen: !!w.fullscreen, tile: w.tile,
      space: w.space, focused: this.focused === w, z: order.indexOf(w.id), frame: w.frame,
    }));
  }
  state() { return { windows: this.snapshot(), space: this.space, spaces: this.spaces, showingDesktop: this.showingDesktop }; }
  changed(w) { this.emit('changed', w); }
}

module.exports = { WindowManager, TB, EDGE };
