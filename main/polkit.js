// The polkit authentication agent: the password sheet apps get when they ask for administrator rights through
// polkit (GParted, Timeshift, pkexec, "Unlock" buttons in settings apps, mounting a system disk…). Without an
// agent in the session those requests failed silently.
//
// Registered with polkitd (system bus) for this login session. When polkit needs someone to authenticate, it calls
// BeginAuthentication: we show the sheet in the shell (renderer/js/polkit.js), and pass the password to polkit's
// own helper, which checks it with PAM and tells polkitd the result — the password never goes anywhere else.
// The helper is reached through /run/polkit/agent-helper.socket (polkit 127+, the helper isn't setuid there) or
// run directly (older polkit, setuid helper). Its protocol: we send the user name and the cookie, it sends lines
// "PAM_PROMPT_ECHO_OFF <prompt>" / "PAM_PROMPT_ECHO_ON …" (we answer with a line), "PAM_ERROR_MSG …",
// "PAM_TEXT_INFO …", and finally "SUCCESS" or "FAILURE".
const fs = require('fs');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');

const SOCKET = '/run/polkit/agent-helper.socket';
const HELPERS = ['/usr/lib/polkit-1/polkit-agent-helper-1', '/usr/libexec/polkit-agent-helper-1', '/usr/lib/policykit-1/polkit-agent-helper-1'];
const OBJ = '/org/liquiddesktop/PolicyKit1/AuthenticationAgent';

let dbus, bus, ask = null, registered = false;
const running = new Map();   // cookie → { cancel() }

/** uid → { name, real } from /etc/passwd (plus getent-less fallback: just the number). */
function userOf(uid) {
  try {
    for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const f = line.split(':');
      if (+f[2] === uid) return { uid, name: f[0], real: (f[4] || '').split(',')[0] || f[0] };
    }
  } catch { /* no passwd */ }
  return uid === process.getuid?.() ? { uid, name: os.userInfo().username, real: os.userInfo().username } : null;
}
/** Members of a group (polkit can ask for "a member of wheel"). */
function groupMembers(gid) {
  try {
    for (const line of fs.readFileSync('/etc/group', 'utf8').split('\n')) {
      const f = line.split(':');
      if (+f[2] === gid) return (f[3] || '').split(',').filter(Boolean);
    }
  } catch { /* no group file */ }
  return [];
}
const uidOfName = (name) => { try { for (const l of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) { const f = l.split(':'); if (f[0] === name) return +f[2]; } } catch { /* */ } return null; };

/**
 * One try with polkit's helper. respond(kind, text) answers a prompt (resolves to the answer, or null to give up).
 * Resolves 'success' | 'failure' | 'cancelled'.
 */
function runHelper(user, cookie, respond, onInfo, register) {
  return new Promise((resolve) => {
    let out, finish, buf = '', done = false;
    const end = (r) => { if (done) return; done = true; try { finish?.(); } catch { /* gone */ } resolve(r); };
    const onLine = async (line) => {
      if (line === 'SUCCESS') return end('success');
      if (line === 'FAILURE') return end('failure');
      const m = line.match(/^(PAM_PROMPT_ECHO_OFF|PAM_PROMPT_ECHO_ON|PAM_ERROR_MSG|PAM_TEXT_INFO) ?(.*)$/);
      if (!m) return;
      if (m[1] === 'PAM_ERROR_MSG' || m[1] === 'PAM_TEXT_INFO') { onInfo(m[1] === 'PAM_ERROR_MSG' ? 'error' : 'info', m[2]); return; }
      const answer = await respond(m[1] === 'PAM_PROMPT_ECHO_OFF' ? 'secret' : 'text', m[2]);
      if (answer == null) return end('cancelled');
      out(String(answer).replace(/\n/g, '') + '\n');
    };
    const onData = (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onLine(line); } };
    const helper = HELPERS.find((p) => fs.existsSync(p));
    const setuid = helper && (() => { try { return (fs.statSync(helper).mode & 0o4000) !== 0; } catch { return false; } })();
    if (fs.existsSync(SOCKET) && !setuid) {
      // polkit 127+: the helper runs as a socket-activated service; it reads the user and the cookie from us
      const sock = net.createConnection(SOCKET);
      out = (s) => sock.write(s);
      finish = () => sock.destroy();
      sock.setEncoding('utf8');
      sock.on('connect', () => sock.write(`${user}\n${cookie}\n`));
      sock.on('data', onData);
      sock.on('error', () => end('failure'));
      sock.on('close', () => end('failure'));
    } else if (helper) {
      const c = spawn(helper, [user], { stdio: ['pipe', 'pipe', 'ignore'] });
      out = (s) => c.stdin.write(s);
      finish = () => c.kill();
      c.stdout.setEncoding('utf8');
      c.stdout.on('data', onData);
      c.on('error', () => end('failure'));
      c.on('exit', () => end('failure'));
      c.stdin.write(`${cookie}\n`);
    } else return end('failure');
    register(() => end('cancelled'));
  });
}

