// Browser back end: Chrome extensions, saved passwords, downloads and site data for the Browser app.
// All web pages of the Browser live in the "persist:browser" session.
const { session, ipcMain, safeStorage, net, app, shell } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PARTITION = 'persist:browser';
const CONFIG = () => app.getPath('userData');
const EXT_DIR = () => path.join(CONFIG(), 'extensions');
const EXT_LIST = () => path.join(CONFIG(), 'extensions.json');
const PW_FILE = () => path.join(CONFIG(), 'passwords.json');

const ses = () => session.fromPartition(PARTITION);
const extApi = () => ses().extensions || ses();   // Electron ≥35 moved these to session.extensions

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };

/* ------------------------------------------------------------------ extensions */
function extInfo(e, rec) {
  const m = e.manifest || {};
  const msg = (s) => (typeof s === 'string' && s.startsWith('__MSG_') ? localized(e.path, s) : s);
  const icons = m.icons || {};
  const iconRel = icons['128'] || icons['48'] || icons['32'] || icons['16'] || Object.values(icons)[0];
  const action = m.action || m.browser_action || m.page_action || null;
  return {
    id: e.id, name: msg(m.name) || e.name, version: m.version || e.version, description: msg(m.description) || '',
    icon: iconRel ? path.join(e.path, iconRel) : null, popup: action && action.default_popup ? action.default_popup : null,
    options: (m.options_ui && m.options_ui.page) || m.options_page || null, path: e.path, source: rec ? rec.source : 'unpacked', manifestVersion: m.manifest_version,
  };
}
function localized(dir, key) {
  const name = key.replace(/^__MSG_|__$/g, '');
  for (const lang of [app.getLocale().replace('-', '_'), app.getLocale().split('-')[0], 'en', 'en_US']) {
    const msgs = readJson(path.join(dir, '_locales', lang, 'messages.json'), null);
    if (msgs) { const hit = Object.entries(msgs).find(([k]) => k.toLowerCase() === name.toLowerCase()); if (hit) return hit[1].message; }
  }
  return key;
}

async function loadSavedExtensions() {
  for (const rec of readJson(EXT_LIST(), [])) {
    if (rec.enabled === false || !fs.existsSync(rec.path)) continue;
    try { await extApi().loadExtension(rec.path, { allowFileAccess: true }); } catch (e) { console.warn('[browser] extension', rec.path, e.message); }
  }
}

function extensionIdFrom(input) {
  const m = String(input).match(/[a-p]{32}/);
  return m ? m[0] : null;
}

