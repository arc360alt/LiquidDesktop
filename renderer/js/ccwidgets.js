// Extra Control Center controls (Control Center › Edit Controls › Add). Each entry is one line:
//   [id, name, size, build]   size: 's' (1×1 square), 'w' (2×1), 'f' (4×1 full width)
// build(ctx) returns the control's element; ctx has the helpers (sq, close, render, …).
// To add a control, add a line to one of the lists below.
import { h } from './util.js';
import { sym } from './icons.js';
import { store } from './store.js';
import { api } from './sys.js';
import { status } from './status.js';
import { appIcon } from './icons.js';
import { catalog } from './catalog.js';
import { getWeather, describe } from './weatherdata.js';
import { customWidgets, deleteCustom, renderCustom, toFile, isCC } from './customwidget.js';
import { mainPhone, PHONE_ICONS, phoneAct, sendFiles, deviceIcon } from './phone.js';

// sizes a control can be (right-click › Size on the ones with more than one)
export const SIZE_NAMES = { s: 'Small (1×1)', w: 'Wide (2×1)', l: 'Large (2×2)' };
export const SPAN = { s: '.cc-sq', w: '.span2', l: '.span2.row2' };
export const sizeOf = (x, iid) => (x.sizes?.includes(cfg(iid).size) ? cfg(iid).size : x.size);

// per-control options (right-click a control): store 'ccConfig' = { [control id]: { … } }
export const cfg = (id) => (store.get('ccConfig') || {})[id] || {};
export const setCfg = (id, patch) => store.set('ccConfig', { ...(store.get('ccConfig') || {}), [id]: { ...cfg(id), ...patch } });
const radio = (id, key, choices, def, c) => choices.map(([v, label]) => ({ label, checked: (cfg(id)[key] ?? def) === v, action: () => { setCfg(id, { [key]: v }); c.render(); } }));
const check = (id, key, label, def, c) => ({ label, checked: cfg(id)[key] ?? def, action: () => { setCfg(id, { [key]: !(cfg(id)[key] ?? def) }); c.render(); } });

/** An app button: opens its app, or the one picked with right-click › Choose App… (shown with its own icon). */
function launcher(id, defApp, defName, defIcon) {
  return { id, name: defName, size: 's',
    build: (c, iid = id) => {
      const app = catalog.find(cfg(iid).app || defApp);
      // no app chosen yet (a new App Shortcut): clicking it asks for one
      const el = c.sq(defIcon || '', app?.name || defName, false, () => { if (!app) return c.render('pick:' + iid); c.close(); catalog.launch(app); });
      if (cfg(iid).app && app) el.querySelector('span')?.replaceWith(appIcon(app, 'cc-app-ic'));
      return el;
    },
    menu: (c, iid = id) => [{ label: 'Choose App…', action: () => c.render('pick:' + iid) }, cfg(iid).app && defApp ? { label: `Reset to ${defName}`, action: () => { setCfg(iid, { app: null }); c.render(); } } : null],
  };
}

