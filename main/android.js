// Android apps through Waydroid (Settings › Android).
//
// Waydroid shows Android on a Wayland display, and the LiquidDesktop session is X11, so Android runs inside
// cage (a one-app Wayland compositor) whose window is an ordinary X11 window: the window manager frames it
// like any other app (macOS title bar and traffic lights; see getTitle/getClass in main/wm.js) and Android
// apps opened from the launcher show up in it.
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
function cfg() { try { return fs.readFileSync('/var/lib/waydroid/waydroid.cfg', 'utf8'); } catch { return ''; } }
async function status() {
  const installed = which('waydroid');
  const initialized = exists('/var/lib/waydroid/images/system.img') || /images_path/.test(cfg());
  const c = cfg();
  const [active, enabled, st] = installed ? await Promise.all([
    run('systemctl', ['is-active', 'waydroid-container.service']), run('systemctl', ['is-enabled', 'waydroid-container.service']), run('waydroid', ['status'], 8000),
  ]) : [{ out: '' }, { out: '' }, { out: '' }];
  return {
    installed, initialized, cage: which('cage'), binder: binderOk(),
    nvidia: exists('/proc/driver/nvidia'),
    gapps: /GAPPS/i.test(c),
    container: active.out.trim() === 'active', serviceEnabled: enabled.out.trim() === 'enabled',
    session: /Session:\s*RUNNING/i.test(st.out),
    window: !!cage,
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
  let step = 0, tail = '', errorText = '', file = 0, lastTotal = 0;
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
      // waydroid init: "[Downloading] 512.34 MB/839.82 MB   4.71 MB/s(avg)" for the system image, then the vendor one
      if ((m = line.match(/([\d.]+)\s*MB\s*\/\s*([\d.]+)\s*MB/))) {
        const total = +m[2];
        if (lastTotal && Math.abs(total - lastTotal) > 1) file++;
        lastTotal = total;
        const frac = file === 0 ? (+m[1] / total) * 0.8 : 0.8 + (+m[1] / total) * 0.2;
        send({ line: `Downloading Android… ${Math.round(+m[1])} of ${Math.round(total)} MB${file ? ' (part 2)' : ''}`, percent: at(step, frac) });
        continue;
      }
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
      const error = ok ? null : errorText || (/incorrect password|a password is required|no password/i.test(tail) ? 'Your password wasn’t accepted.' : tail.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('::')).slice(-3).join('\n') || 'Something went wrong.');
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
pacman -S --needed --noconfirm waydroid cage
echo "::step 1 Checking that your system can run Android…"
if ! grep -qw binder /proc/filesystems && [ ! -e /dev/binder ]; then modprobe binder_linux devices=binder,hwbinder,vndbinder 2>/dev/null || true; fi
if ! grep -qw binder /proc/filesystems && [ ! -e /dev/binder ]; then
  echo "::error Your Linux kernel doesn't include Android's binder driver. Install the linux-zen kernel (sudo pacman -S linux-zen), restart into it, then try again."
  exit 3
fi
echo "::step 2 Downloading Android (about 1 GB)…"
waydroid init -f -s ${type}
echo "::step 3 Starting Android's container…"
systemctl enable --now waydroid-container.service
echo "::step 4 Done"
`, [[0, 12], [12, 15], [15, 92], [92, 100], [100, 100]]);
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

/* ------------------------------------------------------------------ the Android window */
let cage = null, sessionUp = null;
function openWindow() {
  if (cage) return true;
  if (!which('cage') || !which('waydroid')) throw new Error('Android isn’t installed yet. Install it in Settings › Android.');
  if (exists(offFile())) throw new Error('Android is turned off. Turn it on in Settings › Android.');
  // inside cage: start Android's session, wait for it, then show Android's home screen (apps open in it)
  const inner = `
waydroid session start & S=$!
i=0; until waydroid status 2>/dev/null | grep -q 'Session:.*RUNNING'; do sleep 1; i=$((i+1)); [ $i -ge 90 ] && break; done
waydroid show-full-ui
wait $S`;
  const env = userEnv();
  // cage draws into an X11 window here; no client-side decorations (LiquidDesktop frames the window)
  cage = spawn('cage', ['-d', '--', 'sh', '-c', inner], { env, stdio: 'ignore', detached: true });
  sessionUp = waitForSession(120);
  cage.on('exit', () => { cage = null; sessionUp = null; execFile('waydroid', ['session', 'stop'], { env }, () => {}); broadcast('android:changed'); });
  cage.on('error', () => { cage = null; });
  broadcast('android:changed');
  return true;
}
async function waitForSession(secs) {
  for (let i = 0; i < secs; i++) {
    if (/Session:\s*RUNNING/i.test((await run('waydroid', ['status'], 5000)).out)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
async function stopWindow() {
  await run('waydroid', ['session', 'stop'], 20000);
  if (cage) { try { process.kill(-cage.pid, 'SIGTERM'); } catch { /* gone */ } }
  broadcast('android:changed');
  return true;
}
// Android stuck: kill the window and everything in it, stop the session, and restart the container
async function forceQuit() {
  if (cage) { try { process.kill(-cage.pid, 'SIGKILL'); } catch { /* gone */ } cage = null; }
  await run('waydroid', ['session', 'stop'], 10000);
  const { sudoScript } = require('./appstore');
  await sudoScript('systemctl restart waydroid-container.service');
  broadcast('android:changed');
  return status();
}
// an Android app from the launcher (Exec=waydroid app launch PKG): open the Android window first if needed
async function launchApp(pkg) {
  openWindow();
  if (!(await (sessionUp || waitForSession(120)))) return false;
  if (pkg) execFile('waydroid', ['app', 'launch', pkg], { env: userEnv() }, () => {});
  return true;
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
  app.on('before-quit', () => { if (cage) { try { process.kill(-cage.pid, 'SIGTERM'); } catch { /* gone */ } } });
}

module.exports = { register, launchApp, isOff: () => exists(offFile()) };
