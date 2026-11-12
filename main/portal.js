// LiquidDesktop's own file dialogs and file manager, for every app in the session:
//   • org.freedesktop.impl.portal.FileChooser — the backend of the desktop portal's Open / Save dialogs
//     (used by Flatpak apps, Firefox, Chromium/Electron apps, and GTK/Qt apps told to use the portal).
//     xdg-desktop-portal finds it through /usr/share/xdg-desktop-portal/portals/liquiddesktop.portal and the
//     liquiddesktop-portals.conf the session writes. The dialog is the built-in "filepicker" app.
//   • org.freedesktop.FileManager1 — "Show in folder" and opening folders go to the built-in Files app.
// Session only: in a testing window the host desktop keeps its own dialogs and file manager.
const { ipcMain } = require('electron');
const path = require('path');

let dbus;
try { dbus = require('dbus-next'); } catch { dbus = null; }

const BUS_NAME = 'org.freedesktop.impl.portal.desktop.liquiddesktop';
const pending = new Map();   // request id → resolve(result)
let seq = 0, openApp = null;

const unwrap = (v) => (v && typeof v === 'object' && 'value' in v && 'signature' in v ? v.value : v);
const bytesToPath = (b) => (b ? Buffer.from(b).toString('utf8').replace(/\0+$/, '') : '');
const toPath = (u) => { try { return decodeURIComponent(new URL(u).pathname); } catch { return u; } };

/** Show the picker window and wait for the person to choose (or cancel). */
function pick(kind, title, raw) {
  const o = Object.fromEntries(Object.entries(raw || {}).map(([k, v]) => [k, unwrap(v)]));
  const id = ++seq;
  const filters = (o.filters || []).map(([name, rules]) => ({ name, patterns: rules.filter(([t]) => t === 0).map(([, p]) => p), mimes: rules.filter(([t]) => t === 1).map(([, p]) => p) }));
  const current = o.current_filter ? o.current_filter[0] : null;
  const args = {
    req: id, kind, title: title || (kind === 'save' ? 'Save' : kind === 'savefiles' ? 'Choose a Folder' : 'Open'),
    accept: o.accept_label || null, multiple: !!o.multiple, directory: !!o.directory || kind === 'savefiles',
    filters, currentFilter: current, name: o.current_name || (o.current_file ? path.basename(bytesToPath(o.current_file)) : ''),
    folder: o.current_folder ? bytesToPath(o.current_folder) : o.current_file ? path.dirname(bytesToPath(o.current_file)) : '',
    files: (o.files || []).map(bytesToPath),
  };
  return new Promise((resolve) => {
    pending.set(id, resolve);
    openApp('filepicker', args, { size: [780, 500], minSize: [560, 360], name: args.title });
  });
}
function answer(result) {
  if (!result || !result.paths?.length) return [1, {}];   // cancelled
  const uris = result.paths.map((p) => 'file://' + p.split('/').map(encodeURIComponent).join('/'));
  const out = { uris: new dbus.Variant('as', uris) };
  if (result.filter) out.current_filter = new dbus.Variant('(sa(us))', [result.filter.name, [...result.filter.patterns.map((p) => [0, p]), ...result.filter.mimes.map((m) => [1, m])]]);
  return [0, out];
}

function fileChooser() {
  const { Interface } = dbus.interface;
  class FileChooser extends Interface {
    async OpenFile(handle, appId, parent, title, options) { return answer(await pick('open', title, options)); }
    async SaveFile(handle, appId, parent, title, options) { return answer(await pick('save', title, options)); }
    async SaveFiles(handle, appId, parent, title, options) {
      // a folder is chosen; the files keep the names the app proposed
      const r = await pick('savefiles', title, options);
      if (!r || !r.paths?.length) return [1, {}];
      const o = Object.fromEntries(Object.entries(options || {}).map(([k, v]) => [k, unwrap(v)]));
      const names = (o.files || []).map((b) => path.basename(bytesToPath(b)));
      return answer({ paths: names.map((n) => path.join(r.paths[0], n)) });
    }
  }
  FileChooser.configureMembers({ methods: {
    OpenFile: { inSignature: 'osssa{sv}', outSignature: 'ua{sv}' },
    SaveFile: { inSignature: 'osssa{sv}', outSignature: 'ua{sv}' },
    SaveFiles: { inSignature: 'osssa{sv}', outSignature: 'ua{sv}' },
  } });
  return new FileChooser('org.freedesktop.impl.portal.FileChooser');
}