// Weather (2×1): what it shows is chosen with right-click
const WEATHER_SHOWS = [['now', 'Current Conditions'], ['today', 'Today’s High & Low'], ['details', 'Feels Like, Humidity & Wind'], ['tomorrow', 'Tomorrow']];
// The 2×1 one can be added several times, each showing something different: an option another one already
// shows is greyed out, and a new one starts on the first option nobody uses.
const weatherShows = (ids, except) => ids.filter((i) => i.split('#')[0] === 'info-weather' && i !== except).map((i) => cfg(i).show || 'now');
function weatherControl(id) {
  return { id, name: 'Weather', size: 'w', sizes: ['s', 'w', 'l'], multi: true,
    canAdd: (ids) => weatherShows(ids).length < WEATHER_SHOWS.length,
    onAdd: (iid, ids) => { const used = weatherShows(ids); setCfg(iid, { show: (WEATHER_SHOWS.find(([v]) => !used.includes(v)) || WEATHER_SHOWS[0])[0] }); },
    build: (c, iid = id) => {
      const size = sizeOf({ size: 'w', sizes: ['s', 'w', 'l'] }, iid);
      // drawn into its own box, so the Edit Controls badges (+ / −) added to the control aren't cleared with it
      const body = h('div.cc-wx-body', h('small.muted', 'Weather…'));
      const el = h('div.cc-mod.cc-weather' + SPAN[size], body);
      el.addEventListener('click', () => { c.close(); catalog.launch('weather'); });
      // in the Add gallery, a new one shows the first option nobody uses yet
      const show = cfg(iid).show || (c.layout().includes(iid) ? 'now' : (WEATHER_SHOWS.find(([v]) => !weatherShows(c.layout()).includes(v)) || WEATHER_SHOWS[0])[0]);
      getWeather().then((w) => {
        const cur = w.current, d = describe(cur.weather_code, cur.is_day), D = w.daily;
        const ic = (html) => h('span.cc-wx-ic', { html });
        const hl = (i) => `${Math.round(D.temperature_2m_max[i])}° / ${Math.round(D.temperature_2m_min[i])}°`;
        const icon = show === 'tomorrow' ? describe(D.weather_code[1], 1).icon : d.icon;
        const big = show === 'now' ? Math.round(cur.temperature_2m) + '°' : show === 'today' ? hl(0) : show === 'tomorrow' ? hl(1) : `${Math.round(cur.apparent_temperature)}°`;
        const sub = show === 'now' ? d.label : show === 'today' ? 'Today · ' + d.label : show === 'tomorrow' ? 'Tomorrow · ' + describe(D.weather_code[1], 1).label : 'Feels like';
        const details = [h('small', `Feels like ${Math.round(cur.apparent_temperature)}°`), h('small', `Humidity ${Math.round(cur.relative_humidity_2m)}%`), h('small', `Wind ${Math.round(cur.wind_speed_10m)} ${w.current_units?.wind_speed_10m || ''}`)];
        body.innerHTML = '';
        if (size === 's') { body.append(ic(icon), h('b', show === 'details' ? big : big.replace(' / ', '/'))); return; }
        const top = h('div.cc-wx-top', h('small', w.city.name), ic(icon));
        if (show === 'details' && size === 'w') { body.append(top, ...details); return; }
        body.append(top, h('b.cc-wx-big', big), h('small', sub));
        if (size === 'l') body.append(h('div.cc-wx-more', ...(show === 'details' ? [h('small', d.label), h('small', 'Today ' + hl(0))] : show === 'now' ? [h('small', 'Today ' + hl(0)), ...details.slice(0, 2)] : details)));
      }).catch(() => { body.innerHTML = ''; body.append(h('small.muted', 'Weather unavailable')); });
      return el;
    },
    menu: (c, iid = id) => {
      const used = weatherShows(c.layout(), iid), cur = cfg(iid).show || 'now';
      return [{ header: 'Show' }, ...WEATHER_SHOWS.map(([v, label]) => ({ label, checked: cur === v, disabled: used.includes(v) && cur !== v, action: () => { setCfg(iid, { show: v }); c.render(); } }))];
    },
  };
}

