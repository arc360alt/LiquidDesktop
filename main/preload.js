const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => async (...args) => {
  const r = await ipcRenderer.invoke(name, ...args);
  if (r && typeof r === 'object' && '__error' in r) throw new Error(r.__error);
  return r;
};
const names = ['sys:info', 'sys:status', 'sys:media', 'sys:mediaCmd', 'sys:setVolume', 'sys:setMute', 'sys:setBrightness', 'sys:wifiPower',
  'sys:wifiList', 'sys:wifiConnect', 'sys:airplane', 'sys:bluetoothPower', 'sys:stats', 'sys:kill', 'sys:checkPassword', 'sys:power', 'sys:screenshot', 'sys:shells', 'sys:monoFonts', 'sys:updateCheck', 'sys:inputDevices', 'sys:inputApply', 'sys:cursorThemes', 'sys:cursorCss', 'sys:cursorApply', 'sys:displays', 'sys:setDisplay', 'dialogs:status', 'dialogs:fix', 'dialogs:test', 'picker:done', 'appchooser:done', 'net:fetch', 'fs:readDataUrl', 'fs:thumb', 'dialog:open', 'dialog:save', 'apptheme:status', 'apptheme:set', 'apptheme:install', 'sddm:status', 'sddm:apply', 'sddm:sudoStatus', 'sddm:sudoCheck', 'tray:list', 'tray:activate', 'tray:contextMenu', 'tray:menu', 'tray:event', 'sys:capture', 'sys:saveScreenshot', 'sys:account', 'sys:setRealName', 'sys:setAvatar', 'sys:changePassword',
  'fs:home', 'fs:list', 'fs:stat', 'fs:read', 'fs:write', 'fs:mkdir', 'fs:newFile', 'fs:rename', 'fs:move', 'fs:copy', 'fs:trash', 'fs:remove', 'fs:emptyTrash',
  'fs:open', 'fs:reveal', 'fs:search', 'fs:exists', 'fs:places', 'apps:list', 'apps:info', 'apps:iconFor', 'apps:byId', 'apps:launch', 'apps:run', 'clip:write', 'clip:read', 'pty:create',
  'shell:toggleFullscreen', 'shell:devtools', 'shell:quit',
  'bt:state', 'bt:scan', 'bt:pair', 'bt:connect', 'bt:forget', 'bt:power', 'audio:devices', 'audio:setDefault', 'audio:setVolume', 'audio:setMute', 'defaults:list', 'defaults:apply', 'defaults:get', 'apps:openWith', 'wall:list', 'wall:add', 'wall:remove',
  'android:status', 'android:install', 'android:uninstall', 'android:setOn', 'android:open', 'android:stop', 'android:forceQuit', 'android:playId', 'android:setMultiWindow', 'android:resizeApp', 'android:setArm', 'android:zoomApp', 'android:captions', 'android:hideCaptions', 'android:back', 'drives:list', 'drives:mount', 'drives:eject'];
const api = {};
for (const n of names) {
  const [ns, fn] = n.split(':');
  (api[ns] ||= {})[fn] = call(n);
}
api.pty.write = (id, d) => ipcRenderer.send('pty:write', id, d);
api.pty.resize = (id, c, r) => ipcRenderer.send('pty:resize', id, c, r);
api.pty.kill = (id) => ipcRenderer.send('pty:kill', id);
api.pty.onData = (fn) => ipcRenderer.on('pty:data', (_e, id, d) => fn(id, d));
api.pty.onExit = (fn) => ipcRenderer.on('pty:exit', (_e, id) => fn(id));
api.apptheme.dark = (d) => ipcRenderer.send('apptheme:dark', !!d);
api.notif = {
  onShow: (fn) => ipcRenderer.on('notif:show', (_e, n) => fn(n)),
  onClose: (fn) => ipcRenderer.on('notif:close', (_e, id) => fn(id)),
  action: (id, key) => ipcRenderer.send('notif:action', id, key),
  closed: (id, reason) => ipcRenderer.send('notif:closed', id, reason),
};
api.tray.onItems = (fn) => ipcRenderer.on('tray:items', (_e, list) => fn(list));
api.sys.onUpdated = (fn) => ipcRenderer.on('sys:updated', () => fn());
api.apps.onChanged = (fn) => ipcRenderer.on('apps:changed', () => fn());
api.bt.onChanged = (fn) => ipcRenderer.on('bt:changed', () => fn());
api.bt.onCode = (fn) => ipcRenderer.on('bt:code', (_e, c) => fn(c));
api.android.onProgress = (fn) => ipcRenderer.on('android:progress', (_e, m) => fn(m));
api.android.onChanged = (fn) => ipcRenderer.on('android:changed', () => fn());
api.android.onError = (fn) => ipcRenderer.on('android:error', (_e, m) => fn(m));
api.android.onCaptions = (fn) => ipcRenderer.on('android:captions', () => fn());
api.shell.onOpenUrl = (fn) => ipcRenderer.on('shell:openUrl', (_e, url) => fn(url));
// session mode: talk to the window manager (main/session.js)
const OK = /^(wm|shell|appwin|frame):/;
api.session = {
  send: (ch, ...a) => { if (OK.test(ch)) ipcRenderer.send(ch, ...a); },
  invoke: (ch, ...a) => (OK.test(ch) ? ipcRenderer.invoke(ch, ...a) : Promise.reject(new Error('blocked channel'))),
  on: (ch, fn) => { if (/^(session|appwin|frame):/.test(ch)) ipcRenderer.on(ch, (_e, ...a) => fn(...a)); },
};
// the App Store's back end (main/appstore.js)
api.store = {
  invoke: async (ch, ...a) => { if (!/^store:/.test(ch)) throw new Error('blocked'); const r = await ipcRenderer.invoke(ch, ...a); if (r && typeof r === 'object' && '__error' in r) throw new Error(r.__error); return r; },
  onProgress: (fn) => ipcRenderer.on('store:progress', (_e, m) => fn(m)),
};
// the Browser app's back end (main/browser.js)
api.browser = {
  invoke: async (ch, ...a) => { if (!/^browser:/.test(ch)) throw new Error('blocked'); const r = await ipcRenderer.invoke(ch, ...a); if (r && typeof r === 'object' && '__error' in r) throw new Error(r.__error); return r; },
  on: (ch, fn) => { if (/^browser:/.test(ch)) ipcRenderer.on(ch, (_e, ...a) => fn(...a)); },
};
api.native = true;
contextBridge.exposeInMainWorld('sys', api);