/** Download an extension from the Chrome Web Store, unpack it and load it. */
async function installFromWebStore(input) {
  const id = extensionIdFrom(input);
  if (!id) throw new Error('That doesn’t look like a Chrome Web Store link or extension ID.');
  const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${process.versions.chrome}` +
    `&acceptformat=crx2,crx3&x=id%3D${id}%26installsource%3Dondemand%26uc`;
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`The Web Store returned ${res.status}.`);
  const crx = Buffer.from(await res.arrayBuffer());
  if (crx.toString('latin1', 0, 4) !== 'Cr24') throw new Error('Download was not a Chrome extension (it may not be available for this browser).');
  const version = crx.readUInt32LE(4);
  const zipStart = version === 3 ? 12 + crx.readUInt32LE(8) : 16 + crx.readUInt32LE(8) + crx.readUInt32LE(12);
  const dir = path.join(EXT_DIR(), id);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const zipFile = path.join(os.tmpdir(), `liquid-ext-${id}.zip`);
  await fsp.writeFile(zipFile, crx.subarray(zipStart));
  await new Promise((resolve, reject) => execFile('python3', ['-I', '-c',
    'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zipFile, dir], (err) => (err ? reject(err) : resolve())));
  await fsp.rm(zipFile, { force: true });
  // Chrome's own signature folder; Electron refuses names that start with "_" other than _locales
  await fsp.rm(path.join(dir, '_metadata'), { recursive: true, force: true });
  const ext = await extApi().loadExtension(dir, { allowFileAccess: true });
  const list = readJson(EXT_LIST(), []).filter((r) => r.path !== dir);
  list.push({ path: dir, source: 'webstore', id: ext.id, enabled: true });
  writeJson(EXT_LIST(), list);
  return extInfo(ext, { source: 'webstore' });
}

async function loadUnpacked(dir) {
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new Error('No manifest.json in that folder.');
  const ext = await extApi().loadExtension(dir, { allowFileAccess: true });
  const list = readJson(EXT_LIST(), []).filter((r) => r.path !== dir);
  list.push({ path: dir, source: 'unpacked', id: ext.id, enabled: true });
  writeJson(EXT_LIST(), list);
  return extInfo(ext, { source: 'unpacked' });
}

async function removeExtension(id) {
  const all = extApi().getAllExtensions();
  const e = all.find((x) => x.id === id);
  if (e) extApi().removeExtension(id);
  const list = readJson(EXT_LIST(), []);
  const rec = list.find((r) => r.id === id || (e && r.path === e.path));
  if (rec && rec.source === 'webstore') await fsp.rm(rec.path, { recursive: true, force: true });
  writeJson(EXT_LIST(), list.filter((r) => r !== rec));
  return true;
}

/* ------------------------------------------------------------------ passwords */
// Encrypted with the system keyring (libsecret / KWallet) through Electron's safeStorage.
const enc = (s) => (safeStorage.isEncryptionAvailable() ? 'e:' + safeStorage.encryptString(s).toString('base64') : 'p:' + Buffer.from(s).toString('base64'));
const dec = (s) => { try { return s.startsWith('e:') ? safeStorage.decryptString(Buffer.from(s.slice(2), 'base64')) : Buffer.from(s.slice(2), 'base64').toString(); } catch { return ''; } };
const pwAll = () => readJson(PW_FILE(), []);
const pwWrite = (l) => { writeJson(PW_FILE(), l); try { fs.chmodSync(PW_FILE(), 0o600); } catch { /* ignore */ } };
const siteOf = (origin) => { try { return new URL(origin).hostname.replace(/^www\./, ''); } catch { return origin; } };

/* ------------------------------------------------------------------ downloads */
const downloads = [];
function uniquePath(dir, name) {
  let p = path.join(dir, name), n = 2;
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  while (fs.existsSync(p)) p = path.join(dir, `${stem} (${n++})${ext}`);
  return p;
}

function register() {
  const s = ses();
  // look like Chrome to websites (Electron's user agent makes some sites refuse to work)
  s.setUserAgent(s.getUserAgent().replace(/\s(Electron|liquid-desktop|LiquidDesktop)\/\S+/gi, ''));
  s.setPermissionRequestHandler((_wc, perm, cb) => cb(['fullscreen', 'clipboard-sanitized-write', 'notifications', 'pointerLock', 'clipboard-read'].includes(perm)));
  loadSavedExtensions();

  s.on('will-download', (_e, item, wc) => {
    const dir = app.getPath('downloads');
    const file = uniquePath(dir, item.getFilename());
    item.setSavePath(file);
    const d = { id: Date.now() + Math.random(), name: path.basename(file), path: file, url: item.getURL(), total: item.getTotalBytes(), received: 0, state: 'progressing', started: Date.now() };
    downloads.unshift(d);
    const host = wc && (wc.hostWebContents || wc);
    const send = () => { if (host && !host.isDestroyed()) host.send('browser:download', { ...d }); };
    send();
    item.on('updated', (_ev, state) => { d.received = item.getReceivedBytes(); d.total = item.getTotalBytes(); d.state = state === 'interrupted' ? 'interrupted' : 'progressing'; send(); });
    item.once('done', (_ev, state) => { d.state = state; d.received = item.getReceivedBytes(); send(); });
  });

  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (err) { return { __error: String(err.message || err) }; } });
  h('browser:extList', () => {
    const recs = readJson(EXT_LIST(), []);
    return extApi().getAllExtensions().map((e) => extInfo(e, recs.find((r) => r.id === e.id || r.path === e.path)));
  });
  h('browser:extInstall', installFromWebStore);
  h('browser:extLoad', loadUnpacked);
  h('browser:extRemove', removeExtension);

  h('browser:pwStatus', () => ({ encrypted: safeStorage.isEncryptionAvailable(), backend: safeStorage.getSelectedStorageBackend ? safeStorage.getSelectedStorageBackend() : '' }));
  h('browser:pwList', () => pwAll().map((p) => ({ id: p.id, site: p.site, origin: p.origin, username: p.username, password: dec(p.password), updated: p.updated })));
  h('browser:pwFor', (origin) => { const site = siteOf(origin); return pwAll().filter((p) => p.site === site).map((p) => ({ id: p.id, username: p.username, password: dec(p.password) })); });
  h('browser:pwSave', ({ origin, username, password }) => {
    const site = siteOf(origin);
    const list = pwAll();
    const existing = list.find((p) => p.site === site && p.username === username);
    if (existing) { existing.password = enc(password); existing.updated = Date.now(); }
    else list.push({ id: String(Date.now()), site, origin, username, password: enc(password), updated: Date.now() });
    pwWrite(list);
    return true;
  });
  h('browser:pwDelete', (id) => { pwWrite(pwAll().filter((p) => p.id !== id)); return true; });
  h('browser:pwKnown', ({ origin, username, password }) => {
    const site = siteOf(origin);
    const hit = pwAll().find((p) => p.site === site && p.username === username);
    return hit ? (dec(hit.password) === password ? 'same' : 'changed') : 'new';
  });

  h('browser:downloads', () => downloads.map((d) => ({ ...d })));
  h('browser:openDownload', (p) => shell.openPath(p));
  h('browser:showDownload', (p) => shell.showItemInFolder(p));
  h('browser:clearData', async (kinds = []) => {
    if (kinds.includes('cache')) await s.clearCache();
    if (kinds.includes('cookies')) await s.clearStorageData();
    return true;
  });
}

module.exports = { register, PARTITION };
