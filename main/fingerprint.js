// Fingerprint unlock (Touch ID-style), through fprintd (net.reactivated.Fprint, system bus):
//  - Settings › Lock Screen › Fingerprints: add (enroll, with progress per touch) and remove fingers
//  - the lock screen: while it shows, the sensor is armed; a match unlocks (the password still works too)
//  - the login screen (opt-in): pam_fprintd in the login manager's PAM file, after a password check, so typing your
//    password logs in at once as before, and an empty password (just Enter) asks for your finger instead
// fprintd decides who may do what (polkit: verifying your own finger is allowed; enrolling may ask for your password,
// which LiquidDesktop's own password sheet now shows).
const { ipcMain, webContents } = require('electron');
const fs = require('fs');
const os = require('os');

const SVC = 'net.reactivated.Fprint';
const DEV = 'net.reactivated.Fprint.Device';
let dbus = null, bus = null, matched = false;
const user = () => os.userInfo().username;
const send = (ch, v) => { for (const wc of webContents.getAllWebContents()) { try { if (!wc.isDestroyed() && wc.getType() !== 'webview') wc.send(ch, v); } catch { /* gone */ } } };
const has = (cmd) => (process.env.PATH || '/usr/bin').split(':').some((d) => fs.existsSync(`${d}/${cmd}`));

async function connect() {
  if (bus) return true;
  try { dbus = require('dbus-next'); bus = dbus.systemBus(); bus.on('error', () => {}); } catch { return false; }
  if (!matched) {
    matched = true;
    await bus.call(new dbus.Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's',
      body: [`type='signal',interface='${DEV}'`] })).catch(() => {});
    bus.on('message', (m) => {
      if (m.interface !== DEV) return;
      if (m.member === 'VerifyStatus') onVerify?.(m.body[0], m.body[1]);
      if (m.member === 'EnrollStatus') onEnroll?.(m.body[0], m.body[1]);
    });
  }
  return true;
}
const call = (path, iface, member, signature = '', body = [], timeout) => bus.call(new dbus.Message({ destination: SVC, path, interface: iface, member, signature, body, ...(timeout ? {} : {}) })).then((r) => r.body);
const prop = (path, name) => call(path, 'org.freedesktop.DBus.Properties', 'Get', 'ss', [DEV, name]).then((b) => b[0].value).catch(() => null);
const errName = (e) => String(e?.type || e?.name || e?.message || '');

async function device() {
  if (!(await connect())) return null;
  try { return (await call('/net/reactivated/Fprint/Manager', 'net.reactivated.Fprint.Manager', 'GetDefaultDevice'))[0]; } catch { return null; }
}
async function installed() {
  if (!(await connect())) return false;
  try {
    const r = await bus.call(new dbus.Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'ListActivatableNames' }));
    return r.body[0].includes(SVC);
  } catch { return false; }
}
async function enrolled(dev) {
  try { return (await call(dev, DEV, 'ListEnrolledFingers', 's', [user()]))[0]; } catch { return []; }
}

/** What the pane needs: installed, a sensor, its name and kind, your fingers, and the login screen setting. */
async function status() {
  const out = { installed: false, device: null, fingers: [], login: loginState(), pm: has('pacman') ? 'pacman' : has('apt-get') ? 'apt' : has('dnf') ? 'dnf' : null };
  if (!(await installed())) return out;
  out.installed = true;
  const dev = await device();
  if (!dev) return out;
  out.device = { name: await prop(dev, 'name'), scanType: await prop(dev, 'scan-type'), stages: await prop(dev, 'num-enroll-stages') };
  out.fingers = await enrolled(dev);
  return out;
}

async function install() {
  const pm = has('pacman') ? 'pacman -S --needed --noconfirm fprintd' : has('apt-get') ? 'DEBIAN_FRONTEND=noninteractive apt-get install -y fprintd libpam-fprintd' : has('dnf') ? 'dnf install -y fprintd fprintd-pam' : null;
  if (!pm) throw new Error('Install fprintd with your package manager.');
  const { sudoScript } = require('./appstore');
  const r = await sudoScript(`set -e\n${pm}`);
  if (!r.ok) throw new Error(/incorrect password|password is required/i.test(r.out) ? 'Your password wasn’t accepted.' : r.out.split('\n').slice(-3).join('\n'));
  bus?.disconnect?.(); bus = null; matched = false;
  return status();
}

