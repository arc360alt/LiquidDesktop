// Console — the Mac's log viewer: the system's messages (live while you watch), errors and faults, previous
// startups, the kernel's messages, LiquidDesktop's own log files and crash reports. "Create Bug Report" puts
// what a developer would ask for into one text file on your Desktop.
import { h, $, fmtSize } from '../util.js';
import { registerApp, wm } from '../wm.js';
import { sym } from '../icons.js';
import { api } from '../sys.js';
import { contextMenu, alertDialog } from '../menus.js';

const ROW = 24;   // list row height (the list draws only the rows in view)
const PRI = ['Emergency', 'Alert', 'Critical', 'Error', 'Warning', 'Notice', 'Info', 'Debug'];
const priClass = (p) => (p <= 2 ? 'fault' : p === 3 ? 'error' : p === 4 ? 'warn' : p <= 6 ? 'info' : 'debug');
const SOURCES = [
  ['boot', 'This Startup', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v8M7.5 6.3a7 7 0 1 0 9 0" stroke-linecap="round"/></svg>'],
  ['errors', 'Errors and Faults', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3.5 21.5 20h-19z" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.1" stroke-linecap="round"/></svg>'],
  ['all', 'All Messages', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 7h14M5 12h14M5 17h10"/></svg>'],
  ['session', 'Your Apps', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-4 3.6-6 7-6s6.2 2 7 6" stroke-linecap="round"/></svg>'],
  ['kernel', 'Kernel', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" stroke-linecap="round"/></svg>'],
  ['lastboot', 'Previous Startup', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 12a8 8 0 1 0 2.4-5.7" stroke-linecap="round"/><path d="M4 4v4h4" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 8v4.5l3 2" stroke-linecap="round"/></svg>'],
];
const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>';
const CLEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M6 18 18 6"/></svg>';
const REPORT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4M10 12h5M10 15.5h5" stroke-linecap="round"/></svg>';
const DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/></svg>';
const BUG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="7.5" y="7" width="9" height="12" rx="4.5"/><path d="M12 11v8M9 5l1.5 2M15 5l-1.5 2M4 11h3.5M16.5 11H20M4.5 17l3-1.5M19.5 17l-3-1.5"/></svg>';

const fmtTime = (t) => { const d = new Date(t); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
const fmtDay = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });

registerApp({
  id: 'console', name: 'Console', size: [1040, 660], minSize: [700, 420], overlayContent: true, hideTitle: true,
  keywords: ['logs', 'journal', 'journalctl', 'errors', 'crash', 'debug', 'bug report'],
  about: 'Messages from the system and apps, crash reports, and bug reports.',
  menus: (win) => [
    { title: 'File', items: [{ label: 'Create Bug Report…', action: () => win?.state?.report() }, { label: 'Save Shown Messages…', action: () => win?.state?.saveShown() }, '-', { label: 'Close Window', shortcut: '⌘W', action: () => win?.close() }] },
    { title: 'Action', items: [{ label: win?.state?.streaming ? 'Pause' : 'Start Streaming', action: () => win?.state?.toggleStream() }, { label: 'Clear', shortcut: '⌘K', action: () => win?.state?.clear() }, { label: 'Jump to Now', action: () => win?.state?.toEnd() }] }],
  open(win) {
    let source = 'boot', entries = [], sel = -1, streaming = true, filter = '', errorsOnly = false, followId = null, mode = 'journal', fileSel = null, crashSel = null;
    const side = h('div.sidebar.cs-side');
    const list = h('div.cs-list', { tabindex: 0 });
    const spacer = h('div.cs-spacer'), rows = h('div.cs-rows');
    list.append(spacer, rows);
    const head = h('div.cs-head', h('span.cs-c-type'), h('span.cs-c-time', 'Time'), h('span.cs-c-proc', 'Process'), h('span.cs-c-msg', 'Message'));
    const detail = h('div.cs-detail');
    const note = h('div.cs-note', { hidden: true });
    const count = h('span.cs-count');
    const listPane = h('div.cs-pane', head, note, list);
    const textPane = h('pre.cs-text', { hidden: true });
    const main = h('div.main-pane.cs-main', listPane, textPane, detail, h('div.cs-foot', count));
    win.body.append(side, main);

    const playBtn = h('button.tb-btn', { title: 'Pause', html: PAUSE, onclick: () => toggleStream() });
    const search = h('input.field', { placeholder: 'Search', style: { width: '200px' } });
    const errSeg = h('div.segmented.cs-seg', h('button.on', { onclick: () => setErrors(false) }, 'All'), h('button', { onclick: () => setErrors(true) }, 'Errors'));
    win.toolbar.style.marginLeft = '170px';
    win.toolbar.append(
      h('div.tb-group', playBtn, h('button.tb-btn', { title: 'Clear', html: CLEAR, onclick: () => clear() }), h('button.tb-btn', { title: 'Jump to Now', html: sym.chevronDown || '↓', onclick: () => toEnd() })),
      h('div.spacer'), errSeg,
      h('div.tb-group', h('button.tb-btn', { title: 'Create Bug Report', html: REPORT, onclick: () => report() })),
      h('div.search-field', { html: sym.search }, search));
    let searchT = null;
    search.addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(() => { filter = search.value.trim().toLowerCase(); if (mode === 'journal') draw(true); else if (mode === 'file') showFile(fileSel); }, 150); });

    /* ---------------------------------------------- sidebar */
    async function drawSide() {
      const files = await api.console.logFiles().catch(() => []);
      const item = (key, label, icon, onclick, sub) => {
        const el = h('div.sb-item' + (isSel(key) ? '.sel' : ''), { html: icon, title: sub || label }, h('span.ellipsis', label));
        el.addEventListener('click', onclick);
        return el;
      };
      side.replaceChildren(...[
        h('div.sb-sec', 'Messages'),
        ...SOURCES.map(([k, l, ic]) => item('j:' + k, l, ic, () => openSource(k))),
        files.length ? h('div.sb-sec', 'LiquidDesktop Logs') : null,
        ...files.map((f) => item('f:' + f.path, f.name, DOC, () => openFile(f.path), `${f.path} · ${fmtSize(f.size)}`)),
        h('div.sb-sec', 'Reports'),
        item('c:', 'Crash Reports', BUG, () => openCrashes()),
        h('div.spacer'),
        h('button.btn.cs-reportbtn', { onclick: () => report() }, 'Create Bug Report…')].filter(Boolean));
    }
    const isSel = (key) => (mode === 'journal' && key === 'j:' + source) || (mode === 'file' && key === 'f:' + fileSel) || (mode === 'crash' && key === 'c:');

    /* ---------------------------------------------- journal */
    async function openSource(k) {
      mode = 'journal'; source = k; sel = -1; entries = [];
      listPane.hidden = false; textPane.hidden = true; head.hidden = false; errSeg.hidden = false;
      drawSide(); detail.replaceChildren(); detail.hidden = true;
      note.hidden = true;
      if (followId) { api.console.stop(followId); followId = null; }
      rows.replaceChildren(h('div.cs-loading', 'Loading…'));
      const r = await api.console.query({ source: k, limit: 2000 }).catch((e) => ({ entries: [], note: e.message }));
      if (source !== k || mode !== 'journal') return;
      entries = r.entries;
      if (r.note) { note.textContent = r.note; note.hidden = false; }
      draw(true); toEnd();
      startFollow();
    }
    function startFollow() {
      if (!streaming || mode !== 'journal' || source === 'lastboot') return;
      followId = 'f' + Math.random().toString(36).slice(2);
      api.console.follow(followId, { source });
    }
    const shown = () => entries.filter((e) => (!errorsOnly || e.pri <= 3) && (!filter || e.msg.toLowerCase().includes(filter) || e.ident.toLowerCase().includes(filter) || (e.unit || '').toLowerCase().includes(filter)));
    let view = [];
    function draw(rebuild) {
      if (rebuild) view = shown();
      spacer.style.height = view.length * ROW + 'px';
      const top = list.scrollTop, hgt = list.clientHeight || 400;
      const a = Math.max(0, Math.floor(top / ROW) - 10), b = Math.min(view.length, Math.ceil((top + hgt) / ROW) + 10);
      rows.style.transform = `translateY(${a * ROW}px)`;
      const frag = [];
      for (let i = a; i < b; i++) {
        const e = view[i];
        const r = h('div.cs-row.' + priClass(e.pri) + (i === sel ? '.sel' : ''), { 'data-i': i },
          h('span.cs-c-type', h('i')), h('span.cs-c-time', fmtTime(e.t)), h('span.cs-c-proc', e.ident + (e.pid ? `[${e.pid}]` : '')), h('span.cs-c-msg', e.msg.split('\n')[0]));
        frag.push(r);
      }
      rows.replaceChildren(...frag);
      count.textContent = `${view.length.toLocaleString()} message${view.length === 1 ? '' : 's'}${view.length !== entries.length ? ` (of ${entries.length.toLocaleString()})` : ''}${streaming && mode === 'journal' && source !== 'lastboot' ? ' · streaming' : ''}`;
    }
    list.addEventListener('scroll', () => draw(false));
    new ResizeObserver(() => draw(false)).observe(list);
    rows.addEventListener('mousedown', (e) => { const r = e.target.closest('.cs-row'); if (r) select(+r.dataset.i); });
    rows.addEventListener('contextmenu', (e) => {
      const r = e.target.closest('.cs-row'); if (!r) return;
      const en = view[+r.dataset.i];
      select(+r.dataset.i);
      contextMenu(e, [{ label: 'Copy Message', action: () => api.clip.write(en.msg) },
        { label: 'Copy Line', action: () => api.clip.write(`${new Date(en.t).toISOString()} ${en.ident}[${en.pid ?? ''}]: ${en.msg}`) }, '-',
        { label: `Show Only “${en.ident}”`, action: () => { search.value = en.ident; filter = en.ident.toLowerCase(); draw(true); } },
        en.unit ? { label: `Show Only ${en.unit}`, action: () => { search.value = en.unit; filter = en.unit.toLowerCase(); draw(true); } } : null].filter(Boolean));
    });
    function select(i) {
      sel = i; draw(false);
      const e = view[i];
      if (!e) { detail.hidden = true; return; }
      detail.hidden = false;
      detail.replaceChildren(
        h('div.cs-detail-head', h('span.cs-badge.' + priClass(e.pri), PRI[e.pri] || 'Info'), h('b', e.ident), e.pid ? h('span.muted', `pid ${e.pid}`) : null, e.unit ? h('span.muted', e.unit) : null, h('span.spacer'), h('span.muted', `${fmtDay(e.t)} ${fmtTime(e.t)}`),
          h('button.tb-btn', { title: 'Copy', html: sym.copy || DOC, onclick: () => api.clip.write(e.msg) })),
        h('pre.cs-detail-msg', e.msg), e.exe ? h('div.muted.cs-exe', e.exe) : null);
    }
    list.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); select(Math.max(0, Math.min(view.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)))); const y = sel * ROW; if (y < list.scrollTop) list.scrollTop = y; else if (y + ROW > list.scrollTop + list.clientHeight) list.scrollTop = y + ROW - list.clientHeight; }
      if (e.ctrlKey && e.key === 'c' && view[sel]) { e.preventDefault(); api.clip.write(view[sel].msg); }
    });
    // live messages: added at the end; the list follows them only when you're at the end already
    api.console.onEntries?.((id, batch) => {
      if (id !== followId) return;
      const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - ROW * 2;
      entries.push(...batch);
      if (entries.length > 20000) entries.splice(0, entries.length - 20000);
      draw(true);
      if (atEnd) toEnd();
    });
    function toEnd() { list.scrollTop = list.scrollHeight; draw(false); }
    function toggleStream() {
      streaming = !streaming;
      playBtn.innerHTML = streaming ? PAUSE : PLAY; playBtn.title = streaming ? 'Pause' : 'Start Streaming';
      if (!streaming && followId) { api.console.stop(followId); followId = null; } else if (streaming) startFollow();
      draw(false);
    }
    function clear() { entries = []; sel = -1; detail.hidden = true; draw(true); }
    function setErrors(on) { errorsOnly = on; [...errSeg.children].forEach((b, i) => b.classList.toggle('on', i === (on ? 1 : 0))); draw(true); }

    /* ---------------------------------------------- log files */
    async function openFile(p) {
      mode = 'file'; fileSel = p;
      if (followId) { api.console.stop(followId); followId = null; }
      drawSide();
      listPane.hidden = true; detail.hidden = true; textPane.hidden = false; errSeg.hidden = true;
      showFile(p);
    }
    async function showFile(p) {
      const r = await api.console.readLog(p).catch((e) => ({ text: e.message }));
      if (fileSel !== p || mode !== 'file') return;
      const lines = r.text.split('\n').filter((l) => !filter || l.toLowerCase().includes(filter));
      textPane.replaceChildren(...lines.map((l) => h('div' + (/\b(error|fail|fatal|crash|exception|segfault|denied)\b/i.test(l) ? '.err' : /\bwarn/i.test(l) ? '.warn' : ''), l || ' ')));
      count.textContent = `${lines.length.toLocaleString()} lines${r.truncated ? ` · the last ${fmtSize(512 * 1024)} of ${fmtSize(r.size)}` : ''}`;
      textPane.scrollTop = textPane.scrollHeight;
    }

    /* ---------------------------------------------- crash reports */
    async function openCrashes() {
      mode = 'crash';
      if (followId) { api.console.stop(followId); followId = null; }
      drawSide();
      listPane.hidden = true; textPane.hidden = false; detail.hidden = true; errSeg.hidden = true;
      textPane.replaceChildren(h('div.muted', 'Loading…'));
      const c = await api.console.crashes().catch(() => ({ available: false, list: [] }));
      if (mode !== 'crash') return;
      if (!c.available) { textPane.replaceChildren(h('div.muted', 'Crash reports need systemd-coredump (coredumpctl), which this system doesn’t have.')); return; }
      if (!c.list.length) { textPane.replaceChildren(h('div.cs-empty', h('b', 'No Crashes'), h('span.muted', 'Nothing has crashed in the last 30 days.'))); count.textContent = ''; return; }
      const box = h('div.cs-crashes');
      for (const x of c.list) {
        const el = h('div.cs-crash' + (crashSel === x.pid ? '.sel' : ''), h('b', x.exe ? x.exe.split('/').pop() : '?'), h('span.muted', `${fmtDay(x.t)} ${fmtTime(x.t).slice(0, 8)} · signal ${x.sig} · pid ${x.pid}`));
        el.addEventListener('click', async () => {
          crashSel = x.pid; box.querySelectorAll('.sel').forEach((s) => s.classList.remove('sel')); el.classList.add('sel');
          detail.hidden = false; detail.replaceChildren(h('div.muted', 'Loading…'));
          const t = await api.console.crashInfo(x.pid).catch((e) => e.message);
          detail.replaceChildren(h('div.cs-detail-head', h('b', x.exe || '?'), h('span.spacer'), h('button.tb-btn', { title: 'Copy', html: sym.copy || DOC, onclick: () => api.clip.write(t) })), h('pre.cs-detail-msg.tall', t));
        });
        box.append(el);
      }
      textPane.replaceChildren(box);
      count.textContent = `${c.list.length} crash${c.list.length === 1 ? '' : 'es'} in the last 30 days`;
    }

    /* ---------------------------------------------- bug report */
    async function report() {
      const r = await alertDialog({ title: 'Create a Bug Report?', message: 'This saves a text file on your Desktop with what this computer is (system, graphics, monitors), LiquidDesktop’s logs, the errors since it started and recent crashes. Nothing is sent anywhere — look it over, then attach it to your bug report.', buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Create Report', value: 'ok', primary: true }] }, win.el);
      if (r.button !== 'ok') return;
      try {
        const res = await api.console.report();
        const r2 = await alertDialog({ title: 'Report saved', message: res.path, buttons: [{ label: 'OK', value: 'ok' }, { label: 'Show in Files', value: 'show', primary: true }] }, win.el);
        if (r2.button === 'show') wm.open('files', { path: res.path.replace(/\/[^/]+$/, ''), select: res.path });
      } catch (e) { alertDialog({ title: 'The report couldn’t be made', message: e.message }, win.el); }
    }
    async function saveShown() {
      const text = mode === 'journal' ? view.map((e) => `${new Date(e.t).toISOString()} ${e.ident}[${e.pid ?? ''}]: ${e.msg}`).join('\n') : textPane.innerText;
      const p = await api.dialog.save?.({ title: 'Save Messages', name: 'messages.txt' }).catch(() => null);
      const file = Array.isArray(p) ? p[0] : p;
      if (file) await api.fs.write(file, text + '\n').catch((e) => alertDialog({ title: 'Couldn’t save', message: e.message }, win.el));
    }

    win.el.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'k') { e.preventDefault(); clear(); } if (e.ctrlKey && e.key === 'f') { e.preventDefault(); search.focus(); } });
    win.on('close', () => { if (followId) api.console.stop(followId); });
    win.state = { report, saveShown, toggleStream, clear, toEnd, get streaming() { return streaming; } };
    drawSide();
    openSource('boot');
  },
});
