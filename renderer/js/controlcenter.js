// Control Center: connectivity, Now Playing, Focus, display & sound sliders, quick toggles.
import { h, $, bus, clamp } from './util.js';
import { sym } from './icons.js';
import { store } from './store.js';
import { status } from './status.js';
import { api } from './sys.js';
import { attachLens, theme } from './theme.js';
import { shell } from './shell.js';
import { prompt, showMenu } from './menus.js';
import { DEV_ICONS, btIcon, onBluetooth } from './devices.js';
import { wm } from './wm.js';
import { allControls, setCfg, cfg, sizeOf, SIZE_NAMES } from './ccwidgets.js';
import { validate, saveCustom, customWidgets, isCC } from './customwidget.js';
import { catalog } from './catalog.js';
import { appIcon } from './icons.js';
import { phoneState, mainPhone, onPhone, deviceIcon, signalBars, PHONE_ICONS, phoneAct, sendFiles, browsePhone, has } from './phone.js';

// which controls Control Center shows, in order (Edit Controls); the built-in ones can always be added back
// (macOS Tahoe's Control Center: every control its own piece of glass — capsules for Wi-Fi, Bluetooth and
// Focus, round buttons for one-tap controls, wide slider cards, Now Playing as a big square)
const BUILTIN = [['wifi', 'Wi-Fi'], ['bluetooth', 'Bluetooth'], ['airplane', 'Airplane Mode'], ['np', 'Now Playing'], ['focus', 'Focus'], ['dark', 'Dark Mode'], ['shot', 'Screenshot'],
  ['bright', 'Display'], ['sound', 'Sound'], ['ns', 'Night Shift'], ['lock', 'Lock'], ['mission', 'Desktops'], ['rec', 'Record'], ['battery', 'Battery'], ['phone', 'Phone']];
// (Battery and Phone aren't in it: they're in Edit Controls for whoever wants them)
const DEFAULT_LAYOUT = ['wifi', 'np', 'bluetooth', 'airplane', 'dark', 'shot', 'focus', 'ns', 'lock', 'bright', 'sound', 'mission', 'rec'];
// layouts saved before Tahoe's layout had one "Connectivity" block: it's the three capsules now
const layout = () => { const l = store.get('ccLayout'); return Array.isArray(l) ? l.flatMap((id) => (id === 'conn' ? ['wifi', 'bluetooth', 'airplane'].filter((x) => !l.includes(x)) : [id])) : DEFAULT_LAYOUT; };
let editing = false;

// panel: the glass box (stays still); grid: what's in it, which scrolls (so the glass rim and blur don't scroll away)
let panel = null, grid = null, mediaTimer = null, offStatus = null;
// Edit Controls: the controls you can add, in their own glass panel beside Control Center (like the Mac's)
let addPanel = null, addKids = null;
// recording the screen right now (main/recorder.js): the Record button turns into Stop
let recording = false;
api.rec?.status?.().then((r) => { recording = !!r?.recording; }).catch(() => {});
api.rec?.onChanged?.((r) => { recording = !!r?.recording; });

function slider(icon, value, onInput, onCommit, hiIcon) {
  // Tahoe: a thin track between a small and a big icon; the knob appears when you touch it and turns into a glass
  // lens while you drag. The fill and the track have the same round ends, so nothing pokes out at any value.
  const fill = h('div.fill');
  const knob = h('i.knob');
  const track = h('div.track', fill, knob);
  const lo = h('span.lo', { html: icon });
  const el = h('div.cc-slider', lo, track, hiIcon ? h('span.hi', { html: hiIcon }) : null);
  const set = (v) => { fill.style.width = v + '%'; knob.style.left = v + '%'; };
  set(value ?? 50);
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = track.getBoundingClientRect();
    const at = (ev) => clamp(Math.round(((ev.clientX - r.left) / r.width) * 100), 0, 100);
    const mv = (ev) => { const v = at(ev); set(v); onInput(v); };
    el.classList.add('dragging'); knob.classList.add('glass');
    const up = (ev) => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); el.classList.remove('dragging'); knob.classList.remove('glass'); onCommit?.(at(ev)); set(at(ev)); };
    mv(e);
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  });
  // the scroll wheel nudges it, like the Mac's
  el.addEventListener('wheel', (e) => { e.preventDefault(); const cur = parseFloat(fill.style.width) || 0; const v = clamp(Math.round(cur - Math.sign(e.deltaY) * 5), 0, 100); set(v); onInput(v); onCommit?.(v); }, { passive: false });
  el.set = set;
  el.setIcon = (html) => { lo.innerHTML = html; };
  return el;
}

