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
  shotSave: true, shotCopy: true, shotDir: '', shotMode: 'area',
  dockHideMode: null,       // never | always | smart (hide only while a window is in the way); null = from dockAutohide
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
  filesShowHidden: false,
  filesSort: 'name',
  filesFoldersFirst: true,
  storeFlatpakScope: 'auto',  // auto | user | system
  storeShowArch: true,
  weatherUnits: 'auto',       // auto | c | f
  textWrap: false,
  textFontSize: 13,
  textTabSize: 4,
  terminalMiddlePaste: false, // paste the selection with the middle mouse button
  weatherCity: null,
  // Weather app (StormView-style)
  svMode: 'weather', svShowPanel: true, svPanelSide: 'left', svOverlay: 'radar', svBaseMap: 'muted', svSatellite: false,
  svScheme: 7, svOpacity: 0.75, svSmooth: true, svSnow: true, svSpeed: 1, svAdvisories: false, svCards: null, svRecent: [],        // { name, lat, lon }
  browserHome: 'start',
  browserSearch: 'duckduckgo',
  browserShowFavs: true,
  browserZoom: 0,
  browserOfferPasswords: true,
  browserAutofill: true,
  windowTiling: true,
  cursorTheme: 'MacOS-Tahoe-Cursor',
  cursorSize: 32,
  zoomAction: 'fill',       // green button: fill | fill-nodock | fullscreen
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
    // Write only this key on top of what's stored now: in a session several windows (desktop, shell,
    // apps) share these settings, and saving our whole copy could undo another window's newer change
    // (a widget that was just moved jumped back, for example).
    try {
      let cur = {};
      try { cur = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* corrupt: rewrite */ }
      cur[k] = v;
      localStorage.setItem(KEY, JSON.stringify(cur));
    } catch { /* storage full or blocked */ }
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
/** How the Dock hides: 'never', 'always' (auto-hide) or 'smart' (only while a window overlaps it). */
export function dockHideMode() { return store.get('dockHideMode') || (store.get('dockAutohide') ? 'always' : 'never'); }
/** Screen space kept free for the Dock at the bottom (none when it hides). */
export function dockReserve() { return dockHideMode() === 'never' ? store.get('dockSize') + 22 : 0; }
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
