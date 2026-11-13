// Offscreen test harness: renders LiquidDesktop without showing a window, runs scripted steps, saves screenshots.
//   electron tools/shot.js <outdir> [steps.json]
// steps: [{ "js": "...", "wait": 800, "shot": "name" }, ...]
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const system = require('../main/system');

const out = process.argv[2] || 'shots';
const steps = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : [{ wait: 2500, shot: 'desktop' }];
app.commandLine.appendSwitch('enable-features', 'BackdropFilterSVG');
app.on('web-contents-created', (_e, wc) => wc.on('will-attach-webview', (_ev, prefs) => {
  prefs.preload = path.join(__dirname, '../main/webview-preload.js'); prefs.contextIsolation = true; prefs.nodeIntegration = false; prefs.sandbox = true;
}));
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: {
    offscreen: true, preload: path.join(__dirname, '../main/preload.js'), contextIsolation: true, webviewTag: true, sandbox: false } });
  win.webContents.setFrameRate(30);
  system.register({ getWindow: () => win, mode: 'windowed' });
  require('../main/browser').register();
  if (process.env.SW_DEBUG) {
    const { session } = require('electron');
    const sw = session.fromPartition('persist:browser').serviceWorkers;
    sw.on('console-message', (_e, d) => console.log('[sw]', JSON.stringify(d).slice(0, 300)));
    setInterval(() => console.log('[sw running]', JSON.stringify(sw.getAllRunning()).slice(0, 300)), 5000);
  }
  require('../main/appstore').register();
  require('../main/sddm').register();
  require('../main/bluetooth').register();
  require('../main/audio').register(require('electron').ipcMain);
  require('../main/defaultapps').register({ mode: 'windowed' });
  require('../main/android').register();
  require('../main/appthemes').register({ mode: 'windowed' });
  require('../main/portal').register({});
  require('../main/notifications').register({ resolveIcon: require('../main/system').resolveIcon });
  require('../main/tray').register({ resolveIcon: require('../main/system').resolveIcon });
  win.webContents.on('console-message', (e) => { const m = e.message ?? e; if (/error|LiquidDesktop/i.test(String(m))) console.log('[console]', m); });
  await win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { mode: 'windowed' } });
  for (const s of steps) {
    if (s.js) { try { const r = await win.webContents.executeJavaScript(s.js); if (r !== undefined) console.log('[js]', JSON.stringify(r)); } catch (e) { console.log('[js error]', e.message); } }
    await new Promise((r) => setTimeout(r, s.wait ?? 600));
    if (s.shot) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(out, s.shot + '.png'), img.toPNG()); console.log('saved', s.shot); }
  }
  app.exit(0);
});
