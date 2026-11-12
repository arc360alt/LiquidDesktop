// Default apps (Settings › Default Apps): which app opens web links, folders, pictures, videos, music,
// text and PDFs. LiquidDesktop's own apps are the defaults; any installed app that handles that kind of
// file can be picked instead.
//
// Choices apply inside LiquidDesktop (the renderer asks `apps:openWith`) and, in the session, to every other
// app too: they're written to liquiddesktop-mimeapps.list, which xdg-open & co. read when the desktop is
// LiquidDesktop. Built-in apps get small hidden launchers (liquiddesktop-*.desktop) for that, which hand the
// file to the running session through D-Bus (session/liquid-desktop-open --app …).
const { ipcMain, app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CATEGORIES = {
  web: { label: 'Web browser', builtin: 'browser', mimes: ['x-scheme-handler/http', 'x-scheme-handler/https', 'text/html', 'application/xhtml+xml'] },
  files: { label: 'File manager', builtin: 'files', mimes: ['inode/directory', 'x-directory/normal'] },
  images: { label: 'Pictures', builtin: 'preview', mimes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/avif', 'image/x-icon'] },
  video: { label: 'Videos', builtin: 'preview', mimes: ['video/mp4', 'video/webm', 'video/x-matroska', 'video/quicktime', 'video/ogg', 'video/x-m4v', 'video/3gpp'] },
  audio: { label: 'Music & audio', builtin: 'preview', mimes: ['audio/mpeg', 'audio/ogg', 'audio/flac', 'audio/x-flac', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/aac', 'audio/opus', 'audio/webm'] },
  text: { label: 'Text files', builtin: 'texteditor', mimes: ['text/plain', 'text/markdown', 'application/json', 'text/x-log', 'text/csv'] },
  pdf: { label: 'PDF documents', builtin: 'browser', mimes: ['application/pdf'] },
};
const BUILTIN_NAMES = { browser: 'Browser', files: 'Files', preview: 'Preview', texteditor: 'Text Editor' };
const MARK = '# written by LiquidDesktop (Settings › Default Apps) — delete this line to keep your own edits';
const CONF = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const DATA = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share');
const MIMEAPPS = path.join(CONF, 'liquiddesktop-mimeapps.list');
const OPENER = path.join(__dirname, '..', 'session', 'liquid-desktop-open');
const choicesFile = () => path.join(app.getPath('userData'), 'default-apps.json');

function load() { try { return JSON.parse(fs.readFileSync(choicesFile(), 'utf8')) || {}; } catch { return {}; } }
const builtinDesktop = (id) => `liquiddesktop-${id}.desktop`;

// installed apps that say they can open this kind of file
async function candidates() {
  const { listApps } = require('./system');
  const apps = await listApps();
  const out = {};
  for (const [cat, c] of Object.entries(CATEGORIES)) {
    out[cat] = apps.filter((a) => a.mimes?.some((m) => c.mimes.includes(m) || (cat === 'web' && m === 'x-scheme-handler/http')))
      .map((a) => ({ id: a.id, name: a.name, icon: a.icon }));
  }
  return { categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, c]) => [k, { label: c.label, builtin: c.builtin, builtinName: BUILTIN_NAMES[c.builtin] }])), apps: out, choices: load() };
}

