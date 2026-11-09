// Window manager: windows, focus, drag/resize, snapping & tiling, minimize/zoom, Spaces, Mission Control.
import { h, $, $$, clamp, Emitter, bus, sleep } from './util.js';
import { sym, appIcon } from './icons.js';
import { store } from './store.js';
import { showMenu } from './menus.js';
import { wallpaperFor } from './theme.js';
import { layer, session as S } from './layer.js';

// In session mode each built-in app is its own real window; the X11 WM moves/resizes it.
const EMBED = layer === 'app';

export const registry = new Map();
export function registerApp(def) { registry.set(def.id, { size: [760, 500], minSize: [320, 220], ...def, builtin: true }); }
export const getApp = (id) => registry.get(id);

let zTop = 10;
let seq = 0;
const MENUBAR = 30;

class Win extends Emitter {
  constructor(app, opts = {}) {
    super();
    this.id = ++seq;
    this.app = app;
    this.title = opts.title || app.name;
    this.space = wm.currentSpace;
    this.minimized = false;
    this.maximized = false;
    this.fullscreen = false;
    this.tile = null;
    const [w, h0] = opts.size || app.size;
    this.minSize = opts.minSize || app.minSize;
    this.build(opts);
    const area = wm.workArea();
    const cascade = (wm.windows.filter((x) => x.app === app).length % 6) * 26;
    const W = Math.min(w, area.w - 20), H = Math.min(h0, area.h - 20);
    this.setFrame(opts.x ?? Math.round(area.x + (area.w - W) / 2 + cascade - 40), opts.y ?? Math.round(area.y + Math.max(10, (area.h - H) / 2.6) + cascade), W, H);
  }