/** A Tahoe capsule: a round icon button (toggles), and its name and state (opens the details). */
function capsule(icon, title, sub, on, onToggle, onOpen) {
  const circ = h('div.circ', { html: icon });
  const el = h('div.cc-mod.span2.cc-cap' + (on ? '.on' : ''), circ, h('div.t', h('b', title), sub != null ? h('small', sub) : null));
  circ.addEventListener('click', (e) => { e.stopPropagation(); onToggle(el); });
  el.addEventListener('click', () => (onOpen ? onOpen() : onToggle(el)));
  return el;
}

function softwareBrightness(v) {
  // when the backlight can't be driven (desktop monitor, VM, no brightnessctl) dim the shell instead
  $('#desktop').style.filter = v >= 100 ? '' : `brightness(${0.35 + 0.65 * (v / 100)})`;
}

function mainView() {
  const s = status.s;
  const wifi = s.wifi, bt = s.bluetooth;
  const wifiOn = !!(wifi && wifi.enabled);
  const flip = (el) => { const on = !el.classList.contains('on'); el.classList.toggle('on', on); return on; };
  const wifiCap = capsule(sym.wifi, 'Wi-Fi', wifi ? (wifi.enabled ? wifi.ssid || (wifi.wired ? 'Ethernet' : 'Not Connected') : 'Off') : 'Unavailable', wifiOn,
    async (el) => { await api.sys.wifiPower(flip(el)); status.refresh(); }, () => render('wifi'));
  const btCap = capsule(sym.bluetooth, 'Bluetooth', bt ? (bt.powered ? 'On' : 'Off') : 'Unavailable', !!bt?.powered,
    async (el) => { await api.sys.bluetoothPower(flip(el)); status.refresh(); }, () => render('bluetooth'));
  const airCap = capsule(sym.airplane, 'Airplane Mode', store.get('airplane') ? 'On' : 'Off', !!store.get('airplane'),
    async (el) => { const on = flip(el); store.set('airplane', on); el.querySelector('small').textContent = on ? 'On' : 'Off'; await api.sys.airplane(on); status.refresh(); });

  const np = h('div.cc-mod.span2.row2.cc-npmod', h('div.cc-np', h('div.art', { html: sym.music }), h('div.meta', h('b', 'Not Playing'), h('span', 'Music'))),
    h('div.cc-np-ctrl',
      h('button', { html: sym.prev, onclick: () => api.sys.mediaCmd('previous').then(updateMedia) }),
      h('button.pp', { html: sym.play, onclick: () => api.sys.mediaCmd('play-pause').then(() => setTimeout(updateMedia, 300)) }),
      h('button', { html: sym.next, onclick: () => api.sys.mediaCmd('next').then(() => setTimeout(updateMedia, 300)) })));
  np.id = 'cc-np';

  const dnd = store.get('dnd');
  const focus = capsule(sym.moon, 'Focus', dnd ? 'Do Not Disturb' : null, dnd, () => { store.set('dnd', !store.get('dnd')); render(); });
  focus.classList.add('cc-focus');

  // a round one-tap button (its name shows on hover, like the Mac's)
  const sq = (icon, label, on, fn) => { const el = h('div.cc-mod.cc-sq' + (on ? '.on' : ''), { title: label }, h('span.cc-ic', { html: icon }), h('span.cc-lbl', label)); el.addEventListener('click', fn); return el; };
  const dark = sq(sym.contrast, theme.dark ? 'Dark' : 'Light', theme.dark, () => { store.set('theme', theme.dark ? 'light' : 'dark'); render(); });
  const shot = sq(sym.camera, 'Screenshot', false, () => { close(); setTimeout(() => shell.screenshot(), 350); });

  const brightnessVal = s.brightness ?? store.get('softBrightness') ?? 100;
  const bright = h('div.cc-mod.span4.cc-slider-mod', h('h4', 'Display'),
    slider(sym.sunDim, brightnessVal, (v) => {
      if (status.s.brightness != null) api.sys.setBrightness(v); else { store.set('softBrightness', v); softwareBrightness(v); }
    }, (v) => { if (status.s.brightness != null) status.patch({ brightness: v }); }, sym.sun));
  bright.querySelector('h4').addEventListener('click', () => render('display'));

  const vol = s.volume;
  const sound = h('div.cc-mod.span4.cc-slider-mod', h('h4', 'Sound'),
    h('div.cc-slider-row',
      slider(vol?.muted ? sym.speakerMute : sym.speakerLow, vol?.level ?? 50, (v) => { api.sys.setVolume(v); if (vol?.muted) api.sys.setMute(false); },
        (v) => status.patch({ volume: { level: v, muted: false } }), sym.speaker),
      api.audio?.devices ? h('button.cc-more', { title: 'Sound devices', html: sym.chevronRight, onclick: (e) => { e.stopPropagation(); render('sound'); } }) : null));
  sound.querySelector('h4').addEventListener('click', () => render('sound'));

  const ns = sq(sym.nightshift, 'Night Shift', store.get('nightShift'), () => { store.set('nightShift', !store.get('nightShift')); render(); });
  const lockB = sq(sym.lock, 'Lock', false, () => { close(); shell.lock(); });
  const mission = sq(sym.layers, 'Desktops', false, () => { close(); shell.mission(); });
  // Record: the screenshot tool in Record mode (pick an area, a window or the screen); Stop while recording
  const rec = sq(sym.record, recording ? 'Stop' : 'Record', recording, () => { close(); if (recording) api.rec.stop(); else setTimeout(() => shell.screenRecord(), 350); });
  if (recording) rec.classList.add('cc-rec');

  const batt = s.battery;
  const extra = batt && batt.percent != null ? h('div.cc-mod.span4.cc-pill', h('div.circ', { html: sym.bolt, style: { width: '32px', height: '32px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: batt.charging ? '#34c759' : 'rgba(128,128,128,.28)', color: batt.charging ? '#fff' : 'inherit' } }),
    h('div.t', { style: { fontSize: '12.5px', fontWeight: 600 } }, `Battery ${batt.percent}%`, h('small', { style: { display: 'block', fontWeight: 400, opacity: 0.6, fontSize: '11px' } }, batt.status || '')),
    h('div.spacer'), h('div', { style: { width: '90px', height: '8px', borderRadius: '4px', background: 'rgba(128,128,128,.3)', overflow: 'hidden' } },
      h('div', { style: { width: batt.percent + '%', height: '100%', background: batt.percent < 20 ? '#ff3b30' : '#34c759' } }))) : null;

  const builtins = { wifi: wifiCap, bluetooth: btCap, airplane: airCap, np, focus, dark, shot, bright, sound, ns, lock: lockB, mission, rec, battery: extra, phone: phoneModule() };
  const ctx = { sq, close, render: (v) => render(v), shell, wm, layout };
  const controls = allControls();
  const make = (id) => {
    if (id in builtins) return builtins[id];
    // a control that can be added more than once has instances "id#2", "id#3"… (each with its own options)
    const x = controls.find((c) => c.id === id.split('#')[0]);
    try { return x ? x.build(ctx, id) : null; } catch { return null; }
  };
  const ids = layout();
  const out = [];
  for (const id of ids) {
    const el = make(id);
    if (!el) continue;
    // right-click: the control's options (which app it opens, what the weather shows…)
    const x = controls.find((c) => c.id === id.split('#')[0]);
    // right-click: Size (controls that come in more than one), then the control's own options
    const items = () => [...(x?.sizes?.length > 1 ? [{ header: 'Size' }, ...x.sizes.map((z) => ({ label: SIZE_NAMES[z], checked: sizeOf(x, id) === z, action: () => { setCfg(id, { size: z }); render(); } }))] : []),
      ...(x?.menu ? [x.sizes?.length > 1 ? '-' : null, ...x.menu(ctx, id)] : [])].filter(Boolean);
    if (x && (x.menu || x.sizes?.length > 1)) el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showMenu(items(), e.clientX, e.clientY); });
    if (editing) {
      el.classList.add('cc-editing');
      // while editing, a control does nothing except get removed
      el.dataset.cc = id;
      for (const t of ['click', 'mousedown']) el.addEventListener(t, (e) => { if (!e.target.closest('.cc-remove')) { e.stopPropagation(); e.preventDefault(); } }, true);
      el.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest('.cc-remove')) dragControl(el, e); }, true);
      el.append(h('button.cc-remove', { title: 'Remove', html: sym.minus, onclick: (e) => { e.stopPropagation(); store.set('ccLayout', layout().filter((x) => x !== id)); render(); } }));
    }
    out.push(el);
  }
  if (!editing) {
    out.push(h('div.cc-edit-row', h('button.cc-edit-btn', { onclick: (e) => { e.stopPropagation(); editing = true; render(); } }, 'Edit Controls')));
    return out;
  }
  // edit mode: everything not shown yet, drawn as it would be in Control Center (built-in ones first, so a
  // removed one is easy to get back); click one to add it
  const all = [...BUILTIN.map(([id, name]) => ({ id, name })), ...controls.filter((c) => !c.hidden)];
  // not shown yet, or (multi) another one can still be added
  const missing = all.filter((c) => (c.multi ? c.canAdd?.(ids) ?? true : !ids.includes(c.id)));
  const addId = (c) => {
    if (!c.multi || !ids.includes(c.id)) return c.id;
    let n = 2;
    while (ids.includes(`${c.id}#${n}`)) n++;
    return `${c.id}#${n}`;
  };
  const side = [];
  side.push(h('div.cc-add-head.span4', h('b', 'Add Controls'), h('div.cc-add-btns',
    // your own Control Center widgets: make one in Widget Creator, or import a .ldwidget someone shared
    h('button.btn', { title: 'Make a Control Center widget in Widget Creator', onclick: (e) => { e.stopPropagation(); close(); wm.open('widgetcreator', { target: 'cc' }); } }, 'Create…'),
    h('button.btn', { onclick: (e) => { e.stopPropagation(); importControl(); } }, 'Import…'))));
  for (const c of missing) {
    const el = make(addId(c));   // drawn as the one that would be added
    if (!el) continue;
    el.classList.add('cc-preview');
    el.title = 'Add ' + c.name;
    for (const t of ['click', 'mousedown']) el.addEventListener(t, (e) => { e.stopPropagation(); e.preventDefault(); if (t === 'click') { const nid = addId(c); c.onAdd?.(nid, ids); store.set('ccLayout', [...layout(), nid]); render(c.pickOnAdd ? 'pick:' + nid : undefined); } }, true);
    el.append(h('span.cc-add-badge', { html: sym.plus }));
    if (c.custom) el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showMenu(c.menu(ctx, c.id), e.clientX, e.clientY); });
    // its name under it, like the Mac's gallery (the cell takes the control's size in the grid)
    const cell = h('div.cc-add-cell', el, h('small', c.name));
    for (const k of ['span2', 'span4', 'row2']) if (el.classList.contains(k)) cell.classList.add(k);
    side.push(cell);
  }
  if (!missing.length) side.push(h('small.muted.span4.cc-add-none', 'Everything is already in Control Center.'));
  side.push(h('div.cc-edit-row', h('button.cc-reset', { onclick: (e) => { e.stopPropagation(); store.set('ccLayout', null); render(); } }, 'Reset to Default')));
  addKids = side;
  // Control Center itself keeps a Done button where Edit Controls was
  out.push(h('div.cc-edit-row', h('button.cc-edit-btn.cc-done', { onclick: (e) => { e.stopPropagation(); editing = false; render(); } }, 'Done')));
  return out;
}

