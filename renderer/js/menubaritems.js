// The menu bar's right side, customisable (like macOS Tahoe): which items show, in what order — right-click the menu
// bar › Edit Menu Bar…, or Settings › Menu Bar. store 'menubarItems' = the ids shown, left to right (null = default).
// Control Center and the clock always stay (as on the Mac). Each item: { id, name, icon (for the picker), fixed,
// build(ctx) → element }. ctx: { shell, el(id) for the items menubar.js owns (battery, Wi-Fi, clock, tray…) }.
import { h, bus, $, $$ } from './util.js';
import { sym } from './icons.js';
import { store } from './store.js';
import { status } from './status.js';
import { api } from './sys.js';
import { showMenu } from './menus.js';
import { wm } from './wm.js';
import { THERMO, readTemps, fmtTemp, level, describePart, unitItems, partKey, shortName, gaugeSensors, setGaugeSensor, resolveGauges } from './temps.js';

export const DEFAULT_ITEMS = ['tray', 'battery', 'wifi', 'spotlight', 'cc', 'clock'];
export const menubarOrder = () => { const l = store.get('menubarItems'); return Array.isArray(l) && l.length ? l.filter((id) => itemDef(id)) : DEFAULT_ITEMS; };
// An item that can be added more than once (multi) has copies "id#2", "id#3"…, each with its own settings.
/** The definition behind a menu bar id (a copy's is its original's). */
export const itemDef = (id) => ITEMS[String(id).split('#')[0]] || null;
/** "Temperature", "Temperature 2"… */
export const itemName = (id) => { const n = String(id).split('#')[1]; return (itemDef(id)?.name || id) + (n ? ' ' + n : ''); };
/** The id to add for this item: itself, or its next free copy. null when it can't be added again. */
export function addId(base, shown) {
  if (!shown.includes(base)) return base;
  const it = ITEMS[base];
  if (!it?.multi || shown.filter((x) => x.split('#')[0] === base).length >= (it.max || 6)) return null;
  for (let n = 2; ; n++) if (!shown.includes(`${base}#${n}`)) return `${base}#${n}`;
}
/** Put an item in the menu bar (before Control Center and the clock). */
export const withItem = (shown, id) => [...shown.filter((x) => !itemDef(x).fixed), id, ...shown.filter((x) => itemDef(x).fixed)];

const item = (html, title, onclick) => { const el = h('div.mb-item', { html, title }); if (onclick) el.addEventListener('click', (e) => { e.stopPropagation(); onclick(e, el); }); return el; };
// keep an item current while it's on the page: now, on status changes, and every `ms`
// (once it's been taken off the menu bar, it stops: items are built afresh whenever the menu bar's layout changes)
function live(el, fn, ms) {
  let t = null;
  const gone = () => el.dataset.built && !document.contains(el);
  const stop = () => { off(); clearInterval(t); };
  const off = bus.on('status', () => { if (gone()) return stop(); fn(); });
  if (ms) t = setInterval(() => { if (gone()) return stop(); fn(); }, ms);
  fn();
  setTimeout(() => { el.dataset.built = '1'; }, 0);
  return el;
}
const pct = (v) => `${Math.round(v)}%`;
const SHIELD = '<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2.8 4.5 5.6v5.6c0 4.6 3.1 8.4 7.5 10 4.4-1.6 7.5-5.4 7.5-10V5.6z"/></svg>';
const SHIELD_ON = '<svg class="sym" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.8 4.5 5.6v5.6c0 4.6 3.1 8.4 7.5 10 4.4-1.6 7.5-5.4 7.5-10V5.6z"/></svg>';
const PHONE = '<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6.5" y="2" width="11" height="20" rx="2.6"/><path d="M10.5 4.6h3"/></svg>';
const CLIP = '<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="5.5" y="4" width="13" height="17" rx="2.2"/><path d="M9 4V3h6v1M9 10h6M9 14h4"/></svg>';
const LEAF = '<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="7" width="17" height="10" rx="2.5"/><path d="M21.5 10.5v3"/><path d="M6 12h6" stroke-width="3" stroke="#ffcc00"/></svg>';
const MOON_ON = '<svg class="sym" viewBox="0 0 24 24" fill="currentColor"><path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1z"/></svg>';