// "Open With": which app should open a file or link (browsers' downloads, Flatpak apps opening files…).
// Choices come as desktop ids without ".desktop"; the picker can also offer every other installed app.
const pendingApps = new Map();
function appChooser() {
  const { Interface } = dbus.interface;
  class AppChooser extends Interface {
    ChooseApplication(handle, appId, parent, choices, options) {
      const o = Object.fromEntries(Object.entries(options || {}).map(([k, v]) => [k, unwrap(v)]));
      const id = ++seq;
      const args = { req: id, choices: choices || [], last: o.last_choice || '', contentType: o.content_type || '', uri: o.uri || '', filename: o.filename || (o.uri ? decodeURIComponent(o.uri.split('/').pop() || '') : '') };
      return new Promise((resolve) => {
        pendingApps.set(id, (choice) => resolve(choice ? [0, { choice: new dbus.Variant('s', choice) }] : [1, {}]));
        openApp('appchooser', args, { size: [440, 560], minSize: [380, 420], name: 'Open With' });
      });
    }
    UpdateChoices() { /* the list is read when the dialog opens */ }
    get version() { return 2; }
  }
  AppChooser.configureMembers({
    methods: { ChooseApplication: { inSignature: 'ossasa{sv}', outSignature: 'ua{sv}' }, UpdateChoices: { inSignature: 'oas', outSignature: '' } },
    properties: { version: { signature: 'u', access: 'read' } },
  });
  return new AppChooser('org.freedesktop.impl.portal.AppChooser');
}

// Default Apps: other apps open files and links in LiquidDesktop's own apps through this
// (session/liquid-desktop-open --app ID, from the liquiddesktop-*.desktop launchers)
function opener() {
  const { Interface } = dbus.interface;
  const APPS = {
    browser: (u) => ['browser', { url: u }, { size: [1100, 720], name: 'Browser' }],
    preview: (u) => ['preview', { path: toPath(u) }, { size: [820, 600], name: 'Preview' }],
    texteditor: (u) => ['texteditor', { path: toPath(u) }, { size: [760, 560], name: 'Text Editor' }],
    files: (u) => ['files', { path: toPath(u) }, { size: [920, 560], minSize: [520, 320], name: 'Files' }],
  };
  class Open extends Interface {
    OpenWith(appId, uris) {
      const make = APPS[appId];
      if (!make) return false;
      for (const u of (uris || []).slice(0, 8)) openApp(...make(u));
      return true;
    }
  }
  Open.configureMembers({ methods: { OpenWith: { inSignature: 'sas', outSignature: 'b' } } });
  return new Open('org.liquiddesktop.Open');
}

function fileManager() {
  const { Interface } = dbus.interface;
  class FileManager1 extends Interface {
    ShowFolders(uris) { for (const u of (uris || []).slice(0, 4)) openApp('files', { path: toPath(u) }, { size: [920, 560], minSize: [520, 320], name: 'Files' }); }
    ShowItems(uris) { for (const u of (uris || []).slice(0, 4)) { const p = toPath(u); openApp('files', { path: path.dirname(p), select: p }, { size: [920, 560], minSize: [520, 320], name: 'Files' }); } }
    ShowItemProperties(uris) { this.ShowItems(uris); }
  }
  FileManager1.configureMembers({ methods: {
    ShowFolders: { inSignature: 'ass', outSignature: '' },
    ShowItems: { inSignature: 'ass', outSignature: '' },
    ShowItemProperties: { inSignature: 'ass', outSignature: '' },
  } });
  return new FileManager1('org.freedesktop.FileManager1');
}

