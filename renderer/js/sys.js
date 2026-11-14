// Backend access. In Electron this is the real system (window.sys from preload).
// Opened in a plain browser (npm run web) it falls back to a small in-memory mock so the shell still runs.
const native = window.sys && window.sys.native;

function mock() {
  const home = '/home/guest';
  const files = new Map();
  const dir = (p) => files.set(p, { isDir: true, mtime: Date.now() });
  const file = (p, content = '') => files.set(p, { isDir: false, content, mtime: Date.now() - Math.random() * 1e9 });
  for (const d of ['', '/Desktop', '/Documents', '/Downloads', '/Pictures', '/Music', '/Videos', '/Documents/Projects']) dir(home + d);
  file(home + '/Desktop/Welcome.txt', 'Welcome to LiquidDesktop!\n\nThis is the browser preview. Run it with Electron (npm start) to use your real files, terminal and hardware.');
  file(home + '/Documents/Ideas.md', '# Ideas\n\n- Liquid glass everything\n- More widgets');
  file(home + '/Documents/Projects/readme.txt', 'Nothing here yet.');
  dir(home + '/.local/share/Trash/files');
  const kids = (p) => [...files.keys()].filter((k) => k !== p && k.startsWith(p === '/' ? '/' : p + '/') && !k.slice(p.length + 1).includes('/'));
  const entry = (p) => { const f = files.get(p); const name = p.split('/').pop(); return { name, path: p, isDir: f.isDir, size: f.isDir ? 0 : (f.content || '').length, mtime: f.mtime, ext: f.isDir ? '' : (name.split('.').pop() || '').toLowerCase(), hidden: name.startsWith('.') }; };
  const uniq = (d, n) => { let p = `${d}/${n}`, i = 2; while (files.has(p)) p = `${d}/${n} ${i++}`; return p; };
  const ok = async () => true;
  let vol = { level: 60, muted: false }, br = 80, wifiOn = true, bt = true;
  return {
    native: false,
    sys: {
      info: async () => ({ mode: 'browser', user: 'guest', fullName: 'Guest', host: 'liquid', home, os: navigator.platform, kernel: '—', arch: '', cpu: 'Browser preview', cores: navigator.hardwareConcurrency, memory: 8e9, uptime: performance.now() / 1000, electron: '—', chrome: '', gpu: '' }),
      status: async () => ({ battery: { percent: 82, charging: false }, volume: vol, brightness: br, wifi: { enabled: wifiOn, ssid: wifiOn ? 'Liquid Net' : null }, bluetooth: { powered: bt } }),
      media: async () => null, mediaCmd: ok,
      setVolume: async (v) => { vol.level = v; }, setMute: async (m) => { vol.muted = m; }, setBrightness: async (v) => { br = v; },
      wifiPower: async (o) => { wifiOn = o; }, wifiList: async () => [{ ssid: 'Liquid Net', signal: 90, secure: true, active: true }, { ssid: 'Coffee Shop', signal: 55, secure: false }],
      wifiConnect: ok, airplane: ok, bluetoothPower: async (o) => { bt = o; },
      stats: async () => ({ cpu: 10 + Math.random() * 20, memTotal: 8e9, memFree: 3e9, load: [0.5, 0.4, 0.3], uptime: 1000, procs: [{ pid: 1, user: 'root', cpu: 0.1, mem: 0.2, rss: 1e7, name: 'init' }] }),
      kill: ok, checkPassword: async () => ({ ok: true, unsupported: true }), power: async () => ({ simulated: true }), screenshot: async () => null,
    },
    fs: {
      home: async () => home,
      list: async (p) => kids(p).map(entry),
      stat: async (p) => ({ ...entry(p), ctime: files.get(p).mtime }),
      read: async (p) => files.get(p)?.content ?? '',
      write: async (p, c) => { files.set(p, { isDir: false, content: c, mtime: Date.now() }); return true; },
      mkdir: async (d, n) => { const p = uniq(d, n || 'untitled folder'); dir(p); return p; },
      newFile: async (d, n) => { const p = uniq(d, n || 'untitled.txt'); file(p); return p; },
      rename: async (p, n) => { const d = p.split('/').slice(0, -1).join('/'); const np = `${d}/${n}`; for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) { files.set(np + k.slice(p.length), files.get(k)); files.delete(k); } return np; },
      move: async (p, d) => { const np = uniq(d, p.split('/').pop()); for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) { files.set(np + k.slice(p.length), files.get(k)); files.delete(k); } return np; },
      copy: async (p, d) => { const np = uniq(d, p.split('/').pop()); files.set(np, { ...files.get(p) }); return np; },
      trash: async (p) => { const np = uniq(home + '/.local/share/Trash/files', p.split('/').pop()); files.set(np, files.get(p)); files.delete(p); return true; },
      remove: async (p) => { for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) files.delete(k); return true; },
      emptyTrash: async () => { for (const k of [...files.keys()]) if (k.startsWith(home + '/.local/share/Trash/files/')) files.delete(k); return true; },
      open: ok, reveal: ok,
      search: async (q) => [...files.keys()].filter((k) => k.split('/').pop().toLowerCase().includes(q.toLowerCase())).slice(0, 20).map(entry),
      exists: async (p) => files.has(p),
      places: async () => ({ home, desktop: home + '/Desktop', documents: home + '/Documents', downloads: home + '/Downloads', pictures: home + '/Pictures', music: home + '/Music', videos: home + '/Videos', trash: home + '/.local/share/Trash/files' }),
    },
    apps: { list: async () => [], launch: ok, run: ok },
    clip: { write: async (t) => navigator.clipboard?.writeText(t), read: async () => '' },
    pty: { create: async () => { throw new Error('The terminal needs the Electron backend (npm start).'); }, write() {}, resize() {}, kill() {}, onData() {}, onExit() {} },
    shell: { toggleFullscreen: async () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); }, devtools: ok, quit: async () => location.reload(), onOpenUrl() {} },
  };
}

export const api = native ? window.sys : mock();
export const isNative = !!native;
