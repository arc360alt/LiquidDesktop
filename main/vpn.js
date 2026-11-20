// VPN, through NetworkManager (nmcli): the VPN connections you've set up — WireGuard (built into NetworkManager)
// and the plugin kinds (OpenVPN, OpenConnect/AnyConnect, vpnc/Cisco, L2TP, IPsec…) — to turn on and off, import
// from a provider's file (.conf for WireGuard, .ovpn for OpenVPN…), connect on login, and remove. Nothing here costs
// anything or needs an account of ours: the configuration comes from your VPN provider or your own server.
const { ipcMain, webContents } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const has = (cmd) => (process.env.PATH || '/usr/bin').split(':').some((d) => { try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch { return false; } });
const nm = (args, timeout = 20000) => new Promise((resolve) => {
  execFile('nmcli', args, { timeout, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (err, out, er) => resolve({ ok: !err, out: String(out || ''), err: String(er || err?.message || '').trim() }));
});
const broadcast = () => { for (const wc of webContents.getAllWebContents()) { try { if (!wc.isDestroyed()) wc.send('vpn:changed'); } catch { /* gone */ } } };
/** nmcli -t fields: ':' separates, '\:' and '\\' are escaped. */
const fields = (line) => { const out = []; let cur = ''; for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '\\' && i + 1 < line.length) { cur += line[++i]; continue; } if (c === ':') { out.push(cur); cur = ''; continue; } cur += c; } out.push(cur); return out; };

// the VPN kinds NetworkManager can have, with the plugin (package) each needs
const PLUGINS = {
  openvpn: { name: 'OpenVPN', ext: ['ovpn'], pkg: { pacman: 'networkmanager-openvpn', apt: 'network-manager-openvpn', dnf: 'NetworkManager-openvpn' } },
  openconnect: { name: 'Cisco AnyConnect / OpenConnect', ext: [], pkg: { pacman: 'networkmanager-openconnect', apt: 'network-manager-openconnect', dnf: 'NetworkManager-openconnect' } },
  vpnc: { name: 'Cisco IPsec (vpnc)', ext: ['pcf'], pkg: { pacman: 'networkmanager-vpnc', apt: 'network-manager-vpnc', dnf: 'NetworkManager-vpnc' } },
  l2tp: { name: 'L2TP', ext: [], pkg: { pacman: 'networkmanager-l2tp', apt: 'network-manager-l2tp', dnf: 'NetworkManager-l2tp' } },
  strongswan: { name: 'IPsec/IKEv2 (strongSwan)', ext: [], pkg: { pacman: 'networkmanager-strongswan', apt: 'network-manager-strongswan', dnf: 'NetworkManager-strongswan' } },
};
function installedPlugins() {
  const out = new Set();
  for (const dir of ['/usr/lib/NetworkManager/VPN', '/etc/NetworkManager/VPN', '/usr/lib64/NetworkManager/VPN']) {
    try { for (const f of fs.readdirSync(dir)) { const m = f.match(/nm-(\w+)-service\.name$/); if (m) out.add(m[1]); } } catch { /* none */ }
  }
  return out;
}
const pm = () => (has('pacman') ? 'pacman' : has('apt-get') ? 'apt' : has('dnf') ? 'dnf' : null);

