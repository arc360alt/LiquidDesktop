// Lighting: RGB devices through OpenRGB's SDK server (no OpenRGB window).
//
// OpenRGB does the hardware side (it knows hundreds of motherboards, GPUs, RAM sticks, keyboards, mice,
// fans and LED strips). It runs headless, `openrgb --server`, and LiquidDesktop talks to it over its SDK
// protocol (TCP, port 6742): reading the devices, their effects ("modes"), zones and LEDs, and setting colors
// and effects. The Lighting app (renderer/js/apps/lighting.js) is the interface.
//
// Protocol (OpenRGB's NetworkProtocol.md): each packet is a 16-byte header — "ORGB", device index, packet id,
// data size (little-endian u32s) — and its data. Strings are a u16 length (counting the closing 0) then the
// bytes. Colors are 4 bytes: R, G, B, 0. What a device's data contains depends on the protocol version both
// sides agree on (the lower of the two; this client speaks up to 4).
const { ipcMain, webContents } = require('electron');
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.LIQUID_OPENRGB_PORT) || 6742;
const CLIENT_PROTOCOL = 4;
const PKT = {
  CONTROLLER_COUNT: 0, CONTROLLER_DATA: 1, PROTOCOL_VERSION: 40, SET_CLIENT_NAME: 50, DEVICE_LIST_UPDATED: 100,
  PROFILE_LIST: 150, SAVE_PROFILE: 151, LOAD_PROFILE: 152, DELETE_PROFILE: 153,
  RESIZE_ZONE: 1000, UPDATE_LEDS: 1050, UPDATE_ZONE_LEDS: 1051, UPDATE_SINGLE_LED: 1052, SET_CUSTOM_MODE: 1100, UPDATE_MODE: 1101, SAVE_MODE: 1102,
};
// mode flags
const F = { SPEED: 1, DIR_LR: 2, DIR_UD: 4, DIR_HV: 8, BRIGHTNESS: 16, PER_LED: 32, MODE_COLOR: 64, RANDOM: 128, MANUAL_SAVE: 256, AUTO_SAVE: 512 };
const DEVICE_TYPES = ['motherboard', 'dram', 'gpu', 'cooler', 'ledstrip', 'keyboard', 'mouse', 'mousemat', 'headset', 'headsetstand', 'gamepad', 'light', 'speaker', 'virtual', 'storage', 'case', 'microphone', 'accessory', 'keypad'];

/* ------------------------------------------------------------------ reading and writing packets */
class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  u8() { const v = this.b.readUInt8(this.o); this.o += 1; return v; }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  i32() { const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
  str() { const n = this.u16(); const s = this.b.toString('utf8', this.o, this.o + Math.max(0, n - 1)); this.o += n; return s; }
  color() { const c = { r: this.b[this.o], g: this.b[this.o + 1], b: this.b[this.o + 2] }; this.o += 4; return c; }
}
class Writer {
  constructor() { this.parts = []; }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v >>> 0 & 0xffff); this.parts.push(b); return this; }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.parts.push(b); return this; }
  i32(v) { const b = Buffer.alloc(4); b.writeInt32LE(v | 0); this.parts.push(b); return this; }
  str(s) { const t = Buffer.from(String(s) + '\0', 'utf8'); this.u16(t.length); this.parts.push(t); return this; }
  color(c) { this.parts.push(Buffer.from([c.r & 255, c.g & 255, c.b & 255, 0])); return this; }
  colors(list) { this.u16(list.length); for (const c of list) this.color(c); return this; }
  done() { return Buffer.concat(this.parts); }
}

