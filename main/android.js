// Android apps through Waydroid (Settings › Android).
//
// Waydroid shows Android on a Wayland display, and the LiquidDesktop session is X11. liquid-wl-bridge
// (bridge/main.c) is a Wayland display whose windows are ordinary X11 windows, so with Waydroid's multi-window
// mode every Android app gets its own LiquidDesktop window (macOS title bar, Dock icon…). The other way, one
// window with all of Android in it, runs inside cage (see getTitle/getClass in main/wm.js).
//
// Root work (installing, the container service, uninstalling) goes through sudo with the password Settings
// asked for (main/appstore.js); progress is sent to the page as "android:progress".
const { ipcMain, webContents, app } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const DATA = process.env.XDG_DATA_HOME || path.join(HOME, '.local/share');
const exists = (f) => { try { fs.accessSync(f); return true; } catch { return false; } };
const which = (b) => (process.env.PATH || '/usr/bin:/bin').split(':').some((d) => exists(path.join(d, b)));
const run = (cmd, args, timeout = 15000) => new Promise((res) => execFile(cmd, args, { timeout, env: userEnv() }, (err, out, errOut) => res({ ok: !err, out: String(out || ''), err: String(errOut || '') })));
const broadcast = (ch, msg) => { for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.getType() !== 'webview') wc.send(ch, msg); };
const offFile = () => path.join(app.getPath('userData'), 'android-off');

// apps started from here shouldn't inherit Electron's internals, and must not think the session is Wayland
function userEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('ELECTRON_') || k === 'CHROME_DESKTOP') delete env[k];
  delete env.WAYLAND_DISPLAY;
  return env;
}

/* ------------------------------------------------------------------ status */
function binderOk() {
  try { if (/\bbinder\b/.test(fs.readFileSync('/proc/filesystems', 'utf8'))) return true; } catch { /* no procfs */ }
  return exists('/dev/binder') || exists('/dev/binderfs');
}
// the kernel was updated but the computer not restarted: the running kernel's modules are gone (Arch removes
// them on update), so Android's container can't mount its system image ("mount … system.img" fails)
const restartNeeded = () => { try { return !fs.existsSync(path.join('/usr/lib/modules', os.release())); } catch { return false; } };
function cfg() { try { return fs.readFileSync('/var/lib/waydroid/waydroid.cfg', 'utf8'); } catch { return ''; } }
async function status() {
  const installed = which('waydroid');
  const initialized = exists('/var/lib/waydroid/images/system.img') || /images_path/.test(cfg());
  const c = cfg();
  const [active, enabled, st] = installed ? await Promise.all([
    run('systemctl', ['is-active', 'waydroid-container.service']), run('systemctl', ['is-enabled', 'waydroid-container.service']), run('waydroid', ['status'], 8000),
  ]) : [{ out: '' }, { out: '' }, { out: '' }];
  return {
    installed, initialized, cage: which('cage'), binder: binderOk(), restartNeeded: restartNeeded(),
    nvidia: exists('/proc/driver/nvidia'),
    gapps: /GAPPS/i.test(c),
    arm: armStatus(c), cpu: cpuVendor(),
    container: active.out.trim() === 'active', serviceEnabled: enabled.out.trim() === 'enabled',
    session: /Session:\s*RUNNING/i.test(st.out),
    window: !!host,
    mode: host ? host.mode : null,
    multiWindow: multiWindow(),
    bridgeError: lastBridgeError || null,
    on: !exists(offFile()),
    busy: job ? job.kind : null,
  };
}

