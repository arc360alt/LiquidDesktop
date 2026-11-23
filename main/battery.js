// Settings › Battery: battery health, the charge limit, and Low Power Mode (also in Control Center).
//  - Health: how much the battery holds now against when it was new (energy_full / energy_full_design), and cycles.
//  - Charge limit ("Optimized"-style: stop at 80% to make the battery last more years). Laptops do it one of three
//    ways, all in /sys: charge_control_end_threshold (ThinkPad, ASUS, Dell, Framework, Huawei, System76…: any
//    percentage), charge_types with Long_Life (newer kernels; Lenovo IdeaPad/Legion conservation mode, ~80%), or the
//    older ideapad conservation_mode switch. Writing needs root: one password prompt, and a systemd-tmpfiles rule
//    so it's set again at every boot (some firmware forgets it).
//  - Low Power Mode: power-profiles-daemon's Power Saver — Never / Always / Only on Battery (switched as the
//    computer is plugged in and unplugged).
const { ipcMain, powerMonitor, app, webContents } = require('electron');
const fs = require('fs');
const path = require('path');

const PS = '/sys/class/power_supply';
const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };
const CONF = () => path.join(app.getPath('userData'), 'battery.json');
let cfg = { lowPower: 'never' };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONF(), 'utf8')) }; } catch { /* first run */ }
const save = () => { try { fs.writeFileSync(CONF(), JSON.stringify(cfg, null, 2)); } catch { /* */ } };
const broadcast = () => { for (const wc of webContents.getAllWebContents()) { try { if (!wc.isDestroyed() && wc.getType() !== 'webview') wc.send('power:changed'); } catch { /* gone */ } } };

const batteries = () => { try { return fs.readdirSync(PS).filter((n) => read(path.join(PS, n, 'type')) === 'Battery' && read(path.join(PS, n, 'scope')) !== 'Device'); } catch { return []; } };

/** How the charge limit is set on this laptop, if at all. */
function limitMethod() {
  const bat = batteries()[0];
  if (!bat) return null;
  const base = path.join(PS, bat);
  if (fs.existsSync(path.join(base, 'charge_control_end_threshold'))) return { kind: 'threshold', file: path.join(base, 'charge_control_end_threshold'), bat };
  const types = read(path.join(base, 'charge_types'));
  if (types && /\bLong_Life\b/.test(types)) return { kind: 'types', file: path.join(base, 'charge_types'), bat, fixed: 80 };
  try {
    const dir = '/sys/bus/platform/drivers/ideapad_acpi';
    for (const d of fs.readdirSync(dir)) if (fs.existsSync(path.join(dir, d, 'conservation_mode'))) return { kind: 'ideapad', file: path.join(dir, d, 'conservation_mode'), bat, fixed: 80 };
  } catch { /* not an IdeaPad */ }
  return null;
}
function limitNow(m) {
  if (!m) return null;
  const v = read(m.file);
  if (m.kind === 'threshold') return +v >= 100 || !v ? 0 : +v;
  if (m.kind === 'types') return /\[Long_Life\]/.test(v || '') ? 80 : 0;
  return v === '1' ? 80 : 0;
}

function health() {
  const bat = batteries()[0];
  if (!bat) return null;
  const b = (n) => read(path.join(PS, bat, n));
  const full = +(b('energy_full') || b('charge_full') || 0), design = +(b('energy_full_design') || b('charge_full_design') || 0);
  const pct = full && design ? Math.min(100, Math.round((full / design) * 100)) : null;
  return { name: bat, capacity: pct, cycles: b('cycle_count') != null && +b('cycle_count') > 0 ? +b('cycle_count') : null,
    condition: pct == null ? null : pct >= 80 ? 'Normal' : 'Service Recommended', model: [b('manufacturer'), b('model_name')].filter(Boolean).join(' '), technology: b('technology') };
}

function status() {
  const m = limitMethod();
  return { health: health(), limit: m ? { kind: m.kind, current: limitNow(m), choices: m.fixed ? [0, m.fixed] : [0, 80, 85, 90, 95], fixed: m.fixed || null } : null, lowPower: cfg.lowPower, onBattery: powerMonitor.isOnBatteryPower?.() || false };
}

/** Set the charge limit (0 = charge to 100%). Writes now and at every boot (/etc/tmpfiles.d). */
async function setLimit(pct) {
  const m = limitMethod();
  if (!m) throw new Error('This computer doesn’t let the battery charge limit be changed.');
  pct = +pct || 0;
  const value = m.kind === 'threshold' ? String(pct ? Math.max(50, Math.min(100, Math.round(pct))) : 100)
    : m.kind === 'types' ? (pct ? 'Long_Life' : 'Standard') : (pct ? '1' : '0');
  const rule = `# Written by LiquidDesktop (Settings › Battery › Charge limit)\nw ${m.file} - - - - ${value}\n`;
  const { sudoScript } = require('./appstore');
  const r = await sudoScript(`set -e\nprintf '%s' '${value}' > '${m.file}'\nprintf '%s' '${rule.replace(/'/g, `'\\''`)}' > /etc/tmpfiles.d/liquid-desktop-battery.conf`);
  if (!r.ok) throw new Error(/incorrect password|password is required/i.test(r.out) ? 'Your password wasn’t accepted.' : r.out.split('\n').slice(-2).join(' ') || 'The charge limit couldn’t be set.');
  broadcast();
  return status();
}

/** Low Power Mode: apply the choice for how the computer is powered right now. */
async function applyLowPower() {
  const power = require('./power');
  const st = await power.state().catch(() => null);
  if (!st?.available || !st.profiles.includes('power-saver')) return;
  const want = cfg.lowPower === 'always' || (cfg.lowPower === 'battery' && powerMonitor.isOnBatteryPower());
  if (want && st.active !== 'power-saver') { cfg.before = st.active; save(); await power.set('power-saver').catch(() => {}); }
  if (!want && st.active === 'power-saver' && cfg.lowPower !== 'never') await power.set(cfg.before && cfg.before !== 'power-saver' ? cfg.before : 'balanced').catch(() => {});
  broadcast();
}

function register() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (err) { return { __error: String(err.message || err) }; } });
  h('battery:status', status);
  h('battery:setLimit', setLimit);
  h('battery:setLowPower', async (mode) => {
    if (!['never', 'always', 'battery'].includes(mode)) throw new Error('Unknown mode');
    const was = cfg.lowPower; cfg.lowPower = mode; save();
    // turning it off: back to the mode from before
    if (mode === 'never' && was !== 'never') { const power = require('./power'); const st = await power.state().catch(() => null); if (st?.active === 'power-saver') await power.set(cfg.before && cfg.before !== 'power-saver' ? cfg.before : 'balanced').catch(() => {}); }
    await applyLowPower();
    return status();
  });
  app.whenReady().then(() => {
    powerMonitor.on('on-battery', () => applyLowPower().catch(() => {}));
    powerMonitor.on('on-ac', () => applyLowPower().catch(() => {}));
    setTimeout(() => applyLowPower().catch(() => {}), 3000);
  });
}

module.exports = { register, status };