export const ITEMS = {
  // menubar.js's own: drawn and kept up to date there
  tray: { name: 'Background Apps', icon: sym.grid, own: true, about: 'Icons of apps running in the background (Discord, Steam…)' },
  battery: { name: 'Battery', icon: sym.battery || sym.bolt, own: true },
  wifi: { name: 'Wi-Fi', icon: sym.wifi, own: true },
  spotlight: { name: 'Spotlight', icon: sym.search, own: true },
  cc: { name: 'Control Center', icon: sym.controls, own: true, fixed: true },
  clock: { name: 'Clock', icon: sym.clock, own: true, fixed: true },

  bluetooth: { name: 'Bluetooth', icon: sym.bluetooth, build: (c) => {
    const el = item(sym.bluetooth, 'Bluetooth', () => c.shell.toggleControlCenter('bluetooth'));
    return live(el, () => { const on = !!status.s.bluetooth?.powered; el.classList.toggle('mb-dim', !on); el.title = `Bluetooth: ${on ? 'On' : 'Off'}`; });
  } },
  sound: { name: 'Sound', icon: sym.speaker, build: (c) => {
    const el = item(sym.speaker, 'Sound', () => c.shell.toggleControlCenter('sound'));
    // scroll on it to change the volume, like many Linux desktops (and handy)
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const v = Math.max(0, Math.min(100, (status.s.volume?.level ?? 50) - Math.sign(e.deltaY) * 5));
      api.sys.setVolume(v); status.patch({ volume: { ...(status.s.volume || {}), level: v, muted: false } });
    }, { passive: false });
    return live(el, () => {
      const v = status.s.volume;
      el.innerHTML = !v ? sym.speaker : v.muted || v.level === 0 ? sym.speakerMute : v.level < 40 ? sym.speakerLow : sym.speaker;
      el.title = v ? `Volume ${v.muted ? 'muted' : pct(v.level)} — scroll to change` : 'Sound';
    });
  } },
  display: { name: 'Display', icon: sym.sun, build: (c) => item(sym.sun, 'Display', () => c.shell.toggleControlCenter('display')) },
  nowplaying: { name: 'Now Playing', icon: sym.music, build: (c) => {
    const el = h('div.mb-item.mb-np', { title: 'Now Playing' });
    el.addEventListener('click', (e) => { e.stopPropagation(); c.shell.toggleControlCenter(); });
    return live(el, async () => {
      const m = await api.sys.media?.().catch(() => null);
      el.replaceChildren(h('span', { html: sym.music }), ...(m?.title ? [h('small', m.title.length > 22 ? m.title.slice(0, 21) + '…' : m.title)] : []));
      el.classList.toggle('mb-dim', !m?.title || m.status !== 'Playing');
      el.title = m?.title ? `${m.title}${m.artist ? ' — ' + m.artist : ''}` : 'Nothing playing';
    }, 5000);
  } },
  focus: { name: 'Focus', icon: sym.moon, build: () => {
    const el = item(sym.moon, 'Focus', () => store.set('dnd', !store.get('dnd')));
    const draw = () => { const on = !!store.get('dnd'); el.innerHTML = on ? MOON_ON : sym.moon; el.classList.toggle('mb-on', on); el.title = on ? 'Do Not Disturb is on' : 'Focus: off'; };
    store.on('change:dnd', draw);
    draw();
    return el;
  } },
  darkmode: { name: 'Dark Mode', icon: sym.contrast, build: () => item(sym.contrast, 'Dark Mode', () => store.set('theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')) },
  nightshift: { name: 'Night Shift', icon: sym.nightshift, build: () => {
    const el = item(sym.nightshift, 'Night Shift', () => store.set('nightShift', !store.get('nightShift')));
    const draw = () => el.classList.toggle('mb-on', !!store.get('nightShift'));
    store.on('change:nightShift', draw); draw();
    return el;
  } },
  lowpower: { name: 'Low Power Mode', icon: LEAF, build: (c) => {
    let before = 'balanced';
    const el = item(LEAF, 'Low Power Mode', async () => {
      const st = await api.power?.state().catch(() => null);
      if (!st?.available) return c.shell.openSettings('energy');
      if (st.active === 'power-saver') await api.power.set(before || 'balanced').catch(() => {}); else { before = st.active; await api.power.set('power-saver').catch(() => {}); }
      draw();
    });
    const draw = async () => { const st = await api.power?.state().catch(() => null); el.classList.toggle('mb-on', st?.active === 'power-saver'); el.classList.toggle('mb-dim', !st?.available); };
    return live(el, draw, 30000);
  } },
  vpn: { name: 'VPN', icon: SHIELD, build: (c) => {
    let list = [];
    const el = item(SHIELD, 'VPN', async (e, it) => {
      list = (await api.vpn?.list().catch(() => null))?.vpns || [];
      const r = it.getBoundingClientRect();
      const { vpnConnect } = await import('./apps/settings-vpn.js');
      const { prompt } = await import('./menus.js');
      showMenu([{ header: 'VPN' }, ...list.map((v) => ({ label: v.name, checked: v.state === 'on', action: async () => {
        try { if (v.state === 'on') await api.vpn.disconnect(v.uuid); else await vpnConnect(v, prompt); } catch (er) { c.shell.notify({ app: 'settings', title: 'VPN', body: er.message }); }
        draw();
      } })), ...(list.length ? [] : [{ label: 'No VPNs set up', disabled: true }]), '-', { label: 'VPN Settings…', action: () => c.shell.openSettings('vpn') }], r.left, r.bottom + 4);
    });
    const draw = async () => {
      list = (await api.vpn?.list().catch(() => null))?.vpns || [];
      const on = list.find((v) => v.state === 'on');
      el.innerHTML = on ? SHIELD_ON : SHIELD;
      el.classList.toggle('mb-on', !!on);
      el.title = on ? `VPN: ${on.name}` : 'VPN: not connected';
    };
    api.vpn?.onChanged?.(() => { if (document.contains(el)) draw(); });
    return live(el, draw, 60000);
  } },
  phone: { name: 'Phone', icon: PHONE, build: (c) => {
    const el = h('div.mb-item.mb-phone', { title: 'Phone' });
    el.addEventListener('click', (e) => { e.stopPropagation(); c.shell.toggleControlCenter('phone'); });
    import('./phone.js').then(({ mainPhone, onPhone }) => {
      const draw = () => {
        const d = mainPhone(), b = d?.reachable ? d.battery : null;
        el.replaceChildren(h('span', { html: PHONE }), ...(b ? [h('small', `${b.percent}%`)] : []));
        el.classList.toggle('mb-dim', !d?.reachable);
        el.title = d ? `${d.name}${b ? ` — ${b.percent}%${b.charging ? ', charging' : ''}` : d.reachable ? '' : ' — not connected'}` : 'No phone paired';
      };
      draw(); onPhone(el, draw);
    });
    return el;
  } },
  weather: { name: 'Weather', icon: sym.sun, build: () => {
    const el = h('div.mb-item.mb-weather', { title: 'Weather' });
    el.addEventListener('click', (e) => { e.stopPropagation(); wm.activate('weather'); });
    return live(el, async () => {
      try {
        const { getWeather, describe } = await import('./weatherdata.js');
        const w = await getWeather(), d = describe(w.current.weather_code, w.current.is_day);
        el.replaceChildren(h('span.mb-wx', { html: d.icon }), h('small', Math.round(w.current.temperature_2m) + '°'));
        el.title = `${w.city?.name || ''} — ${d.label}`;
      } catch { el.replaceChildren(h('span', { html: sym.sun })); }
    }, 15 * 60_000);
  } },
  cpu: { name: 'CPU', icon: sym.cpu, build: () => {
    const el = h('div.mb-item.mb-meter', { title: 'CPU — click for Activity Monitor' });
    el.addEventListener('click', (e) => { e.stopPropagation(); wm.activate('monitor'); });
    return live(el, async () => { const s = await api.sys.stats?.().catch(() => null); if (s) el.replaceChildren(h('b', 'CPU'), h('small', pct(s.cpu))); }, 4000);
  } },
  memory: { name: 'Memory', icon: sym.cpu, build: () => {
    const el = h('div.mb-item.mb-meter', { title: 'Memory — click for Activity Monitor' });
    el.addEventListener('click', (e) => { e.stopPropagation(); wm.activate('monitor'); });
    return live(el, async () => { const s = await api.sys.stats?.().catch(() => null); if (s) el.replaceChildren(h('b', 'MEM'), h('small', pct(((s.memTotal - s.memFree) / s.memTotal) * 100))); }, 6000);
  } },
  temperature: { name: 'Temperature', icon: THERMO, multi: true, max: 6, about: 'A temperature; add more than one to show several parts',
    // (in the menu bar: which part this one shows)
    detail: (id) => { const k = gaugeSensors()[id]; return k === 'hottest' ? 'Shows the hottest part' : k ? 'Shows ' + k.slice(k.indexOf(':') + 1) : 'Shows the processor'; }, build: (c, id = 'temperature') => {
    const el = h('div.mb-item.mb-meter.mb-temp', { title: 'Temperature' });
    let last = null, closeOpen = null;
    const gauges = () => menubarOrder().filter((x) => x.split('#')[0] === 'temperature');
    // the part this gauge shows (each gauge a different one: temps.js resolveGauges)
    const pick = (r) => {
      if (!r?.devices.length) return null;
      // (a preview of one not added yet: the part it would get)
      const ids = gauges();
      const key = resolveGauges(r, ids.includes(id) ? ids : [...ids, id])[id];
      if (key === 'hottest') { const awake = r.devices.filter((x) => x.temp != null); return awake.reduce((a, b) => (b.temp > a.temp ? b : a), awake[0]) || r.devices[0]; }
      return r.devices.find((x) => partKey(x) === key) || r.cpu || r.devices[0];
    };
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      // clicking it again closes its menu (as the menu bar's other menus do)
      if (closeOpen) { closeOpen(); return; }
      const r = last || (await readTemps());
      const rect = el.getBoundingClientRect();
      const row = (d) => ({ label: d.name, shortcut: d.asleep ? 'Asleep' : fmtTemp(d.temp, true),
        ...(d.detail.length ? { submenu: d.detail.slice(0, 32).map((x) => ({ label: x.label, shortcut: fmtTemp(x.temp, true) })) } : { action: () => {} }) });
      const fans = (r?.fans || []).filter((f) => f.rpm != null || f.percent != null);
      closeOpen = showMenu([{ header: 'Temperature' }, ...(r?.devices.length ? r.devices.map(row) : [{ label: 'No temperature sensors found', disabled: true }]),
        ...(fans.length ? ['-', { header: 'Fans' }, ...fans.map((f) => ({ label: f.name, shortcut: f.rpm != null ? `${Math.round(f.rpm)} rpm` : `${f.percent}%`, action: () => {} }))] : []),
        '-', { label: 'Activity Monitor…', action: () => wm.activate('monitor') }], rect.left, rect.bottom + 4,
      { anchor: el, onClose: () => { closeOpen = null; el.classList.remove('open'); } });
      el.classList.add('open');
    });
    // right-click: which part it shows (one another gauge shows can't be picked), the unit, and more gauges
    el.addEventListener('contextmenu', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const r = (await readTemps()) || last, ids = gauges(), now = resolveGauges(r, ids);
      const taken = new Set(ids.filter((x) => x !== id).map((x) => now[x]));
      const choose = (key) => { setGaugeSensor(id, key); for (const x of ids) if (x !== id && !gaugeSensors()[x] && now[x]) setGaugeSensor(x, now[x]); };
      const opt = (key, label, shortcut) => taken.has(key) ? { label, shortcut: 'In use', disabled: true }
        : { label, shortcut, checked: now[id] === key, action: () => choose(key) };
      const shown = menubarOrder(), more = addId('temperature', shown);
      showMenu([{ header: ids.length > 1 ? `Show in ${itemName(id)}` : 'Show in Menu Bar' },
        ...(r?.devices || []).map((d) => opt(partKey(d), d.name, d.asleep ? 'Asleep' : fmtTemp(d.temp, true))),
        opt('hottest', 'Hottest Part'),
        '-', ...unitItems(), '-',
        ...(more && r && ids.length < r.devices.length + 1 ? [{ label: 'Add Another Temperature', action: () => {
          // after this one, showing the first part no gauge shows yet
          const free = [...r.devices.map(partKey), 'hottest'].find((k) => !Object.values(now).includes(k));
          if (free) setGaugeSensor(more, free);
          const i = shown.indexOf(id);
          store.set('menubarItems', [...shown.slice(0, i + 1), more, ...shown.slice(i + 1)]);
        } }] : []),
        { label: ids.length > 1 ? `Remove ${itemName(id)}` : 'Remove from Menu Bar', action: () => { setGaugeSensor(id, null); store.set('menubarItems', shown.filter((x) => x !== id)); } },
        { label: 'Edit Menu Bar…', action: () => el.closest('#mb-status')?.dispatchEvent(new CustomEvent('mb-edit')) }], e.clientX, e.clientY + 4);
    });
    const draw = async () => {
      const r = await readTemps();
      if (r) last = r;
      const d = pick(r);
      // the processor needs no label when it's the only gauge; anything else says what it is
      const tag = d && (d.kind !== 'cpu' || gauges().length > 1) ? [h('b', shortName(d, r))] : [];
      el.replaceChildren(h('span', { html: THERMO }), ...tag, h('small', d ? (d.asleep ? 'Off' : fmtTemp(d.temp)) : '—'));
      const lv = level(d);
      el.classList.toggle('mb-warm', lv === 'warm'); el.classList.toggle('mb-hot', lv === 'hot');
      el.classList.toggle('mb-dim', !d);
      el.title = d ? describePart(d) : 'No temperature sensors found';
    };
    const offs = ['change:tempUnit', 'change:tempMenubarSensors'].map((k) => store.on(k, () => { if (!document.contains(el)) return offs.forEach((f) => f()); draw(); }));
    return live(el, draw, 5000);
  } },
  screentime: { name: 'Screen Time', icon: sym.hourglass, build: (c) => {
    const el = h('div.mb-item.mb-meter', { title: 'Screen Time today' });
    el.addEventListener('click', (e) => { e.stopPropagation(); c.shell.openSettings('screentime'); });
    return live(el, async () => {
      const ST = await import('./screentime.js');
      const rec = ST.loadScreenTime().days[ST.dayKey()];
      const total = Object.values(rec?.apps || {}).reduce((a, b) => a + b, 0);
      el.replaceChildren(h('span', { html: sym.hourglass }), h('small', ST.fmtDur(total, true)));
    }, 60_000);
  } },
  reminders: { name: 'Reminders', icon: sym.list, build: () => {
    const el = h('div.mb-item.mb-meter', { title: 'Reminders due today' });
    el.addEventListener('click', (e) => { e.stopPropagation(); wm.activate('reminders', { view: 'today' }); });
    const draw = async () => {
      const R = await import('./reminders.js');
      const n = R.loadReminders().items.filter(R.SMART.today.test).length;
      el.replaceChildren(h('span', { html: sym.list }), ...(n ? [h('small', String(n))] : []));
      el.classList.toggle('mb-dim', !n);
    };
    bus.on('reminders', () => { if (document.contains(el)) draw(); });
    return live(el, draw, 60_000);
  } },
  clipboard: { name: 'Clipboard History', icon: CLIP, build: () => item(CLIP, 'Clipboard History (Super+V)', (e, el) => { const r = el.getBoundingClientRect(); import('./cliphistory.js').then((m) => m.openClipboard({ x: r.left - 300, y: r.bottom - 10 })); }) },
  screenshot: { name: 'Screenshot', icon: sym.camera, build: (c) => item(sym.camera, 'Screenshot (Super+Shift+S)', () => c.shell.screenshotTool()) },
  mission: { name: 'Mission Control', icon: sym.layers, build: (c) => item(sym.layers, 'Mission Control (F3)', () => c.shell.mission()) },
  lock: { name: 'Lock Screen', icon: sym.lock, build: (c) => item(sym.lock, 'Lock Screen', () => c.shell.lock()) },
  user: { name: 'Your Account', icon: sym.user, build: (c) => {
    const el = h('div.mb-item.mb-user', { title: 'Your account' });
    const name = () => c.shell.info?.fullName || c.shell.info?.user || 'User';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      showMenu([{ header: name() }, { label: 'Users & Accounts…', action: () => c.shell.openSettings('account') }, '-',
        { label: 'Lock Screen', action: () => c.shell.lock() }, { label: 'Log Out…', action: () => api.sys.power('logout') }], r.left, r.bottom + 4);
    });
    el.textContent = name().split(/\s+/)[0];
    return el;
  } },
};
// each item's category in the gallery, and what it does (where it doesn't say already)
for (const [cat, list] of Object.entries({
  status: { tray: 0, battery: 'How much charge is left, and whether it’s charging', wifi: 'The network you’re on; click for Wi-Fi', bluetooth: 'Whether Bluetooth is on; click for devices', sound: 'The volume — scroll on it to change it', vpn: 'Whether a VPN is connected; click to connect one', phone: 'Your paired phone and its battery', user: 'Your name, with Lock Screen and Log Out' },
  monitor: { cpu: 'How busy the processor is', memory: 'How much memory is in use', temperature: 0, screentime: 'How long you’ve used the computer today' },
  controls: { spotlight: 'Search your apps, files and more', display: 'Brightness and Night Shift', focus: 'Turn Do Not Disturb on and off', darkmode: 'Switch between light and dark', nightshift: 'Warmer colours, easier on the eyes at night', lowpower: 'Turn Low Power Mode on and off', clipboard: 'What you’ve copied lately', screenshot: 'Take a screenshot or record the screen', mission: 'See all your windows and Spaces', lock: 'Lock the screen' },
  info: { nowplaying: 'The song that’s playing', weather: 'The temperature outside and the sky', reminders: 'How many reminders are due today' },
})) for (const [id, about] of Object.entries(list)) if (ITEMS[id]) { ITEMS[id].cat = cat; if (about && !ITEMS[id].about) ITEMS[id].about = about; }

