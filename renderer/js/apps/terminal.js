// Terminal — xterm.js on a real PTY (bash/zsh/fish from $SHELL).
import { h, bus } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { api, isNative } from '../sys.js';
import { store } from '../store.js';
import { Terminal } from '../../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';

const css = document.createElement('link');
css.rel = 'stylesheet'; css.href = '../node_modules/@xterm/xterm/css/xterm.css';
document.head.append(css);

const THEMES = {
  glass: { background: 'rgba(0,0,0,0)', foreground: '#f2f2f7', cursor: '#f2f2f7', cursorAccent: '#000', selectionBackground: 'rgba(120,160,255,.35)',
    black: '#1c1c1e', red: '#ff6b6b', green: '#4fe08a', yellow: '#ffd36b', blue: '#6aa8ff', magenta: '#d68cff', cyan: '#5ee6e6', white: '#e5e5ea',
    brightBlack: '#6e6e73', brightRed: '#ff8a8a', brightGreen: '#7af0a8', brightYellow: '#ffe08f', brightBlue: '#8fc0ff', brightMagenta: '#e4aaff', brightCyan: '#8ff0f0', brightWhite: '#ffffff' },
  dark: { background: '#1e1e1e', foreground: '#e5e5ea', cursor: '#e5e5ea', selectionBackground: 'rgba(120,160,255,.35)' },
  light: { background: '#ffffff', foreground: '#1c1c1e', cursor: '#1c1c1e', cursorAccent: '#fff', selectionBackground: 'rgba(10,132,255,.25)',
    black: '#000', red: '#c41a16', green: '#007400', yellow: '#826b28', blue: '#0e0eff', magenta: '#a90d91', cyan: '#3f6e74', white: '#c7c7c7', brightBlack: '#7f7f7f' },
};

const sessions = new Map();
if (isNative) {
  api.pty.onData((id, d) => sessions.get(id)?.write(d));
  api.pty.onExit((id) => sessions.get(id)?.exit());
}

registerApp({
  id: 'terminal', name: 'Terminal', size: [760, 470], minSize: [360, 200], overlayContent: true,
  keywords: ['shell', 'console', 'bash', 'command line'],
  about: 'A real shell, rendered with xterm.js.',
  menus: (win) => [
    { title: 'Shell', items: [
      { label: 'New Window', shortcut: '⌘N', action: () => wm.open('terminal') },
      { label: 'Clear', action: () => win?.state?.term.clear() },
      { label: 'Reset', action: () => win?.state?.term.reset() }, '-',
      { label: 'Close Window', shortcut: '⌘W', action: () => win?.close() }] },
    { title: 'View', items: [
      { label: 'Bigger', shortcut: '⌃+', action: () => win?.state?.zoom(1) },
      { label: 'Smaller', shortcut: '⌃-', action: () => win?.state?.zoom(-1) },
      { label: 'Actual Size', action: () => win?.state?.zoom(0) }, '-',
      ...['glass', 'dark', 'light'].map((t) => ({ label: `${t[0].toUpperCase() + t.slice(1)} Profile`, checked: store.get('terminalTheme') === t, action: () => store.set('terminalTheme', t) }))] },
  ],
  open(win, args) {
    const wrap = h('div.term-wrap');
    win.body.append(wrap);
    const applyProfile = () => {
      const t = store.get('terminalTheme');
      win.el.classList.remove('term-glass', 'term-dark', 'term-light');
      win.el.classList.add('term-' + t);
      wrap.style.setProperty('--term-bg', THEMES[t].background);
      if (term) term.options.theme = THEMES[t];
    };
    let term = null;
    applyProfile();
    term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", "Fira Code", "DejaVu Sans Mono", monospace', fontSize: store.get('terminalFontSize'),
      cursorBlink: true, cursorStyle: 'bar', allowTransparency: true, theme: THEMES[store.get('terminalTheme')], scrollback: 5000, macOptionIsMeta: true,
    });
    applyProfile();
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(wrap);
    const state = { term, id: null };
    win.state = state;
    state.zoom = (d) => { term.options.fontSize = d === 0 ? 13 : Math.max(8, Math.min(30, term.options.fontSize + d)); store.set('terminalFontSize', term.options.fontSize); fit.fit(); };
    const off = store.on('change:terminalTheme', applyProfile);
    const doFit = () => { try { fit.fit(); if (state.id) api.pty.resize(state.id, term.cols, term.rows); } catch { /* not visible yet */ } };
    win.on('resize', () => requestAnimationFrame(doFit));
    win.on('focus', () => term.focus());
    term.attachCustomKeyEventHandler((e) => {
      // Ctrl+Shift+C / V copy & paste like other Linux terminals
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) { api.clip.write(term.getSelection()); return false; }
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) { api.clip.read().then((t) => state.id && api.pty.write(state.id, t)); return false; }
      if (e.type === 'keydown' && e.ctrlKey && (e.key === '=' || e.key === '+')) { state.zoom(1); return false; }
      if (e.type === 'keydown' && e.ctrlKey && e.key === '-') { state.zoom(-1); return false; }
      return true;
    });
    term.onTitleChange((t) => win.setTitle(t || 'Terminal'));
    setTimeout(async () => {
      doFit();
      if (!isNative) { term.write('\x1b[1mLiquidDesktop Terminal\x1b[0m\r\n\r\nThe terminal needs the desktop backend — run \x1b[36mnpm start\x1b[0m.\r\n'); return; }
      try {
        state.id = await api.pty.create({ cols: term.cols, rows: term.rows, cwd: args.cwd });
        sessions.set(state.id, { write: (d) => term.write(d), exit: () => win.close(true) });
        term.onData((d) => api.pty.write(state.id, d));
        if (args.command) api.pty.write(state.id, args.command + '\n');
        term.focus();
      } catch (e) { term.write('Could not start a shell: ' + e.message + '\r\n'); }
    }, 60);
    win.setTitle('Terminal');
    win.on('close', () => { off(); if (state.id) { api.pty.kill(state.id); sessions.delete(state.id); } term.dispose(); });
    wrap.addEventListener('contextmenu', (e) => {
      import('../menus.js').then(({ contextMenu }) => contextMenu(e, [
        { label: 'Copy', disabled: !term.hasSelection(), action: () => api.clip.write(term.getSelection()) },
        { label: 'Paste', action: () => api.clip.read().then((t) => state.id && api.pty.write(state.id, t)) },
        { label: 'Select All', action: () => term.selectAll() }, '-',
        { label: 'Clear', action: () => term.clear() },
        { label: 'New Window', action: () => wm.open('terminal') },
      ]));
    });
  },
});