  build(opts) {
    const app = this.app;
    this.traffic = h('div.traffic',
      h('button.tl-close', { title: 'Close', html: '<svg viewBox="0 0 10 10"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>', onclick: (e) => { e.stopPropagation(); this.close(); } }),
      h('button.tl-min', { title: 'Minimize', html: '<svg viewBox="0 0 10 10"><path d="M2 5h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>', onclick: (e) => { e.stopPropagation(); this.minimize(); } }),
      h('button.tl-max' + (app.resizable === false ? '.disabled' : ''), { title: 'Zoom', html: '<svg viewBox="0 0 10 10"><path d="M2.2 6.6V2.2h4.4zM7.8 3.4v4.4H3.4z" fill="currentColor"/></svg>', onclick: (e) => { e.stopPropagation(); if (app.resizable !== false) e.altKey ? this.toggleFullscreen() : this.zoom(); } }));
    // hovering the green button shows the tiling menu, like macOS 26
    let hoverT;
    const maxBtn = this.traffic.lastChild;
    maxBtn.addEventListener('mouseenter', () => { if (app.resizable === false) return; hoverT = setTimeout(() => this.tileMenu(maxBtn), 700); });
    maxBtn.addEventListener('mouseleave', () => clearTimeout(hoverT));
    maxBtn.addEventListener('mousedown', () => clearTimeout(hoverT));

    this.titleEl = h('div.win-title' + (app.titleCenter !== false ? '.center' : ''), this.title);
    this.toolbar = h('div.win-toolbar');
    this.dragEl = h('div.drag');
    this.titlebar = h('div.win-titlebar', this.dragEl, this.traffic, this.toolbar, app.hideTitle ? null : this.titleEl);
    this.body = h('div.win-body' + (app.overlayContent ? '' : '.pad-top'));
    this.clip = h('div.win-clip', this.body, this.titlebar);
    this.el = h('div.win.opening', { 'data-app': app.id }, this.clip, h('div.shield'));
    if (app.className) this.el.classList.add(...app.className.split(' '));
    if (app.resizable !== false) for (const d of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) this.el.append(h('div.rz.' + d, { onmousedown: (e) => this.startResize(e, d) }));
    this.el.addEventListener('animationend', () => this.el.classList.remove('opening'), { once: true });
    this.el.addEventListener('mousedown', () => this.focus(), true);
    this.titlebar.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('button, input, select, textarea, .no-drag, a')) return;
      this.startDrag(e);
    });
    this.titlebar.addEventListener('dblclick', (e) => { if (!e.target.closest('button, input, .no-drag') && app.resizable !== false) this.toggleMaximize(); });
    this.titlebar.addEventListener('contextmenu', (e) => { if (!e.target.closest('input')) { e.preventDefault(); this.windowMenu(e.clientX, e.clientY); } });
    wm.spaceEl(this.space).append(this.el);
    if (EMBED) addEventListener('resize', () => this.setFrame());
  }

  /** Let an app element act as a title bar (drag + double-click). */
  dragRegion(el) {
    el.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest('button, input, select, textarea, .no-drag, a, .sb-item, .note-item')) this.startDrag(e); });
    el.addEventListener('dblclick', (e) => { if (!e.target.closest('button, input, .no-drag, .sb-item, .note-item')) this.toggleMaximize(); });
  }

  setTitle(t) { this.title = t; this.titleEl.textContent = t; this.emit('title', t); bus.emit('windows'); }

  setFrame(x, y, w, h) {
    if (EMBED) {
      Object.assign(this.el.style, { left: '0', top: '0', width: '100%', height: '100%' });
      this.x = 0; this.y = 0; this.w = innerWidth; this.h = innerHeight;
      this.emit('resize');
      return;
    }
    const [mw, mh] = this.minSize;
    this.x = Math.round(x); this.y = Math.round(y); this.w = Math.round(Math.max(mw, w)); this.h = Math.round(Math.max(mh, h));
    Object.assign(this.el.style, { left: this.x + 'px', top: this.y + 'px', width: this.w + 'px', height: this.h + 'px' });
    this.emit('resize');
  }

  animateFrame(x, y, w, h) {
    if (EMBED) return this.setFrame();
    this.el.classList.add('animating');
    this.setFrame(x, y, w, h);
    clearTimeout(this._at);
    this._at = setTimeout(() => { this.el.classList.remove('animating'); this.emit('resize'); }, 400);
  }

  focus() {
    if (EMBED) {   // the X11 WM already raised and focused us on click
      this.el.classList.add('focused');
      if (wm.focused !== this) { wm.focused = this; this.emit('focus'); bus.emit('focus', this); }
      return;
    }
    if (wm.focused === this && this.el.classList.contains('focused')) return;
    if (this.space !== wm.currentSpace) wm.switchSpace(this.space);
    if (this.minimized) return this.restore();
    for (const w of wm.windows) if (w !== this) w.el.classList.remove('focused');
    this.el.classList.add('focused');
    this.el.style.zIndex = ++zTop;
    wm.focused = this;
    wm.mru = [this, ...wm.mru.filter((w) => w !== this)];
    this.emit('focus');
    bus.emit('focus', this);
  }

  blur() { this.el.classList.remove('focused'); if (wm.focused === this) { wm.focused = null; bus.emit('focus', null); } }

  async close(force) {
    if (!force && this.beforeClose && (await this.beforeClose()) === false) return;
    this.emit('close');
    if (EMBED) { window.close(); return; }
    this.el.classList.add('closing');
    wm.windows = wm.windows.filter((w) => w !== this);
    wm.mru = wm.mru.filter((w) => w !== this);
    if (wm.focused === this) wm.focused = null;
    setTimeout(() => this.el.remove(), 220);
    if (this.fullscreen) document.body.classList.remove('app-fullscreen');
    wm.focusNext();
    bus.emit('windows');
  }

  minimize() {
    if (EMBED) return S.send('appwin:self', 'minimize');
    if (this.minimized) return;
    this.minimized = true;
    bus.emit('windows'); // the dock adds a tile for us first, so we can fly into it
    requestAnimationFrame(() => {
      const target = document.querySelector(`.dock-item[data-win="${this.id}"]`)?.getBoundingClientRect();
      const r = this.el.getBoundingClientRect();
      const tx = target ? target.left + target.width / 2 - (r.left + r.width / 2) : 0;
      const ty = target ? target.top + target.height / 2 - (r.top + r.height / 2) : innerHeight;
      const s = target ? Math.max(0.04, target.width / r.width) : 0.1;
      this.el.classList.add('minimizing');
      this.el.style.transformOrigin = 'center';
      this.el.style.transform = `translate(${tx}px, ${ty}px) scale(${s}, ${s * 0.8})`;
      this.el.style.opacity = '0.2';
      setTimeout(() => { this.el.style.visibility = 'hidden'; this.el.classList.remove('minimizing'); }, 500);
    });
    if (wm.focused === this) { this.blur(); wm.focusNext(); }
  }

  restore() {
    if (!this.minimized) return;
    if (this.space !== wm.currentSpace) wm.switchSpace(this.space);
    this.minimized = false;
    this.el.style.visibility = '';
    this.el.classList.add('minimizing');
    requestAnimationFrame(() => { this.el.style.transform = ''; this.el.style.opacity = ''; });
    setTimeout(() => this.el.classList.remove('minimizing'), 500);
    bus.emit('windows');
    this.focus();
  }

  toggleMaximize() {
    if (EMBED) return S.send('appwin:self', 'toggleMaximize');
    if (this.fullscreen) return this.toggleFullscreen();
    if (this.maximized || this.tile) {
      const r = this.restoreFrame || { x: this.x + 40, y: this.y + 40, w: this.w * 0.7, h: this.h * 0.7 };
      this.maximized = false; this.tile = null;
      this.el.classList.remove('maximized');
      this.animateFrame(r.x, r.y, r.w, r.h);
    } else {
      this.tileTo('fill');
    }
    bus.emit('windows');
  }

  /** The green button: what it does is chosen in Settings › Desktop & Dock (double-clicking the title bar always fills). */
  zoom(mode = store.get('zoomAction') || 'fill') {
    if (EMBED) return S.send('appwin:self', 'zoom', mode);
    if (mode === 'fullscreen') return this.toggleFullscreen();
    if (mode === 'fill-nodock') return this.tile === 'fill-nodock' ? this.toggleMaximize() : this.tileTo('fill-nodock');
    return this.toggleMaximize();
  }

  tileTo(kind) {
    if (EMBED) return S.send('appwin:self', 'tile', kind);
    if (!this.maximized && !this.tile) this.restoreFrame = { x: this.x, y: this.y, w: this.w, h: this.h };
    const a = wm.workArea(), g = 6;
    const half = (a.w - g * 3) / 2, vh = (a.h - g * 3) / 2;
    const frames = {
      fill: [a.x + g, a.y + g, a.w - g * 2, a.h - g * 2],
      left: [a.x + g, a.y + g, half, a.h - g * 2], right: [a.x + g * 2 + half, a.y + g, half, a.h - g * 2],
      tl: [a.x + g, a.y + g, half, vh], tr: [a.x + g * 2 + half, a.y + g, half, vh],
      bl: [a.x + g, a.y + g * 2 + vh, half, vh], br: [a.x + g * 2 + half, a.y + g * 2 + vh, half, vh],
      center: [a.x + a.w * 0.15, a.y + a.h * 0.1, a.w * 0.7, a.h * 0.8],
      'fill-nodock': [0, MENUBAR, innerWidth, innerHeight - MENUBAR],
    };
    const f = frames[kind];
    this.tile = kind === 'center' ? null : kind;
    this.maximized = kind === 'fill' || kind === 'fill-nodock';
    this.animateFrame(...f);
    bus.emit('windows');
  }

  toggleFullscreen() {
    if (EMBED) return S.send('appwin:self', 'fullscreen');
    if (!this.fullscreen) {
      this.preFull = { x: this.x, y: this.y, w: this.w, h: this.h, max: this.maximized };
      this.fullscreen = true; this.maximized = true;
      this.el.classList.add('maximized');
      document.body.classList.add('app-fullscreen');
      this.animateFrame(0, 0, innerWidth, innerHeight);
    } else {
      this.fullscreen = false; this.maximized = this.preFull.max;
      this.el.classList.remove('maximized');
      document.body.classList.remove('app-fullscreen');
      const p = this.preFull; this.animateFrame(p.x, p.y, p.w, p.h);
    }
    bus.emit('windows');
  }

  tileMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const tileIcon = (rects) => `<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/>${rects}</svg>`;
    showMenu([
      { header: 'Move & Resize' },
      { label: 'Fill', icon: tileIcon('<rect x="4" y="6" width="16" height="12" rx="1.5" fill="currentColor"/>'), shortcut: '⌥⇧F', action: () => this.tileTo('fill') },
      { label: 'Center', icon: tileIcon('<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>'), action: () => this.tileTo('center') },
      '-',
      { label: 'Left', icon: tileIcon('<rect x="4" y="6" width="7.5" height="12" rx="1.5" fill="currentColor"/>'), shortcut: '⌥⇧←', action: () => this.tileTo('left') },
      { label: 'Right', icon: tileIcon('<rect x="12.5" y="6" width="7.5" height="12" rx="1.5" fill="currentColor"/>'), shortcut: '⌥⇧→', action: () => this.tileTo('right') },
      { label: 'Top Left', icon: tileIcon('<rect x="4" y="6" width="7.5" height="5.5" rx="1" fill="currentColor"/>'), action: () => this.tileTo('tl') },
      { label: 'Top Right', icon: tileIcon('<rect x="12.5" y="6" width="7.5" height="5.5" rx="1" fill="currentColor"/>'), action: () => this.tileTo('tr') },
      { label: 'Bottom Left', icon: tileIcon('<rect x="4" y="12.5" width="7.5" height="5.5" rx="1" fill="currentColor"/>'), action: () => this.tileTo('bl') },
      { label: 'Bottom Right', icon: tileIcon('<rect x="12.5" y="12.5" width="7.5" height="5.5" rx="1" fill="currentColor"/>'), action: () => this.tileTo('br') },
      '-',
      { label: this.fullscreen ? 'Exit Full Screen' : 'Enter Full Screen', shortcut: '⌃⌘F', action: () => this.toggleFullscreen() },
      { label: 'Move to Desktop', submenu: wm.spaceNames().map((n, i) => ({ label: n, checked: i === this.space, action: () => wm.moveToSpace(this, i) })) },
    ], r.left - 6, r.bottom + 6);
  }

  windowMenu(x, y) {
    showMenu([
      { label: 'Minimize', shortcut: '⌘M', action: () => this.minimize() },
      { label: this.maximized ? 'Restore' : 'Zoom', action: () => this.toggleMaximize(), disabled: this.app.resizable === false },
      { label: 'Tile Left', action: () => this.tileTo('left') }, { label: 'Tile Right', action: () => this.tileTo('right') },
      { label: 'Move to Desktop', submenu: wm.spaceNames().map((n, i) => ({ label: n, checked: i === this.space, action: () => wm.moveToSpace(this, i) })) },
      '-', { label: 'Close', shortcut: '⌘W', action: () => this.close() },
    ], x, y);
  }

  /* ---------------------------------------------- drag + snapping */
  startDrag(e) {
    e.preventDefault();
    if (EMBED) return S.send('appwin:self', 'beginMove');
    const sx = e.clientX, sy = e.clientY;
    let ox = this.x, oy = this.y, moved = false, snap = null;
    const preview = h('div.snap-preview', { hidden: true });
    wm.spaceEl(this.space).append(preview);
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!moved) {
        moved = true;
        document.body.classList.add('dragging-win');
        if (this.fullscreen) this.toggleFullscreen();
        if (this.maximized || this.tile) {   // tear a tiled window off at its previous size, under the pointer
          const r = this.restoreFrame || { w: this.w * 0.7, h: this.h * 0.7 };
          const rel = (sx - this.x) / this.w;
          this.maximized = false; this.tile = null; this.el.classList.remove('maximized');
          ox = sx - r.w * rel; oy = this.y;
          this.setFrame(ox, oy, r.w, r.h);
          bus.emit('windows');
        }
      }
      this.setFrame(ox + dx, Math.max(MENUBAR, oy + dy), this.w, this.h);
      if (!store.get('windowTiling')) return;
      const W = innerWidth, H = innerHeight, edge = 3, corner = H * 0.18;
      snap = null;
      if (ev.clientY <= MENUBAR + 2) snap = 'fill';
      else if (ev.clientX <= edge) snap = ev.clientY < corner + MENUBAR ? 'tl' : ev.clientY > H - corner ? 'bl' : 'left';
      else if (ev.clientX >= W - edge) snap = ev.clientY < corner + MENUBAR ? 'tr' : ev.clientY > H - corner ? 'br' : 'right';
      if (snap) {
        const a = wm.workArea(), g = 6, hw = (a.w - g * 3) / 2, hh = (a.h - g * 3) / 2;
        const f = { fill: [a.x + g, a.y + g, a.w - g * 2, a.h - g * 2], left: [a.x + g, a.y + g, hw, a.h - g * 2], right: [a.x + g * 2 + hw, a.y + g, hw, a.h - g * 2],
          tl: [a.x + g, a.y + g, hw, hh], tr: [a.x + g * 2 + hw, a.y + g, hw, hh], bl: [a.x + g, a.y + g * 2 + hh, hw, hh], br: [a.x + g * 2 + hw, a.y + g * 2 + hh, hw, hh] }[snap];
        preview.hidden = false;
        Object.assign(preview.style, { left: f[0] + 'px', top: f[1] + 'px', width: f[2] + 'px', height: f[3] + 'px', zIndex: zTop - 1 });
      } else preview.hidden = true;
    };
    const up = () => {
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      document.body.classList.remove('dragging-win');
      preview.remove();
      if (snap) { this.restoreFrame = { x: ox, y: oy, w: this.w, h: this.h }; this.tileTo(snap); }
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  }

  startResize(e, dir) {
    e.preventDefault(); e.stopPropagation();
    if (EMBED) return S.send('appwin:self', 'beginResize', dir);
    this.focus();
    const sx = e.clientX, sy = e.clientY, f = { x: this.x, y: this.y, w: this.w, h: this.h };
    document.body.classList.add('resizing-win');
    document.body.style.cursor = getComputedStyle(e.target).cursor;
    this.tile = null;
    const [mw, mh] = this.minSize;
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      let { x, y, w, h: hh } = f;
      if (dir.includes('e')) w = f.w + dx;
      if (dir.includes('s')) hh = f.h + dy;
      if (dir.includes('w')) { w = Math.max(mw, f.w - dx); x = f.x + f.w - w; }
      if (dir.includes('n')) { hh = Math.max(mh, f.h - dy); y = f.y + f.h - hh; if (y < MENUBAR) { hh -= MENUBAR - y; y = MENUBAR; } }
      this.setFrame(x, y, w, hh);
    };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); document.body.classList.remove('resizing-win'); document.body.style.cursor = ''; };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  }
}