/* ------------------------------------------------------------------ editing */
// Edit Menu Bar (like Control Center's and the desktop's widget galleries): the menu bar's items jiggle and can be
// dragged along it; a gallery under it shows what's in the menu bar now (drag to reorder, − to remove) and every item
// you can add — each drawn as it really looks, with its name and what it does — by category.
export const CATEGORIES = [['all', 'All Items'], ['status', 'Status'], ['monitor', 'Monitoring'], ['controls', 'Controls'], ['info', 'Info']];
let panel = null, galleryCat = 'all';
export function editingMenubar() { return !!panel; }

/** A live preview of an item, as it looks in the menu bar (preview(id) is menubar.js's: a copy of its own items). */
function previewOf(id, preview) {
  let el = null;
  try { el = preview?.(id); } catch { /* drawn as its icon */ }
  const it = itemDef(id);
  // one of menubar.js's own with nothing to show right now (no background apps running…): its icon
  // (the others fill themselves in once their readings arrive)
  if (!el || (it.own && !el.textContent.trim() && !el.querySelector('svg, img'))) el = h('div.mb-item', { html: it.icon || sym.grid });
  el.classList.remove('open', 'mb-dragging', 'mb-pop');
  el.style.animationDelay = '';
  return el;
}
// each item jiggles a little out of step with the others, as icons do on a phone's home screen
const jiggle = () => { for (const [i, el] of $$('#mb-status > [data-mb]').entries()) el.style.animationDelay = `${-((i * 0.083) % 0.28).toFixed(3)}s`; };

