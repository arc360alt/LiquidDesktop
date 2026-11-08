// Activity Monitor — live CPU/memory graph and a process list with Quit / Force Quit.
import { h, fmtSize } from '../util.js';
import { registerApp } from '../wm.js';
import { sym } from '../icons.js';
import { api } from '../sys.js';
import { alertDialog } from '../menus.js';

registerApp({
  id: 'monitor', name: 'Activity Monitor', size: [820, 560], minSize: [520, 340], overlayContent: true,
  keywords: ['task manager', 'processes', 'cpu', 'memory', 'force quit', 'top'],
  open(win) {
    let sel = null, sortKey = 'cpu', filter = '';
    const table = h('table'), tbody = h('tbody');
    const ths = [['Process Name', 'name'], ['% CPU', 'cpu', 1], ['Memory', 'rss', 1], ['PID', 'pid', 1], ['User', 'user']].map(([l, k, num]) => {
      const th = h('th' + (num ? '.num' : ''), { onclick: () => { sortKey = k; tick(); } }, l);
      th.dataset.k = k; return th;
    });
    table.append(h('thead', h('tr', ...ths)), tbody);
    const canvas = h('canvas'), cpuEl = h('dd'), memEl = h('dd'), loadEl = h('dd'), upEl = h('dd'), countEl = h('dd');
    win.body.append(h('div.mon', h('div.mon-table-wrap', table),
      h('div.mon-foot', h('dl.stat', h('dt', 'CPU'), cpuEl, h('dt', 'Memory Used'), memEl, h('dt', 'Load'), loadEl, h('dt', 'Processes'), countEl, h('dt', 'Uptime'), upEl), canvas)));
    const search = h('input.field', { placeholder: 'Search', style: { width: '160px', height: '34px' }, oninput: (e) => { filter = e.target.value.toLowerCase(); tick(); } });
    const killBtn = h('button.tb-btn', { html: sym.stop, title: 'Quit Process', onclick: () => kill() });
    win.toolbar.append(h('div.tb-group', killBtn, h('button.tb-btn', { html: sym.info, title: 'Info', onclick: () => sel && alertDialog({ title: sel.name, message: `PID ${sel.pid} · ${sel.user}\nCPU ${sel.cpu}% · Memory ${fmtSize(sel.rss)}` }, win.el) })),
      h('div.spacer'), h('div.search-field', { html: sym.search }, search));
    const hist = [];
    const kill = async () => {
      if (!sel) return;
      const r = await alertDialog({ title: `Are you sure you want to quit this process?`, message: `“${sel.name}” (PID ${sel.pid})`, buttons: [{ label: 'Cancel', value: 'c' }, { label: 'Force Quit', value: 'f', danger: true }, { label: 'Quit', value: 'q', primary: true }] }, win.el);
      if (r.button === 'q' || r.button === 'f') { try { await api.sys.kill(sel.pid, r.button === 'f'); } catch (e) { alertDialog({ title: 'Couldn’t quit process', message: e.message }, win.el); } tick(); }
    };
    const graph = () => {
      const dpr = devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      const x = canvas.getContext('2d'); x.scale(dpr, dpr);
      x.strokeStyle = 'rgba(255,255,255,.08)';
      for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo(0, (H * i) / 4); x.lineTo(W, (H * i) / 4); x.stroke(); }
      const draw = (key, color) => {
        x.beginPath();
        hist.forEach((v, i) => { const px = W - (hist.length - 1 - i) * (W / 59), py = H - (v[key] / 100) * H; i ? x.lineTo(px, py) : x.moveTo(px, py); });
        x.strokeStyle = color; x.lineWidth = 1.6; x.stroke();
        x.lineTo(W, H); x.lineTo(W - (hist.length - 1) * (W / 59), H); x.closePath();
        x.fillStyle = color.replace('rgb', 'rgba').replace(')', ',.18)'); x.fill();
      };
      draw('mem', 'rgb(10,132,255)'); draw('cpu', 'rgb(48,209,88)');
    };
    const tick = async () => {
      let s;
      try { s = await api.sys.stats(); } catch { return; }
      const memPct = 100 * (1 - s.memFree / s.memTotal);
      hist.push({ cpu: s.cpu, mem: memPct }); if (hist.length > 60) hist.shift();
      cpuEl.textContent = s.cpu.toFixed(1) + '%';
      memEl.textContent = `${fmtSize(s.memTotal - s.memFree)} / ${fmtSize(s.memTotal)}`;
      loadEl.textContent = s.load.map((l) => l.toFixed(2)).join(' ');
      upEl.textContent = `${Math.floor(s.uptime / 86400)}d ${Math.floor((s.uptime % 86400) / 3600)}h ${Math.floor((s.uptime % 3600) / 60)}m`;
      countEl.textContent = s.procs.length + '+';
      graph();
      let procs = s.procs.filter((p) => !filter || p.name.toLowerCase().includes(filter));
      procs.sort((a, b) => (typeof a[sortKey] === 'string' ? a[sortKey].localeCompare(b[sortKey]) : b[sortKey] - a[sortKey]));
      ths.forEach((t) => (t.style.color = t.dataset.k === sortKey ? 'var(--text)' : ''));
      tbody.innerHTML = '';
      for (const p of procs) {
        const tr = h('tr' + (sel?.pid === p.pid ? '.sel' : ''), h('td', p.name), h('td.num', p.cpu.toFixed(1)), h('td.num', fmtSize(p.rss)), h('td.num', p.pid), h('td', p.user));
        tr.addEventListener('click', () => { sel = p; tbody.querySelectorAll('tr').forEach((r) => r.classList.toggle('sel', r === tr)); });
        tr.addEventListener('dblclick', kill);
        tbody.append(tr);
      }
    };
    tick();
    const t = setInterval(tick, 2000);
    win.on('close', () => clearInterval(t));
    win.on('resize', graph);
  },
});
