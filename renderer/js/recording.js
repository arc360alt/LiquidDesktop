// The menu bar's recording indicator: a red dot and how long the screen has been recording. Click it to stop;
// the recording is saved (main/recorder.js) and a notification opens it.
import { h } from './util.js';
import { api } from './sys.js';

const fmt = (s) => { const m = Math.floor(s / 60), x = s % 60; return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };

/** The indicator element, to put in the menu bar's status area. */
export function recordingIndicator() {
  const time = h('span.mb-rec-time');
  const el = h('div.mb-item.mb-rec', { title: 'Stop recording', hidden: true, onclick: (e) => { e.stopPropagation(); stop(); } }, h('i.mb-rec-dot'), time);
  if (!api.rec) return el;
  let started = 0, timer = null, stopping = false;
  const tick = () => { const t = fmt(Math.max(0, Math.floor((Date.now() - started) / 1000))); if (time.textContent !== t) time.textContent = t; };
  const show = (s) => {
    clearInterval(timer);
    el.hidden = !s?.recording;
    el.classList.remove('stopping');
    if (s?.recording) { started = s.started || Date.now(); stopping = false; tick(); timer = setInterval(tick, 500); }
  };
  const stop = async () => {
    if (stopping) return;
    stopping = true; el.classList.add('stopping'); time.textContent = 'Saving…';
    try { await api.rec.stop(); } catch { /* the rec:changed event reports it */ }
  };
  api.rec.onChanged(async (s) => {
    show(s);
    if (s.recording) return;
    const { shell } = await import('./shell.js');
    if (s.file) {
      const name = s.file.split('/').pop();
      shell.notify({ app: 'preview', title: s.error ? 'Screen recording stopped' : 'Screen recording saved', body: `${s.file.replace(shell.home || '\0', '~').replace(name, '')}${name}`, action: () => shell.openPath(s.file) });
    } else if (s.error) shell.notify({ app: 'preview', title: 'Screen Recording', body: s.error });
  });
  api.rec.status().then(show).catch(() => {});   // still recording from before the shell reloaded
  return el;
}