export function editMenubar(redraw, preview) {
  if (panel) return;
  $('#mb-status')?.classList.add('mb-editing');
  jiggle();
  panel = h('div.mb-gallery.glass.panel.sheen');
  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  document.body.append(panel);
  const redrawBar = (popId) => {
    redraw();
    $('#mb-status')?.classList.add('mb-editing');
    jiggle();
    // a new item pops into place
    const el = popId && $(`#mb-status > [data-mb="${CSS.escape(popId)}"]`);
    if (el) { el.classList.add('mb-pop'); setTimeout(() => el.classList.remove('mb-pop'), 520); }
  };
  const save = (list, popId) => { store.set('menubarItems', list); redrawBar(popId); fill(); };
  const drop = (id) => { if (id.startsWith('temperature')) setGaugeSensor(id, null); save(menubarOrder().filter((x) => x !== id)); };
  const add = (base) => { const shown = menubarOrder(), id = addId(base, shown); if (id) save(withItem(shown, id), id); };

  const fill = () => {
    const shown = menubarOrder();
    // what's in the menu bar now, in order: drag to reorder, − to remove
    const strip = h('div.mbg-strip');
    for (const id of shown) {
      const it = itemDef(id);
      const chip = h('div.mbg-chip' + (it.fixed ? '.fixed' : ''), { 'data-id': id, title: it.fixed ? `${itemName(id)} — always shown` : `${itemName(id)}${it.detail ? ' — ' + it.detail(id) : ''}` },
        h('div.mbg-chip-in', previewOf(id, preview)),
        it.fixed ? null : h('button.mbg-rm', { title: 'Remove', html: sym.minus, onmousedown: (e) => e.stopPropagation(), onclick: (e) => {
          e.stopPropagation();
          chip.classList.add('leaving');
          setTimeout(() => drop(id), 200);
        } }));
      if (!it.fixed) chip.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        dragReorder(chip, e, { items: () => $$('.mbg-chip', strip), fixed: (x) => x.classList.contains('fixed'),
          done: () => { const order = $$('.mbg-chip', strip).map((x) => x.dataset.id); save([...order.filter((x) => !itemDef(x).fixed), ...order.filter((x) => itemDef(x).fixed)]); } });
      });
      strip.append(chip);
    }
    // everything you can add, by category (one already in the menu bar: click to take it out again)
    const tabs = h('div.wg-tabs', ...CATEGORIES.map(([c, name]) => h('button' + (galleryCat === c ? '.on' : ''), { onclick: () => { galleryCat = c; fill(); } }, name)));
    const grid = h('div.mbg-grid');
    for (const [base, it] of Object.entries(ITEMS)) {
      if (it.fixed || (galleryCat !== 'all' && it.cat !== galleryCat)) continue;
      const nextId = addId(base, shown), added = !nextId;
      const card = h('div.mbg-card' + (added ? '.added' : ''), { title: added ? `${it.name} is in the menu bar — click to remove it` : `Add ${it.name}` },
        h('div.mbg-prev', previewOf(nextId || base, preview)),
        h('span.mbg-badge', { html: added ? '✓' : sym.plus }),
        h('div.mbg-name', it.name, it.multi && shown.includes(base) && nextId ? h('small.mbg-more', 'Add another') : null),
        h('div.mbg-about', it.about || ''));
      card.addEventListener('click', () => {
        if (added) return drop(base);
        card.classList.add('adding');
        setTimeout(() => add(base), 160);
      });
      grid.append(card);
    }
    if (!grid.children.length) grid.append(h('div.wg-empty', 'Nothing here.'));
    const scroll = panel.querySelector('.mbg-grid')?.scrollTop || 0;
    panel.replaceChildren(
      h('div.mbg-top', h('div.mbg-title', h('b', 'Menu Bar'), h('small', 'Drag items along the menu bar, or here, to move them · click an item below to add it')),
        h('div.mbg-actions', h('button.btn', { onclick: () => { store.set('menubarItems', null); redrawBar(); fill(); } }, 'Reset to Default'),
          h('button.btn.primary', { onclick: () => stopEditing(redraw) }, 'Done'))),
      h('div.mbg-sec', 'In Your Menu Bar'), strip,
      h('div.mbg-sec.mbg-sec-row', h('span', 'Add Items'), tabs),
      grid);
    panel.querySelector('.mbg-grid').scrollTop = scroll;
  };
  panel.refill = fill;
  fill();
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  function outside(e) {
    if (!panel) return document.removeEventListener('mousedown', outside, true);
    if (!panel.contains(e.target) && !e.target.closest('#mb-status') && !e.target.closest('.menu')) { document.removeEventListener('mousedown', outside, true); stopEditing(redraw); }
  }
}
function stopEditing(redraw) {
  if (!panel) return;
  const p = panel; panel = null;
  p.classList.add('closing'); setTimeout(() => p.remove(), 220);
  $('#mb-status')?.classList.remove('mb-editing');
  redraw();
}

