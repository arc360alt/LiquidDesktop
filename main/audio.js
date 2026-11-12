// Sound devices for Settings › Sound and Control Center: outputs (speakers, headphones…) and inputs
// (microphones), each with its volume, and which one is in use. Uses pactl, which works with both
// PipeWire (through pipewire-pulse) and PulseAudio.
const { execFile } = require('child_process');

const pactl = (args, timeout = 3000) => new Promise((res) => execFile('pactl', args, { timeout, maxBuffer: 8 << 20 }, (err, out) => res(err ? null : out)));
const pct = (vol) => {
  const ch = Object.values(vol || {}).map((c) => parseInt(c.value_percent, 10)).filter((n) => !Number.isNaN(n));
  return ch.length ? Math.round(ch.reduce((a, b) => a + b, 0) / ch.length) : 0;
};
const kindOf = (p = {}, name = '', input = false) => {
  const icon = p['device.icon_name'] || '', form = p['device.form_factor'] || '', bus = p['device.bus'] || '';
  if (bus === 'bluetooth' || /bluez/.test(name)) return /headset|headphone/.test(form + icon) || !form ? 'headphones' : 'bluetooth';
  if (/headphone|headset/.test(form + icon)) return 'headphones';
  if (/hdmi|displayport/i.test(name + (p['device.profile.name'] || ''))) return 'display';
  if (/usb/.test(bus)) return form === 'webcam' || /webcam/i.test(p['device.description'] || '') ? 'camera' : input ? 'mic' : 'speaker';
  if (/microphone|webcam/.test(form)) return 'mic';
  return input ? 'mic' : 'speaker';
};

async function list(type) {   // type: 'sinks' (outputs) or 'sources' (inputs)
  const [raw, def] = await Promise.all([pactl(['-f', 'json', 'list', type]), pactl([type === 'sinks' ? 'get-default-sink' : 'get-default-source'])]);
  if (!raw) return null;
  let items;
  try { items = JSON.parse(raw); } catch { return null; }
  const current = (def || '').trim();
  return items
    // monitors are "what's playing" taps of outputs, not microphones
    .filter((d) => type === 'sinks' || (!d.monitor_of_sink || d.monitor_of_sink === 'n/a') && !/\.monitor$/.test(d.name))
    .map((d) => ({
      name: d.name, label: d.description || d.properties?.['device.description'] || d.name,
      volume: pct(d.volume), muted: !!d.mute, default: d.name === current,
      kind: kindOf(d.properties, d.name, type === 'sources'), state: d.state,
    }))
    .sort((a, b) => (b.default - a.default) || a.label.localeCompare(b.label));
}

async function devices() {
  const [outputs, inputs] = await Promise.all([list('sinks'), list('sources')]);
  if (!outputs && !inputs) return { available: false };
  return { available: true, outputs: outputs || [], inputs: inputs || [] };
}

async function setDefault(kind, name) {
  const sink = kind === 'output';
  await pactl([sink ? 'set-default-sink' : 'set-default-source', name]);
  // move what's already playing / recording over (PipeWire usually does this itself; PulseAudio doesn't)
  const streams = await pactl(['list', 'short', sink ? 'sink-inputs' : 'source-outputs']);
  for (const line of (streams || '').split('\n')) {
    const id = line.split('\t')[0];
    if (/^\d+$/.test(id)) await pactl([sink ? 'move-sink-input' : 'move-source-output', id, name]);
  }
  return true;
}
const setVolume = (kind, name, v) => pactl([kind === 'output' ? 'set-sink-volume' : 'set-source-volume', name, `${Math.max(0, Math.min(150, Math.round(v)))}%`]).then((r) => r !== null);
const setMute = (kind, name, m) => pactl([kind === 'output' ? 'set-sink-mute' : 'set-source-mute', name, m ? '1' : '0']).then((r) => r !== null);

function register(ipcMain) {
  const h = (n, fn) => ipcMain.handle(n, async (_e, ...a) => { try { return await fn(...a); } catch (e) { return { __error: e.message }; } });
  h('audio:devices', () => devices());
  h('audio:setDefault', (kind, name) => setDefault(String(kind), String(name)));
  h('audio:setVolume', (kind, name, v) => setVolume(String(kind), String(name), Number(v)));
  h('audio:setMute', (kind, name, m) => setMute(String(kind), String(name), !!m));
}

module.exports = { register, devices };