let BUS = null;
const owned = { chooser: false, fm: false };
async function start() {
  if (!dbus || !process.env.DBUS_SESSION_BUS_ADDRESS) return;
  const bus = dbus.sessionBus();
  BUS = bus;
  bus.on('error', () => {});
  try {
    if ((await bus.requestName(BUS_NAME, 4)) === 1) {
      owned.chooser = true;
      bus.export('/org/freedesktop/portal/desktop', fileChooser());
      bus.export('/org/freedesktop/portal/desktop', appChooser());
      bus.export('/org/liquiddesktop/Open', opener());
      // If the desktop portal started before this name existed (Chromium asks it for settings at startup), it
      // may have settled on another desktop's dialogs: restart it so it picks LiquidDesktop's.
      require('child_process').execFile('systemctl', ['--user', 'try-restart', 'xdg-desktop-portal.service'], () => {});
    }
  } catch (e) { console.warn('[portal] file chooser:', e.message); }
  try {
    // Dolphin, Thunar… also provide this name and D-Bus starts one of them when anything asks for it. Queue for
    // it, so LiquidDesktop takes over as soon as that one lets go (Settings › General can make it let go).
    bus.export('/org/freedesktop/FileManager1', fileManager());
    const r = await bus.requestName('org.freedesktop.FileManager1', 0);
    owned.fm = r === 1;
    bus.on('message', (m) => { if (m.member === 'NameAcquired' && m.body?.[0] === 'org.freedesktop.FileManager1') owned.fm = true; if (m.member === 'NameLost' && m.body?.[0] === 'org.freedesktop.FileManager1') owned.fm = false; });
  } catch (e) { console.warn('[portal] file manager:', e.message); }
}

// LiquidDesktop's own apps ask for Open / Save too (e.g. Widget Creator): the same picker in the session,
// the system dialog in a testing window. opts: { title, accept, multiple, directory, filters:[{name, patterns}], name, folder }
async function dialogFor(kind, opts = {}, win) {
  const filters = (opts.filters || []).map((f) => ({ name: f.name, patterns: f.patterns || [], mimes: [] }));
  if (openApp) {
    const r = await pickLocal(kind, opts.title, { ...opts, filters });
    return r?.paths || null;
  }
  const { dialog, BrowserWindow } = require('electron');
  const parent = win || BrowserWindow.getFocusedWindow();
  const ef = filters.map((f) => ({ name: f.name, extensions: f.patterns.map((p) => p.replace(/^\*\./, '')) }));
  if (kind === 'save') {
    const r = await dialog.showSaveDialog(parent, { title: opts.title, defaultPath: path.join(opts.folder || require('os').homedir(), opts.name || ''), filters: ef });
    return r.canceled || !r.filePath ? null : [r.filePath];
  }
  const r = await dialog.showOpenDialog(parent, { title: opts.title, defaultPath: opts.folder, filters: ef, properties: [opts.directory ? 'openDirectory' : 'openFile', ...(opts.multiple ? ['multiSelections'] : [])] });
  return r.canceled ? null : r.filePaths;
}
function pickLocal(kind, title, o) {
  const id = ++seq;
  const args = { req: id, kind, title: title || (kind === 'save' ? 'Save' : 'Open'), accept: o.accept || null, multiple: !!o.multiple, directory: !!o.directory,
    filters: o.filters, currentFilter: null, name: o.name || '', folder: o.folder || '', files: [] };
  return new Promise((resolve) => { pending.set(id, resolve); openApp('filepicker', args, { size: [780, 500], minSize: [560, 360], name: args.title }); });
}

