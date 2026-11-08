// About This Computer.
import { h, fmtSize } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { logoBadge } from '../icons.js';
import { api } from '../sys.js';

registerApp({
  id: 'about', name: 'About This Computer', size: [420, 520], minSize: [420, 480], resizable: false, singleton: true, overlayContent: false, hideTitle: true,
  open(win) {
    const kv = h('dl.kv');
    win.body.append(h('div.about-box', { style: { flex: 1 } }, h('div.logo', { html: logoBadge() }), h('h2', 'LiquidDesktop'), h('div.ver', 'Version 0.1 “Tahoe Blue”'), kv,
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '18px' } }, h('button.btn', { onclick: () => wm.open('settings') }, 'More Info…'), h('button.btn', { onclick: () => wm.open('monitor') }, 'Activity Monitor')),
      h('div.muted', { style: { marginTop: 'auto', fontSize: '11px' } }, 'A Liquid Glass desktop for Linux. MIT licensed.')));
    win.dragRegion(win.body);
    api.sys.info().then((i) => {
      const rows = [['Computer', i.host], ['User', i.fullName], ['Chip', i.cpu + (i.cores ? ` (${i.cores} cores)` : '')], ['Memory', fmtSize(i.memory)], ['Graphics', i.gpu || '—'],
        ['System', i.os], ['Kernel', i.kernel + (i.arch ? ' ' + i.arch : '')], ['Shell Engine', `Electron ${i.electron}`], ['Mode', i.mode === 'session' ? 'Desktop session' : i.mode === 'windowed' ? 'Windowed (testing)' : 'Browser preview']];
      for (const [k, v] of rows) kv.append(h('dt', k), h('dd', v));
    });
  },
});
