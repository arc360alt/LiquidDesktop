// Login screen settings: which display manager runs, which SDDM theme is really in effect (and which file
// decides it), whether the LiquidDesktop theme can load, recent greeter errors, and fixing all of that.
// SDDM reads /usr/lib/sddm/sddm.conf.d/*, then /etc/sddm.conf.d/* (alphabetically), then /etc/sddm.conf;
// the last value wins. KDE's newer Plasma Login Manager has no themes, so it is detected and can be swapped.
const { ipcMain, nativeImage } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { sudoStatus, checkSudo, sudoScript } = require('./appstore');

const OURS = 'liquid-desktop';
const OUR_CONF = '/etc/sddm.conf.d/zz-liquid-desktop.conf';
const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { timeout: 8000, env: { ...process.env, LC_ALL: 'C' } }, (err, out, e) => res({ ok: !err, out: String(out || ''), err: String(e || '') })));
const exists = (f) => { try { fs.accessSync(f); return true; } catch { return false; } };
const has = (bin) => (process.env.PATH || '/usr/bin').split(':').some((d) => exists(path.join(d, bin)));
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const DM_NAMES = { sddm: 'SDDM', plasmalogin: 'Plasma Login Manager', gdm: 'GDM', lightdm: 'LightDM', lxdm: 'LXDM', ly: 'Ly', greetd: 'greetd' };
function displayManager() {
  let unit = '';
  try { unit = path.basename(fs.realpathSync('/etc/systemd/system/display-manager.service')).replace(/\.service$/, ''); } catch { /* none enabled */ }
  return { id: unit || null, name: DM_NAMES[unit] || unit || 'None' };
}

function configFiles() {
  const list = (d) => { try { return fs.readdirSync(d).filter((f) => f.endsWith('.conf')).sort().map((f) => path.join(d, f)); } catch { return []; } };
  return [...list('/usr/lib/sddm/sddm.conf.d'), ...list('/etc/sddm.conf.d'), ...(exists('/etc/sddm.conf') ? ['/etc/sddm.conf'] : [])];
}
// [Theme] Current / ThemeDir from every file, in reading order
function themeSettings() {
  let current = null, source = null, themeDir = '/usr/share/sddm/themes';
  const setters = [];
  for (const f of configFiles()) {
    let sec = '';
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const raw of text.split('\n')) {
      const l = raw.trim();
      if (!l || l.startsWith('#') || l.startsWith(';')) continue;
      const m = /^\[(.+)\]$/.exec(l);
      if (m) { sec = m[1]; continue; }
      if (sec !== 'Theme') continue;
      const kv = /^(\w+)\s*=\s*(.*)$/.exec(l);
      if (!kv) continue;
      if (kv[1] === 'Current') { current = kv[2]; source = f; setters.push({ file: f, value: kv[2] }); }
      if (kv[1] === 'ThemeDir' && kv[2]) themeDir = kv[2];
    }
  }
  return { current, source, themeDir, setters };
}

