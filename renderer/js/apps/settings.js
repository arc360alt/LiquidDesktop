// System Settings.
import { h, $$, fmtSize, fileUrl } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym, appIcon, appIconSVG, logoBadge } from '../icons.js';
import { store, defaults } from '../store.js';
import { api, isNative } from '../sys.js';
import { WALLPAPERS, wallpaperUrl } from '../wallpapers.js';
import { theme, isNightTime } from '../theme.js';
import { status } from '../status.js';
import { prompt, confirmDialog, alertDialog } from '../menus.js';
import { bus } from '../util.js';

const ACCENTS = [['Multicolor', '#0a84ff'], ['Blue', '#007aff'], ['Purple', '#af52de'], ['Pink', '#ff2d55'], ['Red', '#ff3b30'], ['Orange', '#ff9500'], ['Yellow', '#ffcc00'], ['Green', '#34c759'], ['Graphite', '#8e8e93']];

const PANES = [
  ['general', 'General', '#8e8e93', sym.gear], ['appearance', 'Appearance', '#1c1c1e', sym.contrast], ['wallpaper', 'Wallpaper', '#32ade6', sym.photo],
  ['dock', 'Desktop & Dock', '#1c1c1e', sym.dock], ['menubar', 'Menu Bar', '#0a84ff', sym.controls], ['display', 'Displays', '#0a84ff', sym.display],
  ['sound', 'Sound', '#ff2d55', sym.speaker], ['network', 'Wi-Fi', '#0a84ff', sym.wifi], ['bluetooth', 'Bluetooth', '#0a84ff', sym.bluetooth],
  ['notifications', 'Notifications', '#ff3b30', sym.bell], ['focus', 'Focus', '#5e5ce6', sym.moon], ['lock', 'Lock Screen', '#1c1c1e', sym.lock],
  ['keyboard', 'Keyboard', '#8e8e93', sym.keyboard], ['terminal', 'Terminal', '#1c1c1e', sym.terminal], ['apps', 'Apps', '#5e5ce6', sym.grid],
];

const toggle = (key, after) => h('label.toggle', h('input', { type: 'checkbox', checked: !!store.get(key), onchange: (e) => { store.set(key, e.target.checked); after?.(e.target.checked); } }), h('span'));
const row = (label, control, sub) => h('div.row', h('div.label', label, sub ? h('small', sub) : null), control);
const select = (key, opts, after) => h('select.field.square', { style: { height: '26px', minWidth: '140px' }, onchange: (e) => { const v = opts.find((o) => String(o[0]) === e.target.value)[0]; store.set(key, v); after?.(v); } },
  ...opts.map(([v, l]) => h('option', { value: v, selected: store.get(key) === v }, l)));
