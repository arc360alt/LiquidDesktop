// Persistent settings with change events.
import { Emitter } from './util.js';

const KEY = 'liquid.settings.v1';
export const defaults = {
  theme: 'auto',            // light | dark | auto (follows time of day)
  accent: '#0a84ff',
  glass: 'clear',           // clear | tinted
  refraction: true,         // SVG lens refraction on glass edges
  reduceTransparency: false,
  iconStyle: 'default',     // default | dark | clear | tinted
  uniformIcons: true,       // put Linux app icons on a squircle like the rest
  wallpaper: 'peaks',
  customWallpaper: '',
  dynamicWallpaper: true,   // wallpaper shifts between day and night palettes
  dockSize: 54,
  dockMagnify: true,
  dockMagSize: 84,
  dockAutohide: false,
  dockPinned: ['files', 'browser', 'terminal', 'notes', 'calendar', 'weather', 'appstore', 'monitor', 'calculator', 'settings'],
  showRecents: true,
  showDesktopIcons: true,
  widgets: [
    { id: 'w1', type: 'clock', x: 40, y: 50 },
    { id: 'w2', type: 'calendar', x: 216, y: 50 },
    { id: 'w3', type: 'weather', x: 40, y: 226 },
    { id: 'w4', type: 'system', x: 216, y: 226 },
  ],
  nightShift: false,
  dnd: false,
  clock24: false,
  showSeconds: false,
  showBatteryPct: true,
  hotCorners: { tl: 'none', tr: 'none', bl: 'none', br: 'desktop' },
  requirePassword: true,
  spaces: 2,
  terminalTheme: 'glass',   // glass | dark | light
  terminalFontSize: 13,
  terminalShell: '',        // '' = your login shell ($SHELL)
  terminalLogin: false,     // start it as a login shell
  terminalFont: '',         // '' = best available monospace font
  terminalCursor: 'bar',    // bar | block | underline
  terminalBlink: true,
  terminalScrollback: 5000,
  terminalCwd: '',          // '' = home folder
  weatherCity: null,        // { name, lat, lon }
  browserHome: 'start',
  windowTiling: true,
};

class Store extends Emitter {
  constructor() {
    super();
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* corrupt settings: start fresh */ }
    this.s = { ...defaults, ...saved };
  }
  get(k) { return this.s[k]; }
  set(k, v) {
    this.s[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(this.s)); } catch { /* storage full or blocked */ }
    this.emit('change', k, v);
    this.emit('change:' + k, v);
  }
  reset() { localStorage.removeItem(KEY); location.reload(); }
  // other windows of the same desktop (session layers, app windows) change settings too
  listen() {
    addEventListener('storage', (e) => {
      if (e.key !== KEY || !e.newValue) return;
      let next; try { next = { ...defaults, ...JSON.parse(e.newValue) }; } catch { return; }
      for (const k of Object.keys(next)) {
        if (JSON.stringify(next[k]) === JSON.stringify(this.s[k])) continue;
        this.s[k] = next[k];
        this.emit('change', k, next[k]);
        this.emit('change:' + k, next[k]);
      }
    });
  }
}
export const store = new Store();
store.listen();
if (!store.get('appstorePinned')) {
  const p = store.get('dockPinned');
  if (!p.includes('appstore')) { const i = p.indexOf('settings'); p.splice(i < 0 ? p.length : i, 0, 'appstore'); store.set('dockPinned', [...p]); }
  store.set('appstorePinned', true);
}

// Simple per-app JSON storage (notes, calendar events, …)
export const appData = {
  get(app, fallback) { try { const v = localStorage.getItem('liquid.app.' + app); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(app, v) { try { localStorage.setItem('liquid.app.' + app, JSON.stringify(v)); } catch { /* ignore */ } },
};
