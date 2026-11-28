// Time Machine's shared pieces (the app, Settings › Time Machine, the shell): dates as people say them, the "Choose
// a Backup Disk" sheet, and the notice when a backup fails.
import { h, fmtSize } from './util.js';
import { api } from './sys.js';
import { alertDialog } from './menus.js';
import { askSudo } from './admin.js';

/** "Today, 2:05 PM", "Yesterday, 9:00 AM", "Monday, 18:00", "12 March 2026" */
export function when(t, { long = false } = {}) {
  if (!t) return 'Never';
  const d = new Date(t), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 864e5);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diff === 0) return `Today, ${time}`;
  if (diff === 1) return `Yesterday, ${time}`;
  if (diff < 7) return `${d.toLocaleDateString([], { weekday: 'long' })}, ${time}`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() && !long ? undefined : 'numeric' }) + (long ? `, ${time}` : '');
}
export function inTime(t) {
  if (!t) return '';
  const m = Math.round((t - Date.now()) / 60000);
  if (m <= 1) return 'in a moment';
  if (m < 60) return `in ${m} minutes`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `in ${hr} hour${hr === 1 ? '' : 's'}`;
  return when(t);
}
export const INTERVALS = [[3600e3, 'Every Hour'], [86400e3, 'Every Day'], [7 * 86400e3, 'Every Week']];

/** The sheet for picking (or changing) the backup disk. Resolves true when one was set up. */
export async function chooseDisk(anchor) {
  const list = h('div.tm-disks', h('div.muted.tm-disks-empty', 'Looking for drives…'));
  let picked = null;
  const draw = async () => {
    const drives = await api.tm.drives().catch(() => []);
    if (!drives.length) { list.replaceChildren(h('div.muted.tm-disks-empty', 'Connect an external drive (USB or Thunderbolt) or a second internal disk, then it shows up here.')); return; }
    list.replaceChildren(...drives.map((d) => {
      const el = h('div.tm-disk' + (d.ok ? '' : '.bad'), { onclick: () => { if (!d.ok) return; picked = d.uuid; list.querySelectorAll('.tm-disk').forEach((x) => x.classList.toggle('sel', x === el)); } },
        h('div.tm-disk-ic', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="7" width="18" height="10" rx="2.5"/><circle cx="17" cy="12" r="1.1" fill="currentColor"/><path d="M6 12h6" stroke-linecap="round"/></svg>' }),
        h('div.tm-disk-t', h('b', d.label), h('small', [d.fstype.toUpperCase(), fmtSize(d.size), d.avail != null ? `${fmtSize(d.avail)} free` : d.mount ? '' : 'not opened yet'].filter(Boolean).join(' · ')), d.ok ? null : h('small.tm-disk-why', d.reason)));
      return el;
    }));
  };
  draw();
  // this computer's own drive isn't Btrfs (none of its drives are, or only an external one): backups to a drive still
  // work, but local and system snapshots can't — say so, and what it takes to change
  const box = h('div.tm-choose', list);
  api.tm.systemDisk?.().then((s) => {
    if (!s || s.homeBtrfs) return;
    const fs = (s.homeFs || 'another format').toUpperCase();
    box.prepend(h('div.tm-fswarn',
      h('div.tm-fswarn-ic', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.3v.2"/></svg>' }),
      h('div',
        h('b', 'This computer isn’t set up for Btrfs'),
        h('p', `Its drive uses ${fs}${s.externalBtrfs && !s.internalBtrfs ? ' (the only Btrfs drive is an external one)' : ''}. You can still back up to a drive, but Local Snapshots — versions of your files kept on this computer between backups — and system snapshots need the computer’s own drive to use Btrfs.`),
        h('p', 'Switching to Btrfs means reinstalling the operating system and choosing Btrfs when it asks how to set up the drive. Back up to an external drive first, so you can bring your files back afterwards.'))));
  }).catch(() => {});
  const r = await alertDialog({ title: 'Choose a Backup Disk', message: 'Time Machine keeps hourly backups for the past day, daily ones for the past month, and weekly ones for as long as there’s room. Your files stay readable on the drive.', content: box,
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Set Up Disk', value: 'ok', primary: true }] }, anchor);
  if (r.button !== 'ok' || !picked) return false;
  for (let i = 0; i < 2; i++) {
    try { await api.tm.prepare(picked); return true; } catch (e) {
      if (/NEEDS_PASSWORD/.test(e.message) && i === 0) { if (await askSudo('Making a backup folder on this drive needs your password once.', anchor)) continue; return false; }
      await alertDialog({ title: 'This disk can’t be used', message: e.message }, anchor);
      return false;
    }
  }
  return false;
}

/** The shell: a notice when a backup fails (a successful one is quiet, like the Mac's). */
export function initTimeMachineNotices(notify) {
  api.tm?.onFinished?.((r) => {
    if (r?.ok || !r?.why) return;
    notify({ app: 'timemachine', title: 'Time Machine couldn’t finish the backup', body: r.why, action: () => import('./wm.js').then(({ wm }) => wm.activate('timemachine')) });
  });
}