// 1×1 buttons that open an app
const APPS = [
  ['files', 'Files', sym.folder], ['browser', 'Browser', sym.globe], ['terminal', 'Terminal', sym.terminal], ['notes', 'Notes', sym.compose],
  ['calculator', 'Calculator', sym.calc], ['calendar', 'Calendar', sym.clock], ['weather', 'Weather', sym.sun], ['monitor', 'Activity Monitor', sym.cpu],
  ['appstore', 'App Store', sym.download], ['settings', 'Settings', sym.gear], ['reminders', 'Reminders', sym.list], ['mirroring', 'Phone Mirroring', sym.mirror],
];
// 1×1 on/off switches for a setting
const TOGGLES = [
  ['clock24', '24-Hour Clock', sym.clock], ['showSeconds', 'Seconds', sym.clock], ['dockMagnify', 'Magnify Dock', sym.dock],
  ['showBatteryPct', 'Battery %', sym.battery],
];
// 1×1 actions: [id, name, icon, run(ctx)]
const ACTIONS = [
  ['spotlight', 'Spotlight', sym.search, (c) => c.shell.spotlight()],
  ['launchpad', 'Apps', sym.icons, (c) => c.shell.launchpad()],
  ['showdesktop', 'Desktop', sym.desktop, (c) => c.wm.toggleDesktop()],
  ['capturearea', 'Capture Area', sym.camera, (c) => c.shell.screenshotTool({ kind: 'capture' })],
  ['newdesktop', 'New Desktop', sym.plus, (c) => c.wm.addSpace()],
  ['emptytrash', 'Empty Trash', sym.trash, (c) => c.shell.emptyTrash()],
  ['editwidgets', 'Widgets', sym.widgets, (c) => c.shell.editWidgets()],
  ['sleep', 'Sleep', sym.moon || sym.power, (c) => c.shell.power('suspend')],
  ['logout', 'Log Out', sym.user, (c) => c.shell.power('logout')],
  ['restart', 'Restart', sym.restart, (c) => c.shell.power('restart')],
  ['shutdown', 'Shut Down', sym.power, (c) => c.shell.power('shutdown')],
];

const pad = (n) => String(n).padStart(2, '0');
// 2×1 / full-width info controls
const INFO = [
  ['clock', 'Clock', 'w', (c, iid = 'info-clock') => {
    const size = sizeOf({ size: 'w', sizes: ['s', 'w'] }, iid), o = cfg(iid);
    const t = h('b', { style: { fontSize: size === 's' ? '17px' : '22px', fontVariantNumeric: 'tabular-nums' } }), d = h('small.muted');
    const tick = () => { const n = new Date(); t.textContent = `${store.get('clock24') ? pad(n.getHours()) : n.getHours() % 12 || 12}:${pad(n.getMinutes())}${o.seconds && size !== 's' ? ':' + pad(n.getSeconds()) : ''}`; d.textContent = o.date === false ? '' : size === 's' ? n.toLocaleDateString(undefined, { weekday: 'short' }) : n.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }); };
    tick();
    const el = h('div.cc-mod.cc-info' + SPAN[size], t, d);
    const iv = setInterval(() => (el.isConnected ? tick() : clearInterval(iv)), 1000);
    return el;
  }, ['s', 'w']],
  ['system', 'CPU & Memory', 'w', (c, iid = 'info-system') => {
    const size = sizeOf({ size: 'w', sizes: ['s', 'w'] }, iid);
    const cpu = h('b', '—'), mem = h('b', '—');
    const show = cfg(iid).show || 'both';
    const row = (icon, label, v) => (size === 's' ? h('div.cc-info-row', h('small', label), v) : h('div.cc-info-row', h('span', { html: icon }), h('small', label), v));
    const el = h('div.cc-mod.cc-info' + SPAN[size], show !== 'mem' ? row(sym.cpu, 'CPU', cpu) : null, show !== 'cpu' ? row(sym.layers, size === 's' ? 'Mem' : 'Memory', mem) : null);
    const upd = () => api.sys.stats().then((s) => { cpu.textContent = Math.round(s.cpu) + '%'; mem.textContent = Math.round((1 - s.memFree / s.memTotal) * 100) + '%'; }).catch(() => {});
    upd();
    const iv = setInterval(() => (el.isConnected ? upd() : clearInterval(iv)), 2000);
    return el;
  }, ['s', 'w']],
  ['mute', 'Mute', 's', (c) => {
    const muted = !!status.s.volume?.muted;
    return c.sq(muted ? sym.speakerMute : sym.speaker, muted ? 'Muted' : 'Sound On', muted, async () => { await api.sys.setMute(!muted); status.patch({ volume: { ...status.s.volume, muted: !muted } }); c.render(); });
  }],
  ['airplanesq', 'Airplane Mode', 's', (c) => {
    const on = !!store.get('airplane');
    return c.sq(sym.airplane, 'Airplane', on, async () => { store.set('airplane', !on); await api.sys.airplane(!on); status.refresh(); c.render(); });
  }],
];

