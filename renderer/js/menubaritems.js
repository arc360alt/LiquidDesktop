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

export const DEFAULT_ITEMS = ['tray', 'battery', 'wifi', 'spotlight', 'cc', 'clock'];
export const menubarOrder = () => { const l = store.get('menubarItems'); return Array.isArray(l) && l.length ? l.filter((id) => ITEMS[id]) : DEFAULT_ITEMS; };

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

/* ------------------------------------------------------------------ editing */
// Edit Menu Bar: the items jiggle; drag one to move it; the panel under the menu bar adds and removes them.
let panel = null;
export function editingMenubar() { return !!panel; }
export function editMenubar(redraw) {
  if (panel) return;
  const area = $('#mb-status');
  area.classList.add('mb-editing');
  panel = h('div.mb-edit-panel.glass.panel.sheen');
  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  document.body.append(panel);
  const fill = () => {
    const shown = menubarOrder();
    const row = (id) => {
      const it = ITEMS[id], on = shown.includes(id);
      return h('div.mb-edit-row' + (on ? '.on' : ''), h('span.mb-edit-ic', { html: it.icon || sym.grid }), h('span.mb-edit-name', it.name, it.about ? h('small', it.about) : null),
        it.fixed ? h('small.mb-edit-fixed', 'Always shown') : h('button.mb-edit-btn' + (on ? '.rm' : '.add'), { title: on ? 'Remove' : 'Add', html: on ? sym.minus : sym.plus, onclick: () => {
          const next = on ? shown.filter((x) => x !== id) : [...shown.filter((x) => !ITEMS[x].fixed), id, ...shown.filter((x) => ITEMS[x].fixed)];
          store.set('menubarItems', next); redraw(); fill();
        } }));
    };
    panel.replaceChildren(
      h('div.mb-edit-head', h('b', 'Menu Bar'), h('small', 'Drag items in the menu bar to move them.')),
      h('div.mb-edit-sec', 'In the Menu Bar'), ...shown.map(row),
      h('div.mb-edit-sec', 'More Items'), ...Object.keys(ITEMS).filter((id) => !shown.includes(id)).map(row),
      h('div.mb-edit-foot', h('button.btn', { onclick: () => { store.set('menubarItems', null); redraw(); fill(); } }, 'Reset to Default'), h('div.spacer'), h('button.btn.primary', { onclick: () => stopEditing(redraw) }, 'Done')));
  };
  fill();
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  function outside(e) { if (!panel) return document.removeEventListener('mousedown', outside, true); if (!panel.contains(e.target) && !e.target.closest('#mb-status')) { document.removeEventListener('mousedown', outside, true); stopEditing(redraw); } }
}
function stopEditing(redraw) {
  if (!panel) return;
  const p = panel; panel = null;
  p.classList.add('closing'); setTimeout(() => p.remove(), 180);
  $('#mb-status')?.classList.remove('mb-editing');
  redraw();
}

/** While editing: drag an item along the menu bar to move it (the order is saved when it's dropped). */
export function dragMenubarItem(el, e, redraw) {
  const area = el.parentNode, sx = e.clientX;
  let moved = false;
  const mv = (ev) => {
    if (!moved && Math.abs(ev.clientX - sx) < 4) return;
    moved = true; el.classList.add('mb-dragging');
    // the item under the pointer: go before or after it
    const others = $$('[data-mb]', area).filter((x) => x !== el);
    for (const o of others) {
      const r = o.getBoundingClientRect();
      if (ev.clientX > r.left && ev.clientX < r.right) { area.insertBefore(el, ev.clientX < r.left + r.width / 2 ? o : o.nextSibling); break; }
    }
  };
  const up = () => {
    removeEventListener('mousemove', mv, true); removeEventListener('mouseup', up, true);
    el.classList.remove('mb-dragging');
    if (!moved) return;
    const order = $$('[data-mb]', area).map((x) => x.dataset.mb);
    // Control Center and the clock stay at the end, as on the Mac
    store.set('menubarItems', [...order.filter((id) => !ITEMS[id]?.fixed), ...order.filter((id) => ITEMS[id]?.fixed)]);
    redraw();
  };
  addEventListener('mousemove', mv, true); addEventListener('mouseup', up, true);
}