/* ------------------------------------------------------------------ verify (the lock screen) */
let onVerify = null, verifying = null;
/**
 * Arm the sensor until a finger matches (→ 'match'), verifying is stopped, or it gives up. Progress ('no-match',
 * 'retry', 'match', 'error') goes to the pages as 'fp:verify'.
 */
async function verifyStart() {
  if (verifying) return true;
  const dev = await device();
  if (!dev || !(await enrolled(dev)).length) return false;
  try { await call(dev, DEV, 'Claim', 's', [user()]); } catch (e) { if (!/AlreadyInUse/.test(errName(e))) { send('fp:verify', { state: 'error', error: errName(e) }); return false; } }
  verifying = { dev, tries: 0 };
  const start = () => call(dev, DEV, 'VerifyStart', 's', ['any']).catch((e) => { send('fp:verify', { state: 'error', error: errName(e) }); verifyStop(); });
  onVerify = (result, done) => {
    if (!verifying) return;
    if (result === 'verify-match') { send('fp:verify', { state: 'match' }); verifyStop(); return; }
    if (result === 'verify-no-match') { verifying.tries++; send('fp:verify', { state: 'no-match', tries: verifying.tries }); }
    else if (/retry|too-short|not-centered|remove-and-retry/.test(result)) send('fp:verify', { state: 'retry', hint: result });
    else if (/disconnected|unknown-error/.test(result)) { send('fp:verify', { state: 'error', error: result }); verifyStop(); return; }
    // fprintd ends a verify after each result marked done: start the next one (a few misses, like Touch ID: then password)
    if (done && verifying) {
      if (verifying.tries >= 5) { send('fp:verify', { state: 'locked-out' }); verifyStop(); return; }
      call(dev, DEV, 'VerifyStop').catch(() => {}).then(start);
    }
  };
  await start();
  return true;
}
async function verifyStop() {
  const v = verifying; verifying = null; onVerify = null;
  if (!v) return;
  await call(v.dev, DEV, 'VerifyStop').catch(() => {});
  await call(v.dev, DEV, 'Release').catch(() => {});
}

/* ------------------------------------------------------------------ enroll / delete (Settings) */
let onEnroll = null;
async function enroll(finger) {
  const dev = await device();
  if (!dev) throw new Error('No fingerprint sensor found.');
  await verifyStop();
  await call(dev, DEV, 'Claim', 's', [user()]).catch((e) => { if (!/AlreadyInUse/.test(errName(e))) throw new Error(friendly(e)); });
  const stages = (await prop(dev, 'num-enroll-stages')) || 10;
  let passed = 0;
  return new Promise((resolve, reject) => {
    const finish = async (ok, err) => { onEnroll = null; await call(dev, DEV, 'EnrollStop').catch(() => {}); await call(dev, DEV, 'Release').catch(() => {}); ok ? resolve(status()) : reject(new Error(err)); };
    onEnroll = (result, done) => {
      if (result === 'enroll-stage-passed') { passed++; send('fp:enroll', { state: 'progress', progress: Math.min(0.95, passed / stages) }); }
      else if (result === 'enroll-completed') { send('fp:enroll', { state: 'done', progress: 1 }); finish(true); return; }
      else if (/retry|too-short|not-centered|remove-and-retry/.test(result)) send('fp:enroll', { state: 'retry', hint: result });
      else if (result === 'enroll-duplicate') { send('fp:enroll', { state: 'failed' }); finish(false, 'That finger is already added.'); return; }
      else if (result === 'enroll-data-full') { send('fp:enroll', { state: 'failed' }); finish(false, 'The sensor can’t store any more fingerprints.'); return; }
      else if (done) { send('fp:enroll', { state: 'failed' }); finish(false, 'The fingerprint couldn’t be read. Try again.'); return; }
    };
    call(dev, DEV, 'EnrollStart', 's', [finger]).catch((e) => finish(false, friendly(e)));
  });
}
async function enrollCancel() {
  const dev = await device();
  onEnroll = null;
  if (dev) { await call(dev, DEV, 'EnrollStop').catch(() => {}); await call(dev, DEV, 'Release').catch(() => {}); }
  return true;
}
async function remove(finger) {
  const dev = await device();
  if (!dev) throw new Error('No fingerprint sensor found.');
  await verifyStop();
  await call(dev, DEV, 'Claim', 's', [user()]).catch((e) => { if (!/AlreadyInUse/.test(errName(e))) throw new Error(friendly(e)); });
  try { await call(dev, DEV, 'DeleteEnrolledFinger', 's', [finger]); }
  catch { await call(dev, DEV, 'DeleteEnrolledFingers2').catch((e) => { throw new Error(friendly(e)); }); }   // older fprintd: all of them
  finally { await call(dev, DEV, 'Release').catch(() => {}); }
  return status();
}
const friendly = (e) => (/PermissionDenied|NotAuthorized/i.test(errName(e)) ? 'Not allowed (the password prompt was cancelled?).' : /AlreadyInUse/.test(errName(e)) ? 'The sensor is busy. Try again in a moment.' : errName(e).replace(/^net\.reactivated\.Fprint\.Error\./, ''));