async function wifiView() {
  const s = status.s.wifi;
  const list = h('div.cc-list', h('div.cc-list-item', { style: { opacity: 0.6 } }, 'Scanning…'));
  const t = h('label.toggle', h('input', { type: 'checkbox', checked: !!s?.enabled, onchange: async (e) => { await api.sys.wifiPower(e.target.checked); status.refresh(); setTimeout(() => render('wifi'), 1500); } }), h('span'));
  const mod = h('div.cc-mod.cc-detail', h('h3', h('button.cc-back', { html: sym.chevronLeft, onclick: () => render() }), 'Wi-Fi', t), list);
  api.sys.wifiList().then((nets) => {
    list.innerHTML = '';
    if (!nets.length) list.append(h('div.cc-list-item', { style: { opacity: 0.6 } }, s?.enabled ? 'No networks found' : 'Wi-Fi is off'));
    for (const n of nets) {
      const row = h('div.cc-list-item' + (n.active ? '.active' : ''), h('div.circ', { html: sym.wifi }), h('span.spacer.ellipsis', n.ssid),
        n.secure ? h('span', { html: sym.lock, style: { width: '13px', opacity: 0.5 } }) : null, h('small', { style: { opacity: 0.5, width: '30px', textAlign: 'right' } }, n.signal + '%'));
      row.addEventListener('click', async () => {
        if (n.active) return;
        row.style.opacity = 0.5;
        let r = await api.sys.wifiConnect(n.ssid);
        if (r && !r.ok && n.secure) {
          const pw = await prompt(`Enter the password for “${n.ssid}”`, '', { type: 'password', ok: 'Join' });
          if (pw) r = await api.sys.wifiConnect(n.ssid, pw);
        }
        if (r && !r.ok) shell.notify({ app: 'settings', title: 'Wi-Fi', body: `Could not join “${n.ssid}”.` });
        status.refresh(); render('wifi');
      });
      list.append(row);
    }
  }).catch(() => { list.innerHTML = ''; list.append(h('div.cc-list-item', 'Wi-Fi control unavailable')); });
  return [mod];
}