async function list() {
  if (!has('nmcli')) return { available: false, vpns: [] };
  const [all, active] = await Promise.all([nm(['-t', '-f', 'NAME,UUID,TYPE,AUTOCONNECT,TIMESTAMP', 'connection', 'show']), nm(['-t', '-f', 'UUID,STATE,DEVICE', 'connection', 'show', '--active'])]);
  if (!all.ok) return { available: false, vpns: [], error: all.err };
  const act = new Map(active.out.split('\n').filter(Boolean).map((l) => { const [uuid, state, dev] = fields(l); return [uuid, { state, dev }]; }));
  const vpns = [];
  for (const line of all.out.split('\n').filter(Boolean)) {
    const [name, uuid, type, auto, ts] = fields(line);
    if (type !== 'vpn' && type !== 'wireguard') continue;
    const a = act.get(uuid);
    vpns.push({ name, uuid, type, kind: 'wireguard', autoconnect: auto === 'yes', lastUsed: +ts ? +ts * 1000 : null,
      state: !a ? 'off' : /activated/.test(a.state) && !/deactivat/.test(a.state) ? 'on' : /activating/.test(a.state) ? 'connecting' : /deactivating/.test(a.state) ? 'disconnecting' : 'off' });
  }
  // which plugin each VPN uses, and its server, for the list
  await Promise.all(vpns.map(async (v) => {
    if (v.type === 'wireguard') {
      v.kind = 'wireguard'; v.kindName = 'WireGuard';
      return;
    }
    const r = await nm(['-t', '-g', 'vpn.service-type,vpn.data', 'connection', 'show', v.uuid]);
    const [svc = '', data = ''] = r.out.split('\n');
    v.kind = (svc.match(/NetworkManager\.(\w+)/) || [])[1] || 'vpn';
    v.kindName = PLUGINS[v.kind]?.name || v.kind;
    v.server = ((data.match(/(?:remote|gateway|host|IPSec gateway)\s*=\s*([^,]+)/) || [])[1] || '').trim();
  }));
  const plugins = installedPlugins();
  for (const v of vpns) v.missingPlugin = v.type === 'vpn' && !plugins.has(v.kind) && !!PLUGINS[v.kind];
  return { available: true, vpns, plugins: [...plugins], kinds: Object.entries(PLUGINS).map(([id, p]) => ({ id, name: p.name, installed: plugins.has(id), pkg: p.pkg[pm()] || null })), pm: pm() };
}