// 1×1 controls for your phone (KDE Connect): they show a dash until a phone is connected
const phoneSq = (c, icon, label, run) => {
  const d = mainPhone();
  const el = c.sq(icon, label, false, () => { if (d?.reachable) { c.close(); setTimeout(() => run(d), 200); } else c.shell.openSettings('phone'); });
  if (!d?.reachable) el.classList.add('cc-dim');
  return el;
};
const PHONE_CONTROLS = [
  { id: 'phone-find', name: 'Find My Phone', size: 's', build: (c) => phoneSq(c, PHONE_ICONS.ring, 'Find Phone', (d) => phoneAct(d, 'ring', null, c.shell.notify)) },
  { id: 'phone-clip', name: 'Send Clipboard to Phone', size: 's', build: (c) => phoneSq(c, PHONE_ICONS.clipboard, 'Clipboard', (d) => phoneAct(d, 'clipboard', null, c.shell.notify).then((r) => r && c.shell.notify({ app: 'settings', title: d.name, body: 'Clipboard sent.' }))) },
  { id: 'phone-send', name: 'Send Files to Phone', size: 's', build: (c) => phoneSq(c, PHONE_ICONS.send, 'Send Files', (d) => sendFiles(d, c.shell.notify)) },
  { id: 'phone-battery', name: 'Phone Battery', size: 's', build: (c) => {
    const d = mainPhone(), b = d?.reachable ? d.battery : null;
    const el = h('div.cc-mod.cc-sq.cc-phone-batt', h('span', { html: b?.charging ? sym.bolt : deviceIcon(d) }), h('b', b ? b.percent + '%' : '—'));
    el.title = d ? `${d.name}${b ? ` — ${b.percent}%` : ''}` : 'No phone';
    el.addEventListener('click', () => c.render('phone'));
    return el;
  } },
];

// VPN: on and off with a click (the first VPN, or the one that's on); right-click picks another
let vpnCache = null;
const vpnControl = { id: 'net-vpn', name: 'VPN', size: 's', build: (c) => {
  const el = c.sq(sym.vpn, 'VPN', false, async () => {
    const list = (await api.vpn?.list().catch(() => null))?.vpns || [];
    const v = list.find((x) => x.uuid === cfg('net-vpn').uuid) || list.find((x) => x.state === 'on') || list[0];
    if (!v) { c.close(); c.shell.openSettings('vpn'); return; }
    el.classList.add('busy');
    try {
      if (v.state === 'on' || v.state === 'connecting') await api.vpn.disconnect(v.uuid);
      else { const { vpnConnect } = await import('./apps/settings-vpn.js'); const { prompt } = await import('./menus.js'); await vpnConnect(v, prompt); }
    } catch (e) { c.shell.notify({ app: 'settings', title: 'VPN', body: e.message }); }
    vpnCache = null; c.render();
  });
  const paint = (list) => {
    const v = list.find((x) => x.uuid === cfg('net-vpn').uuid) || list.find((x) => x.state === 'on') || list[0];
    el.classList.toggle('on', v?.state === 'on');
    const lab = el.lastChild;
    if (lab?.nodeType === 3) lab.textContent = v ? (v.state === 'connecting' ? 'Connecting…' : v.name) : 'VPN';
    el.title = v ? `${v.name} — ${v.state === 'on' ? 'Connected' : 'Not Connected'}` : 'No VPN set up — click to add one';
    if (!v) el.classList.add('cc-dim');
  };
  if (vpnCache) paint(vpnCache);
  api.vpn?.list().then((r) => { vpnCache = r.vpns || []; paint(vpnCache); }).catch(() => {});
  return el;
}, menu: (c) => (vpnCache || []).map((v) => ({ label: v.name, checked: v.uuid === (cfg('net-vpn').uuid || vpnCache.find((x) => x.state === 'on')?.uuid || vpnCache[0]?.uuid), action: () => { setCfg('net-vpn', { uuid: v.uuid }); c.render(); } }))
  .concat(['-', { label: 'VPN Settings…', action: () => { c.close(); c.shell.openSettings('vpn'); } }]) };
