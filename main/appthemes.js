// App themes for Linux apps in the session: a GTK theme (through xsettingsd, which GTK 3 apps follow live)
// and a Qt theme (the Kvantum style, through QT_STYLE_OVERRIDE and Kvantum's own config). "Automatic" uses
// MacTahoe (vinceliuice) in its Light or Dark variant, following LiquidDesktop's appearance. In a testing
// window nothing is applied, so the desktop it runs on keeps its own themes.
const { ipcMain, app } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const DATA = process.env.XDG_DATA_HOME || path.join(HOME, '.local/share');
const CONF = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
const GTK_DIRS = [path.join(DATA, 'themes'), path.join(HOME, '.themes'), '/usr/local/share/themes', '/usr/share/themes'];
const KV_DIRS = [path.join(CONF, 'Kvantum'), '/usr/local/share/Kvantum', '/usr/share/Kvantum'];
const exists = (f) => { try { fs.accessSync(f); return true; } catch { return false; } };
const SAVED = () => path.join(app.getPath('userData'), 'app-themes.json');
const XSD = () => path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'liquid-desktop-xsettingsd.conf');

let mode = 'windowed', dark = false, installing = null;

const DEFAULTS = { gtk: 'auto', qt: 'auto', libadwaita: true };
const readCfg = () => { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SAVED(), 'utf8')) }; } catch { return { ...DEFAULTS }; } };
const saveCfg = (c) => { fs.mkdirSync(path.dirname(SAVED()), { recursive: true }); fs.writeFileSync(SAVED(), JSON.stringify(c, null, 2)); };

