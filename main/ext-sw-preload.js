// Runs in every extension's background service worker in the Browser session.
// Electron lacks chrome.windows and chrome.permissions and never marks a tab as "active"; many extensions
// (uBlock Origin Lite, Dark Reader…) use these at startup and stop working without them.
const { contextBridge } = require('electron');

const install =
  // Runs in the extension's own JavaScript world. Chromium attaches the real `chrome` APIs after
  // preload scripts run, so instead of patching `chrome` we provide `browser` (which many extensions
  // prefer): it forwards to the live `chrome` at call time and fills in what Electron lacks.
  (mode) => {
    const activeTabId = async () => (mode === 'page' && globalThis.__liquidBrowser ? globalThis.__liquidBrowser.activeTab() : null);
    const ev = () => ({ addListener() {}, removeListener() {}, hasListener: () => false, hasListeners: () => false });
    const withCb = (p, cb) => (typeof cb === 'function' ? void p.then(cb, () => cb(undefined)) : p);
    const lastFn = (a) => [...a].reverse().find((x) => typeof x === 'function');
    const WINDOW = { id: 1, focused: true, top: 0, left: 0, width: 1280, height: 800, incognito: false, type: 'normal', state: 'normal', alwaysOnTop: false };
    const ch = () => globalThis.chrome || {};
    const pattern = (p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    const query = async (info = {}) => {
      const all = (await ch().tabs.query({})).filter((t) => t.url && /^(https?|file|ftp):/.test(t.url));
      const id = (await activeTabId()) ?? (all.length ? Math.max(...all.map((t) => t.id)) : null);
      let tabs = all.map((t, i) => ({ ...t, active: t.id === id, highlighted: t.id === id, selected: t.id === id, windowId: 1, index: i, status: t.status || 'complete', pinned: false, incognito: false }));
      if (info.active !== undefined) tabs = tabs.filter((t) => t.active === info.active);
      if (info.highlighted !== undefined) tabs = tabs.filter((t) => t.highlighted === info.highlighted);
      if (info.url) { const pats = [].concat(info.url).map(pattern); tabs = tabs.filter((t) => pats.some((r) => r.test(t.url))); }
      return tabs;
    };
    const manifest = () => { try { return ch().runtime.getManifest(); } catch { return {}; } };
    const permissions = {
      contains: (_p, cb) => withCb(Promise.resolve(true), cb),
      getAll: (cb) => { const m = manifest(); return withCb(Promise.resolve({ permissions: [...(m.permissions || []), ...(m.optional_permissions || [])], origins: [...(m.host_permissions || []), ...(m.optional_host_permissions || [])] }), cb); },
      request: (_p, cb) => withCb(Promise.resolve(true), cb), remove: (_p, cb) => withCb(Promise.resolve(false), cb), onAdded: ev(), onRemoved: ev(),
    };
    const one = () => Promise.resolve({ ...WINDOW });
    const windows = {
      WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2,
      get: (...a) => withCb(one(), lastFn(a)), getCurrent: (...a) => withCb(one(), lastFn(a)), getLastFocused: (...a) => withCb(one(), lastFn(a)),
      getAll: (...a) => withCb(Promise.resolve([{ ...WINDOW }]), lastFn(a)), update: (...a) => withCb(one(), lastFn(a)), remove: (...a) => withCb(Promise.resolve(), lastFn(a)),
      create: (d, cb) => { const u = d && d.url && [].concat(d.url)[0]; if (u && ch().tabs?.create) ch().tabs.create({ url: u }); return withCb(one(), cb); },
      onCreated: ev(), onRemoved: ev(), onFocusChanged: ev(), onBoundsChanged: ev(),
    };
    // Chrome APIs Electron doesn't have: accept listeners and calls so extensions keep starting up
    const STUBBED = ['action', 'browserAction', 'pageAction', 'commands', 'contextMenus', 'menus', 'alarms', 'notifications', 'sidePanel', 'webNavigation',
      'idle', 'offscreen', 'declarativeContent', 'downloads', 'history', 'bookmarks', 'sessions', 'topSites', 'tts', 'search', 'privacy', 'proxy', 'fontSettings', 'readingList', 'tabGroups'];
    const stubs = {};
    const stub = (name) => (stubs[name] ||= new Proxy({}, {
      get: (_t, p) => (typeof p !== 'string' ? undefined : p.startsWith('on') ? ev() : /^[A-Z_]+$/.test(p) ? {} : (...a) => withCb(Promise.resolve(p.startsWith('get') ? (p === 'getAll' ? [] : undefined) : undefined), lastFn(a))),
    }));
    const TAB_EVENTS = ['onRemoved', 'onCreated', 'onActivated', 'onUpdated', 'onReplaced', 'onHighlighted', 'onMoved', 'onDetached', 'onAttached', 'onZoomChange'];
    const tabs = new Proxy({}, {
      get: (_t, k) => {
        if (k === 'query') return (info, cb) => withCb(query(info), cb);
        if (k === 'getCurrent') return (cb) => withCb(Promise.resolve(undefined), cb);
        const real = ch().tabs || {};
        if (real[k] === undefined && TAB_EVENTS.includes(k)) return ev();
        const v = real[k];
        return typeof v === 'function' ? v.bind(real) : v;
      },
      has: (_t, k) => k === 'query' || k in (ch().tabs || {}),
    });
    const api = new Proxy({}, {
      get: (_t, k) => {
        const c = ch();
        if (k === 'tabs') return c.tabs ? tabs : undefined;
        if (k === 'windows') return c.windows || windows;
        if (k === 'permissions') return c.permissions || permissions;
        const v = c[k];
        if (v === undefined && STUBBED.includes(k)) return stub(k);
        return typeof v === 'function' ? v.bind(c) : v;
      },
      has: (_t, k) => ['tabs', 'windows', 'permissions', ...STUBBED].includes(k) || k in ch(),
      ownKeys: () => [...new Set([...Reflect.ownKeys(ch()), 'windows', 'permissions'])],
      getOwnPropertyDescriptor: (_t, k) => ({ configurable: true, enumerable: true, value: api[k] }),
    });
    // Electron defines its own `browser` too, but without these APIs; replace it (it forwards to chrome anyway)
    const b = globalThis.browser;
    if (!b || !b.permissions || !b.windows) {
      try { Object.defineProperty(globalThis, 'browser', { configurable: true, writable: true, value: api }); } catch { try { globalThis.browser = api; } catch { /* locked */ } }
    }
  };

// a service worker can't see the Browser's tabs, so the newest web page counts as the active one
contextBridge.executeInMainWorld({ func: install, args: ['sw'] });