/* ------------------------------------------------------------------ the manager */
export const wm = {
  windows: [],
  mru: [],
  focused: null,
  currentSpace: 0,
  spaceEls: [],
  Win,

  init() {
    const n = store.get('spaces') || 1;
    for (let i = 0; i < n; i++) this.addSpaceEl();
    this.layoutSpaces(false);
  },
  addSpaceEl() { const el = h('div.space'); $('#spaces').append(el); this.spaceEls.push(el); return el; },
  spaceEl(i) { return this.spaceEls[i] || this.spaceEls[0]; },
  spaceNames() { return Array.from({ length: EMBED ? store.get('spaces') || 1 : this.spaceEls.length }, (_, i) => `Desktop ${i + 1}`); },
  layoutSpaces(anim = true) {
    this.spaceEls.forEach((el, i) => {
      el.style.transition = anim ? '' : 'none';
      el.style.transform = `translateX(${(i - this.currentSpace) * 100}%)`;
      el.style.visibility = i === this.currentSpace || anim ? 'visible' : 'hidden';
    });
    if (anim) setTimeout(() => this.spaceEls.forEach((el, i) => (el.style.visibility = i === this.currentSpace ? 'visible' : 'hidden')), 560);
  },
  switchSpace(i) {
    i = clamp(i, 0, this.spaceEls.length - 1);
    if (i === this.currentSpace) return;
    this.spaceEls.forEach((el) => (el.style.visibility = 'visible'));
    this.currentSpace = i;
    this.layoutSpaces(true);
    const top = this.mru.find((w) => w.space === i && !w.minimized);
    if (top) top.focus(); else { this.focused?.blur(); }
    bus.emit('space', i);
    bus.emit('windows');
  },
  addSpace() {
    this.addSpaceEl();
    store.set('spaces', this.spaceEls.length);
    this.layoutSpaces(false);
    bus.emit('spaces');
  },
  removeSpace(i) {
    if (this.spaceEls.length <= 1) return;
    const target = i === 0 ? 1 : i - 1;
    for (const w of this.windows.filter((w) => w.space === i)) this.moveToSpace(w, target, true);
    this.spaceEls[i].remove();
    this.spaceEls.splice(i, 1);
    for (const w of this.windows) if (w.space > i) w.space--;
    if (this.currentSpace >= this.spaceEls.length || this.currentSpace > i) this.currentSpace = Math.max(0, this.currentSpace - (this.currentSpace >= i ? 1 : 0));
    store.set('spaces', this.spaceEls.length);
    this.layoutSpaces(false);
    bus.emit('spaces');
  },
  moveToSpace(w, i, quiet) {
    if (EMBED) return S.send('appwin:self', 'moveToSpace', i);
    w.space = i;
    this.spaceEl(i).append(w.el);
    if (!quiet) { this.switchSpace(i); w.focus(); }
    bus.emit('windows');
  },

  workArea() {
    const dockH = store.get('dockAutohide') ? 0 : store.get('dockSize') + 22;
    return { x: 0, y: MENUBAR, w: innerWidth, h: innerHeight - MENUBAR - dockH };
  },

  /** Open a new window of a built-in app. */
  open(appId, args = {}) {
    const app = registry.get(appId);
    if (!app) throw new Error('No app ' + appId);
    if (app.singleton) {
      const existing = this.windows.find((w) => w.app === app);
      if (existing) { existing.focus(); existing.emit('reopen', args); return existing; }
    }
    const win = new Win(app, args.window || {});
    this.windows.push(win);
    try { app.open(win, args); } catch (err) { console.error(err); }
    win.focus();
    bus.emit('windows');
    bus.emit('app-launched', appId);
    return win;
  },
  /** Bring an app forward, or launch it if it has no windows. */
  activate(appId, args) {
    const wins = this.mru.filter((w) => w.app.id === appId);
    if (!wins.length) return this.open(appId, args);
    const visible = wins.filter((w) => !w.minimized);
    if (!visible.length) { wins[0].restore(); return wins[0]; }
    if (this.focused?.app.id === appId && visible.length) return this.focused;
    // bring all the app's windows forward, most recent on top
    for (const w of [...visible].reverse()) { if (w.space === this.currentSpace) w.el.style.zIndex = ++zTop; }
    visible[0].focus();
    return visible[0];
  },
  quitApp(appId) { for (const w of this.windows.filter((w) => w.app.id === appId)) w.close(); },
  appWindows(appId) { return this.windows.filter((w) => w.app.id === appId); },
  runningApps() { const seen = []; for (const w of this.windows) if (!seen.includes(w.app.id)) seen.push(w.app.id); return seen; },
  focusNext() {
    const next = this.mru.find((w) => !w.minimized && w.space === this.currentSpace && w !== this.focused);
    if (next) next.focus(); else bus.emit('focus', null);
  },
  hideOthers() { for (const w of this.windows) if (this.focused && w.app !== this.focused.app) w.minimize(); },

  /* ---------------------------------------------- Show Desktop: push every window to the edges */
  showingDesktop: false,
  toggleDesktop() {
    this.showingDesktop = !this.showingDesktop;
    for (const w of this.windows.filter((w) => w.space === this.currentSpace && !w.minimized)) {
      w.el.classList.add('animating');
      if (this.showingDesktop) {
        const cx = w.x + w.w / 2, cy = w.y + w.h / 2;
        const dx = cx < innerWidth / 2 ? -(w.x + w.w - 30) : innerWidth - w.x - 30;
        const dy = cy < innerHeight / 2 ? -40 : 40;
        w.el.style.transform = `translate(${dx}px, ${dy}px)`;
        w.el.style.opacity = '0.7';
      } else { w.el.style.transform = ''; w.el.style.opacity = ''; }
      setTimeout(() => w.el.classList.remove('animating'), 500);
    }
  },

  /* ---------------------------------------------- Mission Control */
  missionOpen: false,
  mission() {
    if (this.missionOpen) return this.closeMission();
    if (this.showingDesktop) this.toggleDesktop();
    this.missionOpen = true;
    const layer = h('div#mission');
    const bar = h('div.spaces-bar');
    layer.append(bar);
    const labels = [];
    const renderSpaces = () => {
      bar.innerHTML = '';
      this.spaceEls.forEach((_, i) => {
        const pv = h('div.pv', { style: { backgroundImage: `url("${wallpaperFor(300, 168)}")` } });
        for (const w of this.windows.filter((w) => w.space === i && !w.minimized)) {
          pv.append(h('i', { style: { left: (w.x / innerWidth) * 100 + '%', top: (w.y / innerHeight) * 100 + '%', width: (w.w / innerWidth) * 100 + '%', height: (w.h / innerHeight) * 100 + '%' } }));
        }
        const t = h('div.space-thumb' + (i === this.currentSpace ? '.cur' : ''), { 'data-space': i },
          this.spaceEls.length > 1 ? h('button.close', { html: sym.close, onclick: (e) => { e.stopPropagation(); this.removeSpace(i); renderSpaces(); layoutWins(); } }) : null,
          pv, h('span', `Desktop ${i + 1}`));
        t.addEventListener('click', (e) => { e.stopPropagation(); this.switchSpace(i); renderSpaces(); layoutWins(); });
        bar.append(t);
      });
      bar.append(h('button.space-add', { title: 'Add Desktop', onclick: (e) => { e.stopPropagation(); this.addSpace(); renderSpaces(); } }, '+'));
    };
    const layoutWins = () => {
      labels.forEach((l) => l.remove()); labels.length = 0;
      for (const w of this.windows) { w.el.style.transform = ''; w.el.classList.remove('mc'); }
      const wins = this.windows.filter((w) => w.space === this.currentSpace && !w.minimized);
      const top = 140, pad = 40, W = innerWidth - pad * 2, H = innerHeight - top - 60;
      const n = wins.length; if (!n) return;
      const cols = Math.ceil(Math.sqrt(n * (W / H) / 1.4)), rows = Math.ceil(n / cols);
      const cw = W / cols, ch = H / rows;
      wins.forEach((w, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        const inRow = r === rows - 1 ? n - r * cols : cols;
        const rowOffset = (cols - inRow) * cw / 2;
        const s = Math.min(1, (cw - 40) / w.w, (ch - 50) / w.h);
        const tx = pad + rowOffset + c * cw + cw / 2 - (w.x + w.w / 2);
        const ty = top + r * ch + ch / 2 - (w.y + w.h / 2);
        w.el.classList.add('animating', 'mc');
        w.el.style.zIndex = 7600 + i;
        w.el.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
        const lbl = h('div.mc-label.glass.panel', appIcon(w.app.id, 'icon'), w.title);
        lbl.style.left = pad + rowOffset + c * cw + cw / 2 + 'px';
        lbl.style.top = top + r * ch + ch / 2 + (w.h * s) / 2 + 8 + 'px';
        lbl.style.opacity = '0';
        layer.append(lbl); labels.push(lbl);
        w._mcLabel = lbl;
      });
    };
    this._mcHandlers = [];
    const onWinClick = (e) => {
      const el = e.target.closest('.win.mc');
      if (!el || !this.missionOpen) return;
      e.stopPropagation(); e.preventDefault();
      const w = this.windows.find((x) => x.el === el);
      this.closeMission(); w?.focus();
    };
    const onOver = (e) => {
      const el = e.target.closest?.('.win.mc');
      for (const w of this.windows) if (w._mcLabel) w._mcLabel.style.opacity = w.el === el ? '1' : '0';
    };
    // drag windows onto a desktop thumbnail to move them between Spaces
    const onDown = (e) => {
      const el = e.target.closest('.win.mc'); if (!el) return;
      const w = this.windows.find((x) => x.el === el);
      const sx = e.clientX, sy = e.clientY, base = el.style.transform;
      let dragging = false;
      const mv = (ev) => {
        if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        dragging = true; el.classList.remove('animating');
        el.style.transform = `translate(${ev.clientX - sx}px, ${ev.clientY - sy}px) ` + base;
        $$('.space-thumb', bar).forEach((t) => t.classList.toggle('drop', document.elementsFromPoint(ev.clientX, ev.clientY).includes(t.querySelector('.pv'))));
      };
      const upH = (ev) => {
        removeEventListener('mousemove', mv, true); removeEventListener('mouseup', upH, true);
        if (!dragging) return;
        ev.stopPropagation();
        const t = $$('.space-thumb', bar).find((t) => t.classList.contains('drop'));
        if (t) { this.moveToSpace(w, Number(t.dataset.space), true); renderSpaces(); }
        layoutWins();
        el.addEventListener('click', (c) => c.stopPropagation(), { capture: true, once: true });
      };
      addEventListener('mousemove', mv, true); addEventListener('mouseup', upH, true);
    };
    document.addEventListener('click', onWinClick, true);
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mousedown', onDown, true);
    this._mcHandlers = [['click', onWinClick, true], ['mouseover', onOver, false], ['mousedown', onDown, true]];
    layer.addEventListener('click', () => this.closeMission());
    $('#desktop').append(layer);
    document.body.classList.add('mission-open');
    renderSpaces();
    layoutWins();
    this._mcLayer = layer;
    bus.emit('mission', true);
  },
  closeMission() {
    if (!this.missionOpen) return;
    this.missionOpen = false;
    for (const [ev, fn, cap] of this._mcHandlers) document.removeEventListener(ev, fn, cap);
    for (const w of this.windows) {
      w.el.style.transform = '';
      w.el.classList.remove('mc');
      w._mcLabel = null;
      setTimeout(() => w.el.classList.remove('animating'), 450);
    }
    for (const w of this.mru.slice().reverse()) w.el.style.zIndex = ++zTop;
    const l = this._mcLayer; l.classList.add('closing'); setTimeout(() => { l.remove(); if (!this.missionOpen) document.body.classList.remove('mission-open'); }, 300);
    bus.emit('mission', false);
  },
};
