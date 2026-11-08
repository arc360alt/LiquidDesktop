// Which part of the desktop this page is. One web app, several layers:
//   full     — everything in one window (npm start, testing)
//   desktop  — wallpaper, widgets and desktop icons (session, bottom of the stack)
//   shell    — menu bar, Dock and popovers (session, top of the stack)
//   app      — a single built-in app in its own real window (session)
//   frame    — the title bar around a native Linux app's window (session)
const q = new URLSearchParams(location.search);
export const layer = q.get('layer') || document.documentElement.dataset.layer || 'full';
export const params = q;
export const isSession = q.get('mode') === 'session';
export const session = window.sys?.session || null;
document.documentElement.dataset.layer = layer;