// Bluetooth: your devices, click one to connect or disconnect it
async function bluetoothView() {
  const st = await api.bt?.state().catch(() => null);
  const list = h('div.cc-list');
  const t = h('label.toggle', h('input', { type: 'checkbox', checked: !!st?.powered, disabled: !st?.available, onchange: async (e) => { await api.sys.bluetoothPower(e.target.checked); status.refresh(); setTimeout(() => render('bluetooth'), 600); } }), h('span'));
  const mod = h('div.cc-mod.cc-detail', h('h3', h('button.cc-back', { html: sym.chevronLeft, onclick: () => render() }), 'Bluetooth', t), list);
  const draw = (st) => {
    list.innerHTML = '';
    const mine = (st?.devices || []).filter((d) => d.paired);
    if (!st?.available) list.append(h('div.cc-list-item', { style: { opacity: 0.6 } }, 'Bluetooth isn’t available'));
    else if (!st.powered) list.append(h('div.cc-list-item', { style: { opacity: 0.6 } }, 'Bluetooth is off'));
    else if (!mine.length) list.append(h('div.cc-list-item', { style: { opacity: 0.6 } }, 'No devices yet'));
    if (st?.powered) for (const d of mine) {
      const item = h('div.cc-list-item' + (d.connected ? '.active' : ''), h('div.circ' + (d.connected ? '.on' : ''), { html: btIcon(d.icon) }),
        h('span.spacer.ellipsis', d.name), h('small', { style: { opacity: 0.55 } }, d.battery != null ? d.battery + '%' : d.connected ? 'Connected' : ''));
      item.addEventListener('click', async () => {
        item.style.opacity = 0.5; item.querySelector('small').textContent = d.connected ? 'Disconnecting…' : 'Connecting…';
        const r = await api.bt.connect(d.path, !d.connected).catch((e) => ({ ok: false, error: e.message }));
        if (r && r.ok === false) shell.notify({ app: 'settings', title: 'Bluetooth', body: `Couldn’t connect to “${d.name}”. ${r.error || ''}` });
        draw(await api.bt.state().catch(() => st)); status.refresh();
      });
      list.append(item);
    }
    list.append(h('div.cc-list-item', { onclick: () => { close(); shell.openSettings('bluetooth'); } }, 'Bluetooth Settings…'));
  };
  draw(st);
  onBluetooth(list, async () => draw(await api.bt.state().catch(() => null)));
  return [mod];
}