/* ------------------------------------------------------------------ check & fix (Settings › General) */
const fs = require('fs'), os = require('os');
const HOME = os.homedir(), CONF = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
const PORTAL_FILE = '/usr/share/xdg-desktop-portal/portals/liquiddesktop.portal';
const FILES_DESKTOP = '/usr/share/applications/liquid-desktop-files.desktop';
const PORTAL_CONF = path.join(CONF, 'xdg-desktop-portal', 'liquiddesktop-portals.conf');
const MIMEAPPS = path.join(CONF, 'liquiddesktop-mimeapps.list');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const run = (cmd, args) => new Promise((res) => require('child_process').execFile(cmd, args, { timeout: 8000 }, (err, out, e) => res({ ok: !err, out: String(out || '').trim(), err: String(e || '').trim() })));
const call = (dest, p, iface, member, signature = '', body = []) => BUS.call(new dbus.Message({ destination: dest, path: p, interface: iface, member, signature, body })).then((r) => r.body);
async function ownerOf(name) {
  try {
    const [pid] = await call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetConnectionUnixProcessID', 's', [name]);
    return { pid, name: read(`/proc/${pid}/comm`).trim() || '?', env: read(`/proc/${pid}/environ`).split('\0') };
  } catch { return null; }
}
async function dialogStatus() {
  const session = !!openApp;
  const portal = await ownerOf('org.freedesktop.portal.Desktop');
  const portalDesktop = portal?.env.find((e) => e.startsWith('XDG_CURRENT_DESKTOP='))?.slice(20) || null;
  const fm = await ownerOf('org.freedesktop.FileManager1');
  const conf = read(PORTAL_CONF);
  const mime = await run('xdg-mime', ['query', 'default', 'inode/directory']);
  const checks = [
    { id: 'portalFile', ok: /AppChooser/.test(read(PORTAL_FILE)), text: 'LiquidDesktop’s dialogs are registered with the desktop portal', bad: `${PORTAL_FILE} is missing or out of date` },
    { id: 'config', ok: /FileChooser=liquiddesktop/.test(conf) && /AppChooser=liquiddesktop/.test(conf), text: 'The portal is set to use LiquidDesktop’s Open / Save and Open With dialogs', bad: 'The portal settings don’t point to LiquidDesktop’s dialogs' },
    { id: 'portalEnv', ok: !portal || portalDesktop === 'LiquidDesktop', text: 'The portal knows it’s running in LiquidDesktop', bad: `The portal is still running with the settings of another desktop (${portalDesktop || 'unknown'})` },
    { id: 'backend', ok: owned.chooser, text: 'LiquidDesktop’s dialogs are running', bad: 'LiquidDesktop’s dialogs couldn’t start (another program took their name)' },
    { id: 'fm', ok: owned.fm, text: 'Files is the file manager apps use for “Show in Folder”', bad: `“Show in Folder” goes to ${fm?.name || 'another file manager'}${fm ? ` (process ${fm.pid})` : ''}` },
    { id: 'folders', ok: /liquid-desktop-files/.test(mime.out) && fs.existsSync(FILES_DESKTOP), text: 'Folders open in Files', bad: `Folders open in ${mime.out || 'another app'}` },
  ];
  return { session, checks, fmOwner: fm && !owned.fm ? fm : null };
}
async function fixDialogs({ stopOther = false } = {}) {
  const log = [];
  // system files (needs the administrator password, asked for in Settings)
  if (!/AppChooser/.test(read(PORTAL_FILE)) || !fs.existsSync(FILES_DESKTOP)) {
    const { sudoScript } = require('./appstore');
    const src = path.join(__dirname, '..', 'packaging');
    const opener = ['/usr/bin/liquid-desktop-open', '/usr/local/bin/liquid-desktop-open'].find((f) => fs.existsSync(f)) || path.join(__dirname, '..', 'session', 'liquid-desktop-open');
    const r = await sudoScript([
      'set -e',
      `install -Dm644 '${path.join(src, 'liquiddesktop.portal')}' ${PORTAL_FILE}`,
      `sed 's#^Exec=liquid-desktop-open#Exec=${opener}#' '${path.join(src, 'liquid-desktop-files.desktop')}' > ${FILES_DESKTOP}`,
      `chmod 644 ${FILES_DESKTOP}`,
    ].join('\n'));
    if (!r.ok) throw new Error(r.out.split('\n').slice(-3).join('\n') || 'Couldn’t install the portal files');
    log.push('installed the portal files');
  }
  // the user's portal settings and folder handler (rewritten unless you've made them your own)
  const mine = (f) => !fs.existsSync(f) || /^# written by LiquidDesktop/m.test(read(f));
  if (mine(PORTAL_CONF)) {
    const have = (n) => fs.existsSync(`/usr/share/xdg-desktop-portal/portals/${n}.portal`);
    const others = ['kde', 'gnome', 'gtk'].filter(have).join(';');
    const secret = ['kwallet', 'gnome-keyring'].filter(have).join(';');
    fs.mkdirSync(path.dirname(PORTAL_CONF), { recursive: true });
    fs.writeFileSync(PORTAL_CONF, ['# written by LiquidDesktop at login (delete this line to keep your own edits)', '[preferred]', `default=${others};`,
      secret ? `org.freedesktop.impl.portal.Secret=${secret};` : null, `org.freedesktop.impl.portal.FileChooser=liquiddesktop;${others};`, `org.freedesktop.impl.portal.AppChooser=liquiddesktop;${others};`].filter(Boolean).join('\n') + '\n');
  }
  if (mine(MIMEAPPS)) require('./defaultapps').refresh();   // folders → Files, plus the other Default Apps choices
  // apps opened from LiquidDesktop from now on ask the portal for their dialogs
  process.env.GTK_USE_PORTAL = '1';
  if (!/portals/.test(process.env.GDK_DEBUG || '')) process.env.GDK_DEBUG = [process.env.GDK_DEBUG, 'portals'].filter(Boolean).join(',');
  if (fs.existsSync('/usr/lib/qt6/plugins/platformthemes/libqxdgdesktopportal.so')) process.env.QT_QPA_PLATFORMTHEME = 'xdgdesktopportal';
  // the portal: this session's settings, then a fresh start (apps opened from now on get the new dialogs)
  await run('dbus-update-activation-environment', ['--systemd', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP', 'XDG_SESSION_TYPE', 'DISPLAY', 'XAUTHORITY', 'GTK_USE_PORTAL', 'QT_QPA_PLATFORMTHEME']);
  await run('systemctl', ['--user', 'restart', 'xdg-desktop-portal.service']);
  log.push('restarted the desktop portal');
  // the other file manager holding the name
  if (stopOther && !owned.fm) {
    const o = await ownerOf('org.freedesktop.FileManager1');
    if (o && o.pid !== process.pid) { try { process.kill(o.pid, 'SIGTERM'); log.push(`closed ${o.name}`); } catch { /* not ours */ } }
    for (let i = 0; i < 20 && !owned.fm; i++) await new Promise((r) => setTimeout(r, 150));
  }
  return { log, status: await dialogStatus() };
}
// opens an Open dialog through the desktop portal, exactly like a browser would
async function testDialog() {
  if (!BUS) throw new Error('No session bus');
  const [handle] = await call('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.freedesktop.portal.FileChooser', 'OpenFile', 'ssa{sv}', ['', 'Test: an app’s Open dialog', {}]);
  return String(handle);
}

function register(opts = {}) {
  openApp = opts.openApp || null;
  ipcMain.handle('dialog:open', (e, o) => dialogFor('open', o, require('electron').BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle('dialog:save', (e, o) => dialogFor('save', o, require('electron').BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle('dialogs:status', () => dialogStatus().catch((e) => ({ __error: e.message })));
  ipcMain.handle('dialogs:fix', (_e, o) => fixDialogs(o).catch((e) => ({ __error: e.message })));
  ipcMain.handle('dialogs:test', () => testDialog().catch((e) => ({ __error: e.message })));
  if (!openApp) return;   // testing window: no portal, no file manager service
  // the picker window reports back (paths, or null when cancelled / closed)
  ipcMain.removeHandler('picker:done');
  ipcMain.handle('picker:done', (_e, req, result) => { const r = pending.get(req); pending.delete(req); r?.(result || null); return true; });
  ipcMain.removeHandler('appchooser:done');
  ipcMain.handle('appchooser:done', (_e, req, choice) => { const r = pendingApps.get(req); pendingApps.delete(req); r?.(choice || null); return true; });
  start().catch((e) => console.error('[portal]', e.message));
}

module.exports = { register };
