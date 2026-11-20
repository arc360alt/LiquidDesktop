// Which picom configurations work on an X display, and what they cost. For each one: does picom start, does it
// actually draw (a solid red test window must still be red on screen — a compositor can start fine and show only
// black), and how much CPU the X server and picom use while the pointer moves.
//   node tools/picom-probe.js :7                    the configurations liquid-desktop-session tries, in order
//   node tools/picom-probe.js :7 -- --backend glx    just this one (arguments for picom; --config is added if missing)
//   PROBE_ENV='__GLX_VENDOR_LIBRARY_NAME=mesa' node tools/picom-probe.js :7 -- --backend glx
// Run it on a display without a compositor: stop the session's first, or use a fresh `Xwayland :8 -decorate -noreset`
// (without -noreset, rootful Xwayland crashes when the probe — its last client — disconnects).
// Needs picom and xdotool (for pointer movement; without it CPU is measured idle).
// No node? ELECTRON_RUN_AS_NODE=1 electron tools/picom-probe.js :7
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const x11 = require(path.join(__dirname, '..', 'node_modules', 'x11'));

const SESSION = path.join(__dirname, '..', 'session');
const argv = process.argv.slice(2);
const disp = argv[0];
if (!disp || !disp.startsWith(':')) { console.error('usage: node tools/picom-probe.js :DISPLAY [-- picom args…]'); process.exit(2); }
const custom = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : null;
const extraEnv = Object.fromEntries((process.env.PROBE_ENV || '').split(/\s+/).filter(Boolean).map((kv) => kv.split(/=(.*)/s).slice(0, 2)));

// the same steps as picom_variant in session/liquid-desktop-session (NVIDIA flags included: harmless elsewhere)
const NV = ['--xrender-sync-fence', '--no-use-damage'];
const configs = custom ? [custom.includes('--config') ? custom : ['--config', path.join(SESSION, 'picom.conf'), ...custom]] : [
  ['--config', path.join(SESSION, 'picom.conf'), ...NV],
  ['--config', path.join(SESSION, 'picom.conf')],
  ['--config', path.join(SESSION, 'picom.conf'), ...NV, '--backend', 'glx'],
  ['--config', path.join(SESSION, 'picom-software.conf'), '--xrender-sync-fence', '--backend', 'xrender'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (bin) => { try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const ticks = (pid) => { try { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return +f[11] + +f[12]; } catch { return 0; } };
// the X server process for this display (Xwayland, Xephyr, Xorg…)
function xServerPid() {
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      const a = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0');
      if (/(^|\/)(Xwayland|Xephyr|Xorg|Xvfb|X)$/.test(a[0]) && a.includes(disp)) return +p;
    } catch { /* gone */ }
  }
  return 0;
}

x11.createClient({ display: disp }, async (err, d) => {
  if (err) { console.error(err.message || err); process.exit(1); }
  const X = d.client, root = d.screen[0].root;
  const C = await new Promise((r) => X.require('composite', (e, ext) => r(e ? null : ext)));
  const cm = await new Promise((r) => X.InternAtom(false, '_NET_WM_CM_S0', (e, a) => r(a)));
  const owner = await new Promise((r) => X.GetSelectionOwner(cm, (e, o) => r(e ? 0 : o)));
  if (owner) { console.error('A compositor is already running on this display: stop it first.'); process.exit(1); }
  // the test window: solid red, override-redirect (no window manager needed)
  const win = X.AllocID();
  X.CreateWindow(win, root, 40, 40, 300, 200, 0, 0, 0, 0, { backgroundPixel: 0xff0000, overrideRedirect: 1 });
  X.MapWindow(win);
  const pixel = (target) => new Promise((r) => X.GetImage(2, target, 190, 140, 1, 1, 0xffffffff, (e, img) => r(e ? null : [img.data[2], img.data[1], img.data[0]])));
  const isRed = (p) => p && p[0] > 200 && p[1] < 60 && p[2] < 60;
  const xpid = xServerPid(), xdotool = has('xdotool'), hz = 100;   // clock ticks per second (Linux default)
  console.log(`X server pid ${xpid || '?'}; pointer movement ${xdotool ? 'with xdotool' : 'not simulated (no xdotool)'}\n`);

  for (const args of configs) {
    const label = args.map((a) => (a.startsWith('/') ? path.basename(a) : a)).join(' ');
    const p = spawn('picom', args, { env: { ...process.env, ...extraEnv, DISPLAY: disp }, stdio: ['ignore', 'ignore', 'pipe'] });
    let errText = '', exited = false;
    p.stderr.on('data', (b) => { errText += b; });
    p.on('exit', () => { exited = true; });
    p.on('error', (e) => { errText += e.message; exited = true; });
    await sleep(2500);
    if (exited) {
      const why = (errText.match(/(ERROR|FATAL)[^\]]*\]\s*(.*)/) || [])[2] || 'exited';
      console.log(`✗ ${label}\n    doesn't start: ${why}\n`);
      continue;
    }
    const seen = [await pixel(root), C && await new Promise((r) => C.GetOverlayWindow(root, (e, ov) => r(ov))).then(pixel)];
    const draws = seen.some(isRed);
    const x0 = ticks(xpid), p0 = ticks(p.pid), t0 = Date.now();
    if (xdotool) for (let i = 0; i < 40; i++) { execFileSync('xdotool', ['mousemove', String(100 + i * 15), '300'], { env: { ...process.env, DISPLAY: disp } }); await sleep(100); }
    else await sleep(4000);
    const secs = (Date.now() - t0) / 1000;
    const pct = (a, b) => Math.round(((b - a) / hz / secs) * 100);
    console.log(`${draws ? '✓' : '✗'} ${label}\n    ${draws ? 'starts and draws' : 'starts but draws BLACK (test window not visible)'}; ` +
      `CPU: X server ${xpid ? pct(x0, ticks(xpid)) + '%' : '?'}, picom ${pct(p0, ticks(p.pid))}%\n`);
    p.kill(); await sleep(800);
  }
  X.DestroyWindow(win);
  process.exit(0);
});