function gtkThemes() {
  const seen = new Set();
  for (const d of GTK_DIRS) { let l = []; try { l = fs.readdirSync(d); } catch { continue; } for (const n of l) if (exists(path.join(d, n, 'gtk-3.0'))) seen.add(n); }
  return [...seen].sort((a, b) => a.localeCompare(b));
}
function kvantumThemes() {
  const seen = new Set();
  for (const d of KV_DIRS) {
    let l = []; try { l = fs.readdirSync(d); } catch { continue; }
    for (const folder of l) { let f = []; try { f = fs.readdirSync(path.join(d, folder)); } catch { continue; } for (const x of f) if (x.endsWith('.kvconfig')) seen.add(x.replace(/\.kvconfig$/, '')); }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}
const kvantumAvailable = () => ['/usr/lib/qt6/plugins/styles/libkvantum.so', '/usr/lib/qt/plugins/styles/libkvantum.so', '/usr/lib/x86_64-linux-gnu/qt6/plugins/styles/libkvantum.so', '/usr/lib64/qt6/plugins/styles/libkvantum.so'].some(exists);
const macTahoeInstalled = () => gtkThemes().includes('MacTahoe-Dark') && kvantumThemes().includes('MacTahoeDark');

function resolve(cfg = readCfg()) {
  const gtk = cfg.gtk === 'auto' ? (dark ? 'MacTahoe-Dark' : 'MacTahoe-Light-solid') : cfg.gtk;
  const qt = cfg.qt === 'auto' ? (dark ? 'MacTahoeDark' : 'MacTahoe') : cfg.qt;
  return { gtk: gtk && gtk !== 'none' && gtkThemes().includes(gtk) ? gtk : null, qt: qt && qt !== 'none' && kvantumThemes().includes(qt) ? qt : null };
}

/** Rewrites the xsettingsd config (cursor + GTK theme) and tells xsettingsd to reload it. */
function writeXsettings() {
  if (mode !== 'session') return;
  let cursor = process.env.XCURSOR_THEME || 'MacOS-Tahoe-Cursor', size = process.env.XCURSOR_SIZE || '48';
  try { [cursor, size] = fs.readFileSync(path.join(app.getPath('userData'), 'cursor-theme'), 'utf8').trim().split(/\s+/); } catch { /* defaults */ }
  const { gtk } = resolve();
  const lines = [`Gtk/CursorThemeName "${cursor}"`, `Gtk/CursorThemeSize ${Number(size) || 48}`];
  if (gtk) lines.push(`Net/ThemeName "${gtk}"`, `Gtk/ApplicationPreferDarkTheme ${dark ? 1 : 0}`);
  try { fs.writeFileSync(XSD(), lines.join('\n') + '\n'); execFile('pkill', ['-HUP', '-x', 'xsettingsd'], () => {}); } catch { /* no xsettingsd */ }
}

/* ------------------------------------------------------------------ GTK 4 / libadwaita */
// libadwaita apps can only be themed through ~/.config/gtk-4.0/gtk.css, which every session on this account
// reads (KDE keeps its own gtk.css there too). So: whatever was there is backed up the first time, MacTahoe's
// libadwaita files are put in, gtk.css points at the Light or Dark one, and switching it off restores the
// backup. libadwaita apps pick changes up when they are opened again.
const GTK4 = path.join(CONF, 'gtk-4.0');
const LIBADW = path.join(DATA, 'themes', 'MacTahoe-libadwaita');
const OURS4 = ['gtk.css', 'gtk-dark.css', 'gtk-Light.css', 'gtk-Dark.css', 'assets', 'windows-assets'];
const MARK4 = path.join(GTK4, '.liquid-mactahoe');
const BACKUP4 = path.join(GTK4, '.liquid-backup');
function libadwaitaOn(variant) {
  if (!exists(path.join(LIBADW, 'gtk-Light.css'))) return false;
  fs.mkdirSync(GTK4, { recursive: true });
  const stamp = String(fs.statSync(path.join(LIBADW, 'gtk-Light.css')).mtimeMs);
  if (!exists(MARK4)) {
    // first time: keep what's there (e.g. KDE's gtk.css) to put back later
    fs.mkdirSync(BACKUP4, { recursive: true });
    for (const f of OURS4) { const p = path.join(GTK4, f); if (exists(p)) fs.renameSync(p, path.join(BACKUP4, f)); }
  }
  if (!exists(MARK4) || fs.readFileSync(MARK4, 'utf8') !== stamp) {
    for (const f of ['gtk-Light.css', 'gtk-Dark.css', 'assets', 'windows-assets']) {
      fs.rmSync(path.join(GTK4, f), { recursive: true, force: true });
      fs.cpSync(path.join(LIBADW, f), path.join(GTK4, f), { recursive: true });
    }
    fs.writeFileSync(MARK4, stamp);
  }
  for (const [link, target] of [['gtk.css', `gtk-${variant}.css`], ['gtk-dark.css', 'gtk-Dark.css']]) {
    const p = path.join(GTK4, link);
    try { if (fs.readlinkSync(p) === target) continue; } catch { /* not a link yet */ }
    fs.rmSync(p, { force: true });
    fs.symlinkSync(target, p);
  }
  return true;
}
function libadwaitaOff() {
  if (!exists(MARK4)) return;
  for (const f of OURS4) fs.rmSync(path.join(GTK4, f), { recursive: true, force: true });
  if (exists(BACKUP4)) { for (const f of fs.readdirSync(BACKUP4)) fs.renameSync(path.join(BACKUP4, f), path.join(GTK4, f)); fs.rmSync(BACKUP4, { recursive: true, force: true }); }
  fs.rmSync(MARK4, { force: true });
}

function writeKvantum(theme) {
  const f = path.join(CONF, 'Kvantum', 'kvantum.kvconfig');
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { /* new */ }
  if (/^\s*theme\s*=/m.test(text)) text = text.replace(/^\s*theme\s*=.*$/m, `theme=${theme}`);
  else if (/^\[General\]/m.test(text)) text = text.replace(/^\[General\]\s*$/m, `[General]\ntheme=${theme}`);
  else text = `[General]\ntheme=${theme}\n` + text;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

function apply() {
  if (mode !== 'session') return status();
  const cfg = readCfg(), { qt, gtk } = resolve(cfg);
  writeXsettings();
  // GTK 4 / libadwaita follows the GTK choice when that's MacTahoe
  try {
    if (cfg.libadwaita && gtk && /^MacTahoe/.test(gtk)) libadwaitaOn(/Dark/.test(gtk) ? 'Dark' : 'Light');
    else libadwaitaOff();
  } catch (e) { console.warn('[appthemes] gtk-4.0', e.message); }
  // Qt apps started from now on use Kvantum with the chosen theme (apps already open keep their look)
  if (qt && kvantumAvailable()) { writeKvantum(qt); process.env.QT_STYLE_OVERRIDE = 'kvantum'; }
  else if (process.env.QT_STYLE_OVERRIDE === 'kvantum') delete process.env.QT_STYLE_OVERRIDE;
  return status();
}

function install() {
  if (installing) return installing;
  installing = new Promise((resolveP) => {
    const c = spawn('sh', [path.join(__dirname, '..', 'tools', 'install-app-themes.sh'), '--force'], { env: process.env });
    let out = '';
    c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
    c.on('exit', (code) => { installing = null; apply(); resolveP({ ok: code === 0, out: out.trim().split('\n').slice(-3).join('\n') }); });
    c.on('error', (e) => { installing = null; resolveP({ ok: false, out: e.message }); });
  });
  return installing;
}

function status() {
  const cfg = readCfg();
  return { mode, cfg, active: resolve(cfg), libadwaita: exists(MARK4), libadwaitaReady: exists(path.join(LIBADW, 'gtk-Light.css')), dark, gtk: gtkThemes(), qt: kvantumThemes(), kvantum: kvantumAvailable(), macTahoe: macTahoeInstalled(), installing: !!installing };
}

function register(opts = {}) {
  mode = opts.mode || mode;
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (err) { return { __error: String(err.message || err) }; } });
  h('apptheme:status', status);
  h('apptheme:set', (patch) => { saveCfg({ ...readCfg(), ...patch }); return apply(); });
  h('apptheme:install', install);
  // the web UI says whether it's in dark mode; "Automatic" follows it
  ipcMain.on('apptheme:dark', (_e, d) => { if (!!d === dark) return; dark = !!d; apply(); });
  if (mode === 'session') {
    apply();
    // first login with the defaults: fetch MacTahoe in the background, then use it
    const c = readCfg();
    if ((c.gtk === 'auto' || c.qt === 'auto') && !macTahoeInstalled()) install();
  }
}

module.exports = { register, writeXsettings };