const seg = (key, opts, after) => {
  const el = h('div.segmented');
  const draw = () => { el.innerHTML = ''; for (const [v, l] of opts) el.append(h('button' + (store.get(key) === v ? '.on' : ''), { onclick: () => { store.set(key, v); draw(); after?.(v); } }, l)); };
  draw(); return el;
};
const range = (key, min, max, step = 1, fmt = (v) => v) => {
  const out = h('span.muted', { style: { width: '42px', textAlign: 'right', fontSize: '12px' } }, fmt(store.get(key)));
  const s = h('input.slider', { type: 'range', min, max, step, value: store.get(key) });
  const paint = () => s.style.setProperty('--v', ((s.value - min) / (max - min)) * 100 + '%');
  s.addEventListener('input', () => { paint(); out.textContent = fmt(+s.value); store.set(key, +s.value); });
  paint();
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', width: '230px' } }, s, out);
};
const liveSlider = (value, onInput) => {
  const s = h('input.slider', { type: 'range', min: 0, max: 100, value: value ?? 50 });
  const paint = () => s.style.setProperty('--v', s.value + '%');
  s.addEventListener('input', () => { paint(); onInput(+s.value); });
  paint();
  return h('div', { style: { width: '230px' } }, s);
};
const hero = (pane, title, text) => {
  const p = PANES.find((x) => x[0] === pane);
  return h('div.set-hero', h('div', { style: { width: '62px', height: '62px', borderRadius: '15px', background: p[2], color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 14px rgba(0,0,0,.2)' }, html: p[3].replace('class="sym"', 'style="width:34px;height:34px"') }), h('h2', title), h('p', text));
};

const render = {
  async general() {
    const i = await api.sys.info().catch(() => ({}));
    return [
      h('div.about-box', h('div.logo', { html: logoBadge() }), h('h2', 'LiquidDesktop'), h('div.ver', `Version ${i.version || '—'}`)),
      h('div.group', ...[['Name', i.host], ['User', `${i.fullName} (${i.user})`], ['Chip', i.cpu], ['Memory', i.memory ? fmtSize(i.memory) : '—'], ['Graphics', i.gpu || '—'], ['System', i.os], ['Kernel', i.kernel]]
        .map(([k, v]) => row(k, h('span.muted.ellipsis', { style: { maxWidth: '60%' } }, v || '—')))),
      h('div.group-title', 'Software Update'),
      softwareUpdateGroup(),
      h('div.group-title', 'Session'),
      h('div.group',
        row('Mode', h('span.muted', i.mode === 'session' ? 'Desktop session' : i.mode === 'windowed' ? 'Windowed (testing)' : 'Browser preview')),
        row('Reset all settings', h('button.btn', { onclick: async () => { if (await confirmDialog('Reset all settings?', 'Your Dock, wallpaper, widgets and preferences go back to their defaults. Notes and files are kept.', 'Reset', { danger: true })) store.reset(); } }, 'Reset…')),
        isNative ? row('Developer tools', h('button.btn', { onclick: () => api.shell.devtools() }, 'Open')) : null),
    ];
  },
  appearance() {
    const card = (v, label, bg, fg) => h('div.theme-card' + (store.get('theme') === v ? '.sel' : ''), { onclick: () => { store.set('theme', v); rerender(); } },
      h('div.pv', { style: { background: bg } }, h('i', { style: { background: fg } })), label);
    const iconCard = (v, label) => {
      const prev = store.get('iconStyle');
      return h('div.theme-card' + (prev === v ? '.sel' : ''), { onclick: () => { store.set('iconStyle', v); rerender(); } },
        h('div.pv', { style: { background: 'linear-gradient(135deg,#7cc7ff,#8a4dff)', padding: '6px' }, html: appIconSVG('files', v) }), label);
    };
    return [
      hero('appearance', 'Appearance', 'Choose how LiquidDesktop looks — light, dark or automatic with the time of day, and how much glass you see.'),
      h('div.group',
        row('Appearance', h('div.theme-cards', card('light', 'Light', 'linear-gradient(135deg,#8ec5ff,#3d7fe0)', '#f6f6f8'), card('dark', 'Dark', 'linear-gradient(135deg,#0b1a3f,#06143a)', '#232326'), card('auto', 'Auto', 'linear-gradient(90deg,#8ec5ff 50%,#0b1a3f 50%)', 'linear-gradient(90deg,#f6f6f8 50%,#232326 50%)'))),
        row('Accent color', h('div.accent-row', ...ACCENTS.map(([n, c]) => h('button' + (store.get('accent') === c ? '.sel' : ''), { title: n, style: { background: n === 'Multicolor' ? 'conic-gradient(#ff3b30,#ffcc00,#34c759,#0a84ff,#af52de,#ff3b30)' : c }, onclick: () => { store.set('accent', c); rerender(); } })))),
        row('Liquid Glass', seg('glass', [['clear', 'Clear'], ['tinted', 'Tinted']]), 'Clear shows more of what’s behind; Tinted is frostier and easier to read.'),
        row('Glass refraction', toggle('refraction'), 'Bend the background at the edges of glass, like a real lens.'),
        row('Reduce transparency', toggle('reduceTransparency'))),
      h('div.group-title', 'Icon & widget style'),
      h('div.group', row('Icons', h('div.icon-style-cards', iconCard('default', 'Default'), iconCard('dark', 'Dark'), iconCard('clear', 'Clear'), iconCard('tinted', 'Tinted'))),
        row('Uniform Linux app icons', toggle('uniformIcons'), 'Place icons of installed Linux apps on a rounded square.')),
    ];
  },
  wallpaper() {
    const grid = h('div.wall-grid.labels');
    for (const [id, w] of Object.entries(WALLPAPERS)) {
      const t = h('div.wall-thumb' + (!store.get('customWallpaper') && store.get('wallpaper') === id ? '.sel' : ''),
        { style: { backgroundImage: `url("${wallpaperUrl(id, 320, 200, theme.dark && store.get('dynamicWallpaper'))}")` }, onclick: () => { store.set('customWallpaper', ''); store.set('wallpaper', id); rerender(); } }, h('span', w.name));
      grid.append(t);
    }
    const custom = store.get('customWallpaper');
    return [
      h('div.group', { style: { padding: '14px', display: 'flex', gap: '14px', alignItems: 'center' } },
        h('div.wall-thumb', { style: { width: '180px', backgroundImage: `url("${custom || wallpaperUrl(store.get('wallpaper'), 320, 200, theme.dark && store.get('dynamicWallpaper'))}")` } }),
        h('div', h('b', custom ? 'Custom image' : WALLPAPERS[store.get('wallpaper')]?.name), h('div.muted', { style: { fontSize: '12px', marginTop: '4px' } }, store.get('dynamicWallpaper') ? 'Dynamic — changes with light and dark mode' : 'Still'))),
      h('div.group', row('Dynamic wallpaper', toggle('dynamicWallpaper'), 'Switch to the night palette in dark mode.'),
        row('Use an image file', h('button.btn', { onclick: async () => {
          const home = await api.fs.home();
          const p = await prompt('Choose a wallpaper image', home + '/Pictures/', { ok: 'Set Wallpaper', message: 'Path to a PNG, JPG or WebP image. Tip: use “Set as Wallpaper” in Preview.' });
          if (p) { store.set('customWallpaper', fileUrl(p)); rerender(); }
        } }, 'Choose…'))),
      h('div.group-title', 'LiquidDesktop wallpapers'),
      h('div.group', grid),
    ];
  },
  dock() {
    const corners = [['none', '—'], ['mission', 'Mission Control'], ['desktop', 'Show Desktop'], ['launchpad', 'Apps'], ['notifications', 'Notification Center'], ['spotlight', 'Spotlight'], ['lock', 'Lock Screen']];
    const corner = (k, label) => h('select.field.square', { style: { height: '26px' }, onchange: (e) => store.set('hotCorners', { ...store.get('hotCorners'), [k]: e.target.value }) },
      ...corners.map(([v, l]) => h('option', { value: v, selected: store.get('hotCorners')[k] === v }, l)));
    return [
      hero('dock', 'Desktop & Dock', 'Size and behavior of the Dock, windows, Spaces and hot corners.'),
      h('div.group',
        row('Size', range('dockSize', 36, 80, 1, (v) => v + 'px')),
        row('Magnification', toggle('dockMagnify')),
        row('Magnified size', range('dockMagSize', 48, 128, 1, (v) => v + 'px')),
        row('Automatically hide and show the Dock', toggle('dockAutohide'))),
      h('div.group-title', 'Desktop & Windows'),
      h('div.group',
        row('Show files on the desktop', toggle('showDesktopIcons')),
        row('Drag windows to screen edges to tile', toggle('windowTiling')),
        row('Desktops (Spaces)', h('span.muted', `${wm.spaceEls.length}  `), 'Add or remove them in Mission Control (F3).'),
        row('Widgets', h('button.btn', { onclick: () => import('../desktop.js').then((m) => m.editWidgets()) }, 'Edit Widgets…'))),
      h('div.group-title', 'Hot Corners'),
      h('div.group', row('Top left', corner('tl')), row('Top right', corner('tr')), row('Bottom left', corner('bl')), row('Bottom right', corner('br'))),
    ];
  },
  menubar() {
    return [
      hero('menubar', 'Menu Bar', 'What the clock and status items show.'),
      h('div.group', row('Use a 24-hour clock', toggle('clock24')), row('Show seconds', toggle('showSeconds')), row('Show battery percentage', toggle('showBatteryPct'))),
    ];
  },
  async display() {
    const b = status.s.brightness;
    let info = { backend: 'none', displays: [] };
    try { info = await api.sys.displays(); } catch { /* backend unavailable */ }
    const ds = info.displays;
    const enabled = ds.filter((d) => d.enabled);
    if (!displayState.sel || !ds.some((d) => d.name === displayState.sel)) displayState.sel = (ds.find((d) => d.primary) || ds[0])?.name;
    const sel = ds.find((d) => d.name === displayState.sel);
    // working copy of the selected display's settings
    const draft = sel ? { ...sel, ...(displayState.draft?.name === sel.name ? displayState.draft : {}) } : null;
    displayState.draft = draft;

    // arrangement preview: monitors drawn to scale; click one to edit it
    const arr = h('div.disp-arrange');
    if (enabled.length) {
      const ext = (d) => (d.rotation % 180 ? [d.height, d.width] : [d.width, d.height]).map((v) => v / (d.scale || 1));
      const minX = Math.min(...enabled.map((d) => d.x)), minY = Math.min(...enabled.map((d) => d.y));
      const maxX = Math.max(...enabled.map((d) => d.x + ext(d)[0])), maxY = Math.max(...enabled.map((d) => d.y + ext(d)[1]));
      const k = Math.min(430 / (maxX - minX || 1), 140 / (maxY - minY || 1));
      const box = h('div.disp-canvas', { style: { width: (maxX - minX) * k + 'px', height: (maxY - minY) * k + 'px' } });
      for (const d of enabled) {
        const [w, hh] = ext(d);
        box.append(h('div.disp-mon' + (d.name === displayState.sel ? '.sel' : ''), { style: { left: (d.x - minX) * k + 'px', top: (d.y - minY) * k + 'px', width: w * k - 4 + 'px', height: hh * k - 4 + 'px' },
          onclick: () => { displayState.sel = d.name; displayState.draft = null; rerender(); } }, h('b', d.name), h('small', `${d.width}×${d.height}`), d.primary ? h('i', 'Main') : null));
      }
      arr.append(box);
    }
    const disabledList = ds.filter((d) => !d.enabled);
    const tabs = h('div.segmented', ...ds.map((d) => h('button' + (d.name === displayState.sel ? '.on' : ''), { onclick: () => { displayState.sel = d.name; displayState.draft = null; rerender(); } }, d.name + (d.enabled ? '' : ' (off)'))));

    const out = [hero('display', 'Displays', info.backend === 'hyprland' ? 'Arrange and configure your monitors. (Running inside Hyprland: changes last until Hyprland restarts.)'
      : info.backend === 'x11' ? 'Arrange and configure your monitors. Changes are remembered for your next login.' : 'Display configuration needs xrandr (X11) or Hyprland.')];
    if (ds.length) {
      out.push(h('div.group', { style: { padding: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' } }, arr, ds.length > 1 ? tabs : null,
        disabledList.length ? h('small.muted', `${disabledList.length} connected display${disabledList.length > 1 ? 's are' : ' is'} turned off — select it above to turn it on.`) : null));
    }
    if (draft) {
      const mode = draft.modes.find((m) => m.width === draft.width && m.height === draft.height) || draft.modes[0];
      const set = (patch) => { Object.assign(draft, patch); displayState.draft = draft; rerender(); };
      const resSel = h('select.field.square', { style: { height: '28px', minWidth: '190px' }, onchange: (e) => { const m = draft.modes[+e.target.value]; set({ width: m.width, height: m.height, refresh: m.rates[0] }); } },
        ...draft.modes.map((m, i) => h('option', { value: i, selected: m === mode }, `${m.width} × ${m.height}${i === 0 ? '  (largest)' : ''}`)));
      const rateSel = h('select.field.square', { style: { height: '28px', minWidth: '190px' }, onchange: (e) => set({ refresh: +e.target.value }) },
        ...(mode?.rates || []).map((r) => h('option', { value: r, selected: Math.abs(r - draft.refresh) < 0.05 }, `${r.toFixed(r % 1 ? 2 : 0)} Hz`)));
      const scaleSel = h('select.field.square', { style: { height: '28px', minWidth: '190px' }, onchange: (e) => set({ scale: +e.target.value }) },
        ...[1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((v) => h('option', { value: v, selected: Math.abs(v - draft.scale) < 0.01 }, `${Math.round(v * 100)}%${v === 1 ? '  (default)' : ''}`)));
      const rotSel = h('select.field.square', { style: { height: '28px', minWidth: '190px' }, onchange: (e) => set({ rotation: +e.target.value }) },
        ...[[0, 'Standard'], [90, '90°'], [180, '180°'], [270, '270°']].map(([v, l]) => h('option', { value: v, selected: draft.rotation === v }, l)));
      const others = enabled.filter((d) => d.name !== draft.name);
      const posSel = others.length ? h('select.field.square', { style: { height: '28px', minWidth: '190px' }, onchange: (e) => {
        const [where, ref] = e.target.value.split(':');
        const o = others.find((d) => d.name === ref);
        if (!o) return;
        const ow = o.rotation % 180 ? o.height : o.width, oh = o.rotation % 180 ? o.width : o.height;
        const dw = draft.rotation % 180 ? draft.height : draft.width, dh = draft.rotation % 180 ? draft.width : draft.height;
        set({ x: where === 'right' ? o.x + ow / (o.scale || 1) : where === 'left' ? o.x - dw / (draft.scale || 1) : o.x, y: where === 'below' ? o.y + oh / (o.scale || 1) : where === 'above' ? o.y - dh / (draft.scale || 1) : o.y });
      } }, h('option', { value: '' }, `Current (${Math.round(draft.x)}, ${Math.round(draft.y)})`),
        ...others.flatMap((o) => [['right', 'Right of'], ['left', 'Left of'], ['above', 'Above'], ['below', 'Below']].map(([w, l]) => h('option', { value: `${w}:${o.name}` }, `${l} ${o.name}`)))) : null;
      const changed = ['width', 'height', 'refresh', 'scale', 'rotation', 'x', 'y', 'enabled', 'primary'].some((k) => draft[k] !== sel[k]);
      out.push(h('div.group-title', `${draft.label !== draft.name ? draft.label + ' — ' : ''}${draft.name}`),
        h('div.group',
          ds.length > 1 ? row('Use this display', h('label.toggle', h('input', { type: 'checkbox', checked: draft.enabled, onchange: (e) => set({ enabled: e.target.checked, ...(e.target.checked && !draft.width ? { width: draft.modes[0].width, height: draft.modes[0].height, refresh: draft.modes[0].rates[0] } : {}) }) }), h('span'))) : null,
          draft.enabled ? row('Resolution', resSel) : null,
          draft.enabled ? row('Refresh rate', rateSel) : null,
          draft.enabled && info.backend === 'hyprland' ? row('Scale', scaleSel, 'Makes text and controls bigger on high-resolution screens') : null,
          draft.enabled ? row('Rotation', rotSel) : null,
          draft.enabled && posSel ? row('Position', posSel) : null,
          draft.enabled && info.backend === 'x11' && ds.length > 1 ? row('Main display', h('label.toggle', h('input', { type: 'checkbox', checked: draft.primary, onchange: (e) => set({ primary: e.target.checked }) }), h('span')), 'Holds the menu bar and Dock') : null,
          h('div.row', h('div.label', changed ? h('small', 'You have unapplied changes.') : null),
            h('button.btn', { disabled: !changed, onclick: () => { displayState.draft = null; rerender(); } }, 'Revert'),
            h('button.btn.primary', { disabled: !changed, onclick: () => applyDisplay(sel, draft) }, 'Apply'))));
    }
    out.push(h('div.group-title', 'Brightness & color'),
      h('div.group',
        row('Brightness', b != null ? liveSlider(b, (v) => api.sys.setBrightness(v)) : liveSlider(store.get('softBrightness') ?? 100, (v) => { store.set('softBrightness', v); document.getElementById('desktop') && (document.getElementById('desktop').style.filter = v >= 100 ? '' : `brightness(${0.35 + 0.65 * v / 100})`); }),
          b != null ? 'Controls the backlight with brightnessctl.' : 'No backlight control found — dims the desktop instead.'),
        row('Night Shift', toggle('nightShift'), 'Warmer colors after dark, easier on the eyes.')),
      h('div.group-title', 'Window'),
      h('div.group', row('Toggle full screen (testing window)', h('button.btn', { onclick: () => api.shell.toggleFullscreen() }, 'Toggle'))));
    return out;
  },
  sound() {
    const v = status.s.volume;
    return [
      hero('sound', 'Sound', v ? 'Output volume of the default audio device (PipeWire / PulseAudio).' : 'No audio control found (needs wpctl or pactl).'),
      h('div.group',
        row('Output volume', liveSlider(v?.level, (x) => { api.sys.setVolume(x); status.patch({ volume: { level: x, muted: false } }); })),
        row('Mute', h('label.toggle', h('input', { type: 'checkbox', checked: !!v?.muted, onchange: (e) => { api.sys.setMute(e.target.checked); status.patch({ volume: { ...v, muted: e.target.checked } }); } }), h('span')))),
    ];
  },
  async network() {
    const w = status.s.wifi;
    const list = h('div.group', row(h('span.muted', 'Scanning…'), null));
    api.sys.wifiList().then((nets) => {
      list.innerHTML = '';
      if (!nets.length) list.append(row(h('span.muted', 'No networks'), null));
      for (const n of nets) list.append(h('div.row.link', { onclick: async () => {
        if (n.active) return;
        let r = await api.sys.wifiConnect(n.ssid);
        if (r && !r.ok && n.secure) { const pw = await prompt(`Enter the password for “${n.ssid}”`, '', { type: 'password', ok: 'Join' }); if (pw) r = await api.sys.wifiConnect(n.ssid, pw); }
        status.refresh(); setTimeout(rerender, 800);
      } }, h('span', { html: sym.wifi, style: { width: '18px', opacity: n.signal / 100 + 0.3, color: 'var(--accent)' } }), h('div.label', n.ssid, n.active ? h('small', 'Connected') : null), n.secure ? h('span', { html: sym.lock, style: { width: '14px', opacity: 0.5 } }) : null, h('span.muted', n.signal + '%')));
    }).catch(() => { list.innerHTML = ''; list.append(row(h('span.muted', 'NetworkManager (nmcli) not available'), null)); });
    return [
      hero('network', 'Wi-Fi', w?.ssid ? `Connected to ${w.ssid}` : w?.wired ? 'Connected via Ethernet' : 'Not connected'),
      h('div.group', row('Wi-Fi', h('label.toggle', h('input', { type: 'checkbox', checked: !!w?.enabled, onchange: async (e) => { await api.sys.wifiPower(e.target.checked); status.refresh(); setTimeout(rerender, 1500); } }), h('span')))),
      h('div.group-title', 'Networks'), list,
    ];
  },
  bluetooth() {
    const b = status.s.bluetooth;
    return [
      hero('bluetooth', 'Bluetooth', b ? 'Turn Bluetooth on or off. Pair devices with your system’s Bluetooth tool.' : 'No Bluetooth controller found (bluetoothctl).'),
      h('div.group', row('Bluetooth', h('label.toggle', h('input', { type: 'checkbox', disabled: !b, checked: !!b?.powered, onchange: async (e) => { await api.sys.bluetoothPower(e.target.checked); status.refresh(); } }), h('span')))),
    ];
  },
  notifications() {
    return [
      hero('notifications', 'Notifications', 'Banners appear in the top-right corner and collect in Notification Center (click the clock).'),
      h('div.group', row('Do Not Disturb', toggle('dnd'), 'Silence banners. They still collect in Notification Center.'),
        row('Send a test notification', h('button.btn', { onclick: () => import('../shell.js').then(({ shell }) => shell.notify({ app: 'settings', title: 'Hello from LiquidDesktop', body: 'Notifications look like this. Click to dismiss.' })) }, 'Send'))),
    ];
  },
  focus() {
    return [hero('focus', 'Focus', 'Focus silences notifications so you can concentrate.'), h('div.group', row('Do Not Disturb', toggle('dnd')))];
  },
  lock() {
    return [
      hero('lock', 'Lock Screen', 'Lock with ⌃⌘Q / Ctrl+Alt+Q, from the system menu, or a hot corner.'),
      h('div.group', row('Require password to unlock', toggle('requirePassword'), isNative ? 'Checked against your Linux account password.' : 'Unavailable in the browser preview.'),
        row('Lock now', h('button.btn', { onclick: () => import('../shell.js').then(({ shell }) => shell.lock()) }, 'Lock Screen'))),
    ];
  },
  keyboard() {
    const sc = [
      ['Spotlight', 'Alt+Space  ·  Super+Space'], ['Switch apps', 'Alt+Tab'], ['Cycle windows of an app', 'Alt+`'], ['Mission Control', 'F3  ·  Ctrl+↑'], ['Apps (Launchpad)', 'F4'],
      ['Show Desktop', 'F11'], ['Switch Desktop', 'Ctrl+← / Ctrl+→'], ['Tile window', 'Alt+Shift+← → ↑ ↓'], ['New window', 'Alt+N'], ['Close window', 'Alt+W'],
      ['Minimize', 'Alt+M'], ['Hide app', 'Alt+H'], ['Quit app', 'Alt+Q'], ['Settings', 'Alt+,'], ['Screenshot', 'Alt+Shift+3  ·  PrtSc'], ['Lock Screen', 'Ctrl+Alt+Q'],
      ['Full screen (testing window)', 'Ctrl+Shift+F'], ['Developer tools', 'Ctrl+Shift+I'],
    ];
    return [hero('keyboard', 'Keyboard Shortcuts', 'Alt stands in for ⌘ (Super works too, when your compositor lets it through).'),
      h('div.group', ...sc.map(([a, k]) => row(a, h('span.kbd', k))))];
  },
  async terminal() {
    const [sh, fonts] = await Promise.all([api.sys.shells().catch(() => ({ shells: [], default: '/bin/bash' })), api.sys.monoFonts().catch(() => [])]);
    const shellOpts = [['', `Login shell (${sh.default})`], ...sh.shells.map((s) => [s, s])];
    const fontOpts = [['', 'Automatic'], ...fonts.map((f) => [f, f])];
    const cwd = h('input.field.square', { value: store.get('terminalCwd') || '', placeholder: 'Home folder', style: { width: '220px' } });
    cwd.addEventListener('change', () => store.set('terminalCwd', cwd.value.trim()));
    return [
      hero('terminal', 'Terminal', 'How new Terminal windows start and look. Font and cursor changes apply to open windows right away.'),
      h('div.group-title', 'Shell'),
      h('div.group',
        row('Shell', select('terminalShell', shellOpts), 'Takes effect in new windows'),
        row('Run as a login shell', toggle('terminalLogin'), 'Reads ~/.bash_profile, ~/.zprofile… like a terminal login'),
        row('Start in', cwd)),
      h('div.group-title', 'Appearance'),
      h('div.group',
        row('Profile', seg('terminalTheme', [['glass', 'Glass'], ['dark', 'Dark'], ['light', 'Light']])),
        row('Font', select('terminalFont', fontOpts)),
        row('Font size', range('terminalFontSize', 8, 28, 1, (v) => v + ' pt')),
        row('Cursor', seg('terminalCursor', [['bar', 'Bar'], ['block', 'Block'], ['underline', 'Underline']])),
        row('Blinking cursor', toggle('terminalBlink')),
        row('Scrollback', select('terminalScrollback', [[1000, '1,000 lines'], [5000, '5,000 lines'], [10000, '10,000 lines'], [50000, '50,000 lines']]))),
      h('div.group', row('Open a Terminal', h('button.btn', { onclick: () => wm.open('terminal') }, 'New Window'))),
    ];
  },
  apps() {
    return [
      hero('apps', 'Apps', 'Defaults for built-in apps.'),
      h('div.group-title', 'Terminal'),
      h('div.group', h('div.row.link', { onclick: () => wm.open('settings', { pane: 'terminal' }) }, h('div.label', 'Terminal settings…', h('small', 'Shell, font, cursor, colors')), h('span.muted', '›'))),
      h('div.group-title', 'Weather'),
      h('div.group', row('Location', h('span.muted', store.get('weatherCity')?.name || 'Automatic'), 'Search for a city in the Weather app to change it.')),
    ];
  },
};

let rerender = () => {};

// Settings › General › Software Update
export function runUpdate(command) {
  // runs in a Terminal window, so you can see progress and type your password if it's needed
  wm.open('terminal', { command: `LIQUID_UPDATE_PAUSE=1 ${command}` });
}
function softwareUpdateGroup() {
  const status = h('div.label', 'LiquidDesktop', h('small', 'Checking for updates…'));
  const action = h('div', { style: { display: 'flex', gap: '8px' } });
  const changes = h('div');
  const group = h('div.group', h('div.row', h('div', { html: logoBadge(), style: { width: '36px', height: '36px', flex: 'none' } }), status, action), changes);
  const check = async () => {
    action.innerHTML = '';
    status.lastChild.textContent = 'Checking for updates…';
    try {
      const u = await api.sys.updateCheck();
      store.set('lastUpdateCheck', Date.now());
      const ver = `Version ${u.version}${u.current ? ` (${u.current})` : ''}`;
      if (u.upToDate) status.lastChild.textContent = `${ver} — up to date`;
      else if (!u.current) status.lastChild.textContent = `${ver} — latest is ${u.latest}: ${u.message}`;
      else status.lastChild.textContent = `${ver} — ${u.behind ?? 'new'} update${u.behind === 1 ? '' : 's'} available`;
      if (!u.upToDate) action.append(h('button.btn.primary', { onclick: () => runUpdate(u.command) }, u.current ? 'Update Now' : 'Install Latest'));
      action.append(h('button.btn', { onclick: check }, 'Check Again'));
      changes.innerHTML = '';
      if (!u.upToDate && u.changes?.length) changes.append(...u.changes.map((c) => h('div.row', h('div.label', h('small', '• ' + c)))));
    } catch (err) {
      status.lastChild.textContent = `Couldn’t check for updates (${err.message})`;
      action.append(h('button.btn', { onclick: check }, 'Try Again'));
    }
  };
  setTimeout(check, 50);
  return group;
}
const displayState = { sel: null, draft: null };

// apply, then ask to keep the change — it reverts by itself after 15 seconds (in case the screen went blank)
async function applyDisplay(before, after) {
  const r = await api.sys.setDisplay(after.name, after).catch((e) => ({ ok: false, err: e.message }));
  if (r && r.ok === false) { alertDialog({ title: 'Couldn’t change the display', message: r.err || 'The display rejected that setting.' }); return; }
  let n = 15, settled = false;
  const p = alertDialog({ title: 'Keep these display settings?', message: `Reverting in ${n} seconds.`, buttons: [{ label: 'Revert', value: 'revert' }, { label: 'Keep Changes', value: 'keep', primary: true }] });
  const t = setInterval(() => { n--; const m = document.querySelector('.global-alert-layer .alert p'); if (m) m.textContent = `Reverting in ${n} seconds.`; if (n <= 0 && !settled) document.querySelector('.global-alert-layer .btn:not(.primary)')?.click(); }, 1000);
  const res = await p;
  settled = true; clearInterval(t);
  if (res.button !== 'keep') await api.sys.setDisplay(before.name, before).catch(() => {});
  displayState.draft = null;
  setTimeout(rerender, 400);
}

registerApp({
  id: 'settings', name: 'System Settings', size: [780, 620], minSize: [620, 420], singleton: true, overlayContent: true, hideTitle: true,
  keywords: ['preferences', 'control panel', 'config', 'options'],
  open(win, args) {
    const sb = h('div.sidebar', { style: { width: '230px' } });
    win.dragRegion(sb);
    const pane = h('div.settings-pane');
    const title = h('div.win-title', { style: { fontSize: '15px' } });
    win.toolbar.style.marginLeft = '160px';
    win.toolbar.append(h('div.tb-group', h('button.tb-btn', { html: sym.back, onclick: () => hist.length > 1 && (hist.pop(), show(hist.pop())) })), title);
    const search = h('input.field', { placeholder: 'Search', style: { height: '30px', width: '100%' } });
    sb.append(h('div.search-field', { html: sym.search, style: { width: '100%', marginBottom: '8px' } }, search));
    const userRow = h('div.sb-item', { style: { height: '50px', marginBottom: '6px' } });
    api.sys.info().then((i) => { userRow.innerHTML = ''; userRow.append(h('div', { style: { width: '34px', height: '34px', borderRadius: '50%', background: 'linear-gradient(#a1a1aa,#71717a)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600 } }, (i.fullName || 'U')[0]), h('div', h('b', i.fullName), h('div.muted', { style: { fontSize: '11px' } }, i.host))); }).catch(() => {});
    sb.append(userRow);
    const items = h('div');
    sb.append(items);
    const drawSidebar = () => {
      const q = search.value.toLowerCase();
      items.innerHTML = '';
      for (const [id, label, color, icon] of PANES) {
        if (q && !label.toLowerCase().includes(q)) continue;
        const el = h('div.sb-item', { 'data-pane': id, onclick: () => show(id) }, h('div.ic.sq', { style: { background: color }, html: icon }), label);
        items.append(el);
      }
      $$('.sb-item', items).forEach((el) => el.classList.toggle('sel', el.dataset.pane === current));
    };
    search.addEventListener('input', drawSidebar);
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') items.querySelector('.sb-item')?.click(); });
    let current = null;
    const hist = [];
    const show = async (id) => {
      current = id; hist.push(id);
      drawSidebar();
      const label = PANES.find((p) => p[0] === id)?.[1];
      title.textContent = label; win.setTitle(label);
      const kids = await render[id]();
      if (current !== id) return;
      pane.innerHTML = '';
      pane.append(h('div.inner', ...kids.filter(Boolean)));
    };
    rerender = () => { if (win.el.isConnected && current) { const top = pane.scrollTop; show(current).then(() => (pane.scrollTop = top)); hist.pop(); } };
    win.body.append(sb, h('div.main-pane', pane));
    win.on('reopen', (a) => a?.pane && show(a.pane));
    const off = bus.on('status', () => { if (['sound', 'display', 'bluetooth'].includes(current) && !pane.matches(':active')) {} });
    win.on('close', off);
    show(args.pane || 'appearance');
  },
});
