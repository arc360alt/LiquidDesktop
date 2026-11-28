// Settings › Accessibility: seeing (screen reader, Zoom, contrast, motion, the pointer) and the keyboard (Sticky,
// Slow and Bounce Keys). The shell does the work (renderer/js/a11y.js, main/a11y.js); this pane is the switches.
import { h } from '../util.js';
import { store } from '../store.js';
import { api } from '../sys.js';
import { isSession } from '../layer.js';

export async function accessibilityPane({ row, toggle, hero, rerender, askSudo, alertDialog }) {
  const st = await api.a11y?.status?.().catch(() => null) || {};
  const sliderRow = (key, min, max, step, def, fmt, after) => {
    const v = store.get(key) ?? def;
    const out = h('span.muted', { style: { width: '46px', textAlign: 'right', fontSize: '12px' } }, fmt(v));
    const s = h('input.slider', { type: 'range', min, max, step, value: v });
    const paint = () => s.style.setProperty('--v', ((s.value - min) / (max - min)) * 100 + '%');
    s.addEventListener('input', () => { paint(); out.textContent = fmt(+s.value); });
    s.addEventListener('change', () => { store.set(key, +s.value); after?.(+s.value); });
    paint();
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', width: '230px' } }, s, out);
  };

  // the screen reader: Orca (installed on demand)
  const srOn = !!store.get('screenReader') && st.orcaRunning !== false;
  const sr = st.orca
    ? h('label.toggle', h('input', { type: 'checkbox', checked: srOn, onchange: async (e) => {
      const on = e.target.checked;
      try { await api.a11y.screenReader(on); store.set('screenReader', on); } catch (err) { e.target.checked = !on; alertDialog({ title: 'The screen reader couldn’t start', message: err.message }); }
    } }), h('span'))
    : h('button.btn', { onclick: async (e) => {
      if (!(await askSudo('Installing the screen reader (Orca) needs your password.'))) return;
      e.target.disabled = true; e.target.textContent = 'Installing…';
      try { await api.a11y.installOrca(); await api.a11y.screenReader(true); store.set('screenReader', true); } catch (err) { alertDialog({ title: 'The screen reader couldn’t be installed', message: err.message }); }
      rerender();
    } }, 'Install…');

  const lensSizes = [['small', 'Small', 380, 240], ['medium', 'Medium', 520, 320], ['large', 'Large', 720, 440]];
  const curLens = lensSizes.find((l) => l[2] === (store.get('zoomW') || 520))?.[0] || 'medium';
  const lensSeg = h('div.segmented', ...lensSizes.map(([k, l, w, hh]) => h('button' + (curLens === k ? '.on' : ''), { onclick: () => { store.set('zoomW', w); store.set('zoomH', hh); rerender(); } }, l)));

  const keysNote = isSession ? null : 'Works in a LiquidDesktop session (not in a window).';
  // the pointer: the X cursor too (Settings › Mouse does the same), not only LiquidDesktop's own windows
  const pointer = sliderRow('cursorSize', 24, 96, 8, 48, (v) => (v <= 32 ? 'Small' : v <= 48 ? 'Normal' : v <= 64 ? 'Large' : 'Largest'), (v) => api.sys.cursorApply?.(store.get('cursorTheme') || 'MacOS-Tahoe-Cursor', v).catch(() => {}));

  return [
    hero('accessibility', 'Accessibility', 'Make LiquidDesktop easier to see, hear about and use: a screen reader, a magnifier, more contrast, less motion, a bigger pointer, and keys that are easier to press.'),
    h('div.group-title', 'Vision'),
    h('div.group',
      row('Screen reader', sr, st.orca ? 'Orca reads out what’s on the screen and what you type. Its own keys: Insert (or Caps Lock) with other keys; Insert+S turns speech off and on.' : 'Reads out what’s on the screen. Needs Orca (a free screen reader), installed with your password.'),
      row('Zoom', toggle('zoomOn'), 'A magnifying lens next to the pointer. Super+Alt+8 turns it on and off; Super+Alt+= and Super+Alt+− zoom in and out.'),
      row('Zoom level', sliderRow('zoomLevel', 1.5, 8, 0.5, 2, (v) => `${v}×`)),
      row('Lens size', lensSeg)),
    h('div.group-title', 'Display'),
    h('div.group',
      row('Increase contrast', toggle('increaseContrast'), 'Stronger edges around buttons, windows and controls, darker gray text, more solid glass.'),
      row('Reduce transparency', toggle('reduceTransparency'), 'Solid backgrounds instead of glass.'),
      row('Reduce motion', toggle('reduceMotion'), 'No sliding, zooming or bouncing: windows, menus and Mission Control simply appear.'),
      row('Pointer size', pointer)),
    h('div.group-title', 'Keyboard'),
    h('div.group',
      row('Sticky Keys', toggle('stickyKeys'), keysNote || 'Press Shift, Ctrl, Alt or Super, then the other key — no need to hold them together. Press a modifier twice to keep it down.'),
      row('Slow Keys', toggle('slowKeys', () => rerender()), keysNote || 'A key only counts when you hold it for a moment, so brushing a key doesn’t type it.'),
      store.get('slowKeys') ? row('Slow Keys delay', sliderRow('slowKeysDelay', 100, 1500, 50, 300, (v) => `${(v / 1000).toFixed(2)} s`)) : null,
      row('Bounce Keys', toggle('bounceKeys', () => rerender()), keysNote || 'Ignores a key pressed again very quickly, so a shaky press doesn’t type twice.'),
      store.get('bounceKeys') ? row('Bounce Keys delay', sliderRow('bounceKeysDelay', 100, 1500, 50, 300, (v) => `${(v / 1000).toFixed(2)} s`)) : null),
  ];
}
