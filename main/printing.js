// Printers & Scanners and the Print dialog, through CUPS (lpstat, lp, lpadmin, lpoptions, ippfind).
// - Settings › Printers & Scanners: the printers, their queues, default printer, add (driverless IPP Everywhere /
//   AirPrint first, a matching driver otherwise), remove, pause, test page. Installs CUPS if it's missing.
// - The Print dialog (renderer/js/print.js): LiquidDesktop's apps hand it a document (HTML, a file, or PDF bytes);
//   it's turned into a PDF here (an offscreen window's printToPDF) and sent to `lp` with the chosen options.
// Adding, removing and pausing printers need an administrator (CUPS asks for @SYSTEM): run with sudo (askSudo in
// the pane first). Printing, cancelling your own jobs and your default printer don't.
const { ipcMain, BrowserWindow, webContents } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const has = (cmd) => (process.env.PATH || '/usr/bin').split(':').some((d) => { try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch { return false; } });
const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: opts.timeout || 15000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, maxBuffer: 4 << 20 }, (err, stdout, stderr) =>
    resolve({ ok: !err, code: err?.code, out: String(stdout || ''), err: String(stderr || err?.message || '') }));
});
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const broadcast = (ch, ...a) => { for (const wc of webContents.getAllWebContents()) { try { if (!wc.isDestroyed()) wc.send(ch, ...a); } catch { /* gone */ } } };
const TMP = path.join(os.tmpdir(), `liquid-print-${process.getuid?.() ?? 'u'}`);

