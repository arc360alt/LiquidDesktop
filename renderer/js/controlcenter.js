// Control Center: connectivity, Now Playing, Focus, display & sound sliders, quick toggles.
import { h, $, bus, clamp } from './util.js';
import { sym } from './icons.js';
import { store } from './store.js';
import { status } from './status.js';
import { api } from './sys.js';
import { attachLens, theme } from './theme.js';
import { shell } from './shell.js';
import { prompt } from './menus.js';

let panel = null, mediaTimer = null, offStatus = null;

function slider(icon, value, onInput, onCommit) {
  const fill = h('div.fill');
  const knob = h('i.knob');
  const el = h('div.cc-slider', h('span', { html: icon }), fill, knob);
  // while dragging, the fill stops at the knob's centre so the glass knob shows the edge through it
  const set = (v) => { const w = `calc(${v}% + ${30 * (1 - v / 100)}px)`; fill.style.width = el.classList.contains('dragging') ? `calc(${w} - 15px)` : w; knob.style.left = w; };
  set(value ?? 50);
  el.addEventListener('mousedown', (e) => {
    const r = el.getBoundingClientRect();
    const at = (ev) => clamp(Math.round(((ev.clientX - r.left - 15) / (r.width - 30)) * 100), 0, 100);
    const mv = (ev) => { const v = at(ev); set(v); onInput(v); };
    // while held, the knob is glass (in a session the compositor blurs behind anything marked .glass)
    el.classList.add('dragging'); knob.classList.add('glass');
    fill.style.borderRadius = '999px';
    const up = (ev) => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); el.classList.remove('dragging'); knob.classList.remove('glass'); onCommit?.(at(ev)); set(at(ev)); };
    mv(e);
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  });
  el.set = set;
  return el;
}

