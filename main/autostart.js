// Login Items (Settings › General › Login Items): apps that open when you log in, the freedesktop way — the
// .desktop files in ~/.config/autostart and /etc/xdg/autostart (the ones Discord, Steam, Syncthing, KeePassXC…
// add when you tick "Start on login"). A file of yours with the same name wins over the system's; Hidden=true or
// X-GNOME-Autostart-enabled=false turns one off. OnlyShowIn / NotShowIn are read for "LiquidDesktop".
// Some are LiquidDesktop's job already and never started from here: the compositor, KDE Connect's daemon (started
// with logging, main/kdeconnect.js), polkit agents (main/polkit.js), notification daemons; nm-applet only when you
// turn it on (it would add a second Wi-Fi icon to the menu bar).
const { ipcMain, app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DESKTOP = 'LiquidDesktop';
const USER_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
const SYS_DIRS = (process.env.XDG_CONFIG_DIRS || '/etc/xdg').split(':').filter(Boolean).map((d) => path.join(d, 'autostart'));
// [pattern on the Exec / file name, why]
const BUILT_IN = [
  [/\b(picom|compton|xcompmgr)\b/, 'LiquidDesktop runs its own compositor'],
  [/kdeconnectd|kdeconnect\.daemon/, 'LiquidDesktop starts KDE Connect itself'],
  [/polkit.*(agent|authentication)|lxpolkit|mate-polkit/, 'LiquidDesktop has its own password prompt'],
  [/\b(dunst|mako|xfce4-notifyd|notification-daemon)\b/, 'LiquidDesktop shows notifications itself'],
];
const OPT_IN = [[/\bnm-applet\b/, 'LiquidDesktop has Wi-Fi in the menu bar; turn this on for its extra icon']];

const parse = (f) => require('./system').parseDesktopFile(f);
const list_ = (dir) => { try { return fs.readdirSync(dir).filter((n) => n.endsWith('.desktop')); } catch { return []; } };
const off = (e) => /^true$/i.test(e.Hidden || '') || /^false$/i.test(e['X-GNOME-Autostart-enabled'] || '');
const split = (v) => (v || '').split(';').map((s) => s.trim()).filter(Boolean);
const tryExec = (e) => {
  if (!e.TryExec) return true;
  if (e.TryExec.startsWith('/')) return fs.existsSync(e.TryExec);
  return (process.env.PATH || '').split(':').some((d) => fs.existsSync(path.join(d, e.TryExec)));
};

/** Every login item: id (file name), what it is, on or off, and whether it's yours or the system's. */
function list() {
  const items = new Map();
  for (const dir of [...SYS_DIRS].reverse()) for (const n of list_(dir)) { try { items.set(n, { id: n, file: path.join(dir, n), entry: parse(path.join(dir, n)), system: true, user: false }); } catch { /* unreadable */ } }
  for (const n of list_(USER_DIR)) {
    try {
      const e = parse(path.join(USER_DIR, n));
      const sys = items.get(n);
      items.set(n, { id: n, file: path.join(USER_DIR, n), entry: sys && !e.Exec ? { ...sys.entry, ...e } : e, system: !!sys, user: true });
    } catch { /* unreadable */ }
  }
  const out = [];
  for (const it of items.values()) {
    const e = it.entry;
    if (!e.Exec && !e.Name) continue;
    const only = split(e.OnlyShowIn), not = split(e.NotShowIn);
    if (only.length && !only.includes(DESKTOP)) continue;   // another desktop's own pieces (Plasma's shell, GNOME's…)
    if (not.includes(DESKTOP)) continue;
    if (e.Type && e.Type !== 'Application') continue;
    const what = `${it.id} ${e.Exec || ''}`;
    const builtIn = BUILT_IN.find(([re]) => re.test(what));
    const optIn = OPT_IN.find(([re]) => re.test(what));
    const userChoice = it.user && ('Hidden' in e || 'X-GNOME-Autostart-enabled' in e);
    const enabled = !builtIn && !off(e) && (!optIn || (userChoice && !off(e)));
    out.push({ id: it.id, name: e.Name || it.id.replace(/\.desktop$/, ''), comment: e.Comment || '', exec: e.Exec || '', icon: require('./system').resolveIcon(e.Icon) || null,
      enabled, system: it.system, user: it.user, installed: tryExec(e), managed: builtIn?.[1] || null, note: optIn && !enabled ? optIn[1] : null,
      conditional: !!(e['X-GNOME-AutostartCondition'] || e['X-KDE-autostart-condition']), delay: +e['X-GNOME-Autostart-Delay'] || 0, terminal: /^true$/i.test(e.Terminal || '') });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** At login: start what's on (after LiquidDesktop is up, so tray icons find the menu bar). */
function runAll() {
  const started = [];
  for (const it of list()) {
    if (!it.enabled || !it.installed || it.conditional || !it.exec) continue;
    const go = () => { try { require('./system').launchExec(it.exec, it.terminal); } catch (e) { console.log('[autostart]', it.id, e.message); } };
    if (it.delay) setTimeout(go, it.delay * 1000); else go();
    started.push(it.id);
  }
  console.log(`[autostart] started ${started.length}: ${started.join(', ')}`);
  return started;
}

/** Turn one on or off: always through a file of yours (a system item gets a copy with Hidden set). */
function setEnabled(id, on) {
  if (!/^[\w.@+-]+\.desktop$/.test(id)) throw new Error('Not a login item.');
  fs.mkdirSync(USER_DIR, { recursive: true });
  const mine = path.join(USER_DIR, id);
  let text;
  if (fs.existsSync(mine)) text = fs.readFileSync(mine, 'utf8');
  else {
    const src = SYS_DIRS.map((d) => path.join(d, id)).find((f) => fs.existsSync(f));
    if (!src) throw new Error('That login item is gone.');
    text = fs.readFileSync(src, 'utf8');
  }
  // drop any old switch, then set ours right under [Desktop Entry]
  text = text.replace(/^(Hidden|X-GNOME-Autostart-enabled)\s*=.*\n?/gim, '');
  text = text.replace(/^\[Desktop Entry\]\s*$/m, `[Desktop Entry]\nHidden=${on ? 'false' : 'true'}\nX-GNOME-Autostart-enabled=${on ? 'true' : 'false'}`);
  fs.writeFileSync(mine, text);
  return list();
}
/** Add an app: its launcher (.desktop) copied into ~/.config/autostart. */
function add(desktopFile) {
  if (!/\.desktop$/.test(desktopFile || '') || !fs.existsSync(desktopFile)) throw new Error('Choose an app to open at login.');
  fs.mkdirSync(USER_DIR, { recursive: true });
  let text = fs.readFileSync(desktopFile, 'utf8').replace(/^(Hidden|X-GNOME-Autostart-enabled|OnlyShowIn|NotShowIn)\s*=.*\n?/gim, '');
  // only the main entry: an app's extra actions ([Desktop Action …]) mean nothing here
  text = text.split(/^\[Desktop Action /m)[0];
  fs.writeFileSync(path.join(USER_DIR, path.basename(desktopFile)), text);
  return list();
}
/** Remove one of yours (a system one can only be turned off). */
function remove(id) {
  if (!/^[\w.@+-]+\.desktop$/.test(id)) throw new Error('Not a login item.');
  const mine = path.join(USER_DIR, id);
  const isSystem = SYS_DIRS.some((d) => fs.existsSync(path.join(d, id)));
  if (isSystem) return setEnabled(id, false);
  fs.rmSync(mine, { force: true });
  return list();
}
const isOn = (desktopFile) => list().some((it) => it.id === path.basename(desktopFile || '') && it.enabled);

function register({ session = false } = {}) {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (err) { return { __error: String(err.message || err) }; } });
  h('autostart:list', list);
  h('autostart:set', setEnabled);
  h('autostart:add', add);
  h('autostart:remove', remove);
  h('autostart:isOn', isOn);
  // in the session, at login (a few seconds in: the menu bar, tray and notifications are up by then)
  if (session && process.env.LIQUID_NO_AUTOSTART !== '1') app.whenReady().then(() => setTimeout(runAll, 5000));
}

module.exports = { register, list, runAll };
