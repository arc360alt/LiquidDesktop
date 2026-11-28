// Archive Utility — what opens when you double-click a .zip (or .tar.gz, .7z…): a small window with a progress bar
// while it expands next to the archive, gone again when it's done. Files' "Compress" uses it too. Opened by itself,
// it offers to expand an archive or compress some files.
import { h, basename, dirname } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym, appIconSVG, docIcon, isArchive } from '../icons.js';
import { api } from '../sys.js';
import { prompt, alertDialog } from '../menus.js';

let seq = 0;
const ON = new Map();   // job id → its row's progress function (one listener for all of them)
let hooked = false;
const hook = () => { if (hooked || !api.archive?.onProgress) return; hooked = true; api.archive.onProgress((p) => ON.get(p.id)?.(p)); };

registerApp({
  id: 'archive', name: 'Archive Utility', hidden: true, size: [420, 150], minSize: [380, 130], resizable: false, singleton: true, overlayContent: true, hideTitle: true,
  keywords: ['zip', 'unzip', 'extract', 'expand', 'compress', 'tar', '7z', 'rar'],
  about: 'Expand archives and compress files.',
  open(win, args = {}) {
    hook();
    const list = h('div.au-list');
    const idle = h('div.au-idle',
      h('div.au-ic', { html: appIconSVG('archive') }),
      h('div.au-idle-t', h('b', 'Archive Utility'), h('small.muted', 'Double-click an archive in Files to expand it, or pick one here.')),
      h('div.au-idle-b',
        h('button.btn', { onclick: () => pick('expand') }, 'Expand…'),
        h('button.btn', { onclick: () => pick('compress') }, 'Compress…')));
    win.body.append(h('div.au', idle, list));
    let running = 0;
    const done = () => { running--; if (running <= 0 && !list.querySelector('.au-row.failed')) setTimeout(() => { if (running <= 0) win.close(); }, 450); };

    async function pick(kind) {
      const files = await api.dialog.open(kind === 'expand'
        ? { title: 'Choose an Archive to Expand', filters: [{ name: 'Archives', patterns: ['*.zip', '*.tar', '*.tar.*', '*.tgz', '*.txz', '*.7z', '*.rar', '*.gz', '*.xz', '*.bz2', '*.zst', '*.iso'] }, { name: 'All files', patterns: ['*'] }] }
        : { title: 'Choose Files to Compress', multiple: true }).catch(() => null);
      const l = Array.isArray(files) ? files : files ? [files] : [];
      if (!l.length) return;
      if (kind === 'expand') l.forEach((p) => expand(p)); else compress(l);
    }

    function row(icon, title) {
      idle.remove();
      const bar = h('i'), sub = h('small.muted', 'Preparing…');
      const stop = h('button.au-stop', { title: 'Stop', html: sym.close });
      const el = h('div.au-row', h('div.au-ic', { html: icon }), h('div.au-mid', h('b.ellipsis', title), h('div.au-bar', bar), sub), stop);
      list.append(el);
      win.el.style.height = '';
      return { el, bar, sub, stop };
    }

    async function expand(path, passphrase) {
      const id = `x${Date.now()}-${++seq}`;
      const r = row(docIcon(path.split('.').pop()), `Expanding “${basename(path)}”`);
      running++;
      ON.set(id, (p) => {
        if (p.done != null) r.bar.style.width = Math.round(p.done * 100) + '%';
        if (p.done != null && !p.finished) r.sub.textContent = `${Math.round(p.done * 100)}%`;
      });
      r.stop.onclick = () => api.archive.cancel(id);
      try {
        const res = await api.archive.extract(id, path, { passphrase });
        if (res?.needsPassword) {
          r.el.remove(); running--;
          const pw = await prompt(res.wrong ? 'That password isn’t right' : `“${basename(path)}” is protected`, '', { type: 'password', ok: 'Expand', message: 'Enter the password for this archive.' }, win.el);
          if (pw) return expand(path, pw);
          return done();
        }
        if (res?.cancelled) { r.el.remove(); return done(); }
        r.bar.style.width = '100%';
        r.sub.textContent = `Done — “${basename(res.result)}”`;
        r.stop.replaceWith(h('button.au-stop.show', { title: 'Show in Files', html: sym.search, onclick: () => wm.open('files', { path: dirname(res.result), select: res.result }) }));
        done();
      } catch (e) {
        r.el.classList.add('failed'); r.sub.textContent = e.message; r.stop.onclick = () => { r.el.remove(); if (!list.children.length) win.close(); };
        running--;
      } finally { ON.delete(id); }
    }

    async function compress(paths) {
      const id = `c${Date.now()}-${++seq}`;
      const r = row(docIcon('zip'), paths.length === 1 ? `Compressing “${basename(paths[0])}”` : `Compressing ${paths.length} items`);
      running++;
      ON.set(id, (p) => { if (p.done != null) { r.bar.style.width = Math.round(p.done * 100) + '%'; r.sub.textContent = `${Math.round(p.done * 100)}%`; } });
      r.stop.onclick = () => api.archive.cancel(id);
      try {
        const res = await api.archive.compress(id, paths);
        if (res?.cancelled) { r.el.remove(); return done(); }
        r.bar.style.width = '100%'; r.sub.textContent = `Done — “${basename(res.result)}”`;
        done();
      } catch (e) {
        r.el.classList.add('failed'); r.sub.textContent = e.message; r.stop.onclick = () => { r.el.remove(); if (!list.children.length) win.close(); };
        running--;
      } finally { ON.delete(id); }
    }

    const start = (a) => {
      if (a?.compress?.length) compress(a.compress);
      else if (a?.path) { if (isArchive(a.path)) expand(a.path); else alertDialog({ title: 'That isn’t an archive', message: basename(a.path) }, win.el); }
    };
    win.on('reopen', start);
    start(args);
  },
});