/* ------------------------------------------------------------------ long jobs (install / uninstall …) */
let job = null;
// Runs a root shell script; lines "::step TEXT" move the progress on, "::error TEXT" is what to tell the person.
function rootJob(kind, script, steps) {
  if (job) throw new Error('Android is busy with something else. Wait for it to finish.');
  const { sudoSpawn } = require('./appstore');
  const c = sudoSpawn(script);
  job = { kind, child: c };
  let step = 0, tail = '', errorText = '', file = 0, lastTotal = 0, lastErrorLine = '';
  const send = (m) => broadcast('android:progress', { kind, ...m });
  const at = (s, frac = 0) => Math.round(steps[s][0] + (steps[s][1] - steps[s][0]) * Math.max(0, Math.min(1, frac)));
  send({ line: 'Starting…', percent: 0 });
  const onData = (d) => {
    const text = d.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    tail = (tail + text).slice(-6000);
    for (const raw of text.split(/[\r\n]+/)) {
      const line = raw.trim();
      if (!line) continue;
      let m;
      if ((m = line.match(/^::step (\d+) (.*)$/))) { step = +m[1]; file = 0; lastTotal = 0; send({ line: m[2], percent: at(step) }); continue; }
      if ((m = line.match(/^::error (.*)$/))) { errorText = m[1]; continue; }
      if (/\b(ERROR|Error|error)\b[:\]]|Traceback|Exception|cannot open shared object/.test(line) && !/details-to-stdout/.test(line)) lastErrorLine = line.replace(/^\(\d+\)\s*\[[\d:]+\]\s*/, '').slice(0, 300);
      // waydroid init: "[Downloading] 512.34 MB/839.82 MB   4.71 MB/s(avg)" for the system image, then the vendor one
      if ((m = line.match(/([\d.]+)\s*MB\s*\/\s*([\d.]+)\s*MB/))) {
        const total = +m[2];
        if (lastTotal && Math.abs(total - lastTotal) > 1) file++;
        lastTotal = total;
        const frac = file === 0 ? (+m[1] / total) * 0.8 : 0.8 + (+m[1] / total) * 0.2;
        send({ line: `Downloading Android… ${Math.round(+m[1])} of ${Math.round(total)} MB${file ? ' (part 2)' : ''}`, percent: at(step, frac) });
        continue;
      }
      // downloads with a progress bar (tqdm: " 45%|████   | …"): progress within the step
      if ((m = line.match(/(\d{1,3})%\|/)) && +m[1] <= 100) { send({ line: steps[step][2] || line.slice(0, 140), percent: at(step, +m[1] / 100) }); continue; }
      // pacman: "(1/3) installing waydroid" and percentages
      if ((m = line.match(/\((\d+)\/(\d+)\)\s+(installing|checking|loading|downloading|removing)\s+(.*)/i))) { send({ line: `${m[3][0].toUpperCase() + m[3].slice(1)} ${m[4]}`, percent: at(step, +m[1] / +m[2]) }); continue; }
      send({ line: line.slice(0, 140) });
    }
  };
  c.stdout.on('data', onData);
  c.stderr.on('data', onData);
  return new Promise((resolve) => {
    c.on('error', (e) => { job = null; send({ done: true, ok: false, error: e.message }); resolve({ ok: false, error: e.message }); });
    c.on('exit', (code) => {
      job = null;
      const ok = code === 0;
      const error = ok ? null : errorText || (/incorrect password|a password is required|no password/i.test(tail) ? 'Your password wasn’t accepted.' : lastErrorLine
        || tail.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('::') && !/\[Downloading\]|MB\/s|details-to-stdout|See also/.test(l)).slice(-3).join('\n') || 'Something went wrong.');
      send({ done: true, ok, error, percent: ok ? 100 : undefined });
      broadcast('android:changed');
      require('./system').listApps(true).catch(() => {});
      resolve({ ok, error });
    });
  });
}

function install({ gapps = true } = {}) {
  const type = gapps ? 'GAPPS' : 'VANILLA';
  return rootJob('install', `
set -e
echo "::step 0 Installing Waydroid…"
# (no system update here: that's yours to run when you choose. But Arch only supports installing new packages
# onto an up-to-date system, so if the new LXC can't start, that's the reason, and we say so.)
pacman -S --needed --noconfirm waydroid cage android-tools
if ! lxc-info --version >/dev/null 2>&1; then
  echo "::error LXC (the container Android runs in) can't start: $(lxc-info --version 2>&1 | tail -1). Your system has updates it needs first: install them (sudo pacman -Syu) when it suits you, restart, then try again."
  exit 4
fi
echo "::step 1 Checking that your system can run Android…"
if ! grep -qw binder /proc/filesystems && [ ! -e /dev/binder ]; then modprobe binder_linux devices=binder,hwbinder,vndbinder 2>/dev/null || true; fi
if ! grep -qw binder /proc/filesystems && [ ! -e /dev/binder ]; then
  echo "::error Your Linux kernel doesn't include Android's binder driver. Install the linux-zen kernel (sudo pacman -S linux-zen), restart into it, then try again."
  exit 3
fi
echo "::step 2 Downloading Android (about 1 GB)…"
waydroid --details-to-stdout init -f -s ${type}
echo "::step 3 Starting Android's container…"
${multiWindowScript(true)}
systemctl enable --now waydroid-container.service
echo "::step 4 Done"
`, [[0, 12], [12, 15], [15, 92], [92, 100], [100, 100]]);
}