// Sound: the volume, then where sound plays (and which microphone), click one to switch to it
async function soundView() {
  const vol = status.s.volume;
  const d = await api.audio?.devices().catch(() => null);
  const outs = h('div.cc-list'), ins = h('div.cc-list');
  const devItem = (kind, x) => {
    const it = h('div.cc-list-item' + (x.default ? '.active' : ''), h('div.circ' + (x.default ? '.on' : ''), { html: DEV_ICONS[x.kind] || DEV_ICONS.speaker }),
      h('span.spacer.ellipsis', x.label), x.default ? h('span', { html: sym.check, style: { width: '14px', display: 'flex' } }) : null);
    it.addEventListener('click', async () => {
      if (x.default) return;
      await api.audio.setDefault(kind, x.name).catch(() => {});
      await status.refresh(); render('sound');
    });
    return it;
  };
  for (const x of d?.outputs || []) outs.append(devItem('output', x));
  for (const x of d?.inputs || []) ins.append(devItem('input', x));
  if (!d?.available) outs.append(h('div.cc-list-item', { style: { opacity: 0.6 } }, 'No sound devices found'));
  const mod = h('div.cc-mod.cc-detail', h('h3', h('button.cc-back', { html: sym.chevronLeft, onclick: () => render() }), 'Sound'),
    h('div.cc-detail-slider', slider(vol?.muted ? sym.speakerMute : sym.speakerLow, vol?.level ?? 50, (v) => { api.sys.setVolume(v); if (vol?.muted) api.sys.setMute(false); },
      (v) => status.patch({ volume: { level: v, muted: false } }), sym.speaker)),
    h('h5.cc-sub', 'Output'), outs,
    d?.inputs?.length ? h('h5.cc-sub', 'Input') : null, d?.inputs?.length ? ins : null,
    h('div.cc-list', h('div.cc-list-item', { onclick: () => { close(); shell.openSettings('sound'); } }, 'Sound Settings…')));
  return [mod];
}

