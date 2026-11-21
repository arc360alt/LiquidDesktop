// Settings › VPN (main/vpn.js, NetworkManager): your VPN configurations with an on/off switch each, like the Mac's
// VPN pane, plus importing a provider's file (WireGuard .conf, OpenVPN .ovpn) and the plugins for other kinds.
import { h } from '../util.js';
import { api } from '../sys.js';
import { showMenu } from '../menus.js';

let hooked = false, open = null;
const STATE = { on: 'Connected', connecting: 'Connecting…', disconnecting: 'Disconnecting…', off: 'Not Connected' };

/** Turn a VPN on, asking for its password when NetworkManager needs one. Shared with Control Center. */
export async function vpnConnect(v, ask) {
  let r = await api.vpn.connect(v.uuid);
  for (let i = 0; r && r.needSecrets && i < 2; i++) {
    const pw = await ask(`Password for “${v.name}”`, '', { type: 'password', ok: 'Connect', message: i ? 'That didn’t work. Try again.' : 'Your VPN account’s password.' });
    if (pw == null) return false;
    r = await api.vpn.connect(v.uuid, Object.fromEntries(r.keys.map((k) => [k, pw])));
  }
  return !!r?.ok;
}

export async function vpnPane({ row, hero, rerender, askSudo, prompt, alertDialog, confirmDialog }) {
  if (!api.vpn) return [hero('vpn', 'VPN', 'VPNs need the LiquidDesktop app.')];
  if (!hooked) { hooked = true; api.vpn.onChanged?.(() => { if (document.querySelector('.vpn-pane')) rerender(); }); }
  const st = await api.vpn.list().catch((e) => ({ available: false, error: e.message, vpns: [] }));
  const top = hero('vpn', 'VPN', 'A VPN sends your traffic through another network — your workplace, your own server, or a VPN service. Add one from the file your provider gives you.');
  if (!st.available) return [h('div.vpn-pane'), top, h('div.group', row(h('span.muted', 'VPNs need NetworkManager (nmcli), which isn’t running.'), null))];
  const fail = (e) => alertDialog({ title: 'VPN', message: e.message || String(e) });

  const importFile = async () => {
    const files = await api.dialog.open({ title: 'Import VPN Configuration', filters: [{ name: 'VPN configurations', patterns: ['*.conf', '*.ovpn', '*.pcf'] }, { name: 'All files', patterns: ['*'] }] }).catch(() => null);
    const f = Array.isArray(files) ? files[0] : files;
    if (!f) return;
    try {
      let r = await api.vpn.import(f);
      if (r.needPlugin) {
        const k = st.kinds.find((x) => x.id === r.needPlugin);
        if (!(await confirmDialog(`Add ${r.pluginName} support?`, `This file is an ${r.pluginName} configuration. NetworkManager needs its ${r.pluginName} plugin${k?.pkg ? ` (${k.pkg})` : ''} for it. It’s free; installing asks for your password.`, 'Install'))) return;
        if (!(await askSudo('Installing the VPN plugin needs your password.'))) return;
        await api.vpn.install(r.needPlugin);
        r = await api.vpn.import(f);
      }
      if (r.ok) { open = r.uuid; rerender(); }
    } catch (e) { fail(e); }
  };
  const addMenu = (e) => {
    const b = e.currentTarget.getBoundingClientRect();
    showMenu([
      { label: 'Import from File…', action: importFile }, '-',
      { header: 'VPN kinds' },
      { label: 'WireGuard', checked: true, disabled: true },
      ...st.kinds.map((k) => ({ label: k.installed ? k.name : `Install ${k.name} Support…`, checked: k.installed, disabled: k.installed || !k.pkg,
        action: async () => { if (await askSudo(`Installing ${k.name} support needs your password.`)) { try { await api.vpn.install(k.id); rerender(); } catch (er) { fail(er); } } } })),
    ], b.left, b.bottom + 4);
  };

  const rows = st.vpns.map((v) => {
    const sw = h('input', { type: 'checkbox', checked: v.state === 'on' || v.state === 'connecting', disabled: v.missingPlugin, onchange: async (e) => {
      sw.disabled = true;
      try { if (e.target.checked) { if (!(await vpnConnect(v, prompt))) e.target.checked = false; } else await api.vpn.disconnect(v.uuid); }
      catch (er) { e.target.checked = false; fail(er); }
      rerender();
    } });
    const head = h('div.row.vpn-row', h('span.vpn-ic' + (v.state === 'on' ? '.on' : ''), { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2.8 4.5 5.6v5.6c0 4.6 3.1 8.4 7.5 10 4.4-1.6 7.5-5.4 7.5-10V5.6z"/></svg>' }),
      h('div.label', h('span', v.name), h('small', v.missingPlugin ? `Needs ${v.kindName} support` : [STATE[v.state], v.kindName].filter(Boolean).join(' · '))),
      h('button.btn.plain.vpn-more', { title: 'Details', onclick: () => { open = open === v.uuid ? null : v.uuid; rerender(); } }, open === v.uuid ? 'Done' : 'Details…'),
      h('label.toggle', sw, h('span')));
    if (open !== v.uuid) return head;
    return h('div.vpn-detail', head,
      v.server ? row('Server', h('span.muted', v.server)) : null,
      row('Type', h('span.muted', v.kindName)),
      row('Connect when you log in', h('label.toggle', h('input', { type: 'checkbox', checked: v.autoconnect, onchange: (e) => api.vpn.setAuto(v.uuid, e.target.checked).catch(fail) }), h('span'))),
      v.missingPlugin ? row(`${v.kindName} support isn’t installed`, h('button.btn', { onclick: async () => { const k = st.kinds.find((x) => x.id === v.kind); if (k && await askSudo('Installing the VPN plugin needs your password.')) { try { await api.vpn.install(k.id); rerender(); } catch (e) { fail(e); } } } }, 'Install')) : null,
      h('div.row', h('button.btn', { onclick: async () => { const n = await prompt('Rename VPN', v.name, { ok: 'Rename' }); if (n && n !== v.name) { try { await api.vpn.rename(v.uuid, n); } catch (e) { fail(e); } } } }, 'Rename…'), h('div.spacer'),
        h('button.btn.danger', { onclick: async () => { if (await confirmDialog(`Remove “${v.name}”?`, 'Its settings are deleted from this computer. You can import the file again later.', 'Remove', { danger: true })) { try { await api.vpn.remove(v.uuid); } catch (e) { fail(e); } } } }, 'Remove…')));
  });

  return [h('div.vpn-pane'), top,
    h('div.group-title', 'VPN Configurations'),
    h('div.group', ...rows, !rows.length ? row(h('span.muted', 'No VPNs yet'), null) : null, row('', h('button.btn', { onclick: addMenu }, 'Add VPN Configuration ▾'))),
    h('p.vpn-note', 'Get a configuration file from your VPN provider (most offer WireGuard or OpenVPN downloads), your workplace, or a server of your own, then import it here. WireGuard works out of the box; other kinds install a free NetworkManager plugin the first time.'),
  ];
}
