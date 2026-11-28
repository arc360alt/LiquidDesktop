// Temperatures, for the Temperature widgets and the menu bar's Temperature item: the processor, the graphics card,
// storage, memory and the rest — read from the kernel's hwmon sensors (/sys/class/hwmon), with the thermal zones as a
// fallback, and the NVIDIA driver's own reading (nvidia-smi, which doesn't use hwmon). Read-only, no root needed.
// sensors:read → { cpu, gpu, devices: [{ id, kind, name, temp, hot, detail: [{ label, temp }] }], fans: [{ name, rpm }] }
// (temp in °C; hot = the temperature it's too hot at: the sensor's own critical/maximum where it gives a sensible one)
const { ipcMain } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { which, run, handler } = require('./common');

const HW = '/sys/class/hwmon', TZ = '/sys/class/thermal';
const read = (p) => fsp.readFile(p, 'utf8').then((s) => s.trim()).catch(() => null);
const num = async (p) => { const s = await read(p); const n = s == null ? NaN : Number(s); return Number.isFinite(n) ? n : null; };
// a reading that makes sense (sensors that aren't wired up report 0, -40, 127 or nonsense)
const sane = (c) => c != null && c > 1 && c < 125;

// which kind of part each hwmon driver is
const KIND = [
  [/^(coretemp|k10temp|zenpower|cpu_thermal|cpu-thermal|soc_thermal|x86_pkg_temp|cpu\d*_thermal|apple_smc|thinkpad)$/, 'cpu'],
  [/^(amdgpu|radeon|nouveau|xe|i915|nvidia)$/, 'gpu'],
  [/^(nvme|drivetemp)$/, 'disk'],
  [/^(spd5118|jc42|ee1004)$/, 'memory'],
  [/^(iwlwifi.*|mt7\d+.*|ath\d+.*|rtw\d*.*|brcmfmac.*)$/, 'wifi'],
  [/^BAT\d+$|battery/i, 'battery'],
  [/^(acpitz|pch_.*|nct\d+|it\d+|asus.*|dell_smm|hp_.*|legion.*|thinkpad)$/, 'board'],
];
const kindOf = (name) => (KIND.find(([re]) => re.test(name)) || [null, null])[1];
// how hot is too hot when the sensor doesn't say (°C)
const DEFAULT_HOT = { cpu: 100, gpu: 90, disk: 75, memory: 85, wifi: 90, battery: 55, board: 90 };
const NAME = { cpu: 'Processor', gpu: 'Graphics', disk: 'Storage', memory: 'Memory', wifi: 'Wi-Fi', battery: 'Battery', board: 'System' };

let cpuModel;
async function cpuName() {
  if (cpuModel !== undefined) return cpuModel;
  const s = await read('/proc/cpuinfo');
  const m = s && /^model name\s*:\s*(.+)$/m.exec(s);
  cpuModel = m ? m[1].replace(/\((R|TM)\)/gi, '').replace(/\s+(CPU|Processor)\b.*$/i, '').replace(/\s+\d+-Core.*$/i, '').replace(/^\d+\w* Gen\s+/i, '').replace(/\s+/g, ' ').trim() : null;
  return cpuModel;
}

/** One hwmon device's temperature inputs: [{ label, temp, hot }]. */
async function inputs(dir) {
  const names = await fsp.readdir(dir).catch(() => []);
  const out = [];
  for (const f of names.filter((n) => /^temp\d+_input$/.test(n))) {
    const base = path.join(dir, f.replace('_input', ''));
    const raw = await num(base + '_input');
    if (raw == null) continue;
    const temp = raw / 1000;
    if (!sane(temp)) continue;
    // a limit that's real (some report 65261 °C, or a "max" below what it's running at)
    const lim = async (s) => { const v = await num(base + s); return v != null && v / 1000 > 40 && v / 1000 < 130 ? v / 1000 : null; };
    out.push({ n: +f.match(/\d+/)[0], label: (await read(base + '_label')) || '', temp, crit: await lim('_crit'), max: await lim('_max') });
  }
  return out.sort((a, b) => a.n - b.n);
}

