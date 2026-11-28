// Time Machine — go back in time through your backups and snapshots, like the Mac's: a window onto your home folder
// as it was, a stack of earlier ones fading into space behind it, and the timeline down the right edge. Pick a time,
// find the file (deleted ones are marked), and Restore puts it back. The sidebar has the backup disk's status and
// Back Up Now, Local Snapshots, and on Lumen the system snapshots (roll the whole system back).
import { h, $, $$, fmtSize, basename, dirname } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym, appIconSVG, folderIcon, docIcon } from '../icons.js';
import { api } from '../sys.js';
import { shell } from '../shell.js';
import { contextMenu, alertDialog, confirmDialog } from '../menus.js';
import { askSudo } from '../admin.js';
import { when, inTime, chooseDisk } from '../tmshared.js';

const I = {
  drive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="7" width="18" height="10" rx="2.5"/><circle cx="17" cy="12" r="1.1" fill="currentColor"/></svg>',
  local: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="4" y="5" width="16" height="11" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M9.5 10.5a2.5 2.5 0 1 0 2.5-2.5" /><path d="M9.3 7.8v2.6h2.6" stroke-linejoin="round"/></svg>',
  system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3 4 6.5V12c0 4.4 3.3 7.6 8 9 4.7-1.4 8-4.6 8-9V6.5z"/><path d="M9 12.2l2.2 2.2 4-4.4" stroke-linecap="round"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
};