/* ------------------------------------------------------------------ ARM apps */
// Most Android games are built only for phone (ARM) processors, so on a PC (x86) the Play Store hides them.
// A translation layer runs them anyway: Google's libndk (best on AMD) or Intel's libhoudini (best on Intel).
// Installed with waydroid_script (github.com/casualsnek/waydroid_script), the community tool everyone uses for
// this: it adds the layer to Waydroid's system image and tells Android it can run ARM apps.
const WS_REPO = 'https://github.com/casualsnek/waydroid_script';
const WS_DIR = '/var/lib/liquid-desktop/waydroid_script';
function armStatus(c = cfg()) {
  const m = c.match(/^ro\.dalvik\.vm\.native\.bridge\s*=\s*(\S+)/m);
  return !m || m[1] === '0' ? null : /houdini/.test(m[1]) ? 'libhoudini' : /ndk/.test(m[1]) ? 'libndk' : m[1];
}
function cpuVendor() {
  try { const t = fs.readFileSync('/proc/cpuinfo', 'utf8'); return /GenuineIntel/.test(t) ? 'intel' : /AuthenticAMD/.test(t) ? 'amd' : 'other'; } catch { return 'other'; }
}
async function setArm(kind) {
  if (kind === 'auto') kind = cpuVendor() === 'intel' ? 'libhoudini' : 'libndk';
  if (kind && !['libndk', 'libhoudini'].includes(kind)) throw new Error('Unknown translation layer');
  const current = armStatus();
  if (kind === current) return { ok: true };
  await stopWindow();   // Android restarts with the change
  const ws = (args) => `cd "${WS_DIR}" && venv/bin/python3 main.py ${args}`;
  return rootJob('arm', `
set -e
echo "::step 0 Getting the ARM translation installer…"
if [ -d "${WS_DIR}/.git" ]; then git -C "${WS_DIR}" pull -q --ff-only || true; else rm -rf "${WS_DIR}"; mkdir -p "$(dirname "${WS_DIR}")"; git clone -q --depth 1 ${WS_REPO} "${WS_DIR}"; fi
[ -x "${WS_DIR}/venv/bin/python3" ] || python3 -m venv "${WS_DIR}/venv"
"${WS_DIR}/venv/bin/pip" install -q --disable-pip-version-check -r "${WS_DIR}/requirements.txt"
${current ? `echo "::step 1 Removing ${current}…"
${ws(`uninstall ${current}`)}` : ''}
${kind ? `echo "::step 2 Installing ${kind}…"
${ws(`install ${kind}`)}` : ''}
echo "::step 3 Restarting Android…"
systemctl restart waydroid-container.service
echo "::step 4 Done"
`, [[0, 10, 'Getting the ARM translation installer…'], [10, 25, 'Removing the old translation layer…'], [25, 92, `Downloading and installing ${kind || ''}…`], [92, 100, 'Restarting Android…'], [100, 100, 'Done']]);
}

function uninstall() {
  stopWindow();
  return rootJob('uninstall', `
echo "::step 0 Stopping Android…"
waydroid session stop 2>/dev/null || true
systemctl disable --now waydroid-container.service 2>/dev/null || true
echo "::step 1 Removing Waydroid…"
pacman -Rns --noconfirm waydroid || true
echo "::step 2 Deleting Android and its apps…"
rm -rf /var/lib/waydroid
echo "::step 3 Done"
`, [[0, 15], [15, 60], [60, 100], [100, 100]]).then((r) => {
    // this account's side: Android's data and the launchers for its apps
    try { fs.rmSync(path.join(DATA, 'waydroid'), { recursive: true, force: true }); } catch { /* gone */ }
    try { for (const f of fs.readdirSync(path.join(DATA, 'applications'))) if (/^waydroid\..*\.desktop$/.test(f)) fs.rmSync(path.join(DATA, 'applications', f), { force: true }); } catch { /* none */ }
    try { fs.rmSync(offFile(), { force: true }); } catch { /* none */ }
    return r;
  });
}