/**
 * Drag an element along a row to reorder it, animated: it lifts and follows the pointer, the others slide out of its
 * way (FLIP), and it springs into its new place when dropped. o: { items() → the row's elements, fixed(el) → one that
 * can't move (Control Center, the clock), done() → save the new order (only when it moved) }.
 */
function dragReorder(el, e, o) {
  const row = el.parentNode, sx = e.clientX, start = el.getBoundingClientRect().left;
  let moved = false, slot = start;   // slot: where its place in the row is now (it's drawn offset from there)
  const place = (ev) => { el.style.transform = `translateX(${ev.clientX - sx + start - slot}px) scale(1.08)`; };
  const move = (ev, fn) => {
    // FLIP: note where the others are, reorder, then slide each from there to its new place
    const others = o.items().filter((x) => x !== el);
    const before = new Map(others.map((x) => [x, x.getBoundingClientRect().left]));
    fn();
    for (const x of others) {
      const dx = before.get(x) - x.getBoundingClientRect().left;
      if (dx) x.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', composite: 'add' });
    }
    const t = el.style.transform; el.style.transform = 'none';
    slot = el.getBoundingClientRect().left;
    el.style.transform = t;
    place(ev);
  };
  const mv = (ev) => {
    if (!moved && Math.abs(ev.clientX - sx) < 4) return;
    if (!moved) { moved = true; el.classList.add('mb-dragging'); }
    place(ev);
    // its middle past a neighbour's middle: trade places with it
    const r = el.getBoundingClientRect(), mid = r.left + r.width / 2;
    const list = o.items(), i = list.indexOf(el), next = list[i + 1], prev = list[i - 1];
    const midOf = (n) => { const b = n.getBoundingClientRect(); return b.left + b.width / 2; };
    if (next && !o.fixed(next) && mid > midOf(next)) move(ev, () => row.insertBefore(el, next.nextSibling));
    else if (prev && !o.fixed(prev) && mid < midOf(prev)) move(ev, () => row.insertBefore(el, prev));
  };
  const up = () => {
    removeEventListener('mousemove', mv, true); removeEventListener('mouseup', up, true);
    if (!moved) return;
    // spring into its place, then save
    const from = el.style.transform;
    el.style.transform = '';
    const a = el.animate([{ transform: from }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(0.34, 1.36, 0.64, 1)' });
    a.onfinish = () => { el.classList.remove('mb-dragging'); o.done(); };
  };
  addEventListener('mousemove', mv, true); addEventListener('mouseup', up, true);
}

/** While editing: drag an item along the menu bar to move it (the order is saved when it's dropped). */
export function dragMenubarItem(el, e, redraw) {
  const area = el.parentNode;
  if (itemDef(el.dataset.mb)?.fixed) return;
  dragReorder(el, e, { items: () => $$('[data-mb]', area), fixed: (x) => !!itemDef(x.dataset.mb)?.fixed,
    done: () => {
      const order = $$('[data-mb]', area).map((x) => x.dataset.mb);
      // Control Center and the clock stay at the end, as on the Mac
      store.set('menubarItems', [...order.filter((id) => !itemDef(id)?.fixed), ...order.filter((id) => itemDef(id)?.fixed)]);
      redraw();
      if (panel) { $('#mb-status')?.classList.add('mb-editing'); jiggle(); panel.refill(); }
    } });
}
