// Settings › Time Machine: the backup disk (and its status), how often, local snapshots, and what's left out.
import { h, fmtSize } from '../util.js';
import { api } from '../sys.js';
import { wm } from '../wm.js';
import { when, inTime, INTERVALS, chooseDisk } from '../tmshared.js';

export async function timeMachinePane({ row, hero, rerender, askSudo, confirmDialog, alertDialog }) {
  const st = await api.tm?.status?.().catch(() => null);
  if (!st) return [hero('timemachine', 'Time Machine', 'Time Machine isn’t available here.')];
  const d = st.dest;
  const disk = d
    ? h('div.tm-pdisk',
      h('div.tm-pdisk-ic', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="7" width="18" height="10" rx="2.5"/><circle cx="17" cy="12" r="1.1" fill="currentColor"/><path d="M6 12h6" stroke-linecap="round"/></svg>' }),
      h('div.tm-pdisk-t',
        h('b', d.label),
        h('small', d.connected ? (st.running ? 'Backing up now…' : `Latest backup: ${when(st.last?.time)}`) : 'Not connected — backups continue when it’s plugged in'),
        d.connected && d.oldest ? h('small', `Oldest backup: ${when(d.oldest, { long: true })} · ${d.count} backup${d.count === 1 ? '' : 's'}`) : null,
        d.connected && st.auto && !st.running ? h('small', `Next backup: ${inTime(st.next)}`) : null,
        d.space ? h('div.tm-space-bar', h('i', { style: { width: Math.round((1 - d.space.free / d.space.total) * 100) + '%' } })) : null,
        d.space ? h('small', `${fmtSize(d.space.free)} available of ${fmtSize(d.space.total)}`) : null,
        st.lastError && (!st.last || st.lastError.time > st.last.time) ? h('small.tm-err', st.lastError.why) : null))
    : h('div.tm-pdisk.none', h('div.tm-pdisk-t', h('b', 'No backup disk'), h('small', 'Add a disk formatted for Linux (ext4 or Btrfs) — an external drive is best, so your backups survive if this computer doesn’t.')));
  const intervalSel = h('select.field.square', { style: { height: '26px', minWidth: '150px' }, onchange: async (e) => { const v = e.target.value; await api.tm.options(v === 'manual' ? { auto: false } : { auto: true, interval: +v }); rerender(); } },
    ...INTERVALS.map(([v, l]) => h('option', { value: v, selected: st.auto && st.interval === v }, l)), h('option', { value: 'manual', selected: !st.auto }, 'Manually'));
  const tog = (on, fn) => h('label.toggle', h('input', { type: 'checkbox', checked: !!on, onchange: (e) => fn(e.target.checked, e) }), h('span'));
  const home = st.home;
  const excl = h('div.tm-excl', ...st.excludes.map((p) => h('div.tm-excl-row', h('span.ellipsis', p.startsWith(home + '/') ? '~/' + p.slice(home.length + 1) : p),
    h('button.sb-eject', { title: 'Back it up after all', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>', onclick: async () => { await api.tm.options({ excludes: st.excludes.filter((x) => x !== p) }); rerender(); } }))));
  const local = st.local || {};
  return [
    hero('timemachine', 'Time Machine', 'Back up your home folder automatically, then go back in time to get back files you deleted or changed.'),
    h('div.group', disk,
      h('div.row.tm-pbtns',
        d ? h('button.btn', { disabled: !d.connected || !!st.running, onclick: () => { api.tm.backupNow().catch((e) => alertDialog({ title: 'The backup couldn’t start', message: e.message })); setTimeout(rerender, 400); } }, st.running ? 'Backing Up…' : 'Back Up Now') : null,
        h('button.btn', { onclick: async () => { if (await chooseDisk()) rerender(); } }, d ? 'Change Disk…' : 'Add Backup Disk…'),
        d ? h('button.btn.plain', { onclick: async () => { if (await confirmDialog('Stop backing up to this disk?', 'The backups already on it stay there; you can add it again later.', 'Remove', { danger: true })) { await api.tm.forget(); rerender(); } } }, 'Remove') : null,
        h('span.spacer'),
        h('button.btn.plain', { onclick: () => wm.open('timemachine') }, 'Open Time Machine'))),
    h('div.group-title', 'Schedule'),
    h('div.group',
      row('Back up automatically', intervalSel),
      row('Back up on battery power', tog(st.onBattery, async (v) => { await api.tm.options({ onBattery: v }); }), 'Off: laptops only back up while plugged in.')),
    h('div.group-title', 'Local Snapshots'),
    h('div.group',
      row('Hourly snapshots on this computer', local.btrfs ? tog(local.enabled, async (v, e) => {
        if (!(await askSudo(v ? 'Turning on local snapshots needs your password once.' : 'Turning off local snapshots needs your password.'))) { e.target.checked = !v; return; }
        try { await api.tm.localSetup(v); } catch (err) { e.target.checked = !v; alertDialog({ title: 'That didn’t work', message: err.message }); }
        rerender();
      }) : h('span.muted', 'Needs Btrfs'),
      local.btrfs ? `Instant snapshots of /home (Btrfs) every hour, kept for a day, a week and a month — no drive needed. ${local.enabled ? `${local.count} now.` : 'Not a replacement for a backup disk: if this disk breaks, they’re gone too.'}` : 'Your home folder isn’t on a Btrfs file system, so it can’t be snapshotted.')),
    h('div.group-title', 'Not Backed Up'),
    h('div.group', excl,
      h('div.row', h('button.btn', { onclick: async () => {
        const f = await api.dialog.open({ title: 'Leave a Folder Out of Backups', directory: true, folder: home }).catch(() => null);
        const p = Array.isArray(f) ? f[0] : f;
        if (p) { await api.tm.options({ excludes: [...new Set([...st.excludes, p])] }); rerender(); }
      } }, 'Add Folder…'), h('small.muted', { style: { flex: 1, marginLeft: '10px' } }, 'Caches, the Trash and game libraries are left out to save space.'))),
  ];
}
