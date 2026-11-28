// Window tiling, like macOS Tahoe: the layouts (halves, quarters, fill, centre), "Arrange" layouts that tile the
// window together with the ones behind it, and the menu that shows them as pictures (the green button's hover
// menu and Window › Move & Resize). Used by the testing window (wm.js) and the session (sessionwm.js); the
// geometry itself lives in each window manager.

// [kind, name, highlighted part of the screen as [x, y, w, h] fractions]
export const HALVES = [['left', 'Left', [0, 0, 0.5, 1]], ['right', 'Right', [0.5, 0, 0.5, 1]], ['top', 'Top', [0, 0, 1, 0.5]], ['bottom', 'Bottom', [0, 0.5, 1, 0.5]]];
export const QUARTERS = [['tl', 'Top Left', [0, 0, 0.5, 0.5]], ['tr', 'Top Right', [0.5, 0, 0.5, 0.5]], ['bl', 'Bottom Left', [0, 0.5, 0.5, 0.5]], ['br', 'Bottom Right', [0.5, 0.5, 0.5, 0.5]]];
// Arrange: the window takes the first place, the windows behind it (most recently used first) the others
export const ARRANGE = {
  lr: { name: 'Left & Right', places: ['left', 'right'] },
  rl: { name: 'Right & Left', places: ['right', 'left'] },
  tb: { name: 'Top & Bottom', places: ['top', 'bottom'] },
  bt: { name: 'Bottom & Top', places: ['bottom', 'top'] },
  lq: { name: 'Left & Quarters', places: ['left', 'tr', 'br'] },
  rq: { name: 'Right & Quarters', places: ['right', 'tl', 'bl'] },
  quarters: { name: 'Quarters', places: ['tl', 'tr', 'bl', 'br'] },
};
const PART = Object.fromEntries([...HALVES, ...QUARTERS].map(([k, , r]) => [k, r]));
PART.fill = [0, 0, 1, 1];
PART.center = [0.18, 0.12, 0.64, 0.76];

/** A small picture of a layout: the screen, with the window's place filled in (others outlined). */
export function layoutIcon(places) {
  const W = 26, H = 18, x0 = 1, y0 = 1, g = 1.2;
  const rect = (r, i) => {
    const x = x0 + g + r[0] * (W - 2 * g), y = y0 + g + r[1] * (H - 2 * g), w = r[2] * (W - 2 * g) - (r[0] + r[2] < 1 ? g / 2 : 0) - (r[0] > 0 ? g / 2 : 0), hh = r[3] * (H - 2 * g) - (r[1] + r[3] < 1 ? g / 2 : 0) - (r[1] > 0 ? g / 2 : 0);
    return `<rect x="${(x + (r[0] > 0 ? g / 2 : 0)).toFixed(2)}" y="${(y + (r[1] > 0 ? g / 2 : 0)).toFixed(2)}" width="${Math.max(1, w).toFixed(2)}" height="${Math.max(1, hh).toFixed(2)}" rx="1.4" ${i === 0 ? 'fill="currentColor"' : 'fill="currentColor" fill-opacity=".35"'}/>`;
  };
  return `<svg viewBox="0 0 28 20" width="28" height="20"><rect x="${x0}" y="${y0}" width="${W}" height="${H}" rx="3" fill="none" stroke="currentColor" stroke-opacity=".55" stroke-width="1.1"/>${places.map((p, i) => rect(PART[p], i)).join('')}</svg>`;
}

/**
 * The Move & Resize menu for a window. a = { tile(kind), arrange(id), fullscreen(), isFullscreen, canRestore, restore(),
 * spaces: [[name, current, go()]] }.
 */
export function tileMenuItems(a) {
  return [
    { header: 'Move & Resize' },
    { grid: [...HALVES, ...QUARTERS].map(([k, name]) => ({ title: name, icon: layoutIcon([k]), action: () => a.tile(k) })) },
    { header: 'Fill & Arrange' },
    { grid: [
      { title: 'Fill', icon: layoutIcon(['fill']), action: () => a.tile('fill') },
      { title: 'Center', icon: layoutIcon(['center']), action: () => a.tile('center') },
      ...Object.entries(ARRANGE).map(([id, x]) => ({ title: x.name, icon: layoutIcon(x.places), action: () => a.arrange(id) })),
    ] },
    '-',
    a.canRestore ? { label: 'Return to Previous Size', shortcut: '⌃⌘R', action: () => a.restore() } : null,
    { label: a.isFullscreen ? 'Exit Full Screen' : 'Enter Full Screen', shortcut: '⌃⌘F', action: () => a.fullscreen() },
    a.spaces?.length > 1 ? { label: 'Move to Desktop', submenu: a.spaces.map(([name, cur, go]) => ({ label: name, checked: cur, action: go })) } : null,
  ].filter(Boolean);
}

/**
 * Hold Alt (⌥) while dragging a window: where it would tile, from where the pointer is on the screen — a side
 * third gives a half (a quarter near its corners), the middle third gives the top / bottom half, the centre fills.
 * (x, y) are fractions of the monitor.
 */
export function zoneAt(x, y) {
  if (x < 1 / 3) return y < 0.25 ? 'tl' : y > 0.75 ? 'bl' : 'left';
  if (x > 2 / 3) return y < 0.25 ? 'tr' : y > 0.75 ? 'br' : 'right';
  return y < 1 / 3 ? 'top' : y > 2 / 3 ? 'bottom' : 'fill';
}
