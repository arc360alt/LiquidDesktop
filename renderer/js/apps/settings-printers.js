// Settings › Printers & Scanners (main/printing.js, CUPS): your printers and their queues, add one from the network
// or USB, set the default, pause, test page, remove. Offers to install CUPS when it isn't.
import { h, fmtSize } from '../util.js';
import { api } from '../sys.js';
import { store } from '../store.js';

let selected = null, hooked = false;
const STATE = { idle: 'Idle', printing: 'Printing…', paused: 'Paused' };
const KIND = { network: 'Network printer', usb: 'USB printer', pdf: 'PDF printer', other: 'Printer' };
const PRINTER_ICON = '<svg viewBox="0 0 40 40"><defs><linearGradient id="prg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f4f6"/><stop offset="1" stop-color="#c9c9ce"/></linearGradient></defs><rect x="11" y="4" width="18" height="11" rx="1.5" fill="#fff" stroke="#b9b9be"/><rect x="4" y="13" width="32" height="15" rx="4" fill="url(#prg)" stroke="#a9a9ae"/><rect x="10" y="24" width="20" height="12" rx="1" fill="#fff" stroke="#b9b9be"/><path d="M13 28.5h14M13 31.5h10" stroke="#c7c7cc" stroke-width="1.3"/><circle cx="31" cy="17.5" r="1.3" fill="#34c759"/></svg>';