registerApp({
  id: 'timemachine', name: 'Time Machine', size: [1100, 720], minSize: [760, 500], overlayContent: true, hideTitle: true, singleton: true,
  keywords: ['backup', 'backups', 'restore', 'snapshot', 'snapshots', 'history', 'recover', 'undelete'],
  about: 'Back up your files, and go back in time to get them back.',
  menus: (win) => [{ title: 'File', items: [{ label: 'Back Up Now', action: () => win?.state?.backupNow() }, { label: 'Restore', shortcut: '↩', action: () => win?.state?.restoreSel() }, '-', { label: 'Time Machine Settings…', action: () => shell.openSettings('timemachine') }, { label: 'Close Window', shortcut: '⌘W', action: () => win?.close() }] },
    { title: 'Go', items: [{ label: 'Older', shortcut: '↑', action: () => win?.state?.step(-1) }, { label: 'Newer', shortcut: '↓', action: () => win?.state?.step(1) }, { label: 'Enclosing Folder', shortcut: '⌘↑', action: () => win?.state?.up() }] }],
  open(win, args = {}) {
    let st = null, pts = [], cur = -1, rel = args.rel || '', sel = new Set(), source = 'backups', onlyChanged = false, sys = null;
    const side = h('div.sidebar.tm-side');
    const main = h('div.main-pane.tm-main');
    win.body.append(side, main);
    const statusCard = h('div.tm-status');

    /* ---------------------------------------------- data */
    async function refresh(keepPoint) {
      const prevId = pts[cur]?.id;
      [st, pts] = await Promise.all([api.tm.status().catch(() => null), api.tm.points().catch(() => [])]);
      if (source === 'system' && !sys) sys = await api.tm.system().catch(() => null);
      cur = keepPoint && prevId ? Math.max(0, pts.findIndex((p) => p.id === prevId)) : pts.length - 1;
      drawSide(); draw();
    }

    /* ---------------------------------------------- sidebar */
    function drawSide() {
      const item = (k, label, icon, sub) => {
        const el = h('div.sb-item' + (source === k ? '.sel' : ''), { html: icon }, h('span.ellipsis', label), sub ? h('small.ph2-n', sub) : null);
        el.addEventListener('click', async () => { source = k; sel.clear(); if (k === 'system' && !sys) sys = await api.tm.system().catch(() => null); drawSide(); draw(); });
        return el;
      };
      const driveLabel = st?.dest ? st.dest.label : 'No Backup Disk';
      const localOn = st?.local?.enabled;
      side.replaceChildren(...[
        h('div.sb-sec', 'Go Back In Time'),
        item('backups', 'Your Files', I.drive, pts.length ? String(pts.length) : null),
        h('div.sb-sec', 'Kept On'),
        h('div.tm-where', h('span', { html: I.drive }), h('div', h('b.ellipsis', driveLabel), h('small', st?.dest ? (st.dest.connected ? `${st.dest.count} backup${st.dest.count === 1 ? '' : 's'}` : 'Not connected') : 'Not set up'))),
        h('div.tm-where', h('span', { html: I.local }), h('div', h('b', 'Local Snapshots'), h('small', localOn ? `${st.local.count} on this computer` : st?.local?.btrfs ? 'Off' : 'Needs Btrfs'))),
        st?.system?.available ? h('div.sb-sec', 'System') : null,
        st?.system?.available ? item('system', 'System Snapshots', I.system) : null,
        h('div.spacer'),
        statusCard].filter(Boolean));
      drawStatus();
    }
    function drawStatus() {
      if (!st) return;
      const r = st.running;
      const p = r?.progress;
      statusCard.replaceChildren(
        h('div.tm-st-ic', { html: appIconSVG('timemachine') }),
        r ? h('div.tm-st-t', h('b', 'Backing Up…'), h('small', p ? `${p.files.toLocaleString()} files · ${fmtSize(p.copiedBytes)} copied` : 'Getting ready…'), h('div.tm-bar', h('i', { style: { width: p ? Math.min(98, 8 + Math.log10(p.files + 1) * 18) + '%' : '6%' } })))
          : h('div.tm-st-t', h('b', st.dest ? (st.last ? `Latest: ${when(st.last.time)}` : 'No backups yet') : 'Not backing up'),
            h('small', st.dest ? (st.dest.connected ? (st.auto ? `Next backup ${inTime(st.next)}` : 'Backing up when you ask') : `${st.dest.label} isn’t connected`) : 'Choose a backup disk to start'),
            st.lastError && (!st.last || st.lastError.time > st.last.time) ? h('small.tm-err', st.lastError.why) : null),
        h('div.tm-st-b',
          r ? h('button.btn', { onclick: () => api.tm.stop() }, 'Stop')
            : st.dest ? h('button.btn.primary', { disabled: !st.dest.connected, onclick: () => backupNow() }, 'Back Up Now') : h('button.btn.primary', { onclick: async () => { if (await chooseDisk(win.el)) refresh(); } }, 'Choose Disk…'),
          h('button.btn.plain', { onclick: () => shell.openSettings('timemachine') }, 'Settings…')));
    }
    async function backupNow() {
      try { const r = api.tm.backupNow(); refresh(true); await r; } catch (e) { alertDialog({ title: 'The backup couldn’t start', message: e.message }, win.el); }
      refresh(true);
    }

    /* ---------------------------------------------- the main view */
    function draw() {
      if (source === 'system') return drawSystem();
      if (!pts.length) return drawWelcome();
      const p = pts[cur];
      const stack = h('div.tm-stack');
      // the earlier windows, fading back into space
      for (let i = 1; i <= Math.min(6, cur); i++) stack.append(h('div.tm-ghost', { style: { '--i': i } }));
      const crumbs = h('div.tm-crumbs');
      const parts = rel ? rel.split('/') : [];
      const crumb = (label, r) => { const c = h('button.tm-crumb', label); c.addEventListener('click', () => { rel = r; sel.clear(); draw(); }); return c; };
      crumbs.append(crumb('Home', ''));
      parts.forEach((x, i) => { crumbs.append(h('span.tm-chev', '›'), crumb(x, parts.slice(0, i + 1).join('/'))); });
      const listEl = h('div.tm-list', h('div.tm-loading', 'Loading…'));
      const filterBtn = h('button.btn.plain.tm-filter' + (onlyChanged ? '.on' : ''), { title: 'Only show what has changed or been deleted since', onclick: () => { onlyChanged = !onlyChanged; draw(); } }, onlyChanged ? 'Changed & Deleted' : 'All Items');
      const card = h('div.tm-card',
        h('div.tm-card-head', h('button.tb-btn', { title: 'Enclosing Folder', html: sym.chevronLeft, disabled: !rel, onclick: () => up() }), crumbs, h('span.spacer'), filterBtn),
        listEl);
      stack.append(card);
      const title = h('div.tm-when', h('b', when(p.time, { long: true })), h('small', p.source === 'local' ? 'Local snapshot on this computer' : `Backup on ${st?.dest?.label || 'your backup disk'}`));
      const nav = h('div.tm-nav', h('button.tm-navb', { title: 'Older', html: I.up, disabled: cur <= 0, onclick: () => step(-1) }), h('button.tm-navb', { title: 'Newer', html: I.down, disabled: cur >= pts.length - 1, onclick: () => step(1) }));
      const restoreBtn = h('button.btn.primary.tm-restore', { disabled: true, onclick: () => restoreSel() }, 'Restore');
      const foot = h('div.tm-foot', h('button.btn', { onclick: () => win.close() }, 'Done'), h('span.tm-foot-sel'), restoreBtn);
      main.replaceChildren(h('div.tm-space'), title, stack, nav, timeline(), foot);
      loadList(p, listEl, restoreBtn);
    }
    async function loadList(p, listEl, restoreBtn) {
      const my = p.id + '|' + rel;
      let items;
      try { items = await api.tm.list(p.id, rel); } catch (e) { listEl.replaceChildren(h('div.tm-empty', e.message)); return; }
      if (pts[cur]?.id + '|' + rel !== my) return;
      items = items.filter((i) => !i.hidden).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
      if (onlyChanged) items = items.filter((i) => i.state !== 'same' || i.isDir);
      if (!items.length) { listEl.replaceChildren(h('div.tm-empty', onlyChanged ? 'Nothing here has changed since.' : 'This folder was empty.')); return; }
      const paint = () => {
        $$('.tm-row', listEl).forEach((r) => r.classList.toggle('sel', sel.has(r.dataset.rel)));
        restoreBtn.disabled = !sel.size;
        restoreBtn.textContent = sel.size > 1 ? `Restore ${sel.size} Items` : 'Restore';
        const fs = $('.tm-foot-sel', main); if (fs) fs.textContent = sel.size ? `${sel.size} selected` : '';
      };
      listEl.replaceChildren(...items.map((it) => {
        const r = h('div.tm-row.' + it.state, { 'data-rel': it.rel },
          h('span.tm-ic', { html: it.isDir ? folderIcon(it.name) : docIcon(it.ext) }), h('span.tm-nm.ellipsis', it.name),
          h('span.tm-badge', it.state === 'gone' ? 'Deleted since' : it.state === 'changed' && !it.isDir ? 'Changed since' : ''),
          h('span.tm-date', new Date(it.mtime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })), h('span.tm-size', it.isDir ? '--' : fmtSize(it.size)));
        r.addEventListener('mousedown', (e) => { if (e.button === 2 && sel.has(it.rel)) return; if (e.ctrlKey || e.metaKey) sel.has(it.rel) ? sel.delete(it.rel) : sel.add(it.rel); else { sel.clear(); sel.add(it.rel); } paint(); });
        r.addEventListener('dblclick', () => { if (it.isDir) { rel = it.rel; sel.clear(); draw(); } else shell.openPath(it.abs, false); });
        r.addEventListener('contextmenu', (e) => contextMenu(e, [
          { label: 'Restore', action: () => restoreSel() },
          { label: 'Restore To…', action: () => restoreSel({ pickFolder: true }) },
          it.isDir ? { label: 'Open', action: () => { rel = it.rel; sel.clear(); draw(); } } : { label: 'Quick Look', action: () => shell.openPath(it.abs, false) },
          { label: 'Show the Backup in Files', action: () => wm.open('files', { path: dirname(it.abs), select: it.abs }) },
          { label: 'Show Current Version in Files', disabled: it.state === 'gone', action: () => api.fs.places().then((pl) => wm.open('files', { path: dirname(pl.home + '/' + it.rel), select: pl.home + '/' + it.rel })) }]));
        return r;
      }));
      paint();
    }
    // the timeline: every point in time, oldest at the top, now at the bottom (like the Mac's right edge)
    function timeline() {
      const tl = h('div.tm-timeline');
      const n = pts.length;
      let lastDay = '';
      pts.forEach((p, i) => {
        const d = new Date(p.time), day = d.toDateString();
        const label = day !== lastDay ? (d.toDateString() === new Date().toDateString() ? 'Today' : d.toLocaleDateString([], { month: 'short', day: 'numeric' })) : '';
        lastDay = day;
        const t = h('div.tm-tick' + (i === cur ? '.on' : '') + (label ? '.day' : '') + (p.source === 'local' ? '.local' : ''), { title: when(p.time, { long: true }) + (p.source === 'local' ? ' (local snapshot)' : ''), style: { flex: '1 1 0' } }, h('i'), label ? h('span', label) : null);
        t.addEventListener('click', () => { cur = i; sel.clear(); draw(); });
        tl.append(t);
      });
      tl.append(h('div.tm-tick.now', h('i'), h('span', 'Now')));
      void n;
      return tl;
    }
    function step(d) { if (source === 'system' || !pts.length) return; const n = Math.max(0, Math.min(pts.length - 1, cur + d)); if (n !== cur) { cur = n; sel.clear(); draw(); } }
    function up() { if (!rel) return; rel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''; sel.clear(); draw(); }

    async function restoreSel({ pickFolder } = {}) {
      const p = pts[cur];
      if (!p || !sel.size) return;
      const rels = [...sel];
      let to = null, mode = 'keepBoth';
      if (pickFolder) {
        const f = await api.dialog.open({ title: 'Restore To', directory: true }).catch(() => null);
        to = Array.isArray(f) ? f[0] : f;
        if (!to) return;
      } else {
        const inWay = await api.tm.conflicts(p.id, rels).catch(() => []);
        if (inWay.length) {
          const r = await alertDialog({ title: inWay.length === 1 ? `“${basename(inWay[0])}” is already there` : `${inWay.length} of these items are already there`, message: 'Keep both (the restored one is named “… (original)”), or replace what’s there now? Replaced items go to the Trash.',
            buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Replace', value: 'replace' }, { label: 'Keep Both', value: 'keep', primary: true }] }, win.el);
          if (r.button === 'cancel') return;
          mode = r.button === 'replace' ? 'replace' : 'keepBoth';
        }
      }
      try {
        const done = await api.tm.restore(p.id, rels, { mode, to });
        sel.clear(); draw();
        shell.notify({ app: 'timemachine', title: done.length === 1 ? `Restored “${basename(done[0])}”` : `Restored ${done.length} items`, body: dirname(done[0]).replace(shell.home, '~'), action: () => wm.open('files', { path: dirname(done[0]), select: done[0] }) });
      } catch (e) { alertDialog({ title: 'That couldn’t be restored', message: e.message }, win.el); }
    }

    /* ---------------------------------------------- nothing to go back to yet */
    function drawWelcome() {
      const local = st?.local;
      main.replaceChildren(h('div.tm-space'), h('div.tm-welcome',
        h('div.tm-welcome-ic', { html: appIconSVG('timemachine') }),
        h('h1', st?.dest ? 'No backups yet' : 'Back Up with Time Machine'),
        h('p', st?.dest ? (st.dest.connected ? 'Your first backup copies everything in your home folder; after that, only what changed. You can keep using the computer meanwhile.' : `Connect “${st.dest.label}” to back up.`)
          : 'Time Machine keeps copies of your files — every hour for the past day, every day for the past month, every week after that — so you can get back a file you deleted or changed.'),
        h('div.tm-welcome-b',
          st?.dest ? h('button.btn.primary.lg', { disabled: !st.dest.connected || !!st.running, onclick: () => backupNow() }, st.running ? 'Backing Up…' : 'Back Up Now')
            : h('button.btn.primary.lg', { onclick: async () => { if (await chooseDisk(win.el)) refresh(); } }, 'Choose Backup Disk…'),
          local?.btrfs && !local?.enabled ? h('button.btn.lg', { onclick: () => turnOnLocal() }, 'Turn On Local Snapshots') : null),
        local?.btrfs && !local?.enabled ? h('small.muted', 'No drive? Local snapshots keep hourly versions of your files on this computer (Btrfs).') : null));
    }
    async function turnOnLocal() {
      if (!(await askSudo('Turning on local snapshots needs your password once.', win.el))) return;
      try { await api.tm.localSetup(true); refresh(); } catch (e) { alertDialog({ title: 'Local snapshots couldn’t be turned on', message: e.message }, win.el); }
    }

    /* ---------------------------------------------- System Snapshots (Lumen) */
    function drawSystem() {
      const s = sys;
      if (!s?.available) { main.replaceChildren(h('div.tm-space'), h('div.tm-welcome', h('h1', 'No system snapshots'), h('p', 'This system doesn’t take snapshots of itself.'))); return; }
      const rows = s.list.map((x) => {
        const r = h('div.tm-srow', h('div', h('b', x.label || (x.kind === 'pre' ? 'Before a change' : x.kind === 'post' ? 'After a change' : 'Snapshot')), h('small.muted', `#${x.number} · ${when(x.time, { long: true })}`)),
          h('button.btn', { onclick: () => rollback(x) }, 'Restore…'));
        return r;
      });
      main.replaceChildren(h('div.tm-space'), h('div.tm-system',
        s.live ? h('div.tm-banner', h('b', 'You’re using a snapshot.'), ' Changes you make now aren’t kept. Restore it to keep using this version, or restart to go back.') : null,
        h('h1', 'System Snapshots'),
        h('p.muted', 'Lumen takes a snapshot of the system before every update and software change. Restoring one rolls the whole system back to it (your files in your home folder stay as they are). The system you have now is kept until you clean up old systems.'),
        !s.readable ? h('div.tm-banner', 'Your account can’t see the system’s snapshot list. On Lumen, the “wheel” group can.') : null,
        h('div.group.tm-slist', ...(rows.length ? rows : [h('div.tm-empty', 'No snapshots yet.')]))));
    }
    async function rollback(x) {
      if (!(await confirmDialog(`Restore the system to “${x.label || '#' + x.number}”?`, `The system goes back to how it was on ${when(x.time, { long: true })}, after a restart. Your home folder isn’t changed.`, 'Restore…', { danger: true }, win.el))) return;
      if (!(await askSudo('Restoring a system snapshot needs your password.', win.el))) return;
      try {
        await api.tm.systemRollback(x.number);
        const r = await alertDialog({ title: 'Restart to finish', message: 'The snapshot is ready. Restart to start up from it.', buttons: [{ label: 'Later', value: 'later' }, { label: 'Restart', value: 'restart', primary: true }] }, win.el);
        if (r.button === 'restart') shell.power('restart');
      } catch (e) { alertDialog({ title: 'The snapshot couldn’t be restored', message: e.message }, win.el); }
    }

    /* ---------------------------------------------- live updates */
    api.tm.onChanged?.(() => refresh(true));
    api.tm.onProgress?.((p) => { if (st) { st.running = { ...(st.running || { started: Date.now() }), progress: p }; drawStatus(); } });
    win.el.addEventListener('keydown', (e) => {
      if (e.target.closest('input')) return;
      if (e.key === 'ArrowUp' && !e.ctrlKey) { e.preventDefault(); step(-1); }
      if (e.key === 'ArrowDown' && !e.ctrlKey) { e.preventDefault(); step(1); }
      if (e.ctrlKey && e.key === 'ArrowUp') { e.preventDefault(); up(); }
      if (e.key === 'Enter' && sel.size) { e.preventDefault(); restoreSel(); }
      if (e.key === 'Escape') win.close();
    });
    win.el.tabIndex = 0;
    win.state = { backupNow, restoreSel, step, up };
    win.on('reopen', () => refresh(true));
    refresh();
  },
});