// hidden launchers for the built-in apps, so other apps' "open this" can reach them
function writeLaunchers() {
  const dir = path.join(DATA, 'applications');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, name] of Object.entries(BUILTIN_NAMES)) {
    if (id === 'files') continue;   // Files has its own (liquid-desktop-files.desktop, installed with the package)
    const mimes = [...new Set(Object.values(CATEGORIES).filter((c) => c.builtin === id).flatMap((c) => c.mimes))];
    fs.writeFileSync(path.join(dir, builtinDesktop(id)), [
      '[Desktop Entry]', 'Type=Application', `Name=${name} (LiquidDesktop)`, `Exec="${OPENER}" --app ${id} %U`,
      `MimeType=${mimes.join(';')};`, 'NoDisplay=true', 'OnlyShowIn=LiquidDesktop;', 'Terminal=false', '',
    ].join('\n'));
  }
}
function writeMimeapps(choices) {
  // keep someone's own hand-edited file
  try { const cur = fs.readFileSync(MIMEAPPS, 'utf8'); if (cur.trim() && !/written by LiquidDesktop/.test(cur)) return false; } catch { /* none yet */ }
  const lines = [MARK, '[Default Applications]'];
  for (const [cat, c] of Object.entries(CATEGORIES)) {
    const pick = choices[cat];
    const desktop = pick && pick.startsWith('desktop:') ? pick.slice(8) : cat === 'files' ? 'liquid-desktop-files.desktop' : builtinDesktop(c.builtin);
    for (const m of c.mimes) lines.push(`${m}=${desktop}`);
  }
  fs.mkdirSync(CONF, { recursive: true });
  fs.writeFileSync(MIMEAPPS, lines.join('\n') + '\n');
  return true;
}
function apply(choices) {
  const clean = {};
  for (const k of Object.keys(CATEGORIES)) if (typeof choices?.[k] === 'string' && choices[k].startsWith('desktop:')) clean[k] = choices[k];
  fs.mkdirSync(path.dirname(choicesFile()), { recursive: true });
  fs.writeFileSync(choicesFile(), JSON.stringify(clean, null, 1));
  if (sessionMode) {   // the testing window leaves the system's files alone
    try { writeLaunchers(); writeMimeapps(clean); } catch (e) { console.warn('[defaultapps]', e.message); }
  }
  return clean;
}

// open files / links with an installed app, the way its .desktop file asks for them
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const toUri = (p) => (/^[a-z][a-z0-9+.-]*:/i.test(p) ? p : 'file://' + p.split('/').map(encodeURIComponent).join('/'));
async function openWith(id, targets) {
  const { listApps, launchEnv } = require('./system');
  const a = (await listApps()).find((x) => x.id === id) || (await listApps(true)).find((x) => x.id === id);
  if (!a) throw new Error('That app isn’t installed any more.');
  const files = targets.map((t) => (t.startsWith('file://') ? decodeURIComponent(t.slice(7)) : t));
  let exec = a.exec, used = false;
  const one = (code) => { used = true; return code === 'f' ? q(files[0]) : q(toUri(targets[0])); };
  exec = exec.replace(/%([fFuU])/g, (_m, c) => (c === 'F' ? (used = true, files.map(q).join(' ')) : c === 'U' ? (used = true, targets.map((t) => q(toUri(t))).join(' ')) : one(c)));
  exec = exec.replace(/%[dDnNickvm]/g, '').replace(/%%/g, '%').trim();
  if (!used) exec += ' ' + files.map(q).join(' ');
  spawn('/bin/sh', ['-c', exec], { detached: true, stdio: 'ignore', cwd: os.homedir(), env: launchEnv() }).unref();
  return true;
}

let sessionMode = false;
function register({ mode } = {}) {
  sessionMode = mode === 'session';
  const h = (n, fn) => ipcMain.handle(n, async (_e, ...a) => { try { return await fn(...a); } catch (e) { return { __error: e.message }; } });
  h('defaults:list', () => candidates());
  h('defaults:apply', (choices) => apply(choices || {}));
  h('defaults:get', () => load());
  h('apps:openWith', (id, targets) => openWith(String(id), [].concat(targets).map(String)));
  if (mode === 'session') { try { writeLaunchers(); writeMimeapps(load()); } catch (e) { console.warn('[defaultapps]', e.message); } }
}

// rewrite the launchers and the session's defaults from the saved choices (the file-dialog Fix button uses this)
function refresh() { writeLaunchers(); return writeMimeapps(load()); }

module.exports = { register, refresh, CATEGORIES };

// links from LiquidDesktop's own pages: the chosen browser if it isn't the built-in one
module.exports.openUrlExternally = (url) => {
  const pick = load().web;
  if (!pick || !/^https?:/i.test(url)) return false;
  openWith(pick, [url]).catch(() => {});
  return true;
};