export async function printersPane({ row, hero, rerender, askSudo, alertDialog, confirmDialog }) {
  if (!api.print) return [hero('printers', 'Printers & Scanners', 'Printing needs the LiquidDesktop app (it isn’t available in the browser preview).')];
  if (!hooked) { hooked = true; api.print.onChanged?.(() => { if (document.querySelector('.pr-pane')) rerender(); }); }
  const st = await api.print.status().catch((e) => ({ error: e.message, printers: [] }));
  const top = hero('printers', 'Printers & Scanners', 'Add printers on your network or plugged in over USB, and choose your default printer.');
  const busy = async (btn, label, fn) => {
    const was = btn.textContent; btn.disabled = true; btn.textContent = label;
    try { await fn(); } catch (e) { await alertDialog({ title: 'Printers', message: e.message }); }
    btn.disabled = false; btn.textContent = was;
    rerender();
  };

  if (!st.installed || !st.running) {
    const btn = h('button.btn.primary', { onclick: () => busy(btn, st.installed ? 'Starting…' : 'Installing…', async () => {
      if (!(await askSudo(st.installed ? 'Starting the printing service needs your password.' : 'Installing printing support (CUPS) needs your password.'))) return;
      await (st.installed ? api.print.start() : api.print.install());
    }) }, st.installed ? 'Start Printing' : 'Set Up Printing');
    return [h('div.pr-pane'), top, h('div.group', h('div.pr-empty', h('div.pr-big', { html: PRINTER_ICON }),
      h('b', st.installed ? 'The printing service isn’t running' : 'Printing isn’t set up yet'),
      h('p', st.installed ? 'CUPS is installed but turned off. Start it to use your printers.' : st.pm ? 'This installs CUPS (the Linux printing system), driverless printing for network and USB printers, and printer discovery. It asks for your password once.' : 'Install CUPS with your package manager, then come back here.'),
      st.pm || st.installed ? btn : null))];
  }

  const printers = st.printers;
  if (!printers.find((p) => p.name === selected)) selected = (printers.find((p) => p.default) || printers[0])?.name || null;
  const list = h('div.group.pr-list',
    ...printers.map((p) => h('div.row.link.pr-row' + (p.name === selected ? '.sel' : ''), { onclick: () => { selected = p.name; rerender(); } },
      h('span.pr-ic', { html: PRINTER_ICON }),
      h('div.label', h('span', p.info || p.name, p.default ? h('span.pr-badge', 'Default') : null),
        h('small', [p.jobs.length ? `${p.jobs.length} job${p.jobs.length === 1 ? '' : 's'}` : null, STATE[p.state] || p.state, p.detail].filter(Boolean).join(' · '))),
      h('span.pr-dot.' + p.state))),
    !printers.length ? row(h('span.muted', 'No printers yet'), null) : null,
    row('', h('button.btn', { onclick: () => addPrinter() }, 'Add Printer…')));

  // the selected printer: its details, queue and actions
  const p = printers.find((x) => x.name === selected);
  const detail = p ? [h('div.group-title', p.info || p.name), h('div.group',
    row('Status', h('span.muted', [STATE[p.state] || p.state, p.accepting === false ? 'not accepting jobs' : null, p.alerts].filter(Boolean).join(' · '))),
    p.location ? row('Location', h('span.muted', p.location)) : null,
    row('Kind', h('span.muted', [KIND[p.kind], p.makeModel].filter(Boolean).join(' · '))),
    p.uri ? row('Address', h('span.muted.ellipsis', { style: { maxWidth: '60%' }, title: p.uri }, decodeURIComponent(p.uri))) : null,
    row('Queue', p.jobs.length ? h('span.muted', `${p.jobs.length} waiting`) : h('span.muted', 'Empty')),
    ...p.jobs.map((j) => h('div.row.pr-job', h('div.label', h('span', `Job ${j.id.split('-').pop()}`), h('small', `${j.user} · ${fmtSize(j.size)} · ${j.when}`)),
      h('button.btn', { onclick: (e) => busy(e.currentTarget, 'Cancelling…', () => api.print.cancel(j.id)) }, 'Cancel'))),
    h('div.row.pr-acts',
      h('button.btn', { disabled: p.default, onclick: (e) => busy(e.currentTarget, 'Setting…', () => api.print.setDefault(p.name)) }, p.default ? 'Default Printer' : 'Set as Default'),
      h('button.btn', { onclick: (e) => busy(e.currentTarget, 'Sending…', async () => { await api.print.testPage(p.name); }) }, 'Print Test Page'),
      h('button.btn', { onclick: (e) => busy(e.currentTarget, '…', async () => { if (await askSudo(`${p.state === 'paused' ? 'Resuming' : 'Pausing'} a printer needs your password.`)) await api.print.pause(p.name, p.state !== 'paused'); }) }, p.state === 'paused' ? 'Resume' : 'Pause'),
      p.jobs.length ? h('button.btn', { onclick: (e) => busy(e.currentTarget, 'Cancelling…', () => api.print.cancel(p.name)) }, 'Cancel All') : null,
      h('div.spacer'),
      h('button.btn.danger', { onclick: async (e) => { if (await confirmDialog(`Remove “${p.info || p.name}”?`, 'You can add it again later.', 'Remove', { danger: true })) busy(e.currentTarget, 'Removing…', async () => { if (await askSudo('Removing a printer needs your password.')) await api.print.remove(p.name); }); } }, 'Remove…')))] : [];

  const paper = h('select.field.square', { style: { height: '26px', minWidth: '140px' }, onchange: (e) => store.set('printPaper', e.target.value) },
    ...[['', 'Automatic'], ['Letter', 'US Letter'], ['A4', 'A4'], ['Legal', 'US Legal'], ['A5', 'A5']].map(([v, l]) => h('option', { value: v, selected: (store.get('printPaper') || '') === v }, l)));

  async function addPrinter() {
    if (!(await askSudo('Adding a printer needs your password.'))) return;
    const listEl = h('div.pr-found', h('div.pr-looking', h('span.spinner'), 'Looking for printers…'));
    const addr = h('input.field.square', { placeholder: 'ipp://192.168.1.20/ipp/print', style: { flex: 1 } });
    const content = h('div.pr-add', listEl, h('div.pr-addr', h('small', 'Or enter its address'), h('div', { style: { display: 'flex', gap: '6px' } }, addr,
      h('button.btn', { onclick: () => doAdd({ uri: /^\w+:/.test(addr.value.trim()) ? addr.value.trim() : `ipp://${addr.value.trim()}/ipp/print`, name: addr.value.trim().replace(/^\w+:\/\//, '').split(/[/:]/)[0] }) }, 'Add'))));
    let closeDialog = null;
    const done = alertDialog({ title: 'Add Printer', message: 'Printers on your network and plugged in over USB show up here.', content, buttons: [{ label: 'Done', value: 'done', primary: true }] });
    closeDialog = () => content.closest('.global-alert-layer, .alert-layer')?.querySelector('.a-btns .btn')?.click();
    async function doAdd(dev, btn) {
      if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
      try { const r = await api.print.add(dev); selected = r.name; closeDialog(); }
      catch (e) { if (btn) { btn.disabled = false; btn.textContent = 'Add'; } await alertDialog({ title: 'The printer couldn’t be added', message: e.message }); }
    }
    api.print.discover().then((found) => {
      listEl.replaceChildren(...(found.length ? found.map((d) => {
        const b = h('button.btn', 'Add');
        b.onclick = () => doAdd(d, b);
        return h('div.pr-found-row', h('span.pr-ic', { html: PRINTER_ICON }), h('div.label', h('span', d.name), h('small', [d.kind === 'usb' ? 'USB' : 'Network', d.makeModel].filter(Boolean).join(' · '))), b);
      }) : [h('div.pr-looking', 'No printers found. Check the printer is on and on the same network, or enter its address below.')]));
    }).catch((e) => listEl.replaceChildren(h('div.pr-looking', e.message)));
    await done;
    rerender();
  }

  return [h('div.pr-pane'), top,
    h('div.group-title', 'Printers'), list,
    ...detail,
    h('div.group-title', 'Printing'),
    h('div.group', row('Default paper size', paper, 'Used when a printer doesn’t say which paper it has.'),
      row('Printing service', h('span.muted', 'CUPS · ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); import('../wm.js').then(({ wm }) => wm.open('browser', { url: 'http://localhost:631/' })); } }, 'Advanced settings')))),
  ];
}