function displayView() {
  const mod = h('div.cc-mod.cc-detail', h('h3', h('button.cc-back', { html: sym.chevronLeft, onclick: () => render() }), 'Display'),
    h('div.cc-list',
      row('Dark Mode', theme.dark, (v) => store.set('theme', v ? 'dark' : 'light')),
      row('Night Shift', store.get('nightShift'), (v) => store.set('nightShift', v)),
      row('Dynamic Wallpaper', store.get('dynamicWallpaper'), (v) => store.set('dynamicWallpaper', v)),
      row('Glass Refraction', store.get('refraction'), (v) => store.set('refraction', v)),
      h('div.cc-list-item', { onclick: () => { close(); shell.openSettings('display'); } }, 'Display Settings…')));
  return [mod];
  function row(label, on, fn) {
    return h('div.cc-list-item', h('span.spacer', label), h('label.toggle', h('input', { type: 'checkbox', checked: on, onchange: (e) => fn(e.target.checked) }), h('span')));
  }
}

// Phone (KDE Connect): name, battery and signal; Find rings it; click for the details. Not shown without a phone.
function phoneModule() {
  const d = mainPhone();
  if (!d) return editing ? h('div.cc-mod.span4.cc-pill.cc-phone', h('div.circ.ph-circ', { html: PHONE_ICONS.phone }), h('div.t', h('b', 'Phone'), h('small', 'Pair a phone in Settings'))) : null;
  const b = d.battery;
  const sub = !d.reachable ? 'Not Connected' : [b ? `${b.percent}%${b.charging ? ' ⚡︎' : ''}` : 'Connected', d.media?.playing ? '♪ ' + d.media.title : null].filter(Boolean).join(' · ');
  const ring = has(d, 'findmyphone') && d.reachable ? h('button.cc-more.ph-find', { title: 'Play a sound on ' + d.name, html: PHONE_ICONS.ring, onclick: (e) => { e.stopPropagation(); phoneAct(d, 'ring', null, shell.notify); } }) : null;
  const el = h('div.cc-mod.span4.cc-pill.cc-phone' + (d.reachable ? '.on' : ''), h('div.circ.ph-circ', { html: deviceIcon(d) }),
    h('div.t', h('b', d.name), h('small', sub)), h('div.spacer'), d.signal ? signalBars(d.signal) : null,
    b ? h('div.ph-batt-bar', h('i', { style: { width: b.percent + '%', background: b.percent <= 20 && !b.charging ? '#ff3b30' : '#34c759' } })) : null, ring);
  el.addEventListener('click', () => render('phone'));
  return el;
}

function phoneView() {
  const d = mainPhone();
  const back = h('button.cc-back', { html: sym.chevronLeft, onclick: () => render() });
  if (!d) return [h('div.cc-mod.cc-detail', h('h3', back, 'Phone'), h('div.cc-list', h('div.cc-list-item', { onclick: () => { close(); shell.openSettings('phone'); } }, 'Phone Settings…')))];
  const ok = (p) => d.reachable && has(d, p);
  const item = (icon, label, enabled, fn) => h('div.cc-list-item' + (enabled ? '' : '.disabled'), { onclick: () => enabled && fn() }, h('div.circ', { html: icon }), h('span.spacer', label));
  const files = (path) => wm.open('files', { path });
  const m = d.media;
  const media = m && (m.title || m.players?.length) ? h('div.cc-phone-media', h('div.cc-np',
    h('div.art', m.art ? { style: { backgroundImage: `url("${m.art}")` } } : { html: sym.music }),
    h('div.meta', h('b', m.title || 'Not Playing'), h('span', [m.artist, m.player].filter(Boolean).join(' — ')))),
  h('div.cc-np-ctrl',
    h('button', { html: sym.prev, onclick: () => phoneAct(d, 'media', 'Previous') }),
    h('button.pp', { html: m.playing ? sym.pause : sym.play, onclick: () => phoneAct(d, 'media', 'PlayPause') }),
    h('button', { html: sym.next, onclick: () => phoneAct(d, 'media', 'Next') }))) : null;
  const notifs = (d.notifications || []).slice(0, 6);
  const head = h('div.cc-phone-head', h('div.circ.ph-circ' + (d.reachable ? '.on' : ''), { html: deviceIcon(d) }),
    h('div.t', h('b', d.name), h('small', !d.reachable ? 'Not Connected' : d.battery ? `Battery ${d.battery.percent}%${d.battery.charging ? ', charging' : ''}` : 'Connected')),
    h('div.spacer'), d.signal ? signalBars(d.signal) : null);
  return [h('div.cc-mod.cc-detail.cc-phone-detail', h('h3', back, 'Phone'), head, media,
    h('div.cc-list',
      item(PHONE_ICONS.ring, 'Find My Phone', ok('findmyphone'), () => phoneAct(d, 'ring', null, shell.notify)),
      item(PHONE_ICONS.clipboard, 'Send Clipboard', ok('clipboard'), () => phoneAct(d, 'clipboard', null, shell.notify).then((r) => r && shell.notify({ app: 'settings', title: d.name, body: 'Clipboard sent.' }))),
      item(PHONE_ICONS.send, 'Send Files…', ok('share'), () => { close(); sendFiles(d, shell.notify); }),
      item(PHONE_ICONS.folder, 'Browse Files', ok('sftp'), () => { close(); browsePhone(d, shell.notify, files); }),
      item(sym.compose, 'Messages', d.supported.includes('sms') || has(d, 'sms'), () => { close(); wm.activate('messages'); }),
      item(PHONE_ICONS.phone, 'Open Phone', true, () => { close(); wm.activate('phone'); })),
    notifs.length ? h('h5.cc-sub', 'Notifications') : null,
    notifs.length ? h('div.cc-list.cc-phone-notifs', ...notifs.map((n) => h('div.cc-list-item.cc-phone-notif',
      n.icon ? h('img.ph-nic', { src: n.icon }) : h('div.circ', { html: sym.bell }),
      h('div.spacer.ph-ntext', h('b', n.title || n.app), h('small', n.text)),
      n.dismissable ? h('button.cc-back.ph-dismiss', { title: 'Dismiss', html: sym.close, onclick: (e) => { e.stopPropagation(); phoneAct(d, 'dismiss', n.id); e.currentTarget.closest('.cc-list-item').remove(); } }) : null))) : null,
    h('div.cc-list', h('div.cc-list-item', { onclick: () => { close(); shell.openSettings('phone'); } }, 'Phone Settings…')))];
}