function makeAgent() {
  const { Interface } = dbus.interface;
  class Agent extends Interface {
    async BeginAuthentication(actionId, message, iconName, details, cookie, identities) {
      // who may authenticate: users named directly, and members of groups polkit names (e.g. wheel)
      const users = [];
      const me = process.getuid?.();
      for (const [kind, d] of identities) {
        if (kind === 'unix-user') { const u = userOf(Number(d.uid?.value)); if (u && !users.some((x) => x.uid === u.uid)) users.push(u); }
        if (kind === 'unix-group') for (const n of groupMembers(Number(d.gid?.value))) { const uid = uidOfName(n); const u = uid != null && userOf(uid); if (u && !users.some((x) => x.uid === u.uid)) users.push(u); }
      }
      if (!users.length) throw new dbus.DBusError('org.freedesktop.PolicyKit1.Error.Failed', 'No user to authenticate as');
      users.sort((a, b) => (b.uid === me) - (a.uid === me) || (a.uid === 0) - (b.uid === 0));   // you first, root last
      const info = { actionId, message, icon: iconName, details: Object.fromEntries(Object.entries(details || {})), users };
      let cancelled = false, cancelHelper = null;
      running.set(cookie, { cancel: () => { cancelled = true; cancelHelper?.(); ask?.cancel?.(cookie); } });
      try {
        let error = '';
        for (let attempt = 0; attempt < 5 && !cancelled; attempt++) {
          // the sheet: which user (when there's a choice) and the password
          const a = await ask({ ...info, cookie, error, attempt });
          if (!a || cancelled) throw new dbus.DBusError('org.freedesktop.PolicyKit1.Error.Cancelled', 'Cancelled');
          let infoMsg = '';
          const r = await runHelper(a.user, cookie,
            async (kind) => (kind === 'secret' ? a.password : a.user),
            (kind, text) => { if (kind === 'error') infoMsg = text; },
            (c) => { cancelHelper = c; });
          if (r === 'success') return;
          if (r === 'cancelled' || cancelled) throw new dbus.DBusError('org.freedesktop.PolicyKit1.Error.Cancelled', 'Cancelled');
          error = infoMsg && !/authentication failure/i.test(infoMsg) ? infoMsg : 'Incorrect password. Try again.';
        }
        throw new dbus.DBusError('org.freedesktop.PolicyKit1.Error.Failed', 'Authentication failed');
      } finally {
        running.delete(cookie);
        ask.close?.(cookie);   // the sheet goes away however it ended (polkit cancelled it, the app gave up…)
      }
    }
    CancelAuthentication(cookie) { running.get(cookie)?.cancel(); }
  }
  Agent.configureMembers({
    methods: {
      BeginAuthentication: { inSignature: 'sssa{ss}sa(sa{sv})', outSignature: '' },
      CancelAuthentication: { inSignature: 's', outSignature: '' },
    },
  });
  return new Agent('org.freedesktop.PolicyKit1.AuthenticationAgent');
}

/** This login session's id (logind), for registering the agent for it. */
async function sessionId() {
  if (process.env.XDG_SESSION_ID) return process.env.XDG_SESSION_ID;
  const r = await bus.call(new dbus.Message({ destination: 'org.freedesktop.login1', path: '/org/freedesktop/login1', interface: 'org.freedesktop.login1.Manager', member: 'GetSessionByPID', signature: 'u', body: [process.pid] }));
  const p = await bus.call(new dbus.Message({ destination: 'org.freedesktop.login1', path: r.body[0], interface: 'org.freedesktop.DBus.Properties', member: 'Get', signature: 'ss', body: ['org.freedesktop.login1.Session', 'Id'] }));
  return p.body[0].value;
}

/**
 * Start the agent (session mode only: in a window, your own desktop already has one).
 * askFn(info) → Promise<{ user, password } | null>; askFn.cancel(cookie) / askFn.close(cookie) close its sheet.
 */
async function register(askFn) {
  ask = askFn;
  // a nested / test session runs inside another login session, which has its own agent
  if (process.env.LIQUID_NO_POLKIT === '1') return false;
  if (process.env.LIQUID_POLKIT_TEST_PID) { await registerForProcess(askFn, +process.env.LIQUID_POLKIT_TEST_PID).catch((e) => console.log('[polkit] test:', e.message)); return true; }
  try {
    dbus = require('dbus-next');
    bus = dbus.systemBus();
    bus.export(OBJ, makeAgent());
    const sid = await sessionId();
    const subject = ['unix-session', { 'session-id': new dbus.Variant('s', String(sid)) }];
    const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || 'en_US.UTF-8';
    await bus.call(new dbus.Message({ destination: 'org.freedesktop.PolicyKit1', path: '/org/freedesktop/PolicyKit1/Authority', interface: 'org.freedesktop.PolicyKit1.Authority',
      member: 'RegisterAuthenticationAgent', signature: '(sa{sv})ss', body: [subject, locale, OBJ] }));
    registered = true;
    console.log(`[polkit] authentication agent registered for session ${sid}`);
  } catch (e) {
    // another agent already runs for this session (fine), or no polkit at all
    console.log('[polkit] no authentication agent:', e.message);
  }
  return registered;
}

/** For testing: register for one process instead of the session (pkcheck --process PID). */
async function registerForProcess(askFn, pid) {
  ask = askFn;
  dbus = require('dbus-next');
  bus = dbus.systemBus();
  bus.export(OBJ, makeAgent());
  const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  const subject = ['unix-process', { pid: new dbus.Variant('u', pid), 'start-time': new dbus.Variant('t', BigInt(st[19])) }];
  await bus.call(new dbus.Message({ destination: 'org.freedesktop.PolicyKit1', path: '/org/freedesktop/PolicyKit1/Authority', interface: 'org.freedesktop.PolicyKit1.Authority',
    member: 'RegisterAuthenticationAgent', signature: '(sa{sv})ss', body: [subject, 'en_US.UTF-8', OBJ] }));
}

module.exports = { register, registerForProcess };