// the sensor that stands for the whole part, by its driver
function mainInput(kind, driver, list) {
  const by = (re) => list.find((i) => re.test(i.label));
  if (driver === 'coretemp') return by(/^Package/) || list.reduce((a, b) => (b.temp > a.temp ? b : a));
  if (driver === 'k10temp' || driver === 'zenpower') return by(/^Tctl$/) || by(/^Tdie$/) || list[0];
  if (driver === 'amdgpu' || driver === 'radeon') return by(/^edge$/) || list[0];
  if (driver === 'nvme') return by(/^Composite$/) || list[0];
  return list[0];
}
const detailLabel = (driver, l) => (driver === 'k10temp' && /^Tccd(\d+)/.test(l) ? `Core complex ${+l.slice(4)}` : l === 'edge' ? 'Edge' : l === 'junction' ? 'Hotspot' : l === 'mem' ? 'Memory' : l);

async function deviceName(kind, driver, dir, i) {
  const dev = path.join(dir, 'device');
  if (kind === 'cpu') return (await cpuName()) || 'Processor';
  if (kind === 'disk') {
    const model = (await read(path.join(dev, 'model'))) || (await read(path.join(dev, 'device', 'model')));
    return model ? model.replace(/[_\s]+/g, ' ').trim() : `Storage ${i + 1}`;
  }
  if (kind === 'memory') return `Memory ${i + 1}`;
  if (kind === 'gpu') return driver === 'amdgpu' ? 'AMD Graphics' : driver === 'nouveau' ? 'NVIDIA Graphics' : driver === 'radeon' ? 'AMD Graphics' : 'Intel Graphics';
  if (kind === 'wifi') return 'Wi-Fi';
  if (kind === 'battery') return 'Battery';
  return NAME[kind] || driver;
}

/* ----------------------------------------------------------------- NVIDIA */
// The proprietary driver has no hwmon sensors: nvidia-smi gives the temperature. On a laptop the graphics card
// sleeps when nothing uses it, and asking nvidia-smi would wake it (costing battery), so a sleeping card isn't asked —
// it shows as asleep instead.
let nvCache = { t: 0, v: null };
async function nvidia() {
  const cards = [];
  for (const d of await fsp.readdir('/sys/bus/pci/devices').catch(() => [])) {
    const p = path.join('/sys/bus/pci/devices', d);
    if ((await read(path.join(p, 'vendor'))) !== '0x10de' || !/^0x03/.test((await read(path.join(p, 'class'))) || '')) continue;
    const drv = path.basename((await fsp.readlink(path.join(p, 'driver')).catch(() => '')) || '');
    cards.push({ drv, state: await read(path.join(p, 'power', 'runtime_status')) });
  }
  const card = cards.find((c) => c.drv === 'nvidia');
  if (!card || !which('nvidia-smi')) return null;
  if (card.state === 'suspended') return { asleep: true };
  if (Date.now() - nvCache.t < 4000) return nvCache.v;
  const q = (f) => run('nvidia-smi', ['--query-gpu=' + f, '--format=csv,noheader,nounits'], { timeout: 3000 });
  // (older drivers don't know temperature.gpu.tlimit, and then refuse the whole query)
  let out = await q('temperature.gpu,name,fan.speed,temperature.gpu.tlimit');
  if (!out.ok) out = await q('temperature.gpu,name,fan.speed');
  const line = out.ok ? out.out.split('\n')[0] : '';
  const [t, name, fan, tlimit] = line.split(',').map((s) => s.trim());
  const temp = Number(t);
  const v = sane(temp) ? { temp, name: (name || '').replace(/^NVIDIA\s+/, '').replace(/\s+Laptop GPU$/, ' Laptop'), fan: Number.isFinite(+fan) ? +fan : null,
    // tlimit: how far below its slow-down point it is (newer drivers)
    hot: Number.isFinite(+tlimit) && +tlimit > 0 ? Math.round(temp + +tlimit) : null } : null;
  nvCache = { t: Date.now(), v };
  return v;
}

