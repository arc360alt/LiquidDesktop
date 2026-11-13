// External drives for Files (USB sticks, SD cards, external disks, and other disks' partitions mounted
// under /run/media, /media or /mnt): listed with lsblk, mounted / ejected with udisksctl (no password
// needed for removable drives in your own session).
const { ipcMain } = require('electron');
const { execFile } = require('child_process');

const run = (cmd, args, timeout = 20000) => new Promise((res, rej) => execFile(cmd, args, { timeout }, (err, out, errOut) => {
  // the program itself is missing: say what to install, not "spawn … ENOENT"
  if (err?.code === 'ENOENT') return rej(new Error(cmd === 'udisksctl'
    ? 'Opening drives needs udisks2. Install it (sudo pacman -S udisks2), or update LiquidDesktop, then try again.'
    : `${cmd} isn’t installed.`));
  res({ ok: !err, out: String(out || ''), err: String(errOut || err?.message || '') });
}));
const USER_MOUNT = /^\/(run\/media|media|mnt)\//;

async function list() {
  const r = await run('lsblk', ['-J', '-b', '-o', 'NAME,PATH,LABEL,PARTLABEL,SIZE,FSTYPE,MOUNTPOINTS,RM,HOTPLUG,TYPE,TRAN,MODEL,VENDOR']);
  if (!r.ok) return [];
  let tree;
  try { tree = JSON.parse(r.out).blockdevices || []; } catch { return []; }
  const out = [];
  const walk = (dev, disk) => {
    const removable = !!(disk.rm || disk.hotplug || disk.tran === 'usb' || dev.rm || dev.hotplug);
    const mounts = (dev.mountpoints || []).filter(Boolean);
    const userMounted = mounts.some((m) => USER_MOUNT.test(m));
    // a filesystem on an external drive, or one someone mounted under /run/media, /media or /mnt
    if (dev.fstype && !/swap|crypto_LUKS|LVM2_member|linux_raid_member/.test(dev.fstype) && (removable || userMounted) && dev.type !== 'loop' && !/^zram/.test(dev.name)) {
      const model = [disk.vendor, disk.model].map((s) => (s || '').trim()).filter(Boolean).join(' ');
      out.push({
        device: dev.path, disk: disk.path,
        name: dev.label || dev.partlabel || (model ? model : 'Untitled'),
        size: Number(dev.size) || 0, fstype: dev.fstype,
        mounted: mounts[0] || null, removable, usb: disk.tran === 'usb',
        kind: disk.tran === 'usb' ? 'usb' : /mmc/.test(disk.name || '') ? 'sd' : removable ? 'usb' : 'disk',
      });
    }
    for (const c of dev.children || []) walk(c, disk);
  };
  for (const d of tree) walk(d, d);
  return out;
}

async function mount(device) {
  const r = await run('udisksctl', ['mount', '-b', device, '--no-user-interaction']);
  if (!r.ok && !/AlreadyMounted/.test(r.err)) throw new Error(clean(r.err) || 'The drive couldn’t be opened.');
  const m = r.out.match(/ at (.+?)\.?\s*$/m);
  if (m) return m[1];
  return (await list()).find((d) => d.device === device)?.mounted || null;
}
// unmount every filesystem on the drive, then switch the drive off so it can be pulled out
async function eject(device) {
  const drives = await list();
  const me = drives.find((d) => d.device === device);
  if (!me) throw new Error('That drive isn’t connected any more.');
  for (const d of drives.filter((x) => x.disk === me.disk && x.mounted)) {
    const r = await run('udisksctl', ['unmount', '-b', d.device, '--no-user-interaction']);
    if (!r.ok && !/NotMounted/.test(r.err)) throw new Error(/busy/i.test(r.err) ? `“${d.name}” is in use. Close the files and apps using it, then try again.` : clean(r.err) || 'The drive couldn’t be ejected.');
  }
  if (me.removable) await run('udisksctl', ['power-off', '-b', me.disk, '--no-user-interaction']);   // fine if it can't (SD readers)
  return true;
}
const clean = (s) => s.replace(/^Error [^:]*:\s*/m, '').replace(/GDBus\.Error:[\w.]+:\s*/g, '').trim().split('\n')[0];

function register() {
  const h = (n, fn) => ipcMain.handle(n, async (_e, ...a) => { try { return await fn(...a); } catch (e) { return { __error: e.message }; } });
  h('drives:list', () => list());
  h('drives:mount', (d) => mount(String(d)));
  h('drives:eject', (d) => eject(String(d)));
}

module.exports = { register, list };