/** Turn a VPN on. NetworkManager may need a password it doesn't have: then { needSecrets } and the pane asks. */
async function connect(uuid, secrets) {
  let file = null;
  const args = ['connection', 'up', 'uuid', uuid];
  if (secrets && typeof secrets === 'object') {
    // the secrets go in a private temporary file, never on the command line
    file = path.join(os.tmpdir(), `liquid-vpn-${process.pid}-${Date.now()}`);
    fs.writeFileSync(file, Object.entries(secrets).map(([k, v]) => `${k}:${String(v).replace(/\n/g, '')}`).join('\n') + '\n', { mode: 0o600 });
    args.push('passwd-file', file);
  }
  broadcast();
  const r = await nm(args, 90000);
  if (file) fs.rm(file, { force: true }, () => {});
  broadcast();
  if (r.ok) return { ok: true };
  if (/secrets were required|no secrets|password|Secrets.*not provided|NoSecrets/i.test(r.err)) {
    const kind = await nm(['-t', '-g', 'connection.type,vpn.service-type', 'connection', 'show', uuid]);
    const svc = kind.out.split('\n')[1] || '';
    return { ok: false, needSecrets: true, keys: /openconnect/.test(svc) ? ['vpn.secrets.gateway', 'vpn.secrets.cookie'] : ['vpn.secrets.password'], error: r.err };
  }
  throw new Error(cleanErr(r.err) || 'The VPN didn’t connect.');
}
const cleanErr = (e) => e.replace(/^Error:\s*/i, '').replace(/\(\w+[\w.]*\)\s*$/, '').replace(/Hint: use 'journalctl.*$/s, '').trim();
async function disconnect(uuid) {
  const r = await nm(['connection', 'down', 'uuid', uuid]);
  broadcast();
  if (!r.ok && !/not an active connection/i.test(r.err)) throw new Error(cleanErr(r.err));
  return true;
}

/** Import a provider's file. WireGuard names the network interface after the file, so it's copied to a safe name. */
async function importFile(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const text = (() => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } })();
  let type = ext === 'conf' && /\[Interface\]/i.test(text) && /PrivateKey/i.test(text) ? 'wireguard' : Object.keys(PLUGINS).find((k) => PLUGINS[k].ext.includes(ext));
  if (!type && /^\s*(client|remote\s)/m.test(text)) type = 'openvpn';
  if (!type) throw new Error('That file isn’t a VPN configuration LiquidDesktop knows (WireGuard .conf or OpenVPN .ovpn).');
  if (type !== 'wireguard' && !installedPlugins().has(type)) return { ok: false, needPlugin: type, pluginName: PLUGINS[type].name };
  let src = file, tmp = null;
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  if (type === 'wireguard') {
    // an interface name: 1–15 letters, digits, - and _
    const ifname = (base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'wg0').slice(0, 15);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'liquid-vpn-'));
    src = path.join(tmp, ifname + '.conf');
    fs.copyFileSync(file, src); fs.chmodSync(src, 0o600);
  }
  const r = await nm(['connection', 'import', 'type', type, 'file', src]);
  if (tmp) fs.rm(tmp, { recursive: true, force: true }, () => {});
  if (!r.ok) throw new Error(cleanErr(r.err) || 'The configuration couldn’t be imported.');
  const uuid = (r.out.match(/\(([0-9a-f-]{36})\)/) || [])[1];
  // a friendly name (the file's), not the interface name; and off until you turn it on
  if (uuid) {
    await nm(['connection', 'modify', 'uuid', uuid, 'connection.id', base.slice(0, 60), 'connection.autoconnect', 'no']);
  }
  broadcast();
  return { ok: true, uuid };
}
async function remove(uuid) {
  const r = await nm(['connection', 'delete', 'uuid', uuid]);
  broadcast();
  if (!r.ok) throw new Error(cleanErr(r.err));
  return true;
}
async function setAuto(uuid, on) {
  const r = await nm(['connection', 'modify', 'uuid', uuid, 'connection.autoconnect', on ? 'yes' : 'no']);
  broadcast();
  if (!r.ok) throw new Error(cleanErr(r.err));
  return true;
}
async function rename(uuid, name) {
  const r = await nm(['connection', 'modify', 'uuid', uuid, 'connection.id', String(name).slice(0, 60)]);
  broadcast();
  if (!r.ok) throw new Error(cleanErr(r.err));
  return true;
}
/** Install a VPN kind's NetworkManager plugin (one password prompt), then NetworkManager reloads its plugins. */
async function installPlugin(kind) {
  const p = PLUGINS[kind], m = pm();
  if (!p || !m) throw new Error('Install the NetworkManager plugin for this VPN with your package manager.');
  const cmd = { pacman: `pacman -S --needed --noconfirm ${p.pkg.pacman}`, apt: `DEBIAN_FRONTEND=noninteractive apt-get install -y ${p.pkg.apt}`, dnf: `dnf install -y ${p.pkg.dnf}` }[m];
  const { sudoScript } = require('./appstore');
  const r = await sudoScript(`set -e\n${cmd}\nsystemctl reload NetworkManager 2>/dev/null || true`);
  broadcast();
  if (!r.ok) throw new Error(/incorrect password|password is required/i.test(r.out) ? 'Your password wasn’t accepted.' : r.out.split('\n').slice(-3).join('\n'));
  return true;
}

// NetworkManager tells us when connections change: one `nmcli monitor` while LiquidDesktop runs
function watch() {
  if (!has('nmcli')) return;
  let t = null, child = null, quitting = false;
  const start = () => {
    if (quitting) return;
    child = spawn('nmcli', ['monitor'], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } });
    child.stdout.on('data', (d) => { if (/vpn|wireguard|connect|disconnect/i.test(String(d))) { clearTimeout(t); t = setTimeout(broadcast, 400); } });
    child.on('exit', () => { child = null; if (!quitting) setTimeout(start, 10000); });
    child.on('error', () => {});
  };
  start();
  // it outlived LiquidDesktop otherwise (one left over per run)
  const stop = () => { quitting = true; child?.kill(); };
  require('electron').app.on('will-quit', stop);
  process.on('exit', stop);
}

function register() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (err) { return { __error: String(err.message || err) }; } });
  h('vpn:list', list);
  h('vpn:connect', connect);
  h('vpn:disconnect', disconnect);
  h('vpn:import', importFile);
  h('vpn:remove', remove);
  h('vpn:setAuto', setAuto);
  h('vpn:rename', rename);
  h('vpn:install', installPlugin);
  watch();
}
module.exports = { register, list, fields };
