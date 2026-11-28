// Videos and songs in formats Chromium can't play (AVI, WMV, MPEG, MKVs with HEVC video, WMA…): Photos, Preview and
// Files play a copy FFmpeg makes (main/medialib.js media:playable), with "Preparing video… 40%" while it's made.
// A file that looks playable is tried as it is first; if it fails (or plays sound with no picture) the copy is used.
import { h, fileUrl } from './util.js';
import { api } from './sys.js';
import { CONVERT_EXT } from './icons.js';

const extOf = (p) => (/\.([^./]+)$/.exec(p)?.[1] || '').toLowerCase();

/**
 * A <video> (or <audio>) for this file, in a box that shows progress while a copy is made.
 * o: { video (default true), className, autoplay, onFail(message) — when it can't be played at all }
 * Returns { el (the box to add), media (the <video>/<audio>) }.
 */
export function playableMedia(path, o = {}) {
  const video = o.video !== false;
  const media = h(video ? 'video' : 'audio', { controls: true, autoplay: o.autoplay !== false, preload: 'metadata', class: o.className || null });
  const note = h('div.pl-note', { hidden: true });
  const box = h('div.pl-box' + (video ? '' : '.audio'), media, note);
  let converting = false;
  const fail = (msg) => { note.hidden = true; o.onFail ? o.onFail(msg) : (note.hidden = false, note.replaceChildren(h('b', 'This can’t be played'), h('small', msg))); };

  const convert = async () => {
    if (converting) return;
    converting = true;
    media.removeAttribute('src'); media.load();
    media.hidden = true;
    const bar = h('i');
    const pct = h('small', 'Getting it ready to play…');
    note.hidden = false;
    note.replaceChildren(h('div.pl-spin'), h('b', video ? 'Preparing video' : 'Preparing audio'), h('div.pl-bar', bar), pct);
    const off = api.media?.onProgress?.((p, f) => { if (p !== path || !box.isConnected) return; bar.style.width = Math.round(f * 100) + '%'; pct.textContent = `${Math.round(f * 100)}% — converting it so it can play here`; });
    try {
      const r = await api.media.playable(path);
      if (!box.isConnected) return;
      note.hidden = true; media.hidden = false;
      media.src = fileUrl(r.path);
      if (o.autoplay !== false) media.play().catch(() => {});
    } catch (e) {
      if (!box.isConnected) return;
      fail(/NEEDS_FFMPEG/.test(e.message) ? 'Playing this format needs FFmpeg. Install it from the App Store (or your package manager), then try again.' : e.message);
    } finally { typeof off === 'function' && off(); }
  };
  media.addEventListener('error', () => { if (!converting && media.getAttribute('src')) convert(); });
  // sound with no picture: the video inside is one Chromium can't decode (HEVC, MPEG-2…)
  if (video) media.addEventListener('loadedmetadata', () => { if (!converting && media.videoWidth === 0) convert(); });
  if (CONVERT_EXT.has(extOf(path))) setTimeout(convert, 0);
  else media.src = fileUrl(path);
  return { el: box, media };
}