/* ------------------------------------------------------------------- read */
let cache = { t: 0, v: null }, pending = null;
async function readAll() {
  const devices = [], fans = [], count = {};
  for (const h of (await fsp.readdir(HW).catch(() => [])).sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)))) {
    const dir = path.join(HW, h);
    const driver = (await read(path.join(dir, 'name'))) || '';
    // fans, from any device that has them
    for (const f of (await fsp.readdir(dir).catch(() => [])).filter((n) => /^fan\d+_input$/.test(n))) {
      const rpm = await num(path.join(dir, f));
      if (rpm != null) fans.push({ name: (await read(path.join(dir, f.replace('_input', '_label')))) || `Fan ${fans.length + 1}`, rpm });
    }
    const kind = kindOf(driver);
    if (!kind) continue;
    const list = await inputs(dir);
    if (!list.length) continue;
    const m = mainInput(kind, driver, list);
    const i = count[kind] = (count[kind] ?? -1) + 1;
    devices.push({
      id: h, kind, driver, name: await deviceName(kind, driver, dir, i), temp: Math.round(m.temp * 10) / 10,
      hot: m.crit || (kind === 'memory' ? null : m.max) || DEFAULT_HOT[kind],
      // the rest of its sensors (cores, hotspot…): the hottest core is the one that matters most
      detail: list.filter((x) => x !== m).map((x) => ({ label: detailLabel(driver, x.label) || `Sensor ${x.n}`, temp: Math.round(x.temp) })),
    });
  }
  // no processor sensor in hwmon: the thermal zones (ARM boards, some laptops)
  if (!devices.some((d) => d.kind === 'cpu')) {
    for (const z of await fsp.readdir(TZ).catch(() => [])) {
      if (!z.startsWith('thermal_zone')) continue;
      const type = (await read(path.join(TZ, z, 'type'))) || '';
      if (!/x86_pkg_temp|cpu|soc|TCPU$|acpitz/i.test(type)) continue;
      const t = (await num(path.join(TZ, z, 'temp'))) / 1000;
      if (!sane(t)) continue;
      devices.unshift({ id: z, kind: 'cpu', driver: type, name: (await cpuName()) || 'Processor', temp: Math.round(t * 10) / 10, hot: DEFAULT_HOT.cpu, detail: [] });
      break;
    }
  }
  const nv = await nvidia();
  if (nv) {
    devices.push(nv.asleep ? { id: 'nvidia', kind: 'gpu', driver: 'nvidia', name: 'NVIDIA Graphics', temp: null, asleep: true, hot: DEFAULT_HOT.gpu, detail: [] }
      : { id: 'nvidia', kind: 'gpu', driver: 'nvidia', name: nv.name || 'NVIDIA Graphics', temp: nv.temp, hot: nv.hot || DEFAULT_HOT.gpu, detail: [] });
    if (nv.fan != null && !nv.asleep) fans.push({ name: 'Graphics fan', percent: nv.fan });
  }
  // the memory modules: one "Memory", the hottest module, with each one as a detail
  const mods = devices.filter((d) => d.kind === 'memory');
  if (mods.length > 1) {
    const top = mods.reduce((a, b) => (b.temp > a.temp ? b : a));
    devices.splice(devices.indexOf(mods[0]), 0, { ...top, name: 'Memory', detail: mods.map((m, k) => ({ label: `Module ${k + 1}`, temp: Math.round(m.temp) })) });
    for (const m of mods) devices.splice(devices.indexOf(m), 1);
  }
  const ORDER = ['cpu', 'gpu', 'disk', 'memory', 'board', 'wifi', 'battery'];
  devices.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  // the graphics card: a dedicated one over the one built into the processor
  const gpus = devices.filter((d) => d.kind === 'gpu');
  const gpu = gpus.find((d) => d.driver === 'nvidia' || d.driver === 'nouveau' || d.driver === 'amdgpu' && !d.asleep && d.temp != null) || gpus[0] || null;
  return { cpu: devices.find((d) => d.kind === 'cpu') || null, gpu, devices, fans, t: Date.now() };
}
/** All the readings, at most once a second and a half however many widgets ask. */
async function readSensors() {
  if (Date.now() - cache.t < 1500 && cache.v) return cache.v;
  if (!pending) pending = readAll().then((v) => { cache = { t: Date.now(), v }; return v; }).finally(() => { pending = null; });
  return pending;
}

function register() {
  const h = handler(ipcMain);
  h('sensors:read', readSensors);
}
module.exports = { register, readSensors };
