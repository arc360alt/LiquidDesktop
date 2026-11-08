// Calendar — month view with local events.
import { h } from '../util.js';
import { registerApp } from '../wm.js';
import { sym } from '../icons.js';
import { appData } from '../store.js';
import { prompt, contextMenu } from '../menus.js';
import { shell } from '../shell.js';

const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

registerApp({
  id: 'calendar', name: 'Calendar', size: [920, 620], minSize: [520, 380], overlayContent: true, hideTitle: true,
  keywords: ['events', 'date', 'schedule'],
  open(win) {
    let view = new Date(); view.setDate(1);
    const root = h('div.cal');
    win.body.append(root);
    const title = h('div.win-title', { style: { fontSize: '15px' } });
    win.toolbar.append(h('div.spacer'),
      h('div.tb-group', h('button.tb-btn', { html: sym.chevronLeft, onclick: () => { view.setMonth(view.getMonth() - 1); draw(); } }),
        h('button.btn.plain', { style: { height: '28px' }, onclick: () => { view = new Date(); view.setDate(1); draw(); } }, 'Today'),
        h('button.tb-btn', { html: sym.chevronRight, onclick: () => { view.setMonth(view.getMonth() + 1); draw(); } })),
      h('div.tb-group', h('button.tb-btn', { html: sym.plus, title: 'New Event', onclick: () => addEvent(new Date()) })));
    const addEvent = async (d) => {
      const t = await prompt(`New event on ${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`, '', { placeholder: 'Title — optionally “Lunch at 12:30”', ok: 'Add' }, win.el);
      if (!t) return;
      const m = t.match(/^(.*?)\s+at\s+(\d{1,2}(:\d{2})?\s*(am|pm)?)$/i);
      const ev = appData.get('calendar', {});
      (ev[key(d)] ||= []).push({ title: m ? m[1] : t, time: m ? m[2] : '' });
      appData.set('calendar', ev);
      draw();
      shell.notify({ app: 'calendar', title: 'Event added', body: `${m ? m[1] : t} — ${d.toLocaleDateString()}` });
    };
    const draw = () => {
      const evs = appData.get('calendar', {});
      root.innerHTML = '';
      const today = new Date();
      root.append(h('div.cal-head', h('h2', view.toLocaleDateString([], { month: 'long' }), ' ', h('span', view.getFullYear()))));
      root.append(h('div.cal-dow', ...['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => h('span', d))));
      const grid = h('div.cal-grid');
      const start = new Date(view); start.setDate(1 - view.getDay());
      for (let i = 0; i < 42; i++) {
        const d = new Date(start); d.setDate(start.getDate() + i);
        const list = evs[key(d)] || [];
        const cell = h('div.cal-cell' + (d.getMonth() !== view.getMonth() ? '.other' : '') + (key(d) === key(today) ? '.today' : '') + (d.getDay() % 6 === 0 ? '.weekend' : ''),
          h('span.d', d.getDate() === 1 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.getDate()),
          ...list.map((e, j) => {
            const el = h('div.cal-ev', (e.time ? e.time + ' ' : '') + e.title);
            el.addEventListener('contextmenu', (ev) => contextMenu(ev, [{ label: 'Delete Event', danger: true, action: () => { const all = appData.get('calendar', {}); all[key(d)].splice(j, 1); appData.set('calendar', all); draw(); } }]));
            return el;
          }));
        if (d.getDate() === 1) cell.querySelector('.d').style.width = 'auto';
        cell.addEventListener('dblclick', () => addEvent(d));
        grid.append(cell);
      }
      root.append(grid);
      win.setTitle(view.toLocaleDateString([], { month: 'long', year: 'numeric' }));
    };
    draw();
  },
});
