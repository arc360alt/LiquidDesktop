// Lighting: RGB devices (motherboard, RAM, graphics card, keyboard, mouse, fans, LED strips…) through OpenRGB's
// server (main/openrgb.js). Pick a device (or All Devices), an effect it supports, colors, speed, brightness.
// Changes go to the hardware as you make them.
import { h, $$ } from '../util.js';
import { registerApp } from '../wm.js';
import { sym } from '../icons.js';
import { api } from '../sys.js';
import { store } from '../store.js';
import { alertDialog, prompt } from '../menus.js';

const F = { SPEED: 1, DIR_LR: 2, DIR_UD: 4, DIR_HV: 8, BRIGHTNESS: 16, PER_LED: 32, MODE_COLOR: 64, RANDOM: 128, MANUAL_SAVE: 256 };
const S = (d) => `<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const KIND_ICONS = {
  motherboard: S('<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/><path d="M8 3.5v-1M12 3.5v-1M16 3.5v-1M8 21.5v-1M12 21.5v-1M16 21.5v-1"/>'),
  dram: S('<rect x="2.5" y="7" width="19" height="9" rx="1.2"/><path d="M6 10v3M9 10v3M12 10v3M15 10v3M18 10v3M5 16v2M19 16v2"/>'),
  gpu: S('<rect x="2.5" y="6" width="19" height="11" rx="2"/><circle cx="9" cy="11.5" r="3"/><circle cx="16.5" cy="11.5" r="2"/><path d="M5 17v2"/>'),
  cooler: S('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.8"/><path d="M12 10.2c0-3 1.5-5 4-5M13.8 12c3 0 5 1.5 5 4M12 13.8c0 3-1.5 5-4 5M10.2 12c-3 0-5-1.5-5-4"/>'),
  ledstrip: S('<path d="M3 15c3-6 6 0 9-6s6 0 9-6"/><circle cx="5" cy="12.5" r="1"/><circle cx="12" cy="9" r="1"/><circle cx="19" cy="5" r="1"/>'),
  keyboard: S('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  mouse: S('<rect x="6" y="2.5" width="12" height="19" rx="6"/><path d="M12 6.5v3.5"/>'),
  mousemat: S('<rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M2.5 15h19"/>'),
  headset: S('<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="7" rx="1.8"/><rect x="16.5" y="14" width="4.5" height="7" rx="1.8"/>'),
  light: S('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z"/>'),
  speaker: S('<rect x="6" y="2.5" width="12" height="19" rx="3"/><circle cx="12" cy="14.5" r="3.4"/>'),
  case: S('<rect x="6" y="2.5" width="12" height="19" rx="1.5"/><circle cx="12" cy="15" r="2.5"/><path d="M9 6h6"/>'),
  gamepad: S('<path d="M7 7h10a5 5 0 0 1 4.8 6.3l-1 3.6a2.6 2.6 0 0 1-4.4 1.1L14 15.5h-4L7.6 18a2.6 2.6 0 0 1-4.4-1.1l-1-3.6A5 5 0 0 1 7 7z"/>'),
};
const kindIcon = (k) => KIND_ICONS[k] || KIND_ICONS[{ headsetstand: 'headset', storage: 'case', accessory: 'light', microphone: 'headset', keypad: 'keyboard' }[k]] || KIND_ICONS.light;
const KIND_NAMES = { motherboard: 'Motherboard', dram: 'Memory', gpu: 'Graphics card', cooler: 'Cooler', ledstrip: 'LED strip', keyboard: 'Keyboard', mouse: 'Mouse', mousemat: 'Mouse pad', headset: 'Headset', light: 'Light', speaker: 'Speaker', case: 'Case' };

/* ------------------------------------------------------------------ colors */
const toHex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const fromHex = (s) => { const m = /^#?([0-9a-f]{6})$/i.exec(s.trim()); if (!m) return null; const n = parseInt(m[1], 16); return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 }; };
function hsv(hh, s, v) {
  const f = (n) => { const k = (n + hh / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return { r: Math.round(f(5) * 255), g: Math.round(f(3) * 255), b: Math.round(f(1) * 255) };
}
function toHsv({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hh = 0;
  if (d) hh = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (hh + 360) % 360, s: max ? d / max : 0, v: max };
}
const PRESETS = ['#ffffff', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#0a84ff', '#5e5ce6', '#bf5af2', '#ff2d92'];

// A glass color picker: saturation/brightness square, hue slider, preset swatches and a hex field.
function colorPicker(initial, onChange) {
  let c = toHsv(initial);
  const square = h('div.lt-sq'), knob = h('i.lt-sq-knob'), hue = h('input.lt-hue', { type: 'range', min: 0, max: 359, value: Math.round(c.h) });
  const hex = h('input.field.lt-hex', { value: toHex(initial), spellcheck: false });
  square.append(knob);
  const paint = (emit) => {
    const rgb = hsv(c.h, c.s, c.v);
    square.style.setProperty('--hue', `hsl(${c.h} 100% 50%)`);
    knob.style.left = c.s * 100 + '%'; knob.style.top = (1 - c.v) * 100 + '%'; knob.style.background = toHex(rgb);
    hue.value = Math.round(c.h);
    if (document.activeElement !== hex) hex.value = toHex(rgb);
    $$('.lt-swatch', box).forEach((s) => s.classList.toggle('on', s.dataset.hex === toHex(rgb)));
    if (emit) onChange(rgb);
  };
  square.addEventListener('pointerdown', (e) => {
    square.setPointerCapture(e.pointerId);
    const move = (ev) => { const r = square.getBoundingClientRect(); c.s = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)); c.v = Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height)); paint(true); };
    move(e);
    square.onpointermove = move;
    square.onpointerup = () => { square.onpointermove = null; };
  });
  hue.addEventListener('input', () => { c.h = +hue.value; if (c.s < 0.05) c.s = 1; if (c.v < 0.05) c.v = 1; paint(true); });
  hex.addEventListener('change', () => { const rgb = fromHex(hex.value); if (rgb) { c = toHsv(rgb); paint(true); } });
  const swatches = h('div.lt-swatches', ...PRESETS.map((p) => h('button.lt-swatch', { 'data-hex': p, style: { background: p }, title: p, onclick: () => { c = toHsv(fromHex(p)); paint(true); } })));
  const box = h('div.lt-picker', square, hue, h('div.lt-picker-row', swatches, hex));
  box.set = (rgb) => { c = toHsv(rgb); paint(false); };
  paint(false);
  return box;
}

/* ------------------------------------------------------------------ the app */
registerApp({
  id: 'lighting', name: 'Lighting', size: [980, 660], minSize: [760, 520], overlayContent: true, hideTitle: true, className: 'lt-win',
  keywords: ['rgb', 'openrgb', 'leds', 'keyboard lights', 'fans', 'color'],
  open(win) {
    const side = h('div.sidebar.lt-side'), main = h('div.lt-main');
    win.body.append(h('div.lt', side, main));
    win.dragRegion(side);
    let st = null, sel = store.get('lightingSel') ?? 'all', color = fromHex(store.get('lightingColor') || '#0a84ff'), zone = null;
    const devices = () => st?.devices || [];
    const device = () => (sel === 'all' ? null : devices().find((d) => d.index === sel));
    const ok = (p) => p.catch((e) => alertDialog({ title: 'The lighting couldn’t be changed', message: e.message }, win.el));
    // sending as you drag: at most every 60ms, and the last value always goes out
    const throttle = (fn) => { let t = null, last = null; return (...a) => { last = a; if (t) return; t = setTimeout(() => { t = null; fn(...last); }, 60); fn(...a); last = null; }; };

    async function load(refresh) {
      main.replaceChildren(h('div.lt-empty', h('span.lt-spin'), h('small.muted', 'Looking for RGB devices…')));
      try { st = refresh ? { ...(await api.rgb.status()), devices: await api.rgb.refresh() } : await api.rgb.status(); } catch (e) { st = { installed: true, running: false, error: e.message }; }
      draw();
    }

    function drawSide() {
      const item = (key, icon, name, sub, dots) => h('div.sb-item.lt-dev' + (sel === key ? '.sel' : ''), { onclick: () => { sel = key; zone = null; store.set('lightingSel', key); draw(); } },
        h('span.lt-dev-ic', { html: icon }), h('div.lt-dev-t', h('span', name), sub ? h('small', sub) : null), dots);
      const swatch = (d) => {
        const cs = (d.colors || []).filter((_, i) => i % Math.max(1, Math.floor((d.colors.length || 1) / 4)) === 0).slice(0, 4);
        return h('span.lt-dev-dots', ...cs.map((c) => h('i', { style: { background: toHex(c) } })));
      };
      side.replaceChildren(h('div.sb-sec', 'Lighting'),
        item('all', S('<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>'), 'All Devices', `${devices().length} device${devices().length === 1 ? '' : 's'}`),
        h('div.sb-sec', 'Devices'),
        ...devices().map((d) => item(d.index, kindIcon(d.kind), d.name, KIND_NAMES[d.kind] || d.vendor || '', swatch(d))),
        h('div.spacer'),
        h('button.btn.lt-rescan', { onclick: () => load(true) }, 'Rescan Devices'));
    }

    function draw() {
      drawSide();
      if (!st?.installed) { main.replaceChildren(setupView()); return; }
      if (!st.running) {
        main.replaceChildren(h('div.lt-empty', h('div.lt-big-ic', { html: KIND_ICONS.light }), h('b', 'OpenRGB isn’t responding'), h('small.muted', st.error || ''),
          h('button.btn.primary', { onclick: () => load(true) }, 'Try Again')));
        return;
      }
      if (!devices().length) {
        main.replaceChildren(h('div.lt-empty', h('div.lt-big-ic', { html: KIND_ICONS.light }), h('b', 'No RGB devices found'),
          h('small.muted', 'Motherboard and memory lighting needs the i2c-dev module (set up when OpenRGB was installed here) and sometimes a restart. Some devices need their maker’s app closed first.'),
          h('button.btn', { onclick: () => load(true) }, 'Rescan')));
        return;
      }
      main.replaceChildren(sel === 'all' || !device() ? allView() : deviceView(device()));
    }

    /* ---- not installed */
    function setupView() {
      return h('div.lt-empty.lt-setup', h('div.lt-big-ic', { html: KIND_ICONS.light }), h('h2', 'Lighting'),
        h('p.muted', 'Control the RGB lights in your computer and accessories: motherboard, memory, graphics card, fans, keyboard, mouse and LED strips. Lighting uses OpenRGB in the background to talk to the hardware.'),
        h('button.btn.primary', { onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = 'Installing…';
          if (!(await askSudo())) { e.target.disabled = false; e.target.textContent = 'Install OpenRGB'; return; }
          try { await api.rgb.install(); await load(true); } catch (err) { alertDialog({ title: 'OpenRGB couldn’t be installed', message: err.message }, win.el); e.target.disabled = false; e.target.textContent = 'Install OpenRGB'; }
        } }, 'Install OpenRGB'), h('small.muted', 'Needs your password. Installs OpenRGB and turns on access to motherboard and memory lighting (i2c).'));
    }
    async function askSudo() {
      if (!(await api.sddm.sudoStatus()).needed) return true;
      for (let i = 0; i < 3; i++) {
        const pw = await prompt('Enter your password', '', { type: 'password', ok: 'Install', message: 'Installing OpenRGB needs administrator rights (sudo).' }, win.el);
        if (pw == null) return false;
        if (await api.sddm.sudoCheck(pw)) return true;
        await alertDialog({ title: 'Incorrect password', message: 'Try again.' }, win.el);
      }
      return false;
    }

    /* ---- the LEDs, laid out like the device: a key grid, a strip, single lights */
    function preview(d) {
      const box = h('div.lt-preview');
      const mode = d.modes[d.activeMode];
      const live = !mode || (mode.flags & F.PER_LED);   // per-LED colors are what's shown; effects run on the device
      const led = (i, big) => {
        const c = d.colors[i] || { r: 0, g: 0, b: 0 }, hex = toHex(c), dark = c.r + c.g + c.b < 30;
        return h('i.lt-led' + (big ? '.big' : '') + (dark ? '.off' : ''), { style: '--c:' + hex, title: d.leds[i]?.name || '' });
      };
      for (const [zi, z] of d.zones.entries()) {
        const zoneBox = h('div.lt-zone' + (zone === zi ? '.sel' : ''), { onclick: () => { zone = zone === zi ? null : zi; draw(); } }, h('small', z.name));
        if (z.matrix && z.matrix.width) {
          const grid = h('div.lt-grid', { style: { gridTemplateColumns: `repeat(${z.matrix.width}, 1fr)`, maxWidth: z.matrix.width * 24 + 'px' } });
          for (const v of z.matrix.map) grid.append(v === 0xffffffff ? h('i.lt-led.none') : led(z.start + v));
          zoneBox.append(grid);
        } else {
          const row = h('div.lt-row');
          for (let i = 0; i < z.ledsCount; i++) row.append(led(z.start + i, z.ledsCount <= 4));
          zoneBox.append(row);
        }
        box.append(zoneBox);
      }
      if (!live) box.append(h('div.lt-effect-note', `${mode.name} runs on the device itself`));
      return box;
    }

    // OpenRGB's "Direct" is per-LED control: shown as Custom
    const label = (m) => (/^direct$/i.test(m.name) ? 'Custom' : m.name);

    /* ---- one device */
    function deviceView(d) {
      const modeIdx = d.activeMode, mode = d.modes[modeIdx];
      const isPerLed = mode && (mode.flags & F.PER_LED);
      const chips = h('div.lt-modes', ...d.modes.map((m, i) => h('button.lt-mode' + (i === modeIdx ? '.on' : ''), { onclick: () => ok(api.rgb.setMode(d.index, i, {}).then(() => { d.activeMode = i; if (m.flags & F.PER_LED) return api.rgb.setColors(d.index, [color], zone); }).then(() => draw())) }, label(m))));
      const controls = h('div.lt-controls');
      // colors: the LEDs themselves (Custom/Static), or the effect's own colors
      if (isPerLed) {
        const send = throttle((c) => ok(api.rgb.setColors(d.index, [c], zone)));
        controls.append(h('div.lt-ctl', h('div.lt-ctl-t', h('b', zone == null ? 'Color' : `Color · ${d.zones[zone].name}`), h('small.muted', zone == null ? 'Click a zone above to color only that part' : 'Click the zone again to color the whole device')),
          colorPicker(color, (c) => { color = c; store.set('lightingColor', toHex(c)); d.colors = d.colors.map((x, i) => (zone == null || (i >= d.zones[zone].start && i < d.zones[zone].start + d.zones[zone].ledsCount) ? c : x)); send(c); refreshPreview(d); })));
      } else if (mode && (mode.flags & F.MODE_COLOR) && mode.colorsMax > 0) {
        const n = Math.max(1, Math.min(mode.colorsMax, Math.max(mode.colors.length, mode.colorsMin || 1)));
        const cols = Array.from({ length: n }, (_, i) => mode.colors[i] || color);
        let slot = 0;
        const send = throttle(() => ok(api.rgb.setMode(d.index, modeIdx, { colors: cols, colorMode: 2 })));
        const slots = h('div.lt-slots');
        const drawSlots = () => slots.replaceChildren(...cols.map((c, i) => h('button.lt-slot' + (i === slot ? '.on' : ''), { style: { background: toHex(c) }, onclick: () => { slot = i; picker.set(cols[i]); drawSlots(); } })));
        const picker = colorPicker(cols[0], (c) => { cols[slot] = c; color = c; mode.colors = cols.slice(); drawSlots(); send(); });
        drawSlots();
        controls.append(h('div.lt-ctl', h('div.lt-ctl-t', h('b', n > 1 ? 'Colors' : 'Color'), mode.flags & F.RANDOM ? h('button.btn.lt-mini', { onclick: () => ok(api.rgb.setMode(d.index, modeIdx, { colorMode: 3 })) }, 'Random') : null), n > 1 ? slots : null, picker));
      }
      // speed / brightness (some devices count down: min above max)
      const range = (title, min, max, value, key) => {
        const lo = Math.min(min, max), hi = Math.max(min, max), inv = min > max;
        const s = h('input.slider', { type: 'range', min: lo, max: hi, value: inv ? lo + hi - value : value });
        const pv = () => s.style.setProperty('--v', ((s.value - lo) / ((hi - lo) || 1)) * 100 + '%');
        const send = throttle(() => ok(api.rgb.setMode(d.index, modeIdx, { [key]: inv ? lo + hi - +s.value : +s.value })));
        s.addEventListener('input', () => { pv(); send(); });
        pv();
        return h('div.lt-ctl.lt-range', h('b', title), s);
      };
      if (mode && (mode.flags & F.SPEED) && mode.speedMin !== mode.speedMax) controls.append(range('Speed', mode.speedMin, mode.speedMax, mode.speed, 'speed'));
      if (mode && (mode.flags & F.BRIGHTNESS) && mode.brightnessMin !== mode.brightnessMax) controls.append(range('Brightness', mode.brightnessMin, mode.brightnessMax, mode.brightness, 'brightness'));
      // direction
      const dirs = [];
      if (mode?.flags & F.DIR_LR) dirs.push([0, 'Left'], [1, 'Right']);
      if (mode?.flags & F.DIR_UD) dirs.push([2, 'Up'], [3, 'Down']);
      if (mode?.flags & F.DIR_HV) dirs.push([4, 'Horizontal'], [5, 'Vertical']);
      if (dirs.length) controls.append(h('div.lt-ctl', h('b', 'Direction'), h('div.segmented', ...dirs.map(([v, l]) => h('button' + (mode.direction === v ? '.on' : ''), { onclick: () => ok(api.rgb.setMode(d.index, modeIdx, { direction: v })).then(() => draw()) }, l)))));
      if (!controls.childElementCount) controls.append(h('small.muted.lt-none', `${mode?.name || 'This effect'} has no settings.`));

      return h('div.lt-dev-view',
        h('div.lt-head', h('span.lt-head-ic', { html: kindIcon(d.kind) }), h('div', h('h2', d.name), h('small.muted', [KIND_NAMES[d.kind], d.vendor && d.vendor !== d.name ? d.vendor : null, `${d.leds.length} LED${d.leds.length === 1 ? '' : 's'}`].filter(Boolean).join(' · '))),
          h('div.spacer'),
          mode && (mode.flags & F.MANUAL_SAVE) ? h('button.btn', { title: 'Keep this lighting in the device, so it stays after a restart', onclick: () => ok(api.rgb.saveMode(d.index)).then(() => alertDialog({ title: 'Saved to the device', message: `${d.name} keeps this lighting even when the computer restarts.` }, win.el)) }, 'Save to Device') : null,
          h('button.btn', { onclick: () => turnOff([d]) }, 'Turn Off')),
        preview(d),
        h('div.lt-sec', 'Effect'), chips,
        controls);
    }
    function refreshPreview(d) { const old = main.querySelector('.lt-preview'); if (old) old.replaceWith(preview(d)); }

    /* ---- every device at once: one color, or off */
    const directMode = (d) => {
      const by = (re) => d.modes.findIndex((m) => re.test(m.name) && (m.flags & F.PER_LED));
      const i = [by(/^direct$/i), by(/^static$/i), by(/custom/i), d.modes.findIndex((m) => m.flags & F.PER_LED)].find((x) => x >= 0);
      return i ?? -1;
    };
    async function colorAll(c, list = devices()) {
      for (const d of list) {
        const i = directMode(d);
        if (i >= 0 && d.activeMode !== i) { await api.rgb.setMode(d.index, i, {}); d.activeMode = i; }
        if (i >= 0) { await api.rgb.setColors(d.index, [c]); d.colors = d.colors.map(() => c); continue; }
        // no per-LED control: the first effect with its own color ("Static" on many devices)
        const m = d.modes.findIndex((x) => /static|steady|solid/i.test(x.name) && (x.flags & F.MODE_COLOR));
        if (m >= 0) { await api.rgb.setMode(d.index, m, { colors: [c], colorMode: 2 }); d.activeMode = m; }
      }
    }
    const turnOff = (list) => ok((async () => {
      for (const d of list) {
        const off = d.modes.findIndex((m) => /^off$/i.test(m.name));
        if (off >= 0) { await api.rgb.setMode(d.index, off, {}); d.activeMode = off; d.colors = d.colors.map(() => ({ r: 0, g: 0, b: 0 })); } else await colorAll({ r: 0, g: 0, b: 0 }, [d]);
      }
      draw();
    })());
    function allView() {
      const cards = () => h('div.lt-all-grid', ...devices().map((d) => h('button.lt-all-dev', { onclick: () => { sel = d.index; store.set('lightingSel', d.index); draw(); } },
        h('span.lt-head-ic', { html: kindIcon(d.kind) }), h('b', d.name), h('small.muted', d.modes[d.activeMode] ? label(d.modes[d.activeMode]) : ''),
        h('span.lt-dev-dots', ...(d.colors || []).slice(0, 6).map((c) => h('i', { style: { background: toHex(c) } }))))));
      let grid = cards();
      const send = throttle((c) => ok(colorAll(c).then(() => { drawSide(); const g = cards(); grid.replaceWith(g); grid = g; })));
      return h('div.lt-dev-view',
        h('div.lt-head', h('span.lt-head-ic', { html: S('<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>') }),
          h('div', h('h2', 'All Devices'), h('small.muted', 'One color on everything, in sync')), h('div.spacer'),
          h('button.btn', { onclick: () => turnOff(devices()) }, 'Turn All Off')),
        grid,
        h('div.lt-controls', h('div.lt-ctl', h('b', 'Color for every device'), colorPicker(color, (c) => { color = c; store.set('lightingColor', toHex(c)); send(c); }))));
    }

    api.rgb.onChanged?.(() => { if (win.el.isConnected) api.rgb.status().then((s) => { st = s; if (!main.querySelector('.lt-sq:active')) draw(); }).catch(() => {}); });
    load(false);
  },
});