function parseMode(r, proto) {
  const m = { name: r.str(), value: r.i32(), flags: r.u32(), speedMin: r.u32(), speedMax: r.u32() };
  if (proto >= 3) { m.brightnessMin = r.u32(); m.brightnessMax = r.u32(); }
  m.colorsMin = r.u32(); m.colorsMax = r.u32(); m.speed = r.u32();
  if (proto >= 3) m.brightness = r.u32();
  m.direction = r.u32(); m.colorMode = r.u32();
  const n = r.u16(); m.colors = []; for (let i = 0; i < n; i++) m.colors.push(r.color());
  return m;
}
function writeMode(w, m, proto) {
  w.str(m.name).i32(m.value).u32(m.flags).u32(m.speedMin).u32(m.speedMax);
  if (proto >= 3) w.u32(m.brightnessMin ?? 0).u32(m.brightnessMax ?? 0);
  w.u32(m.colorsMin).u32(m.colorsMax).u32(m.speed);
  if (proto >= 3) w.u32(m.brightness ?? 0);
  w.u32(m.direction).u32(m.colorMode).colors(m.colors || []);
}
function parseController(buf, proto) {
  const r = new Reader(buf);
  r.u32();   // data size
  const d = { type: r.i32() };
  d.kind = DEVICE_TYPES[d.type] || 'unknown';
  d.name = r.str();
  if (proto >= 1) d.vendor = r.str();
  d.description = r.str(); d.version = r.str(); d.serial = r.str(); d.location = r.str();
  const nModes = r.u16(); d.activeMode = r.i32();
  d.modes = []; for (let i = 0; i < nModes; i++) d.modes.push(parseMode(r, proto));
  const nZones = r.u16(); d.zones = [];
  for (let i = 0; i < nZones; i++) {
    const z = { name: r.str(), type: r.i32(), ledsMin: r.u32(), ledsMax: r.u32(), ledsCount: r.u32() };
    const matrixLen = r.u16();
    if (matrixLen > 0) {
      const h = r.u32(), w = r.u32(); z.matrix = { width: w, height: h, map: [] };
      for (let k = 0; k < w * h; k++) z.matrix.map.push(r.u32());
    }
    if (proto >= 4) { const nSeg = r.u16(); z.segments = []; for (let k = 0; k < nSeg; k++) z.segments.push({ name: r.str(), type: r.i32(), start: r.u32(), count: r.u32() }); }
    d.zones.push(z);
  }
  const nLeds = r.u16(); d.leds = []; for (let i = 0; i < nLeds; i++) d.leds.push({ name: r.str(), value: r.u32() });
  const nColors = r.u16(); d.colors = []; for (let i = 0; i < nColors; i++) d.colors.push(r.color());
  // each zone's first LED (zones list their LEDs in order)
  let start = 0; for (const z of d.zones) { z.start = start; start += z.ledsCount; }
  return d;
}

/* ------------------------------------------------------------------ the connection */
class Client {
  constructor() { this.sock = null; this.buf = Buffer.alloc(0); this.waiting = []; this.proto = 0; this.onListChanged = null; }
  connect(timeout = 2500) {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: '127.0.0.1', port: PORT });
      const t = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, timeout);
      s.once('connect', () => { clearTimeout(t); this.sock = s; resolve(); });
      s.once('error', (e) => { clearTimeout(t); reject(e); });
      s.on('data', (d) => this.onData(d));
      s.on('close', () => { this.sock = null; for (const w of this.waiting.splice(0)) w.reject(new Error('OpenRGB closed the connection')); });
    });
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 16) {
      if (this.buf.toString('latin1', 0, 4) !== 'ORGB') { this.buf = Buffer.alloc(0); return; }   // out of step: drop it
      const dev = this.buf.readUInt32LE(4), id = this.buf.readUInt32LE(8), size = this.buf.readUInt32LE(12);
      if (this.buf.length < 16 + size) return;
      const data = this.buf.subarray(16, 16 + size);
      this.buf = this.buf.subarray(16 + size);
      if (id === PKT.DEVICE_LIST_UPDATED) { this.onListChanged?.(); continue; }
      const i = this.waiting.findIndex((w) => w.id === id && (w.dev === dev || w.anyDev));
      if (i >= 0) { const [w] = this.waiting.splice(i, 1); clearTimeout(w.t); w.resolve(data); }
    }
  }
  send(id, dev = 0, data = Buffer.alloc(0)) {
    if (!this.sock) throw new Error('Not connected to OpenRGB');
    const h = Buffer.alloc(16); h.write('ORGB', 0, 'latin1'); h.writeUInt32LE(dev, 4); h.writeUInt32LE(id, 8); h.writeUInt32LE(data.length, 12);
    this.sock.write(Buffer.concat([h, data]));
  }
  request(id, dev = 0, data, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const w = { id, dev, resolve, reject, anyDev: id === PKT.PROTOCOL_VERSION || id === PKT.CONTROLLER_COUNT || id === PKT.PROFILE_LIST };
      w.t = setTimeout(() => { const i = this.waiting.indexOf(w); if (i >= 0) this.waiting.splice(i, 1); reject(new Error('OpenRGB didn’t answer')); }, timeout);
      this.waiting.push(w);
      try { this.send(id, dev, data); } catch (e) { clearTimeout(w.t); this.waiting.splice(this.waiting.indexOf(w), 1); reject(e); }
    });
  }
  async hello() {
    // the protocol version: the lower of ours and the server's (very old servers don't answer: version 0)
    let server = 0;
    try { server = (await this.request(PKT.PROTOCOL_VERSION, 0, new Writer().u32(CLIENT_PROTOCOL).done(), 1500)).readUInt32LE(0); } catch { server = 0; }
    this.proto = Math.min(server, CLIENT_PROTOCOL);
    this.send(PKT.SET_CLIENT_NAME, 0, Buffer.from('LiquidDesktop\0'));
  }
  async devices() {
    const count = (await this.request(PKT.CONTROLLER_COUNT)).readUInt32LE(0);
    const out = [];
    for (let i = 0; i < count; i++) {
      const data = await this.request(PKT.CONTROLLER_DATA, i, this.proto >= 1 ? new Writer().u32(this.proto).done() : Buffer.alloc(0));
      try { out.push({ index: i, ...parseController(data, this.proto) }); } catch (e) { console.warn('[openrgb] device', i, e.message); }
    }
    return out;
  }
}

