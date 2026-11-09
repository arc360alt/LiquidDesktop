// The app catalog: built-in apps plus every installed Linux app (.desktop files).
import { api } from './sys.js';
import { registry, wm } from './wm.js';
import { bus } from './util.js';
import { appData } from './store.js';
export function recordRecent(id) { const r = appData.get('recentApps', []).filter((x) => x !== id); r.unshift(id); appData.set('recentApps', r.slice(0, 10)); }

bus.on('app-launched', (id) => recordRecent(id));

export const catalog = {
  native: [],
  extra: new Map(),   // apps known only by a running window (session mode)
  async load(force) {
    try { this.native = await api.apps.list(!!force); } catch { this.native = []; }
    bus.emit('catalog');
  },
  builtins() { return [...registry.values()].filter((a) => !a.hidden); },
  all() { return [...this.builtins(), ...this.native]; },
  find(id) { return registry.get(id) || this.native.find((a) => a.id === id) || this.extra.get(id) || null; },
  recent() { return appData.get('recentApps', []).map((id) => this.find(id)).filter(Boolean); },
  launch(idOrApp, args) {
    const app = typeof idOrApp === 'string' ? this.find(idOrApp) : idOrApp;
    if (!app) return;
    if (app.builtin) return wm.activate(app.id, args);
    if (wm.appWindows(app.id).length) return wm.activate(app.id);   // already running: bring it forward
    if (!app.exec) return;
    api.apps.launch(app.exec, app.terminal);
    recordRecent(app.id);
    bus.emit('native-launched', app.id);
  },
};
