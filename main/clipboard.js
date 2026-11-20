// Clipboard history (Super+V, or Edit › Clipboard History): everything you copy — text, links, colors, pictures —
// kept in ~/.local/share/LiquidDesktop/clipboard (history.json plus one PNG per picture), newest first, with pins.
//
// In a session the X server says when something new was copied (XFixes SelectSelectionInput on CLIPBOARD), so
// nothing is polled. In the testing window, text is checked every 1.5 s instead.
//
// Left out on purpose: what password managers mark as secret (KeePassXC, KDE: x-kde-passwordManagerHint), and
// anything copied while history is off. Pasting from history puts the item back on the clipboard and sends the
// app Ctrl+V (Ctrl+Shift+V in terminals), through the window manager.
const { ipcMain, clipboard, nativeImage, webContents } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'LiquidDesktop', 'clipboard');
const FILE = path.join(DIR, 'history.json');
const MAX_IMAGES = 40;            // pictures take space: only this many are kept (pinned ones too)
const MAX_TEXT = 200_000;         // characters; longer copies are kept cut to this
const TERMINALS = /^(kitty|alacritty|konsole|xterm|uxterm|urxvt|rxvt|st|foot|wezterm|gnome-terminal|kgx|tilix|terminator|xfce4-terminal|lxterminal|qterminal|sakura|termite|ptyxis|blackbox|ghostty|terminology|cool-retro-term|guake|yakuake|tilda)/i;

let data = { enabled: true, max: 100, items: [] };
let wm = null, last = '', saving = null;

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    data = { ...data, ...d, items: Array.isArray(d.items) ? d.items.filter((x) => x && x.id && (x.kind !== 'image' || fs.existsSync(imgPath(x)))) : [] };
  } catch { /* first run */ }
  last = data.items[0]?.sig || '';
}
const imgPath = (it) => path.join(DIR, it.id + '.png');
function save() {
  clearTimeout(saving);
  saving = setTimeout(() => {
    try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(data), { mode: 0o600 }); fs.renameSync(FILE + '.tmp', FILE); }
    catch (e) { console.error('[clipboard] save', e.message); }
  }, 300);
}
const broadcast = () => { for (const wc of webContents.getAllWebContents()) { try { if (!wc.isDestroyed()) wc.send('clip:changed'); } catch { /* gone */ } } };