api.vpn?.onChanged?.(() => { vpnCache = null; });

const MENUS = {
  clock: (c, iid = 'info-clock') => [check(iid, 'seconds', 'Show Seconds', false, c), check(iid, 'date', 'Show Date', true, c)],
  system: (c, iid = 'info-system') => [{ header: 'Show' }, ...radio(iid, 'show', [['both', 'CPU & Memory'], ['cpu', 'CPU'], ['mem', 'Memory']], 'both', c)],
};

/** Every extra control: { id, name, size, build(ctx) }. */
export const EXTRA_CONTROLS = [
  ...APPS.map(([id, name, icon]) => launcher('app-' + id, id, name, icon)),
  // App Shortcut: add as many as you like; each asks which app as it's added
  { ...launcher('app-shortcut', null, 'Choose App', sym.plus), name: 'App Shortcut', multi: true, pickOnAdd: true },
  // the earlier numbered ones, still drawn where they were added
  ...[1, 2, 3].map((n) => ({ ...launcher('app-shortcut' + n, 'files', 'Files', sym.folder), hidden: true })),
  weatherControl('info-weather'),
  // the old separate 1×1 Temperature: still drawn where it was added, now a Weather at Small size
  { ...weatherControl('info-weathersq'), multi: false, hidden: true, size: 's' },
  ...TOGGLES.map(([key, name, icon]) => ({ id: 'set-' + key, name, size: 's', build: (c) => c.sq(icon, name, !!store.get(key), () => { store.set(key, !store.get(key)); c.render(); }) })),
  ...ACTIONS.map(([id, name, icon, run]) => ({ id: 'act-' + id, name, size: 's', build: (c) => c.sq(icon, name, false, () => { c.close(); setTimeout(() => run(c), 300); }) })),
  ...INFO.map(([id, name, size, build, sizes]) => ({ id: 'info-' + id, name, size, sizes, build, menu: MENUS[id] })),
  ...PHONE_CONTROLS,
  vpnControl,
];

// Control Center widgets made in Widget Creator (size "cs" / "cw" / "cl"): shown like any control, with
// Edit in Widget Creator, Export and Delete on right-click
const CC_SPAN = { cs: 's', cw: 'w', cl: 'l' };
export function customControls() {
  return Object.values(customWidgets()).filter(isCC).map((spec) => ({
    id: 'custom:' + spec.id, name: spec.name, size: CC_SPAN[spec.size], custom: spec,
    build: () => renderCustom(h('div.cc-mod.cc-custom' + SPAN[CC_SPAN[spec.size]]), spec),
    menu: (c) => [
      { label: 'Edit in Widget Creator', action: () => { c.close(); c.wm.open('widgetcreator', { id: spec.id }); } },
      { label: 'Export…', action: async () => {
        const p = await api.dialog?.save({ title: 'Export Widget', name: `${spec.name.replace(/[/\\]/g, '-')}.ldwidget`, filters: [{ name: 'LiquidDesktop widget', patterns: ['*.ldwidget'] }] }).catch(() => null);
        if (p?.[0]) await api.fs.write(p[0], toFile(spec));
      } },
      '-',
      { label: 'Delete Widget', danger: true, action: () => { deleteCustom(spec.id); store.set('ccLayout', c.layout().filter((i) => i !== 'custom:' + spec.id)); c.render(); } },
    ],
  }));
}
/** Every control that can be added: the ones above and your own. */
export const allControls = () => [...EXTRA_CONTROLS, ...customControls()];