/** Everything the pane shows. */
let lastUse = 0;
async function status() {
  lastUse = Date.now();
  if (!has('lpstat')) return { installed: false, running: false, printers: [], jobs: [], pm: pkgManager()?.name || null };
  const sched = await run('lpstat', ['-r']);
  const running = /scheduler is running/.test(sched.out);
  if (!running) return { installed: true, running: false, printers: [], jobs: [], pm: pkgManager()?.name || null };
  const [p, d, v, o, a] = await Promise.all([run('lpstat', ['-l', '-p']), run('lpstat', ['-d']), run('lpstat', ['-v']), run('lpstat', ['-o']), run('lpstat', ['-a'])]);
  const printers = parsePrinters(p.out);
  const def = (d.out.match(/system default destination:\s*(\S+)/) || [])[1] || null;
  // the user's own default (lpoptions -d) wins over the system one, like CUPS does
  const userDef = readUserDefault();
  for (const line of v.out.split('\n')) { const m = line.match(/^device for (\S+):\s*(.+)$/); if (m) { const pr = printers.find((x) => x.name === m[1]); if (pr) pr.uri = m[2].trim(); } }
  for (const line of a.out.split('\n')) { const m = line.match(/^(\S+) (not )?accepting requests/); if (m) { const pr = printers.find((x) => x.name === m[1]); if (pr) pr.accepting = !m[2]; } }
  const jobs = o.out.split('\n').map((l) => l.match(/^(\S+)-(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
    .map((m) => ({ id: `${m[1]}-${m[2]}`, printer: m[1], user: m[3], size: +m[4], when: m[5].trim() }));
  for (const pr of printers) { pr.default = pr.name === (userDef || def); pr.jobs = jobs.filter((j) => j.printer === pr.name); pr.kind = kindOf(pr); }
  // the make and model (and a nicer name) from each printer's attributes
  await Promise.all(printers.map(async (pr) => {
    const r = await run('lpoptions', ['-p', pr.name], { timeout: 4000 });
    const attr = (k) => { const m = r.out.match(new RegExp(`(?:^| )${k}=(?:'((?:[^']|\\\\')*)'|(\\S+))`)); return m ? (m[1] ?? m[2]).replace(/\\(.)/g, '$1') : ''; };
    pr.makeModel ||= attr('printer-make-and-model');
    pr.info ||= attr('printer-info');
  }));
  return { installed: true, running: true, printers, jobs, default: userDef || def, canAdd: has('lpadmin'), pm: pkgManager()?.name || null };
}
function parsePrinters(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    let m;
    // "printer HP is idle.  enabled since …", "printer HP now printing HP-12.  enabled since …", "printer HP disabled since …"
    if ((m = line.match(/^printer (\S+) (is idle|now printing|disabled since)/))) {
      cur = { name: m[1], state: m[2] === 'is idle' ? 'idle' : m[2] === 'now printing' ? 'printing' : 'paused', detail: '', info: '', location: '', makeModel: '', accepting: true };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if ((m = line.match(/^\s+Description:\s*(.*)$/))) cur.info = m[1].trim();
    else if ((m = line.match(/^\s+Location:\s*(.*)$/))) cur.location = m[1].trim();
    else if ((m = line.match(/^\s+(?:Printer Driver|Make and Model):\s*(.*)$/))) cur.makeModel ||= m[1].trim();
    else if ((m = line.match(/^\s+Alerts:\s*(.*)$/))) cur.alerts = m[1].trim() === 'none' ? '' : m[1].trim();
    else if (/^\t\S/.test(line) && !cur.detail && !/:(\s|$)/.test(line)) cur.detail = line.trim();   // the printer's own status message ("Out of paper", "Rendering completed")
  }
  return out;
}
const kindOf = (pr) => (/^cups-pdf|pdf/i.test(pr.uri || '') || /pdf/i.test(pr.name) ? 'pdf' : /^usb:/.test(pr.uri || '') ? 'usb' : /^(ipps?|dnssd|socket|lpd|http|https):/.test(pr.uri || '') ? 'network' : 'other');
function readUserDefault() {
  try {
    const t = fs.readFileSync(path.join(os.homedir(), '.cups', 'lpoptions'), 'utf8');
    return (t.match(/^Default\s+(\S+)/m) || [])[1] || null;
  } catch { return null; }
}

function pkgManager() {
  if (has('pacman')) return { name: 'pacman', install: (p) => `pacman -S --needed --noconfirm ${p.join(' ')}` };
  if (has('apt-get')) return { name: 'apt', install: (p) => `DEBIAN_FRONTEND=noninteractive apt-get install -y ${p.join(' ')}` };
  if (has('dnf')) return { name: 'dnf', install: (p) => `dnf install -y ${p.join(' ')}` };
  if (has('zypper')) return { name: 'zypper', install: (p) => `zypper --non-interactive install ${p.join(' ')}` };
  return null;
}

/** Install CUPS (and mDNS discovery, so network printers show up), and start it. One password prompt. */
async function install() {
  const pm = pkgManager();
  if (!pm) throw new Error('Install CUPS with your package manager, then come back here.');
  const pkgs = pm.name === 'pacman' ? ['cups', 'cups-filters', 'ghostscript', 'avahi', 'ipp-usb']
    : pm.name === 'apt' ? ['cups', 'cups-filters', 'avahi-daemon', 'ipp-usb'] : ['cups', 'cups-filters', 'avahi'];
  const lines = ['set -e', pm.install(pkgs),
    'systemctl enable --now cups.socket cups.service || systemctl enable --now cups.service',
    'systemctl enable --now avahi-daemon.service || true',
    'systemctl enable --now ipp-usb.service 2>/dev/null || true'];
  const { sudoScript } = require('./appstore');
  const r = await sudoScript(lines.join('\n'));
  broadcast('print:changed');
  if (!r.ok) throw new Error(/incorrect password|password is required/i.test(r.out) ? 'Your password wasn’t accepted.' : r.out.split('\n').slice(-3).join('\n') || 'CUPS couldn’t be installed.');
  return status();
}
/** CUPS is installed but not running: start it. */
async function start() {
  const { sudoScript } = require('./appstore');
  const r = await sudoScript('systemctl enable --now cups.socket cups.service || systemctl enable --now cups.service');
  broadcast('print:changed');
  if (!r.ok) throw new Error(r.out.split('\n').slice(-2).join('\n') || 'CUPS didn’t start.');
  return status();
}

/**
 * Printers nearby and plugged in that aren't set up yet: network ones from DNS-SD (ippfind, no password needed),
 * USB and everything else from `lpinfo -v` (needs an administrator: sudo, already unlocked by the pane).
 */
async function discover() {
  const found = new Map();
  const st = await status();
  const known = new Set(st.printers.map((p) => p.uri));
  const add = (uri, name, kind, makeModel = '') => {
    if (!uri || known.has(uri)) return;
    // the same printer over ipp and ipps, or as dnssd and ipp: keep one (the secure / dnssd one)
    const key = (name || uri).toLowerCase();
    const prev = found.get(key);
    if (prev && !(uri.startsWith('ipps:') || uri.startsWith('dnssd:'))) return;
    found.set(key, { uri, name: name || uri.replace(/^\w+:\/\//, '').split(/[/:?]/)[0], kind, makeModel });
  };
  if (has('ippfind')) {
    // as dnssd:// addresses (CUPS finds the printer again by its name through Avahi, so a .local host name
    // doesn't have to resolve, and a printer that changes its IP address keeps working)
    const r = await run('ippfind', ['_ipp._tcp', '_ipps._tcp', '-T', '4', '-x', 'printf', '%s\\t%s\\t%s\\t%s\\n', '{service_uri}', '{service_name}', '{service_regtype}', '{service_domain}', ';'], { timeout: 9000 });
    for (const line of r.out.split('\n')) {
      const [uri, name, type, domain] = line.split('\t').map((x) => (x || '').trim());
      if (!uri) continue;
      const dnssd = name && type ? `dnssd://${encodeURIComponent(name)}.${type.replace(/\.$/, '')}.${(domain || 'local').replace(/\.$/, '')}/` : uri;
      add(dnssd, name, 'network');
    }
  }
  if (has('lpinfo')) {
    const { sudoScript } = require('./appstore');
    const r = await sudoScript('LC_ALL=C lpinfo -l -v --timeout 6 2>/dev/null');
    let cur = null;
    for (const line of r.out.split('\n')) {
      let m;
      if ((m = line.match(/^Device:\s*uri\s*=\s*(\S+)/))) { cur = { uri: m[1] }; continue; }
      if (!cur) continue;
      if ((m = line.match(/^\s*class\s*=\s*(\S+)/))) cur.cls = m[1];
      else if ((m = line.match(/^\s*info\s*=\s*(.*)$/))) cur.info = m[1].trim();
      else if ((m = line.match(/^\s*make-and-model\s*=\s*(.*)$/))) {
        cur.mm = m[1].trim();
        // only real printers: "direct" (USB…) and "network" ones with an address (not the empty backends)
        if (cur.uri.includes(':/') && !/^(cups-brf|beh|lpd|socket|ipp|ipps|http|https|smb):?\/?\/?$/.test(cur.uri)) add(cur.uri, cur.info && cur.info !== 'Unknown' ? cur.info : cur.mm, /^usb:/.test(cur.uri) ? 'usb' : 'network', cur.mm !== 'Unknown' ? cur.mm : '');
        cur = null;
      }
    }
  }
  return [...found.values()];
}
const safeName = (n) => String(n || 'Printer').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 127) || 'Printer';

/** Set up a printer: driverless (IPP Everywhere) when it can, else the best-matching installed driver. */
async function addPrinter({ uri, name, location = '', makeModel = '' }) {
  if (!/^[a-z][\w+.-]*:/i.test(uri || '')) throw new Error('That isn’t a printer address.');
  const { sudoScript } = require('./appstore');
  const id = safeName(name);
  const base = `lpadmin -p ${q(id)} -E -v ${q(uri)} -D ${q(name || id)}${location ? ` -L ${q(location)}` : ''} -o printer-error-policy=retry-job`;
  let r = await sudoScript(`LC_ALL=C ${base} -m everywhere`);
  if (!r.ok) {
    // no IPP Everywhere: a driver for this make and model (Gutenprint, HPLIP, foo2zjs…), if one's installed
    const words = (makeModel || name || '').split(/\s+/).slice(0, 3).join(' ');
    const list = words ? await sudoScript(`LC_ALL=C lpinfo -m --make-and-model ${q(words)} 2>/dev/null | head -5`) : { out: '' };
    const model = (list.out.split('\n')[0] || '').split(' ')[0];
    if (model) r = await sudoScript(`LC_ALL=C ${base} -m ${q(model)}`);
    if (!r.ok || !model) throw new Error(model ? (r.out.split('\n').slice(-2).join(' ') || 'The printer couldn’t be added.')
      : `This printer needs a driver that isn’t installed. Look for one for “${makeModel || name}” in the App Store (for example hplip, gutenprint or foo2zjs), then add it again.`);
  }
  broadcast('print:changed');
  return { ok: true, name: id };
}
async function admin(cmd) {
  const { sudoScript } = require('./appstore');
  const r = await sudoScript(`LC_ALL=C ${cmd}`);
  broadcast('print:changed');
  if (!r.ok) throw new Error(r.out.split('\n').slice(-2).join(' ') || 'It didn’t work.');
  return true;
}
const removePrinter = (name) => admin(`lpadmin -x ${q(name)}`);
const pausePrinter = (name, on) => admin(on ? `cupsdisable ${q(name)}` : `cupsenable ${q(name)} && cupsaccept ${q(name)}`);
async function setDefault(name) {
  const r = await run('lpoptions', ['-d', name]);
  broadcast('print:changed');
  if (!r.ok) throw new Error(r.err.trim() || 'Couldn’t set the default printer.');
  return true;
}
async function cancel(id) {
  const r = await run('cancel', id.includes('-') ? [id] : ['-a', id]);
  broadcast('print:changed');
  if (!r.ok) throw new Error(r.err.trim() || 'The job couldn’t be cancelled.');
  return true;
}
async function testPage(name) {
  const page = ['/usr/share/cups/data/testprint', '/usr/share/cups/data/default-testpage.pdf'].find((f) => fs.existsSync(f));
  if (!page) throw new Error('CUPS’s test page isn’t installed.');
  return printFile(name, page, { title: 'Test Page' });
}
/** The options a printer offers (paper sizes, two-sided, color) for the Print dialog. */
async function options(name) {
  const r = await run('lpoptions', ['-p', name, '-l']);
  const out = {};
  for (const line of r.out.split('\n')) {
    const m = line.match(/^([^/]+)\/([^:]+):\s*(.*)$/);
    if (!m) continue;
    const vals = m[3].split(/\s+/).filter(Boolean);
    out[m[1]] = { label: m[2], values: vals.map((v) => v.replace(/^\*/, '')), current: (vals.find((v) => v.startsWith('*')) || '').slice(1) };
  }
  return {
    media: out.PageSize || out.media || null,
    duplex: !!(out.Duplex && out.Duplex.values.some((v) => /Duplex/i.test(v) && !/None/i.test(v))) || !!out.sides,
    color: !!(out.ColorModel || out['print-color-mode']),
  };
}

/** Print a file with the dialog's choices. Returns the job id. */
async function printFile(name, file, o = {}) {
  if (!has('lp')) throw new Error('Printing needs CUPS: set it up in Settings › Printers & Scanners.');
  const args = name ? ['-d', name] : [];
  if (o.copies > 1) args.push('-n', String(Math.min(999, o.copies | 0)));
  if (o.title) args.push('-t', String(o.title).slice(0, 200));
  if (o.pages && /^[\d,\s-]+$/.test(o.pages)) args.push('-o', 'page-ranges=' + o.pages.replace(/\s+/g, ''));
  if (o.landscape) args.push('-o', 'landscape');
  if (o.twoSided) args.push('-o', o.landscape ? 'sides=two-sided-short-edge' : 'sides=two-sided-long-edge');
  else if (o.twoSided === false) args.push('-o', 'sides=one-sided');
  if (o.mono) args.push('-o', 'print-color-mode=monochrome', '-o', 'ColorModel=Gray');
  if (o.media) args.push('-o', 'media=' + o.media);
  if (o.fit) args.push('-o', 'fit-to-page');
  if (o.collate === false) args.push('-o', 'collate=false');
  args.push('--', file);
  const r = await run('lp', args, { timeout: 60000 });
  broadcast('print:changed');
  if (!r.ok) throw new Error(r.err.trim().replace(/^lp:\s*/, '') || 'The document couldn’t be printed.');
  return { ok: true, job: (r.out.match(/request id is (\S+)/) || [])[1] || null };
}

/**
 * A document from one of LiquidDesktop's apps as a PDF: the HTML is laid out in an offscreen window at the
 * paper's size (with the app's print styles), then printToPDF. Returns the PDF's path (a private temp file).
 */
async function htmlToPdf(html, o = {}) {
  fs.mkdirSync(TMP, { recursive: true, mode: 0o700 });
  const file = path.join(TMP, `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.pdf`);
  const w = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { offscreen: true, javascript: false, sandbox: true, contextIsolation: true } });
  try {
    // from a file (not a data: URL), so pictures on disk the document shows can load
    const src = file.replace(/\.pdf$/, '.html');
    fs.writeFileSync(src, html, { mode: 0o600 });
    await w.loadFile(src);
    fs.rm(src, { force: true }, () => {});
    // pictures in the document finish loading first
    await new Promise((r) => setTimeout(r, 250));
    const pdf = await w.webContents.printToPDF({ landscape: !!o.landscape, printBackground: true, pageSize: o.pageSize || 'Letter', margins: { marginType: 'default' }, preferCSSPageSize: true });
    fs.writeFileSync(file, pdf, { mode: 0o600 });
  } finally { w.destroy(); }
  // tidy old ones away (an hour is plenty for the printer to read them)
  fs.readdir(TMP, (e, names) => { if (e) return; for (const n of names) fs.stat(path.join(TMP, n), (er, s) => { if (!er && Date.now() - s.mtimeMs > 3600e3) fs.rm(path.join(TMP, n), { force: true }, () => {}); }); });
  return file;
}
async function printDoc(name, doc, o = {}) {
  lastUse = Date.now();
  let file = doc.file;
  if (doc.html) file = await htmlToPdf(doc.html, { landscape: o.landscape, pageSize: pageSizeFor(o.media) });
  else if (doc.pdf) { fs.mkdirSync(TMP, { recursive: true, mode: 0o700 }); file = path.join(TMP, `doc-${Date.now()}.pdf`); fs.writeFileSync(file, Buffer.from(doc.pdf), { mode: 0o600 }); }
  if (!file) throw new Error('Nothing to print.');
  // the landscape choice is already in a PDF we made: don't turn it again
  return printFile(name, file, { ...o, landscape: doc.file ? o.landscape : false, title: o.title || doc.title });
}
/** Save as PDF (the dialog's PDF button): the same PDF, written where you chose. */
async function savePdf(doc, dest, o = {}) {
  if (doc.file && /\.pdf$/i.test(doc.file)) { fs.copyFileSync(doc.file, dest); return dest; }
  if (doc.pdf) { fs.writeFileSync(dest, Buffer.from(doc.pdf)); return dest; }
  // a picture: embedded in the page
  const img = () => { const ext = path.extname(doc.file).slice(1).toLowerCase().replace("jpg", "jpeg").replace("svg", "svg+xml"); return `<img src="data:image/${ext};base64,${fs.readFileSync(doc.file).toString("base64")}" style="max-width:100%;max-height:100vh;display:block;margin:auto">`; };
  const f = await htmlToPdf(doc.html || img(), { landscape: o.landscape, pageSize: pageSizeFor(o.media) });
  fs.copyFileSync(f, dest);
  return dest;
}
const pageSizeFor = (media) => (/a4/i.test(media || '') ? 'A4' : /a5/i.test(media || '') ? 'A5' : /legal/i.test(media || '') ? 'Legal' : /tabloid|11x17/i.test(media || '') ? 'Tabloid' : 'Letter');

function register() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (err) { return { __error: String(err.message || err) }; } });
  h('print:status', status);
  h('print:install', install);
  h('print:start', start);
  h('print:discover', discover);
  h('print:add', addPrinter);
  h('print:remove', removePrinter);
  h('print:setDefault', setDefault);
  h('print:pause', pausePrinter);
  h('print:cancel', cancel);
  h('print:testPage', testPage);
  h('print:options', options);
  h('print:doc', printDoc);
  h('print:savePdf', savePdf);
  // the queue changes while jobs print: tell the pane every few seconds while there are jobs — only after
  // printing was used lately (the pane opened, something printed), so an idle desktop doesn't run lpstat
  let jobsBefore = 0;
  setInterval(async () => {
    if ((!jobsBefore && Date.now() - lastUse > 10 * 60_000) || !has('lpstat')) return;
    const r = await run('lpstat', ['-o']);
    const n = r.out.split('\n').filter(Boolean).length;
    if (n || jobsBefore) broadcast('print:changed');
    jobsBefore = n;
  }, 5000);
}

module.exports = { register, status, parsePrinters, discover };