/** What kind of text: a link, a color, or plain text (the picker shows each its own way). */
function textKind(t) {
  const s = t.trim();
  if (/^(https?|ftp):\/\/\S+$/i.test(s) && !/\s/.test(s)) return 'link';
  if (/^(#[0-9a-f]{3,8}|rgba?\([\d\s,.%/]+\)|hsla?\([\d\s,.%/deg]+\))$/i.test(s)) return 'color';
  if (/^file:\/\/\S+(\r?\nfile:\/\/\S+)*$/i.test(s)) return 'files';
  return 'text';
}

/** Read the clipboard and add it to the history if it's new. */
function capture() {
  if (!data.enabled) return;
  let formats = [];
  try { formats = clipboard.availableFormats(); } catch { return; }
  if (!formats.length) return;
  // password managers ask clipboard managers to look away
  if (formats.includes('x-kde-passwordManagerHint')) {
    try { if (/secret/.test(clipboard.readBuffer('x-kde-passwordManagerHint').toString())) return; } catch { return; }
  }
  const text = clipboard.readText();
  const hasImage = formats.some((f) => /^image\//.test(f));
  if (text && text.trim()) {
    const sig = 't:' + crypto.createHash('sha1').update(text).digest('hex');
    if (sig === last) return;
    last = sig;
    let html = '';
    if (formats.includes('text/html')) { try { html = clipboard.readHTML().slice(0, MAX_TEXT); } catch { /* none */ } }
    add({ kind: textKind(text), text: text.slice(0, MAX_TEXT), html: html || undefined, sig });
    return;
  }
  if (hasImage) {
    const img = clipboard.readImage();
    if (img.isEmpty()) return;
    const { width, height } = img.getSize();
    const png = img.toPNG();
    const sig = 'i:' + crypto.createHash('sha1').update(png).digest('hex');
    if (sig === last) return;
    last = sig;
    const it = { kind: 'image', w: width, h: height, sig };
    it.id = newId();
    try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(imgPath(it), png, { mode: 0o600 }); } catch { return; }
    add(it, true);
  }
}
const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

function add(it, haveId = false) {
  if (!haveId) it.id = newId();
  it.t = Date.now();
  const f = wm?.focused;
  if (f) it.app = { appId: f.appId || null, wmClass: f.wmClass?.[1] || f.wmClass?.[0] || null, title: (f.title || '').slice(0, 80) };
  // the same thing copied again moves to the top (and keeps its pin)
  const old = data.items.find((x) => x.sig === it.sig);
  if (old) { it.pinned = old.pinned; removeItem(old, false); }
  data.items.unshift(it);
  trim();
  save(); broadcast();
}
function removeItem(it, notify = true) {
  data.items = data.items.filter((x) => x !== it);
  if (it.kind === 'image') fs.rm(imgPath(it), { force: true }, () => {});
  if (notify) { save(); broadcast(); }
}
function trim() {
  let images = 0, kept = 0;
  for (const it of [...data.items]) {
    const isImg = it.kind === 'image';
    if (isImg) images++;
    if (!it.pinned) kept++;
    if ((!it.pinned && kept > data.max) || (isImg && images > MAX_IMAGES)) { removeItem(it, false); if (isImg) images--; }
  }
}

/** For the picker: newest first, pictures as file paths. */
function list() {
  return { enabled: data.enabled, max: data.max, session: !!wm, items: data.items.map(({ sig, ...it }) => (it.kind === 'image' ? { ...it, file: imgPath(it) } : it)) };
}

/** Put an item back on the clipboard; with paste, also into the app you were in. */
async function use(id, { paste = true, plain = false } = {}) {
  const it = data.items.find((x) => x.id === id);
  if (!it) return false;
  if (it.kind === 'image') clipboard.writeImage(nativeImage.createFromPath(imgPath(it)));
  else if (it.html && !plain) clipboard.write({ text: it.text, html: it.html });
  else clipboard.writeText(it.text);
  last = it.sig;
  // back to the top, like copying it again
  data.items = [it, ...data.items.filter((x) => x !== it)];
  it.t = Date.now();
  save(); broadcast();
  if (paste && wm?.pasteKeys) {
    const f = wm.focused;
    const term = f && (f.appId === 'terminal' || TERMINALS.test(f.wmClass?.[1] || '') || TERMINALS.test(f.wmClass?.[0] || ''));
    await wm.pasteKeys(!!term);
  }
  return true;
}

/* ------------------------------------------------------------------ hearing about copies */
// XFixes SelectSelectionInput (minor 2) on CLIPBOARD: the server sends XFixesSelectionNotify (the extension's
// first event) whenever an app takes the clipboard. The x11 module doesn't wrap this request, so it's packed here.
function watchX(theWm) {
  wm = theWm;
  const X = wm.X;
  X.require('fixes', (err, ext) => {
    if (err || !ext) { console.error('[clipboard] no XFixes, checking every 1.5 s instead'); return poll(); }
    X.InternAtom(false, 'CLIPBOARD', (e, atom) => {
      if (e) return poll();
      let pending = null;
      X.eventParsers[ext.firstEvent] = (type, seq, extra, code, raw) => {
        const v = raw.unpack('LLLL');
        return { type, seq, name: 'XFixesSelectionNotify', window: extra, owner: v[0], selection: v[1], time: v[2] };
      };
      X.on('event', (ev) => {
        if (ev.name !== 'XFixesSelectionNotify' || ev.selection !== atom) return;
        // let the app finish setting it up, and fold a burst of changes into one
        clearTimeout(pending);
        pending = setTimeout(() => { try { capture(); } catch (er) { console.error('[clipboard]', er.message); } }, 120);
      });
      X.seq_num++;
      X.pack_stream.pack('CCSLLL', [ext.majorOpcode, 2, 4, wm.root, atom, 1 /* SetSelectionOwner */ | 2 /* window destroyed */ | 4 /* client closed */]);
      X.pack_stream.flush();
    });
  });
}
let polling = null;
function poll() { if (!polling) polling = setInterval(() => { try { capture(); } catch { /* clipboard busy */ } }, 1500); }

function register({ wm: theWm } = {}) {
  load();
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (err) { return { __error: String(err.message || err) }; } });
  h('cliph:list', list);
  h('cliph:use', use);
  h('cliph:remove', (id) => { const it = data.items.find((x) => x.id === id); if (it) removeItem(it); return true; });
  h('cliph:pin', (id, on) => { const it = data.items.find((x) => x.id === id); if (it) { it.pinned = !!on; save(); broadcast(); } return true; });
  h('cliph:clear', (keepPinned = true) => { for (const it of [...data.items]) if (!keepPinned || !it.pinned) removeItem(it, false); save(); broadcast(); return true; });
  h('cliph:options', (o) => {
    if (o && typeof o === 'object') {
      if ('enabled' in o) data.enabled = !!o.enabled;
      if (o.max) data.max = Math.max(10, Math.min(1000, Math.round(o.max)));
      trim(); save(); broadcast();
    }
    return { enabled: data.enabled, max: data.max };
  });
  if (theWm) watchX(theWm); else poll();
}

module.exports = { register, capture };