function tog(icon, title, sub, on, onclick) {
  const el = h('div.cc-tog' + (on ? '.on' : ''), h('div.circ', { html: icon }), h('div.t', title, sub != null ? h('small', sub) : null));
  el.querySelector('.circ').addEventListener('click', (e) => { e.stopPropagation(); onclick(el); });
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
  const conn = h('div.cc-mod.span2.row2.cc-conn',
    tog(sym.wifi, 'Wi-Fi', wifi ? (wifi.enabled ? wifi.ssid || (wifi.wired ? 'Ethernet' : 'Not Connected') : 'Off') : 'Unavailable', wifiOn, async (el) => {
      const on = !el.classList.contains('on');
      el.classList.toggle('on', on);
      await api.sys.wifiPower(on); status.refresh();
    }),
    tog(sym.bluetooth, 'Bluetooth', bt ? (bt.powered ? 'On' : 'Off') : 'Unavailable', !!bt?.powered, async (el) => {
      const on = !el.classList.contains('on');
      el.classList.toggle('on', on);
      await api.sys.bluetoothPower(on); status.refresh();
    }),
    tog(sym.airplane, 'Airplane Mode', null, !!store.get('airplane'), async (el) => {
      const on = !el.classList.contains('on');
      el.classList.toggle('on', on);
      store.set('airplane', on);
      await api.sys.airplane(on); status.refresh();
    }));
  conn.querySelector('.cc-tog .t').addEventListener('click', () => render('wifi'));

  const np = h('div.cc-mod.span2.row2', h('div.cc-np', h('div.art', { html: sym.music }), h('div.meta', h('b', 'Not Playing'), h('span', 'Music'))),
    h('div.cc-np-ctrl',
      h('button', { html: sym.prev, onclick: () => api.sys.mediaCmd('previous').then(updateMedia) }),
      h('button.pp', { html: sym.play, onclick: () => api.sys.mediaCmd('play-pause').then(() => setTimeout(updateMedia, 300)) }),
      h('button', { html: sym.next, onclick: () => api.sys.mediaCmd('next').then(() => setTimeout(updateMedia, 300)) })));
  np.id = 'cc-np';

  const dnd = store.get('dnd');
  const focus = h('div.cc-mod.span2.cc-pill' + (dnd ? '.on' : ''), { style: dnd ? { background: 'rgba(94,92,230,.9)', color: '#fff' } : {} },
    h('div.cc-tog' + (dnd ? '.on' : ''), h('div.circ', { html: sym.moon, style: dnd ? { background: '#fff', color: '#5e5ce6' } : {} }), h('div.t', 'Focus', h('small', dnd ? 'Do Not Disturb' : 'Off'))));
  focus.addEventListener('click', () => { store.set('dnd', !store.get('dnd')); render(); });

  const sq = (icon, label, on, fn) => { const el = h('div.cc-mod.cc-sq' + (on ? '.on' : ''), h('span', { html: icon }), label); el.addEventListener('click', fn); return el; };
  const dark = sq(sym.contrast, theme.dark ? 'Dark' : 'Light', theme.dark, () => { store.set('theme', theme.dark ? 'light' : 'dark'); render(); });
  const shot = sq(sym.camera, 'Screenshot', false, () => { close(); setTimeout(() => shell.screenshot(), 350); });

  const brightnessVal = s.brightness ?? store.get('softBrightness') ?? 100;
  const bright = h('div.cc-mod.span4.cc-slider-mod', h('h4', 'Display'),
    slider(sym.sunDim, brightnessVal, (v) => {
      if (status.s.brightness != null) api.sys.setBrightness(v); else { store.set('softBrightness', v); softwareBrightness(v); }
    }, (v) => { if (status.s.brightness != null) status.patch({ brightness: v }); }));
  bright.querySelector('h4').addEventListener('click', () => render('display'));

  const vol = s.volume;
  const sound = h('div.cc-mod.span4.cc-slider-mod', h('h4', 'Sound'),
    slider(vol?.muted ? sym.speakerMute : sym.speaker, vol?.level ?? 50, (v) => { api.sys.setVolume(v); if (vol?.muted) api.sys.setMute(false); },
      (v) => status.patch({ volume: { level: v, muted: false } })));

  const ns = sq(sym.nightshift, 'Night Shift', store.get('nightShift'), () => { store.set('nightShift', !store.get('nightShift')); render(); });
  const lockB = sq(sym.lock, 'Lock', false, () => { close(); shell.lock(); });
  const mission = sq(sym.layers, 'Desktops', false, () => { close(); shell.mission(); });
  const widgets = sq(sym.widgets, 'Widgets', false, () => { close(); shell.editWidgets(); });

  const batt = s.battery;
  const extra = batt && batt.percent != null ? h('div.cc-mod.span4.cc-pill', h('div.circ', { html: sym.bolt, style: { width: '32px', height: '32px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: batt.charging ? '#34c759' : 'rgba(128,128,128,.28)', color: batt.charging ? '#fff' : 'inherit' } }),
    h('div.t', { style: { fontSize: '12.5px', fontWeight: 600 } }, `Battery ${batt.percent}%`, h('small', { style: { display: 'block', fontWeight: 400, opacity: 0.6, fontSize: '11px' } }, batt.status || '')),
    h('div.spacer'), h('div', { style: { width: '90px', height: '8px', borderRadius: '4px', background: 'rgba(128,128,128,.3)', overflow: 'hidden' } },
      h('div', { style: { width: batt.percent + '%', height: '100%', background: batt.percent < 20 ? '#ff3b30' : '#34c759' } }))) : null;

  return [conn, np, focus, dark, shot, bright, sound, ns, lockB, mission, widgets, extra];
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

async function render(view) {
  if (!panel) return;
  const kids = view === 'wifi' ? await wifiView() : view === 'display' ? displayView() : mainView();
  panel.innerHTML = '';
  panel.append(...kids.filter(Boolean));
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

export function toggleControlCenter(view) {
  if (panel) { close(); return; }
  panel = h('div.cc.glass.panel.sheen');
  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  document.body.append(panel);
  render(view === 'wifi' ? 'wifi' : undefined);
  status.refresh();
  offStatus = bus.on('status', () => { if (panel && !panel.dataset.view && !panel.matches(':active')) render(); });
  mediaTimer = setInterval(updateMedia, 3000);
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
}
function outside(e) { if (panel && !panel.contains(e.target) && !e.target.closest('.global-alert-layer')) close(); }
export function closeControlCenter() { if (panel) close(); }
function close() {
  if (!panel) return;
  const p = panel; panel = null;
  p.classList.add('closing');
  setTimeout(() => p.remove(), 200);
  clearInterval(mediaTimer); offStatus?.();
  document.removeEventListener('mousedown', outside);
}

export function initControlCenter() {
  const v = store.get('softBrightness');
  if (v != null && v < 100) softwareBrightness(v);
}