/* ------------------------------------------------------------------ the login screen (PAM) */
// Which login manager's PAM file, and whether it has our lines. Ours go first, in front of the stack it already has:
//   auth [success=ignore default=1] pam_exec.so quiet expose_authtok <empty-password check>
//   auth sufficient pam_fprintd.so max-tries=3 timeout=20
// The check script only answers "was the password empty?". Empty (just Enter): the finger is asked for. Typed: the
// fingerprint line is skipped and your system's own stack checks the password as always (pam_unix reuses it via
// try_first_pass), so failed-login lockout (pam_faillock) and everything else stays exactly as it was.
// LiquidDesktop's own login screen (greetd): it sends an empty password for "use my finger". (Its SDDM theme refuses an
// empty password on purpose — an accidental Enter would count as a failed login — so SDDM is left as it is.)
const PAM_FILES = ['/etc/pam.d/greetd'];
const MARK = '# LiquidDesktop: fingerprint login';
const CHECK = '/etc/security/liquid-desktop-empty-password';
function loginState() {
  const files = PAM_FILES.filter((f) => fs.existsSync(f));
  return { files, on: files.some((f) => { try { return fs.readFileSync(f, 'utf8').includes(MARK); } catch { return false; } }) };
}
async function setLogin(on) {
  const files = loginState().files;
  if (!files.length) throw new Error('Fingerprint login works with LiquidDesktop’s own login screen (Settings › Lock Screen › Login Screen › Use LiquidDesktop’s login screen).');
  const lines = [];
  if (on) lines.push(`printf '%s\\n' '#!/bin/sh' '# LiquidDesktop: succeeds when the password typed at the login screen was empty (then the fingerprint is asked for)' '[ -z "$(head -c 1 | tr -d "\\\\000")" ]' > ${CHECK}`, `chmod 755 ${CHECK}`);
  for (const f of files) {
    lines.push(`sed -i '/^${MARK}$/,+2d' ${f}`);   // ours out (and nothing else)
    if (on) lines.push(`awk 'BEGIN{d=0} /^auth/ && !d {print "${MARK}"; print "auth       [success=ignore default=1]  pam_exec.so quiet expose_authtok ${CHECK}"; print "auth       sufficient   pam_fprintd.so max-tries=3 timeout=20"; d=1} {print}' ${f} > ${f}.liquid && cat ${f}.liquid > ${f} && rm -f ${f}.liquid`);
  }
  if (!on) lines.push(`rm -f ${CHECK}`);
  const { sudoScript } = require('./appstore');
  const r = await sudoScript(`set -e\n${lines.join('\n')}`);
  if (!r.ok) throw new Error(r.out.split('\n').slice(-2).join(' ') || 'The login screen couldn’t be changed.');
  return loginState();
}

function register() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (err) { return { __error: String(err.message || err) }; } });
  h('fp:status', status);
  h('fp:install', install);
  h('fp:verifyStart', verifyStart);
  h('fp:verifyStop', verifyStop);
  h('fp:enroll', enroll);
  h('fp:enrollCancel', enrollCancel);
  h('fp:remove', remove);
  h('fp:setLogin', setLogin);
}
module.exports = { register, status };
