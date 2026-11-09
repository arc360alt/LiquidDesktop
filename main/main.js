// LiquidDesktop — Electron entry point.
//   electron . --windowed   the whole desktop inside one normal window (for testing)
//   electron . --session    the real desktop on an X11 display (see main/session.js)
const { app, BrowserWindow, screen, session } = require('electron');
const path = require('path');
const system = require('./system');

const argv = process.argv.slice(1);
const mode = argv.includes('--session') ? 'session' : 'windowed';
const sizeArg = (argv.find((a) => a.startsWith('--size=')) || '').slice(7);
const preload = path.join(__dirname, 'preload.js');

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
if (mode === 'session') {
  // the session is an X11 window manager, so Chromium must talk X11 even if a Wayland socket is around
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  delete process.env.WAYLAND_DISPLAY;
}
app.setName('LiquidDesktop');

let win;

function createWindowed() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const [w, h] = sizeArg ? sizeArg.split('x').map(Number) : [Math.min(1440, sw), Math.min(900, sh)];
  win = new BrowserWindow({
    width: w, height: h, minWidth: 900, minHeight: 600, title: 'LiquidDesktop', backgroundColor: '#0b1220', show: false, autoHideMenuBar: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, webviewTag: true, sandbox: false, spellcheck: false },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { mode, layer: 'full' } });
  win.once('ready-to-show', () => { win.show(); if (argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' }); });
  win.webContents.setWindowOpenHandler(({ url }) => { win.webContents.send('shell:openUrl', url); return { action: 'deny' }; });
  win.webContents.on('did-attach-webview', (_e, wc) => {
    wc.setWindowOpenHandler(({ url }) => { win.webContents.send('browser:newTab', url); return { action: 'deny' }; });
  });
}

// every web page in the Browser app gets a small helper script (password saving/filling)
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (_ev, prefs) => {
    prefs.preload = path.join(__dirname, 'webview-preload.js');
    prefs.contextIsolation = true;
    prefs.nodeIntegration = false;
    prefs.sandbox = true;
  });
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['clipboard-sanitized-write', 'fullscreen', 'notifications'].includes(perm)));
  require('./browser').register();
  require('./appstore').register();
  require('./sddm').register();
  require('./notifications').register({ resolveIcon: require('./system').resolveIcon });
  require('./tray').register({ resolveIcon: require('./system').resolveIcon });
  require('./appthemes').register({ mode });   // before any app starts: Qt apps need QT_STYLE_OVERRIDE
  if (mode === 'session') {
    try {
      const { startSession } = require('./session');
      const s = await startSession({ preload });
      win = s.shell;
      system.register({ getWindow: () => s.shell, mode });
    } catch (err) {
      console.error('[LiquidDesktop] could not start the session:', err.message);
      console.error('Is another window manager running? Use `npm start` to run LiquidDesktop in a window instead.');
      app.exit(1);
    }
  } else {
    system.register({ getWindow: () => win, mode });
    createWindowed();
  }
});
app.on('window-all-closed', () => { if (mode !== 'session') app.quit(); });