// Edit Controls: drag a control to move it. The others make way as you go; the order is saved on release.
function dragControl(el, e) {
  const sx = e.clientX, sy = e.clientY;
  const r0 = el.getBoundingClientRect(), gx = sx - r0.left, gy = sy - r0.top;
  let moving = false;
  const place = (ev) => {
    el.style.transform = '';
    const r = el.getBoundingClientRect();
    el.style.transform = `translate(${ev.clientX - gx - r.left}px, ${ev.clientY - gy - r.top}px) scale(1.04)`;
  };
  const mv = (ev) => {
    if (!moving && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
    if (!moving) { moving = true; el.classList.add('cc-dragging'); }
    // the control under the pointer (not the one being dragged): take its place
    const over = document.elementsFromPoint(ev.clientX, ev.clientY).map((x) => x.closest?.('[data-cc]')).find((x) => x && x !== el);
    if (over && over.parentNode === el.parentNode) {
      const kids = [...el.parentNode.children];
      el.parentNode.insertBefore(el, kids.indexOf(el) < kids.indexOf(over) ? over.nextSibling : over);
    }
    place(ev);
  };
  const up = () => {
    removeEventListener('mousemove', mv, true); removeEventListener('mouseup', up, true);
    el.classList.remove('cc-dragging'); el.style.transform = '';
    if (!moving) return;
    const order = [...el.parentNode.querySelectorAll('[data-cc]')].map((x) => x.dataset.cc);
    store.set('ccLayout', [...order, ...layout().filter((id) => !order.includes(id))]);
    render();
  };
  addEventListener('mousemove', mv, true); addEventListener('mouseup', up, true);
}

// Import… in Add Controls: a .ldwidget file. A desktop-sized one is made Control Center-sized (it's drawn in
// percentages, so it fits).
async function importControl() {
  const files = await api.dialog?.open({ title: 'Import Widget', filters: [{ name: 'LiquidDesktop widgets', patterns: ['*.ldwidget', '*.json'] }] }).catch(() => null);
  if (!files?.length) return;
  try {
    const spec = validate(await api.fs.read(files[0]));
    if (!isCC(spec)) spec.size = { s: 'cs', m: 'cw', l: 'cl' }[spec.size] || 'cs';
    if (customWidgets()[spec.id]) spec.id = spec.id + Math.random().toString(36).slice(2, 5);
    saveCustom(spec);
    store.set('ccLayout', [...layout(), 'custom:' + spec.id]);
    render();
  } catch (err) { shell.notify({ app: 'widgetcreator', title: 'Couldn’t import the widget', body: err.message }); }
}

// Choose App… for an app button: every app, with a search field
function pickView(id) {
  const list = h('div.cc-list.cc-pick-list');
  const search = h('input.field.cc-pick-search', { placeholder: 'Search apps', oninput: () => fill() });
  const apps = catalog.all().filter((a) => a.name).sort((a, b) => a.name.localeCompare(b.name));
  const fill = () => {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = '';
    for (const a of apps.filter((x) => !q || x.name.toLowerCase().includes(q)).slice(0, 200)) {
      list.append(h('div.cc-list-item.cc-pick-item', { onclick: (e) => { e.stopPropagation(); setCfg(id, { app: a.id }); render(); } }, appIcon(a, 'cc-app-ic'), a.name));
    }
  };
  fill();
  setTimeout(() => search.focus(), 50);
  return [h('div.cc-mod.span4.cc-pick', h('div.cc-add-head', h('b', 'Choose App'), h('button.btn', { onclick: (e) => { e.stopPropagation(); render(); } }, 'Cancel')), search, list)];
}

async function render(view) {
  if (!panel) return;
  if (view?.startsWith?.('pick:')) { grid.innerHTML = ''; grid.append(...pickView(view.slice(5))); panel.dataset.view = view; panel.scrollTop = 0; return; }
  const kids = view === 'wifi' ? await wifiView() : view === 'bluetooth' ? await bluetoothView() : view === 'sound' ? await soundView() : view === 'display' ? displayView() : view === 'phone' ? phoneView() : mainView();
  // it's rebuilt whenever the status changes (volume, battery…): keep the scroll position
  const top = panel.dataset.view === (view || '') ? panel.scrollTop : 0;
  grid.innerHTML = '';
  const shown = kids.filter(Boolean);
  // the controls fly in once, as Control Center opens — not again whenever it's redrawn (the status changes often,
  // and replaying it mid-way is what flickered)
  if (!panel.dataset.shown) { panel.dataset.shown = '1'; shown.forEach((el, i) => { el.classList.add('cc-in'); el.style.setProperty('--i', Math.min(i, 8)); }); }
  grid.append(...shown);
  sideRender(editing && !view);
  panel.scrollTop = top;
  panel.dataset.view = view || '';
  if (!view) updateMedia();
}

async function updateMedia() {
  const el = $('#cc-np');
  if (!el) return;
  let m = null;
  try { m = await api.sys.media(); } catch { /* playerctl unavailable */ }
  const art = el.querySelector('.art'), meta = el.querySelector('.meta'), pp = el.querySelector('.pp');
  if (m && m.title) {
    meta.innerHTML = '';
    meta.append(h('b', m.title), h('span', m.artist || m.player || ''));
    if (m.art) { art.style.backgroundImage = `url("${m.art}")`; art.innerHTML = ''; }
    pp.innerHTML = m.status === 'Playing' ? sym.pause : sym.play;
  }
}

function sideRender(show) {
  if (!show || !addKids) { if (addPanel) { const p = addPanel; addPanel = null; p.classList.add('closing'); setTimeout(() => p.remove(), 180); } addKids = null; return; }
  if (!addPanel) {
    // the glass (and its rim) stays put; what's inside scrolls (a rim on a scrolling box scrolls away with it)
    addPanel = h('div.cc-addpanel.cc-tahoe.glass.panel.sheen', h('div.cc-add-scroll', h('div.cc-grid')));
    addPanel.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.append(addPanel);
  }
  const sc = addPanel.firstChild, g = sc.firstChild, top = sc.scrollTop;
  g.replaceChildren(...addKids);
  sc.scrollTop = top;
}

export function toggleControlCenter(view) {
  if (panel) { close(); return; }
  // only one of the two at a time: Notification Center (the clock) closes when Control Center opens
  if (document.querySelector('#nc.open')) import('./notifications.js').then((m) => m.toggleNotificationCenter(false));
  grid = h('div.cc-grid');
  // no box around it: each control is its own glass (Tahoe)
  panel = h('div.cc.cc-tahoe', grid);
  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  document.body.append(panel);
  render(view === 'wifi' ? 'wifi' : undefined);
  status.refresh();
  offStatus = bus.on('status', () => { if (panel && !panel.dataset.view && !panel.matches(':active')) render(); });
  // the phone's battery, music or notifications changed: redraw the main view or the Phone view
  onPhone(panel, () => { if (panel && ['', 'phone'].includes(panel.dataset.view) && !panel.matches(':active') && !editing) render(panel.dataset.view || undefined); });
  mediaTimer = setInterval(updateMedia, 3000);
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
}
function outside(e) { if (panel && !panel.contains(e.target) && !addPanel?.contains(e.target) && !e.target.closest('.global-alert-layer') && !e.target.closest('.menu')) close(); }
export function closeControlCenter() { if (panel) close(); }
function close() {
  editing = false;
  if (!panel) return;
  const p = panel; panel = null;
  sideRender(false);
  p.classList.add('closing');
  setTimeout(() => p.remove(), 200);
  clearInterval(mediaTimer); offStatus?.();
  document.removeEventListener('mousedown', outside);
}

export function initControlCenter() {
  const v = store.get('softBrightness');
  if (v != null && v < 100) softwareBrightness(v);
}