function themes(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.map((id) => {
    const meta = path.join(dir, id, 'metadata.desktop');
    if (!exists(meta)) return null;
    const t = fs.readFileSync(meta, 'utf8');
    const get = (k) => (t.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim() || '';
    let preview = null;
    const shot = get('Screenshot');
    if (shot) {
      try { const img = nativeImage.createFromPath(path.join(dir, id, shot)); if (!img.isEmpty()) preview = img.resize({ width: 320 }).toDataURL(); } catch { /* no preview */ }
    }
    return { id, name: get('Name') || id, description: get('Description'), qt: get('QtVersion') || '5', preview };
  }).filter(Boolean).sort((a, b) => (b.id === OURS) - (a.id === OURS) || a.name.localeCompare(b.name));
}

async function recentErrors() {
  const r = await run('journalctl', ['-b', '-u', 'sddm', '-n', '300', '--no-pager', '-o', 'cat']);
  if (!r.ok) return null;   // no permission to read the system log
  return r.out.split('\n').filter((l) => /qml|error|fail|could not|cannot|theme/i.test(l) && !/pam_unix|session (opened|closed)/i.test(l)).slice(-8);
}

// Qt pieces the LiquidDesktop theme uses
function themeNeeds() {
  const missing = [];
  if (!has('sddm-greeter-qt6')) missing.push({ what: 'the Qt 6 version of SDDM’s greeter', pkg: 'sddm' });
  if (!exists('/usr/lib/qt6/qml/QtQuick/Effects/qmldir')) missing.push({ what: 'Qt Quick effects', pkg: 'qt6-declarative' });
  if (!exists('/usr/lib/qt6/plugins/imageformats/libqsvg.so')) missing.push({ what: 'SVG icons for Qt 6', pkg: 'qt6-svg' });
  return missing;
}

async function status() {
  const dm = displayManager();
  const sddmInstalled = has('sddm');
  const ts = themeSettings();
  const list = themes(ts.themeDir);
  // not installed yet: offer the copy that ships with LiquidDesktop
  if (!list.some((t) => t.id === OURS)) {
    const local = themes(path.join(__dirname, '..', 'packaging', 'sddm')).find((t) => t.id === OURS);
    if (local) list.unshift({ ...local, notInstalled: true });
  }
  const ourInstalled = exists(path.join(ts.themeDir, OURS, 'Main.qml'));
  const problems = [];
  if (dm.id !== 'sddm') {
    problems.push({ id: 'dm', level: 'error', text: dm.id
      ? `Your login screen is drawn by ${dm.name}, which doesn’t use SDDM themes${dm.id === 'plasmalogin' ? ' (it always shows Plasma’s own login screen)' : ''}. Switching the login manager to SDDM fixes this; it takes effect when you restart.`
      : 'No login manager is enabled, so there’s no graphical login screen. Turning on SDDM fixes this; it takes effect when you restart.', fix: 'switch' });
  }
  if (!ourInstalled) problems.push({ id: 'missing', level: 'error', text: 'The LiquidDesktop login theme isn’t installed.', fix: 'install' });
  const effective = ts.current || '(SDDM’s built-in theme)';
  if (sddmInstalled && ts.current !== OURS) {
    problems.push({ id: 'current', level: 'warn', text: ts.source ? `${ts.source} selects “${effective}” and is read last, so it wins.` : 'No login theme is selected, so SDDM uses its plain built-in one.', fix: 'apply' });
  }
  const needs = themeNeeds();
  if (sddmInstalled && needs.length) problems.push({ id: 'deps', level: 'error', text: `Missing ${needs.map((n) => n.what).join(', ')}: the theme can’t load without it, and SDDM falls back to its plain one.`, fix: 'deps', pkgs: [...new Set(needs.map((n) => n.pkg))] });
  return { dm, sddmInstalled, current: ts.current, source: ts.source, setters: ts.setters, themeDir: ts.themeDir, themes: list, ours: OURS, ourInstalled,
    problems, errors: dm.id === 'sddm' ? await recentErrors() : [], usingOurs: dm.id === 'sddm' && ts.current === OURS && ourInstalled && !needs.length, pacman: has('pacman') };
}

// Build one root script for everything that needs fixing, so there is a single password prompt.
async function apply({ theme = OURS, switchDm = false, install = false, deps = [] } = {}) {
  const st = await status();
  const lines = ['set -e'];
  const pm = has('pacman') ? (p) => `pacman -S --needed --noconfirm ${p.join(' ')}` : has('apt-get') ? (p) => `apt-get install -y ${p.join(' ')}` : has('dnf') ? (p) => `dnf install -y ${p.join(' ')}` : null;
  const pkgs = [...new Set([...(switchDm && !st.sddmInstalled ? ['sddm'] : []), ...deps, ...(switchDm && has('pacman') ? ['qt6-svg', 'qt6-declarative'] : [])])];
  if (pkgs.length) { if (!pm) throw new Error(`Install ${pkgs.join(', ')} with your package manager first.`); lines.push(pm(pkgs)); }
  if (install || !st.ourInstalled) {
    const src = [path.join(__dirname, '..', 'packaging', 'sddm', OURS), path.join(__dirname, '..', 'sddm-theme', OURS)].find((d) => exists(path.join(d, 'Main.qml')));
    if (!src) throw new Error('The theme files aren’t part of this install. Update LiquidDesktop and try again.');
    lines.push(`mkdir -p ${q(st.themeDir)}`, `rm -rf ${q(path.join(st.themeDir, OURS))}`, `cp -r ${q(src)} ${q(path.join(st.themeDir, OURS))}`, `chmod -R a+rX ${q(path.join(st.themeDir, OURS))}`);
  }
  // our drop-in, plus every other file that names a theme (so KDE's settings page shows the same one)
  lines.push('mkdir -p /etc/sddm.conf.d', `printf '%s\\n' '# Written by LiquidDesktop (Settings › Lock Screen › Login Screen).' '[Theme]' ${q('Current=' + theme)} > ${OUR_CONF}`);
  for (const s of st.setters) {
    if (s.file === OUR_CONF || s.file.startsWith('/usr/')) continue;
    lines.push(`sed -i ${q(`/^\\[Theme\\]/,/^\\[/ s/^\\(\\s*Current\\s*=\\).*/\\1${theme.replace(/[/&]/g, '\\$&')}/`)} ${q(s.file)}`);
  }
  if (switchDm) {
    if (st.dm.id && st.dm.id !== 'sddm') lines.push(`systemctl disable ${q(st.dm.id + '.service')} || true`);
    lines.push('systemctl enable --force sddm.service');
  }
  const r = await sudoScript(lines.join('\n'));
  if (!r.ok) throw new Error(r.out.split('\n').slice(-4).join('\n') || 'It didn’t work.');
  return status();
}

function register() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (err) { return { __error: String(err.message || err) }; } });
  h('sddm:status', status);
  h('sddm:apply', apply);
  h('sddm:sudoStatus', sudoStatus);
  h('sddm:sudoCheck', checkSudo);
}

module.exports = { register, status };