/* ------------------------------------------------------------------ the server and state */
let client = null, server = null, devices = [], connecting = null, lastError = '';
const which = (b) => (process.env.PATH || '/usr/bin:/bin').split(':').some((d) => { try { fs.accessSync(path.join(d, b), fs.constants.X_OK); return true; } catch { return false; } });
const broadcast = (ch, ...a) => { for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.getType() !== 'webview') wc.send(ch, ...a); };

async function tryConnect() {
  const c = new Client();
  await c.connect();
  await c.hello();
  c.onListChanged = () => refresh().catch(() => {});
  client = c;
  c.sock.on('close', () => { if (client === c) { client = null; broadcast('rgb:changed'); } });
  return c;
}
// connected to OpenRGB's server, starting it if it isn't running (headless: no OpenRGB window)
async function ensure() {
  if (client?.sock) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    try { return await tryConnect(); } catch { /* not running */ }
    if (!which('openrgb')) throw Object.assign(new Error('OpenRGB isn’t installed'), { code: 'missing' });
    if (!server) {
      server = spawn('openrgb', ['--server', '--server-port', String(PORT)], { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
      server.stderr.on('data', (d) => { const t = String(d).trim(); if (t) lastError = t.split('\n').pop(); });
      server.on('exit', (code) => { server = null; if (code) console.warn('[openrgb] server exited', code, lastError); broadcast('rgb:changed'); });
    }
    // it scans the hardware first (a few seconds); the port opens once it's listening
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try { return await tryConnect(); } catch { if (!server) break; }
    }
    throw new Error(lastError || 'OpenRGB’s server didn’t start');
  })();
  try { return await connecting; } finally { connecting = null; }
}
async function refresh() {
  const c = await ensure();
  devices = await c.devices();
  broadcast('rgb:changed');
  return devices;
}

/* ------------------------------------------------------------------ actions */
const dev = (i) => { const d = devices.find((x) => x.index === i); if (!d) throw new Error('That device isn’t connected any more'); return d; };
const clampColor = (c) => ({ r: Math.max(0, Math.min(255, Math.round(c?.r || 0))), g: Math.max(0, Math.min(255, Math.round(c?.g || 0))), b: Math.max(0, Math.min(255, Math.round(c?.b || 0))) });

