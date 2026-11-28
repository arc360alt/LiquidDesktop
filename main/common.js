// Small helpers shared by the newer main-process modules (Time Machine, Console, Archive Utility, Live Text, the
// media libraries, Accessibility): finding programs, running them, telling every window something changed, and
// installing a missing package with the system's package manager.
const { webContents } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const which = (cmd) => {
  for (const d of (process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':')) {
    const p = path.join(d, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* not here */ }
  }
  return null;
};

/** Run a program, never through a shell: { ok, code, out, err }. */
function run(cmd, args = [], { timeout = 30000, input, env, maxBuffer = 64 * 1024 * 1024, cwd } = {}) {
  return new Promise((resolve) => {
    const c = execFile(cmd, args, { timeout, maxBuffer, env: env ? { ...process.env, ...env } : process.env, cwd }, (e, out, err) =>
      resolve({ ok: !e, code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(out || ''), err: String(err || (e && !out ? e.message : '')) }));
    if (input != null) c.stdin.end(input);
  });
}

/** Send an event to every window (shell, apps, desktop). */
const broadcast = (ch, ...v) => { for (const wc of webContents.getAllWebContents()) { try { if (!wc.isDestroyed()) wc.send(ch, ...v); } catch { /* gone */ } } };

/** Which package manager this system has, and how to install with it. */
function pkgManager() {
  if (which('pacman')) return { name: 'pacman', install: (p) => `pacman -S --needed --noconfirm ${p.join(' ')}` };
  if (which('apt-get')) return { name: 'apt', install: (p) => `DEBIAN_FRONTEND=noninteractive apt-get install -y ${p.join(' ')}` };
  if (which('dnf')) return { name: 'dnf', install: (p) => `dnf install -y ${p.join(' ')}` };
  if (which('zypper')) return { name: 'zypper', install: (p) => `zypper --non-interactive install ${p.join(' ')}` };
  return null;
}

/**
 * Install packages, named per package manager: { pacman: [...], apt: [...], dnf: [...] }. Runs with sudo, using
 * the password the renderer checked just before (askSudo → sddm:sudoCheck). Throws a readable error.
 */
async function installPackages(spec, what = 'It') {
  const pm = pkgManager();
  const pkgs = pm && (spec[pm.name] || (pm.name === 'zypper' ? spec.dnf : null));
  if (!pkgs?.length) throw new Error(`${what} can’t be installed automatically here. Install it with your package manager, then come back.`);
  if (!pkgs.every((p) => /^[\w.+-]+$/.test(p))) throw new Error('Bad package name');
  const { sudoScript } = require('./appstore');
  const r = await sudoScript(`set -e\n${pm.install(pkgs)}`);
  if (!r.ok) throw new Error(/incorrect password|password is required/i.test(r.out) ? 'Your password wasn’t accepted.' : r.out.split('\n').slice(-3).join('\n') || `${what} couldn’t be installed.`);
  return true;
}

/** ipcMain.handle with errors turned into { __error } (the preload's call() rethrows them in the renderer). */
function handler(ipcMain) {
  return (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (err) { return { __error: String(err?.message || err) }; } });
}

const HOME = require('os').homedir();
const dataDir = (...p) => path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'LiquidDesktop', ...p);
const cacheDir = (...p) => path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'LiquidDesktop', ...p);

module.exports = { which, run, broadcast, pkgManager, installPackages, handler, HOME, dataDir, cacheDir };