// on: the container service runs (Android can start); off: everything stops and Android apps leave the launcher
async function setOn(on) {
  const { sudoScript } = require('./appstore');
  if (!on) {
    await stopWindow();
    fs.mkdirSync(path.dirname(offFile()), { recursive: true });
    fs.writeFileSync(offFile(), '1');
    await sudoScript('systemctl disable --now waydroid-container.service');
  } else {
    try { fs.rmSync(offFile(), { force: true }); } catch { /* none */ }
    const r = await sudoScript('systemctl enable --now waydroid-container.service');
    if (!r.ok) throw new Error(/password/i.test(r.out) ? 'Your password wasn’t accepted.' : r.out || 'Couldn’t start Android’s container.');
  }
  require('./system').listApps(true).catch(() => {});
  broadcast('android:changed');
  return status();
}

/* ------------------------------------------------------------------ Android's windows */
// Two ways to show Android, both ordinary X11 windows the window manager frames:
//  • separate windows (default): liquid-wl-bridge (bridge/main.c) is the Wayland display, and Waydroid's
//    multi-window mode gives every Android app its own window, each one a LiquidDesktop window of its own
//  • one window: cage (a one-app Wayland compositor) shows Android's whole screen in a single window
const BRIDGE_SOCKET = 'liquid-android';
let host = null, sessionUp = null;   // host: the running bridge or cage process
let lastBridgeError = '';
const multiWindow = () => /persist\.waydroid\.multi_windows\s*=\s*true/i.test(cfg());

// The bridge: built with the package (bridge/liquid-wl-bridge); from a source checkout it's built on demand
async function bridgeBinary() {
  const root = path.join(__dirname, '..', 'bridge');
  const packaged = path.join(root, 'liquid-wl-bridge');
  if (exists(packaged)) return packaged;
  const built = path.join(root, 'build', 'liquid-wl-bridge');
  const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  const stale = mtime(built) < Math.max(mtime(path.join(root, 'main.c')), mtime(path.join(root, 'meson.build')));
  if (!stale) return built;
  if (!which('meson') || !exists(path.join(root, 'main.c'))) return exists(built) ? built : null;
  if (!exists(path.join(root, 'build', 'build.ninja'))) await run('meson', ['setup', path.join(root, 'build'), root, '--buildtype=release'], 120000);
  await run('meson', ['compile', '-C', path.join(root, 'build')], 300000);
  return exists(built) ? built : null;
}

async function startBridge() {
  const bin = await bridgeBinary();
  if (!bin) { lastBridgeError = 'liquid-wl-bridge isn’t installed: update LiquidDesktop'; return null; }
  return new Promise((resolve) => {
    // a stale socket from a bridge that didn't exit cleanly would block the name
    const rt = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
    for (const f of [BRIDGE_SOCKET, BRIDGE_SOCKET + '.lock']) { try { fs.rmSync(path.join(rt, f), { force: true }); } catch { /* none */ } }
    const p = spawn(bin, ['--socket', BRIDGE_SOCKET, '--no-activate', '--crop-to-content', '--verbose'], { env: userEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    p.stdin.on('error', () => {});
    // tell it each app's remembered zoom, and the title-bar height if it's known already
    for (const [app, z] of Object.entries(loadZooms())) p.stdin.write(`zoom ${app} ${z}\n`);
    if (captionPx) p.stdin.write(`crop-top ${captionPx}\n`);
    // what Android's windows send (sizes…), for working out window-size problems: ~/.local/state/liquid-desktop/android-bridge.log
    let log = null;
    try {
      const dir = path.join(process.env.XDG_STATE_HOME || path.join(HOME, '.local/state'), 'liquid-desktop');
      fs.mkdirSync(dir, { recursive: true });
      log = fs.createWriteStream(path.join(dir, 'android-bridge.log'));
    } catch { /* no log */ }
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok ? p : null); } };
    p.stdout.on('data', (d) => {
      const t = String(d);
      if (/WAYLAND_DISPLAY=/.test(t)) finish(true);
      // the window was resized: that app's new zoom, remembered for next time
      for (const m of t.matchAll(/^zoom (\S+) ([\d.]+)$/gm)) saveZoom(m[1], Number(m[2]));
    });
    p.stderr.on('data', (d) => {
      log?.write(d);
      const err = String(d).split('\n').filter((l) => l.startsWith('liquid-wl-bridge:')).pop();
      if (err) lastBridgeError = err.replace(/^liquid-wl-bridge:\s*/, '');
    });
    p.on('exit', () => finish(false));
    p.on('error', () => finish(false));
    setTimeout(() => finish(false), 8000);
  });
}