// every LED (or one zone) to these colors: a device's "Direct"/"Static" style control
async function setColors(index, colors, zone = null) {
  const c = await ensure(), d = dev(index);
  const list = colors.map(clampColor);
  if (zone == null) {
    const all = d.leds.map((_, i) => list[i % list.length] || list[0]);
    const w = new Writer().u32(0).colors(all).done(); w.writeUInt32LE(w.length, 0);
    c.send(PKT.UPDATE_LEDS, index, w);
    d.colors = all;
  } else {
    const z = d.zones[zone]; if (!z) throw new Error('Unknown zone');
    const zl = Array.from({ length: z.ledsCount }, (_, i) => list[i % list.length] || list[0]);
    const w = new Writer().u32(0).u32(zone).colors(zl).done(); w.writeUInt32LE(w.length, 0);
    c.send(PKT.UPDATE_ZONE_LEDS, index, w);
    d.colors.splice(z.start, z.ledsCount, ...zl);
  }
  return true;
}
// an effect, with its settings (speed, brightness, direction, colors)
async function setMode(index, modeIdx, patch = {}) {
  const c = await ensure(), d = dev(index), m = d.modes[modeIdx];
  if (!m) throw new Error('Unknown effect');
  const next = { ...m };
  if (patch.speed != null && (m.flags & F.SPEED)) next.speed = Math.round(patch.speed);
  if (patch.brightness != null && (m.flags & F.BRIGHTNESS)) next.brightness = Math.round(patch.brightness);
  if (patch.direction != null) next.direction = patch.direction | 0;
  if (patch.colorMode != null) next.colorMode = patch.colorMode | 0;
  if (Array.isArray(patch.colors) && (m.flags & F.MODE_COLOR)) {
    const n = Math.max(m.colorsMin || 0, Math.min(m.colorsMax || patch.colors.length, patch.colors.length));
    next.colors = Array.from({ length: n }, (_, i) => clampColor(patch.colors[i % patch.colors.length]));
  }
  const w = new Writer().u32(0).i32(modeIdx); writeMode(w, next, c.proto);
  const buf = w.done(); buf.writeUInt32LE(buf.length, 0);
  c.send(PKT.UPDATE_MODE, index, buf);
  d.modes[modeIdx] = next; d.activeMode = modeIdx;
  return true;
}
// "Direct"/"Custom" control, so per-LED colors take effect
async function customMode(index) { const c = await ensure(); c.send(PKT.SET_CUSTOM_MODE, index); return true; }
// keep the current effect in the device itself (where it can), so it survives a restart
async function saveMode(index) {
  const c = await ensure(), d = dev(index), m = d.modes[d.activeMode];
  if (!m || !(m.flags & F.MANUAL_SAVE)) return false;
  const w = new Writer().u32(0).i32(d.activeMode); writeMode(w, m, c.proto);
  const buf = w.done(); buf.writeUInt32LE(buf.length, 0);
  c.send(PKT.SAVE_MODE, index, buf);
  return true;
}

async function status() {
  // an OpenRGB server that's already running counts too (the Flatpak or AppImage, started by the user)
  try { await ensure(); } catch (e) { return e.code === 'missing' ? { installed: false } : { installed: true, running: false, error: e.message }; }
  if (!devices.length) await refresh().catch(() => {});
  return { installed: true, running: true, protocol: client?.proto ?? 0, devices };
}

// installs OpenRGB, and what it needs for motherboard / RAM lighting (the i2c-dev module, loaded now and at boot)
function install() {
  const { sudoScript } = require('./appstore');
  return sudoScript(`set -e
pacman -S --needed --noconfirm openrgb i2c-tools
modprobe i2c-dev || true
echo i2c-dev > /etc/modules-load.d/liquid-desktop-i2c-dev.conf
udevadm control --reload-rules && udevadm trigger || true`).then((r) => {
    if (!r.ok) throw new Error(/password/i.test(r.out) ? 'Your password wasn’t accepted.' : r.out.split('\n').pop() || 'OpenRGB couldn’t be installed.');
    return status();
  });
}

function register() {
  const h = (n, fn) => ipcMain.handle(n, async (_e, ...a) => { try { return await fn(...a); } catch (e) { return { __error: e.message } } });
  h('rgb:status', () => status());
  h('rgb:refresh', () => refresh());
  h('rgb:setColors', (i, colors, zone) => setColors(i | 0, Array.isArray(colors) ? colors : [colors], zone == null ? null : zone | 0));
  h('rgb:setMode', (i, m, patch) => setMode(i | 0, m | 0, patch || {}));
  h('rgb:customMode', (i) => customMode(i | 0));
  h('rgb:saveMode', (i) => saveMode(i | 0));
  h('rgb:install', () => install());
  require('electron').app.on('before-quit', () => { try { client?.sock?.destroy(); } catch { /* gone */ } if (server) server.kill(); });
}

module.exports = { register, Client, parseController, writeMode, Writer, Reader, F, PKT };
