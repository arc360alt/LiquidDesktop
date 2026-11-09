// Activity Monitor — CPU, Memory, Disk and Network tabs like macOS: a live, sortable process list (or the
// network interfaces), totals and a history graph for the selected tab, and Quit / Force Quit.
import { h, fmtSize } from '../util.js';
import { registerApp } from '../wm.js';
import { sym } from '../icons.js';
import { api } from '../sys.js';
import { alertDialog } from '../menus.js';

const rate = (b) => (b < 1 ? '0 B/s' : fmtSize(b).replace('bytes', 'B') + '/s');
const dur = (t) => { const s = Math.floor(t), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60; return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}.${String(Math.floor((t % 1) * 100)).padStart(2, '0')}`; };

const TABS = {
  cpu: { label: 'CPU', sort: 'cpu', cols: [['Process Name', 'name'], ['% CPU', 'cpu', (p) => p.cpu.toFixed(1)], ['CPU Time', 'cpuTime', (p) => dur(p.cpuTime)], ['Threads', 'threads'], ['PID', 'pid'], ['User', 'user']] },
  memory: { label: 'Memory', sort: 'rss', cols: [['Process Name', 'name'], ['Memory', 'rss', (p) => fmtSize(p.rss)], ['Threads', 'threads'], ['PID', 'pid'], ['User', 'user']] },
  disk: { label: 'Disk', sort: 'ioW', cols: [['Process Name', 'name'], ['Written/s', 'ioW', (p) => (p.mine ? rate(p.ioW) : '—')], ['Read/s', 'ioR', (p) => (p.mine ? rate(p.ioR) : '—')], ['Bytes Written', 'ioTotalW', (p) => (p.mine ? fmtSize(p.ioTotalW) : '—')], ['Bytes Read', 'ioTotalR', (p) => (p.mine ? fmtSize(p.ioTotalR) : '—')], ['PID', 'pid'], ['User', 'user']] },
  network: { label: 'Network', sort: 'rxRate', ifaces: true, cols: [['Interface', 'name'], ['Received/s', 'rxRate', (i) => rate(i.rxRate)], ['Sent/s', 'txRate', (i) => rate(i.txRate)], ['Received', 'rx', (i) => fmtSize(i.rx)], ['Sent', 'tx', (i) => fmtSize(i.tx)]] },
};

registerApp({
  id: 'monitor', name: 'Activity Monitor', size: [880, 600], minSize: [560, 380], overlayContent: true, hideTitle: true,
  keywords: ['task manager', 'processes', 'cpu', 'memory', 'disk', 'network', 'force quit', 'top'],
  open(win) {
    let tab = 'cpu', sel = null, filter = '', mine = false, last = null;
    const sorts = Object.fromEntries(Object.entries(TABS).map(([k, t]) => [k, { key: t.sort, desc: true }]));
    const hist = [];
    const table = h('table'), thead = h('thead'), tbody = h('tbody');
    table.append(thead, tbody);
    const stat = h('dl.stat'), canvas = h('canvas'), legend = h('div.mon-legend');
    const wrap = h('div.mon-table-wrap', table);
    win.body.append(h('div.mon', wrap, h('div.mon-foot', stat, h('div.mon-graph', canvas, legend))));

    // toolbar: quit, info, the tab switcher, All / My processes, search
    const search = h('input.field', { placeholder: 'Search', style: { width: '150px', height: '34px' }, oninput: (e) => { filter = e.target.value.toLowerCase(); draw(); } });
    const tabBtns = Object.entries(TABS).map(([k, t]) => h('button', { onclick: () => { tab = k; sel = null; tabBtns.forEach((b) => b.classList.toggle('on', b.dataset.k === k)); head(); draw(); graph(); }, 'data-k': k }, t.label));
    tabBtns[0].classList.add('on');
    const scope = h('select.field.square', { style: { height: '30px' }, onchange: (e) => { mine = e.target.value === 'mine'; draw(); } }, h('option', { value: 'all' }, 'All Processes'), h('option', { value: 'mine' }, 'My Processes'));
    win.toolbar.append(
      h('div.tb-group', h('button.tb-btn', { html: sym.stop, title: 'Quit Process', onclick: () => kill() }), h('button.tb-btn', { html: sym.info, title: 'Inspect', onclick: () => info() })),
      h('div.mon-tabs', ...tabBtns), h('div.spacer'), scope, h('div.search-field', { html: sym.search }, search));

    const head = () => {
      const t = TABS[tab], srt = sorts[tab];
      thead.innerHTML = '';
      thead.append(h('tr', ...t.cols.map(([label, key], i) => {
        const th = h('th' + (i ? '.num' : ''), { onclick: () => { if (srt.key === key) srt.desc = !srt.desc; else { srt.key = key; srt.desc = key !== 'name' && key !== 'user'; } head(); draw(); } },
          label, srt.key === key ? h('span.mon-arrow', srt.desc ? ' ▾' : ' ▴') : null);
        if (key === 'user' || key === 'name') th.classList.remove('num');
        return th;
      })));
    };

    const rows = () => {
      if (!last) return [];
      const t = TABS[tab], srt = sorts[tab];
      let list = t.ifaces ? last.ifaces : last.procs.filter((p) => (!mine || p.mine) && (!filter || p.name.toLowerCase().includes(filter) || String(p.pid) === filter));
      const k = srt.key, dir = srt.desc ? -1 : 1;
      list = [...list].sort((a, b) => (typeof a[k] === 'string' ? a[k].localeCompare(b[k]) : a[k] - b[k]) * dir || a.name.localeCompare(b.name));
      return list;
    };

    const draw = () => {
      const t = TABS[tab];
      const list = rows();
      const frag = document.createDocumentFragment();
      for (const p of list) {
        const id = t.ifaces ? p.name : p.pid;
        const tr = h('tr' + (sel === id ? '.sel' : ''), ...t.cols.map(([, key, fmt], i) => h('td' + (i && key !== 'user' ? '.num' : ''), fmt ? fmt(p) : String(p[key]))));
        tr.addEventListener('click', () => { sel = id; tbody.querySelectorAll('tr.sel').forEach((r) => r.classList.remove('sel')); tr.classList.add('sel'); });
        if (!t.ifaces) tr.addEventListener('dblclick', () => { sel = id; info(); });
        frag.append(tr);
      }
      tbody.replaceChildren(frag);   // the scroll position of the list is kept
      footer();
    };

    const footer = () => {
      if (!last) return;
      const s = last, dd = (k, v) => [h('dt', k), h('dd', v)];
      const used = s.memTotal - s.memFree;
      const items = {
        cpu: [...dd('System', s.cpuSystem.toFixed(1) + '%'), ...dd('User', s.cpuUser.toFixed(1) + '%'), ...dd('Idle', Math.max(0, 100 - s.cpu).toFixed(1) + '%'), ...dd('Threads', s.threads.toLocaleString()), ...dd('Processes', s.procs.length.toLocaleString())],
        memory: [...dd('Physical Memory', fmtSize(s.memTotal)), ...dd('Memory Used', fmtSize(used)), ...dd('Cached Files', fmtSize(s.memCached)), ...dd('Swap Used', s.swapTotal ? `${fmtSize(s.swapUsed)} of ${fmtSize(s.swapTotal)}` : 'No swap'), ...dd('Load', s.load.map((l) => l.toFixed(2)).join(' '))],
        disk: [...dd('Data read', fmtSize(s.diskTotalR)), ...dd('Data written', fmtSize(s.diskTotalW)), ...dd('Read/s', rate(s.diskR)), ...dd('Written/s', rate(s.diskW))],
        network: [...dd('Data received', fmtSize(s.netTotalRx)), ...dd('Data sent', fmtSize(s.netTotalTx)), ...dd('Received/s', rate(s.netRx)), ...dd('Sent/s', rate(s.netTx))],
      }[tab];
      stat.replaceChildren(...items);
    };

    // history graph of the current tab (two series)
    const SERIES = {
      cpu: [['System', 'cpuSystem', '#ff453a', 100], ['User', 'cpuUser', '#0a84ff', 100]],
      memory: [['Memory used', 'memPct', '#30d158', 100], ['Swap used', 'swapPct', '#ff9f0a', 100]],
      disk: [['Read', 'diskR', '#0a84ff'], ['Written', 'diskW', '#ff453a']],
      network: [['Received', 'netRx', '#30d158'], ['Sent', 'netTx', '#0a84ff']],
    };
    const graph = () => {
      const dpr = devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
      if (!W || !H) return;
      canvas.width = W * dpr; canvas.height = H * dpr;
      const x = canvas.getContext('2d'); x.scale(dpr, dpr);
      x.strokeStyle = 'rgba(255,255,255,.08)';
      for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo(0, (H * i) / 4); x.lineTo(W, (H * i) / 4); x.stroke(); }
      const series = SERIES[tab];
      const max = series[0][3] || Math.max(1024, ...hist.flatMap((v) => series.map((s) => v[s[1]]))) * 1.15;
      for (const [, key, color] of series) {
        x.beginPath();
        hist.forEach((v, i) => { const px = W - (hist.length - 1 - i) * (W / 89), py = H - Math.min(1, v[key] / max) * (H - 2) - 1; i ? x.lineTo(px, py) : x.moveTo(px, py); });
        x.strokeStyle = color; x.lineWidth = 1.6; x.stroke();
        if (hist.length > 1) { x.lineTo(W, H); x.lineTo(W - (hist.length - 1) * (W / 89), H); x.closePath(); x.fillStyle = color + '2e'; x.fill(); }
      }
      legend.replaceChildren(...series.map(([label, key, color]) => h('span', h('i', { style: { background: color } }), label, h('b', last ? (series[0][3] ? (last[key] ?? hist.at(-1)?.[key] ?? 0).toFixed(1) + '%' : rate(last[key])) : ''))));
    };

    const selected = () => (last && !TABS[tab].ifaces ? last.procs.find((p) => p.pid === sel) : null);
    const info = () => {
      const p = selected();
      if (!p) return;
      alertDialog({ title: p.name, message: `PID ${p.pid} · parent ${p.ppid} · ${p.user}\nCPU ${p.cpu.toFixed(1)}% · CPU time ${dur(p.cpuTime)}\nMemory ${fmtSize(p.rss)} · ${p.threads} thread${p.threads === 1 ? '' : 's'}`,
        buttons: [{ label: 'Close', value: 'c' }, { label: 'Quit Process…', value: 'q', primary: true }] }, win.el).then((r) => r.button === 'q' && kill());
    };
    const kill = async () => {
      const p = selected();
      if (!p) return;
      const r = await alertDialog({ title: 'Are you sure you want to quit this process?', message: `“${p.name}” (PID ${p.pid})`, buttons: [{ label: 'Cancel', value: 'c' }, { label: 'Force Quit', value: 'f', danger: true }, { label: 'Quit', value: 'q', primary: true }] }, win.el);
      if (r.button !== 'q' && r.button !== 'f') return;
      try {
        const res = await api.sys.kill(p.pid, r.button === 'f');
        if (res?.__error) throw new Error(res.__error);
      } catch (e) {
        alertDialog({ title: 'Couldn’t quit the process', message: /EPERM/.test(e.message) ? `“${p.name}” belongs to ${p.user}. Only that user (or an administrator) can quit it.` : e.message }, win.el);
      }
      tick();
    };

    const tick = async () => {
      let s;
      try { s = await api.sys.stats(); } catch { return; }
      if (!s || s.__error) return;
      last = s;
      hist.push({ cpuSystem: s.cpuSystem, cpuUser: s.cpuUser, memPct: 100 * (1 - s.memFree / s.memTotal), swapPct: s.swapTotal ? (100 * s.swapUsed) / s.swapTotal : 0, diskR: s.diskR, diskW: s.diskW, netRx: s.netRx, netTx: s.netTx });
      if (hist.length > 90) hist.shift();
      s.memPct = hist.at(-1).memPct; s.swapPct = hist.at(-1).swapPct;
      draw(); graph();
    };
    head();
    tick();
    setTimeout(tick, 700);   // the second sample gives real CPU numbers right away
    const t = setInterval(tick, 2000);
    win.on('close', () => clearInterval(t));
    win.on('resize', graph);
  },
});