// several opens at once (two app icons clicked quickly) share one start
let starting = null;
// full: show Android's whole desktop too. With separate windows, apps opened from the launcher appear as
// their own windows and nothing else is shown; Android's whole desktop (a window with every app inside it)
// only when asked for.
function openWindow(full = true) {
  if (!host && starting) return starting.then(() => { if (full) showFullUi(); return true; });
  const p = openWindowNow(full);
  if (!host) { starting = p; p.finally(() => { if (starting === p) starting = null; }).catch(() => {}); }
  return p;
}
async function showFullUi() {
  if (await (sessionUp || waitForSession(5))) execFile('waydroid', ['show-full-ui'], { env: hostEnv() }, () => {});
}
async function openWindowNow(full) {
  if (host) {
    if (full) showFullUi();   // already running: bring Android's home screen (its launcher) up
    return true;
  }
  if (!which('waydroid')) throw new Error('Android isn’t installed yet. Install it in Settings › Android.');
  if (exists(offFile())) throw new Error('Android is turned off. Turn it on in Settings › Android.');
  if (restartNeeded()) throw new Error('Restart your computer first: Linux was updated, and Android can’t start until the new version is running.');
  const env = userEnv();
  // An Android session still running from before (LiquidDesktop restarted, logged out…) draws to a display that
  // no longer exists: it plays sounds and sends notifications but can't show a single window. Start it afresh.
  if (/Session:\s*RUNNING/i.test((await run('waydroid', ['status'], 5000)).out)) {
    await run('waydroid', ['session', 'stop'], 20000);
    for (let i = 0; i < 20 && /Session:\s*RUNNING/i.test((await run('waydroid', ['status'], 5000)).out); i++) await new Promise((r) => setTimeout(r, 500));
  }
  const startup = (showDesktop) => `
waydroid session start & S=$!
i=0; until waydroid status 2>/dev/null | grep -q 'Session:.*RUNNING'; do sleep 1; i=$((i+1)); [ $i -ge 90 ] && break; done
${showDesktop ? 'waydroid show-full-ui' : ''}
wait $S`;
  let bridge = null;
  if (multiWindow()) {
    bridge = await startBridge().catch((e) => { lastBridgeError = e.message; return null; });
    // separate windows were asked for but can't work: say why, then show Android in one window instead
    if (!bridge) broadcast('android:error', `Android apps can’t open in separate windows (${lastBridgeError || 'the window bridge didn’t start'}), so Android opens in one window.`);
  }
  if (bridge) {
    host = bridge;
    host.mode = 'windows';
    const sess = spawn('sh', ['-c', startup(full)], { env: { ...env, WAYLAND_DISPLAY: BRIDGE_SOCKET }, stdio: 'ignore', detached: true });
    host.session = sess;
  } else {
    if (!which('cage')) throw new Error('Android’s window can’t open: cage is missing. Reinstall Android in Settings › Android.');
    // cage draws into one X11 window; no client-side decorations (LiquidDesktop frames the window)
    host = spawn('cage', ['-d', '--', 'sh', '-c', startup(true)], { env, stdio: 'ignore', detached: true });
    host.mode = 'window';
  }
  const me = host;
  sessionUp = waitForSession(180);   // a first start can take a couple of minutes
  if (host.mode === 'windows') sessionUp.then((up) => up && execFile('waydroid', ['prop', 'set', 'persist.waydroid.multi_windows', 'true'], { env: hostEnv() }, () => {}));
  sessionUp.then((up) => up && desktopTweaks()).catch(() => {});
  me.on('exit', () => {
    if (host !== me) return;
    host = null; sessionUp = null;
    execFile('waydroid', ['session', 'stop'], { env }, () => {});
    broadcast('android:changed');
  });
  me.on('error', () => { if (host === me) host = null; });
  broadcast('android:changed');
  return true;
}
const hostEnv = () => (host?.mode === 'windows' ? { ...userEnv(), WAYLAND_DISPLAY: BRIDGE_SOCKET } : userEnv());
// Android is up: the session runs AND Android has finished starting (apps asked to open before that are ignored)
async function waitForSession(secs) {
  const until = Date.now() + secs * 1000;
  while (Date.now() < until) {
    if (/Session:\s*RUNNING/i.test((await run('waydroid', ['status'], 5000)).out)
      && (await run('waydroid', ['prop', 'get', 'sys.boot_completed'], 8000)).out.trim().endsWith('1')) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
function killHost(sig) {
  const h = host;
  if (!h) return;
  for (const p of [h.session, h]) if (p) { try { process.kill(-p.pid, sig); } catch { /* gone */ } }
}
async function stopWindow() {
  await run('waydroid', ['session', 'stop'], 20000);
  killHost('SIGTERM');
  broadcast('android:changed');
  return true;
}
// Android stuck: kill its windows and everything in them, stop the session, and restart the container
async function forceQuit() {
  killHost('SIGKILL');
  host = null; sessionUp = null;
  await run('waydroid', ['session', 'stop'], 10000);
  const { sudoScript } = require('./appstore');
  await sudoScript('systemctl restart waydroid-container.service');
  broadcast('android:changed');
  return status();
}
// separate windows per app, or one Android window (a Waydroid setting: needs Android restarted)
async function setMultiWindow(on) {
  await stopWindow();
  const { sudoScript } = require('./appstore');
  const r = await sudoScript(multiWindowScript(on));
  if (!r.ok) throw new Error(/password/i.test(r.out) ? 'Your password wasn’t accepted.' : r.out.split('\n').pop() || 'Couldn’t change the setting.');
  broadcast('android:changed');
  return status();
}
function multiWindowScript(on) {
  return `
CFG=/var/lib/waydroid/waydroid.cfg
[ -f "$CFG" ] || exit 0
grep -q '^\\[properties\\]' "$CFG" || printf '\\n[properties]\\n' >> "$CFG"
sed -i '/^persist.waydroid.multi_windows/d' "$CFG"
sed -i '/^\\[properties\\]/a persist.waydroid.multi_windows = ${on ? 'true' : 'false'}' "$CFG"
waydroid upgrade --offline >/dev/null 2>&1 || true
# Android reads its settings when its container starts
systemctl is-enabled -q waydroid-container.service 2>/dev/null && systemctl restart waydroid-container.service || true`;
}
// an Android app from the launcher (Exec=waydroid app launch PKG): start Android first if needed
async function launchApp(pkg) {
  // an app: just that app (its own window); the Waydroid icon itself: Android's whole desktop
  await openWindow(!pkg);
  if (!(await (sessionUp || waitForSession(180)))) return false;
  if (pkg) {
    execFile('waydroid', ['app', 'launch', pkg], { env: hostEnv() }, () => {});
    // once its window is up; adb can need a moment to (re)connect after Android starts, so a few tries
    if (!captionPx) for (const ms of [4000, 12000, 25000]) setTimeout(() => { if (!captionPx) measureCaption().catch(() => {}); }, ms);
  }
  return true;
}

/* ------------------------------------------------------------------ Android's own title bar, and zoom */
// Every Android app window has Android's own title bar (back, minimise, maximise, close) under ours. The
// bridge crops it off; its height (it depends on Android's screen density) is read from Android over adb.
let captionPx = 0;
const toBridge = (line) => { try { if (host?.mode === 'windows' && host.stdin?.writable) host.stdin.write(line + '\n'); } catch { /* gone */ } };
async function measureCaption() {
  if (captionPx || !adbBin()) return;
  await adbConnect();
  const out = (await adb(['shell', 'dumpsys', 'input'])).out;
  const m = out.match(/Caption of Task=\d+\}[^\n]*?frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return;
  const px = Number(m[4]) - Number(m[2]);
  if (px > 0 && px < 300) { captionPx = px; toBridge(`crop-top ${px}`); }
}
// zoom per app: the window drawn bigger (or smaller), same shape, same layout inside
const zoomsFile = () => path.join(app.getPath('userData'), 'android-zoom.json');
function loadZooms() { try { return JSON.parse(fs.readFileSync(zoomsFile(), 'utf8')) || {}; } catch { return {}; } }
function saveZoom(appId, z) {
  if (!/^[\w.]+$/.test(appId) || !(z > 0)) return;
  const all = loadZooms();
  if (Math.abs(z - 1) < 0.01) delete all[appId]; else all[appId] = Math.round(z * 100) / 100;
  try { fs.mkdirSync(path.dirname(zoomsFile()), { recursive: true }); fs.writeFileSync(zoomsFile(), JSON.stringify(all)); } catch { /* not saved */ }
}
const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
function zoomApp(appId, how) {
  appId = String(appId);
  if (!/^[\w.]+$/.test(appId)) throw new Error('Unknown app');
  const cur = loadZooms()[appId] || 1;
  let z = how === 'in' ? ZOOM_STEPS.find((x) => x > cur + 0.01) || cur : how === 'out' ? [...ZOOM_STEPS].reverse().find((x) => x < cur - 0.01) || cur : 1;
  saveZoom(appId, z);
  toBridge(`zoom ${appId} ${z}`);
  return z;
}

/* ------------------------------------------------------------------ Google Play certification */
// The device ID Google asks for at google.com/android/uncertified (needs Google Play services to have run once)
async function playId() {
  const s = await status();
  if (!s.session) throw new Error('Open Android first, and open the Play Store once, then try again.');
  const { sudoScript } = require('./appstore');
  const q = `ANDROID_RUNTIME_ROOT=/apex/com.android.runtime ANDROID_DATA=/data ANDROID_TZDATA_ROOT=/apex/com.android.tzdata ANDROID_I18N_ROOT=/apex/com.android.i18n sqlite3 /data/data/com.google.android.gsf/databases/gservices.db "select value from main where name = 'android_id';"`;
  const r = await sudoScript(`waydroid shell -- sh -c ${JSON.stringify(q)}`);
  const id = (r.out.match(/\b(\d{10,22})\b/) || [])[1];
  if (!id) throw new Error(r.ok || /no such table|unable to open/i.test(r.out) ? 'Google Play services hasn’t set up yet. Open the Play Store in Android, wait a minute, and try again.' : /password/i.test(r.out) ? 'Your password wasn’t accepted.' : r.out.split('\n').pop() || 'Couldn’t read the device ID.');
  return id;
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ Android settings for a desktop */
// Waydroid's Android is set up like a tablet: it shows its on-screen keyboard even though a real keyboard is
// connected (that keyboard opened as a huge window of its own). Turned off each time Android starts; typing
// on your keyboard works as before. Needs adb (android-tools); without it, nothing changes.
async function desktopTweaks() {
  // without adb this can't be done: say so instead of quietly leaving the on-screen keyboard on
  if (!adbBin()) { broadcast('android:error', 'Android’s on-screen keyboard can’t be turned off without adb. Install it with: sudo pacman -S android-tools, then restart Android.'); return; }
  // Android can take a little while after starting before it takes commands: a few tries
  for (let i = 0; i < 3; i++) {
    try {
      await adbConnect();
      const r = await adb(['shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '0']);
      if (r.ok && (await adb(['shell', 'settings', 'get', 'secure', 'show_ime_with_hard_keyboard'])).out.trim() === '0') return;
    } catch (e) { if (i === 2) broadcast('android:error', `Android’s on-screen keyboard couldn’t be turned off: ${e.message}`); }
    await new Promise((res) => setTimeout(res, 5000));
  }
}

/* ------------------------------------------------------------------ app window sizes (View menu) */
// Like iPhone/iPad apps on a Mac: an Android app's window has a few fixed shapes, switched from the menu bar.
// Android decides an app's size itself, so the change is made inside Android over adb (Android's debugging
// connection to the container). LiquidDesktop approves its own adb key by putting it in Android's data
// folder, which belongs to you, so no password or on-screen prompt is needed.
const adbBin = () => ['adb', '/opt/android-sdk/platform-tools/adb'].find((b) => (b.includes('/') ? exists(b) : which(b))) || null;
let adbSerial = null;
async function adb(args, timeout = 10000) {
  const bin = adbBin();
  if (!bin) throw new Error('Changing an Android app’s size needs adb: install android-tools (sudo pacman -S android-tools).');
  return run(bin, adbSerial ? ['-s', adbSerial, ...args] : args, timeout);
}
async function adbConnect() {
  if (adbSerial && /device$/m.test((await adb(['get-state'], 5000)).out.trim())) return adbSerial;
  const bin = adbBin();
  if (!bin) throw new Error('Changing an Android app’s size needs adb: install android-tools (sudo pacman -S android-tools).');
  // our key (adb makes one the first time it runs), approved in Android's data folder
  const keyPub = path.join(HOME, '.android', 'adbkey.pub');
  if (!exists(keyPub)) await run(bin, ['start-server'], 15000);
  const keysFile = path.join(DATA, 'waydroid', 'data', 'misc', 'adb', 'adb_keys');
  try {
    const key = fs.readFileSync(keyPub, 'utf8').trim();
    const have = exists(keysFile) ? fs.readFileSync(keysFile, 'utf8') : '';
    if (key && !have.includes(key.split(' ')[0])) { fs.appendFileSync(keysFile, (have && !have.endsWith('\n') ? '\n' : '') + key + '\n'); fs.chmodSync(keysFile, 0o640); }
  } catch { /* Android's data folder not there yet: adb will ask on screen instead */ }
  // a fresh connection can be refused while Android is still settling: try twice, waiting a while each time
  for (let attempt = 0; attempt < 2; attempt++) {
    if (adbSerial) await run(bin, ['disconnect', adbSerial], 5000);
    const r = await run('waydroid', ['adb', 'connect'], 20000);
    const ip = (r.out + r.err).match(/(\d+\.\d+\.\d+\.\d+)/)?.[1];
    if (!ip) throw new Error('Couldn’t connect to Android. Is it running?');
    adbSerial = `${ip}:5555`;
    for (let i = 0; i < 20; i++) {
      const st = (await run(bin, ['-s', adbSerial, 'get-state'], 5000)).out.trim();
      if (st === 'device') return adbSerial;
      await new Promise((res) => setTimeout(res, 500));
    }
  }
  throw new Error('Android didn’t accept the connection. Open Android, allow USB debugging if it asks, and try again.');
}
// the app's task, where it is, and the screen it's on
async function taskOf(pkg) {
  await adbConnect();
  const out = (await adb(['shell', 'am', 'stack', 'list'])).out;
  let max = null;
  for (const block of out.split(/\n(?=RootTask )/)) {
    const mb = block.match(/mMaxBounds=Rect\((\d+), (\d+) - (\d+), (\d+)\)/);
    if (mb) max = mb.slice(1).map(Number);
    const t = block.match(new RegExp(`taskId=(\\d+): ${pkg.replace(/\./g, '\\.')}/\\S+ bounds=\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]`));
    if (t) {
      const dpi = Number(block.match(/ (\d+)dpi /)?.[1]) || 160;
      return { id: t[1], bounds: t.slice(2).map(Number), max: max || [0, 0, 1920, 1080], dpi };
    }
  }
  throw new Error('That app isn’t open in Android.');
}
// shapes, in dp (Android's size unit): turned into pixels for this screen, kept on the Android screen
const SIZES = { phone: [412, 732], 'phone-landscape': [732, 412], tablet: [800, 1100], 'tablet-landscape': [1100, 800], large: [1100, 700] };
async function resizeApp(pkg, shape) {
  const t = await taskOf(pkg.replace(/^waydroid\./, ''));
  const [mx1, my1, mx2, my2] = t.max;
  const k = t.dpi / 160, margin = Math.round(24 * k);
  let [w, h] = SIZES[shape] ? SIZES[shape].map((x) => Math.round(x * k)) : [0, 0];
  if (shape === 'rotate') { w = t.bounds[3] - t.bounds[1]; h = t.bounds[2] - t.bounds[0]; }
  if (!w || !h) throw new Error('Unknown size');
  // too big for the Android screen: shrink, keeping the shape
  const fit = Math.min(1, (mx2 - mx1 - 2 * margin) / w, (my2 - my1 - 2 * margin) / h);
  w = Math.round(w * fit); h = Math.round(h * fit);
  const left = Math.max(mx1 + margin, Math.min(t.bounds[0], mx2 - margin - w));
  const top = Math.max(my1 + margin, Math.min(t.bounds[1], my2 - margin - h));
  const r = await adb(['shell', 'am', 'task', 'resize', t.id, String(left), String(top), String(left + w), String(top + h)]);
  if (!r.ok) throw new Error((r.err || r.out).trim().split('\n').pop() || 'Android didn’t resize the app.');
  return true;
}

function register() {
  const h = (n, fn) => ipcMain.handle(n, async (_e, ...a) => { try { return await fn(...a); } catch (e) { return { __error: e.message }; } });
  h('android:status', () => status());
  h('android:install', (o) => install(o || {}));
  h('android:uninstall', () => uninstall());
  h('android:setOn', (on) => setOn(!!on));
  h('android:open', () => openWindow());
  h('android:stop', () => stopWindow());
  h('android:forceQuit', () => forceQuit());
  h('android:playId', () => playId());
  h('android:setMultiWindow', (on) => setMultiWindow(!!on));
  h('android:resizeApp', (pkg, shape) => resizeApp(String(pkg), String(shape)));
  h('android:setArm', (kind) => setArm(kind ? String(kind) : null));
  h('android:zoomApp', (appId, how) => zoomApp(appId, String(how)));
  // Android's Back (its title bar, with the back arrow, is hidden): to the app that has the keyboard
  h('android:back', async () => { await adbConnect(); await adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']); return true; });
  app.on('before-quit', () => killHost('SIGTERM'));
}

module.exports = { register, launchApp, isOff: () => exists(offFile()) };
