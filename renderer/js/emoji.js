// Emoji & Symbols (Ctrl+Cmd+Space, or Edit › Emoji & Symbols): the Mac's emoji picker. Search by name or keyword,
// browse by category, pick a skin tone (right-click an emoji, or the hand at the bottom), recently used first.
// The character goes into whatever had the keyboard: in a session the window manager types it into the app
// (main/wm.js typeText), in the testing window it's inserted into the focused text field.
import { h, $, $$ } from './util.js';
import { store } from './store.js';
import { isSession, session as S } from './layer.js';

let data = null, layerEl = null, target = null, lastText = null, saved = null;
const textLike = (a) => !!a && (a.isContentEditable || a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|url|email|)$/.test(a.type)));
// the text field you were last in (opening the picker from the Edit menu moves the focus away from it)
addEventListener('focusin', (e) => { if (textLike(e.target) && !e.target.closest('#emoji-picker')) lastText = e.target; }, true);
const TONES = ['', '\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'];
const TONE_NAMES = ['Default', 'Light', 'Medium-Light', 'Medium', 'Medium-Dark', 'Dark'];
// one icon per category for the bar along the bottom (the first emoji of the category draws too small)
const CAT_ICON = { 'Frequently Used': '🕘', 'Smileys & Emotion': '😀', 'People & Body': '👋', 'Animals & Nature': '🐻', 'Food & Drink': '🍔', 'Travel & Places': '🚗',
  Activities: '⚽', Objects: '💡', Symbols: '🔣', Flags: '🏳️', 'Special Characters': '⌘' };

const toned = (ch, t) => {
  if (!t) return ch;
  const cps = [...ch];
  const rest = cps.slice(1).join('').replace(/^️/, '');
  return cps[0] + t + rest;
};
const recent = () => store.get('emojiRecent') || [];
function remember(ch) { store.set('emojiRecent', [ch, ...recent().filter((x) => x !== ch)].slice(0, 24)); }

/** Put the character where the user was typing. */
async function insert(ch) {
  remember(ch);
  close();
  if (isSession) { try { await S.invoke('wm:typeText', ch); } catch { /* no window manager */ } return; }
  const el = target;
  if (!el || !el.isConnected) return;
  el.focus();
  // back where the caret was (focusing the picker's search field moved it)
  if (saved?.range) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(saved.range); }
  else if (saved && 'selectionStart' in el) { try { el.setSelectionRange(saved.start, saved.end); } catch { /* not a text input */ } }
  if (!document.execCommand('insertText', false, ch) && 'value' in el) {
    const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
    el.value = el.value.slice(0, s) + ch + el.value.slice(e);
    el.selectionStart = el.selectionEnd = s + ch.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

export function closeEmoji() { close(); }
function close() {
  if (!layerEl) return;
  const l = layerEl; layerEl = null;
  l.classList.add('closing');
  setTimeout(() => l.remove(), 160);
}
export const emojiOpen = () => !!layerEl;

/**
 * Open the picker. at: { x, y } (CSS pixels) to open near, else near the pointer / the middle of the screen.
 */
export async function openEmoji(at) {
  if (layerEl) { close(); return; }
  // what had the keyboard (testing window): the character goes back there
  const a = document.activeElement;
  target = textLike(a) ? a : lastText;
  saved = null;
  if (target?.isContentEditable) { const sel = getSelection(); if (sel.rangeCount && target.contains(sel.anchorNode)) saved = { range: sel.getRangeAt(0).cloneRange() }; }
  else if (target && 'selectionStart' in target) saved = { start: target.selectionStart, end: target.selectionEnd };
  if (!data) data = (await import('./emojidata.js')).EMOJI;
  if (isSession && !at) {
    // near the pointer (the window manager knows where it is, in screen pixels)
    const p = await S.invoke('wm:pointer').catch(() => null);
    if (p) at = { x: p.x / (devicePixelRatio || 1) - screenLeft, y: p.y / (devicePixelRatio || 1) - screenTop };
  }
  build(at);
}

function build(at) {
  const W = 352, H = 400;
  let tone = store.get('emojiTone') || 0, query = '';
  const search = h('input.ej-search', { placeholder: 'Search', spellcheck: false, autocomplete: 'off' });
  const grid = h('div.ej-grid');
  const footer = h('div.ej-name', '');
  const cats = h('div.ej-cats');
  const toneBtn = h('button.ej-tone', { title: 'Skin Tone' });
  const panel = h('div#emoji-picker.glass.panel', h('div.ej-top', h('span.ej-sicon', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.6-4.6"/></svg>' }), search), grid, h('div.ej-bottom', cats, toneBtn), footer);
  layerEl = h('div#emoji-layer', panel);
  layerEl.addEventListener('mousedown', (e) => { if (!panel.contains(e.target)) close(); });
  document.body.append(layerEl);
  // place it: near `at`, kept on the screen
  const x = Math.round(Math.max(8, Math.min(innerWidth - W - 8, (at?.x ?? innerWidth / 2 - W / 2) - 20)));
  let y = Math.round((at?.y ?? innerHeight / 3) + 18);
  if (y + H > innerHeight - 8) y = Math.max(36, (at?.y ?? innerHeight) - H - 18);
  Object.assign(panel.style, { left: x + 'px', top: y + 'px', width: W + 'px', height: H + 'px' });

  const groups = () => {
    const out = [];
    const rec = recent();
    if (rec.length) out.push(['Frequently Used', rec.map((c) => [c, findName(c) || ''])]);
    return out.concat(data);
  };
  const cell = (e) => {
    const [ch0, name, , canTone] = e;
    const ch = canTone ? toned(ch0, TONES[tone]) : ch0;
    const b = h('button.ej-cell', { title: name }, ch);
    b.addEventListener('mouseenter', () => { footer.textContent = name.charAt(0).toUpperCase() + name.slice(1); });
    b.addEventListener('click', () => insert(ch));
    if (canTone) b.addEventListener('contextmenu', (ev) => { ev.preventDefault(); tonePopup(b, ch0, name); });
    return b;
  };
  function draw() {
    grid.innerHTML = '';
    const q = query.trim().toLowerCase();
    if (q) {
      const words = q.split(/\s+/);
      const hits = [];
      for (const [, list] of data) for (const e of list) {
        const hay = (e[1] + ' ' + (e[2] || '')).toLowerCase();
        if (words.every((w) => hay.includes(w))) hits.push([e[1].toLowerCase().startsWith(q) ? 0 : (' ' + hay).includes(' ' + words[0]) ? 1 : 2, e]);
      }
      hits.sort((a, b) => a[0] - b[0]);
      grid.append(h('div.ej-head', hits.length ? 'Search Results' : 'No Results'), h('div.ej-cells', ...hits.slice(0, 400).map(([, e]) => cell(e))));
      return;
    }
    for (const [name, list] of groups()) {
      grid.append(h('div.ej-head', { 'data-cat': name }, name), h('div.ej-cells', ...list.map(cell)));
    }
  }
  const findName = (c) => { for (const [, list] of data) for (const e of list) if (e[0] === c || (e[3] && TONES.some((t) => toned(e[0], t) === c))) return e[1]; return null; };
  function drawCats() {
    cats.innerHTML = '';
    for (const [name] of groups()) {
      cats.append(h('button.ej-cat', { title: name, 'data-cat': name, onclick: () => {
        if (query) { query = ''; search.value = ''; draw(); }
        const head = $$('.ej-head', grid).find((x) => x.dataset.cat === name);
        if (head) grid.scrollTop = head.offsetTop - grid.offsetTop;
      } }, CAT_ICON[name] || name[0]));
    }
  }
  // the category you're looking at is lit in the bar
  grid.addEventListener('scroll', () => {
    const heads = $$('.ej-head', grid);
    let cur = heads[0]?.dataset.cat;
    for (const hd of heads) if (hd.offsetTop - grid.offsetTop <= grid.scrollTop + 4) cur = hd.dataset.cat;
    $$('.ej-cat', cats).forEach((b) => b.classList.toggle('on', b.dataset.cat === cur));
  });
  const drawTone = () => { toneBtn.textContent = toned('✋', TONES[tone]); toneBtn.title = `Skin Tone: ${TONE_NAMES[tone]}`; };
  toneBtn.addEventListener('click', () => tonePopup(toneBtn, '✋', null));
  function tonePopup(anchor, base, name) {
    $('.ej-tones', panel)?.remove();
    const r = anchor.getBoundingClientRect(), pr = panel.getBoundingClientRect();
    const pop = h('div.ej-tones', ...TONES.map((t, i) => h('button.ej-cell' + (i === tone && !name ? '.on' : ''), { title: TONE_NAMES[i], onclick: (e) => {
      e.stopPropagation();
      pop.remove();
      if (name) { insert(toned(base, t)); return; }   // one emoji in this tone
      tone = i; store.set('emojiTone', i); drawTone(); draw();   // every emoji from now on
    } }, toned(base, t))));
    panel.append(pop);
    pop.style.left = Math.max(6, Math.min(pr.width - 6 * 38 - 16, r.left - pr.left - 90)) + 'px';
    pop.style.top = Math.max(6, r.top - pr.top - 48) + 'px';
    setTimeout(() => panel.addEventListener('mousedown', function off(e) { if (!pop.contains(e.target)) { pop.remove(); panel.removeEventListener('mousedown', off); } }), 0);
  }
  search.addEventListener('input', () => { query = search.value; grid.scrollTop = 0; draw(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter') { const first = $('.ej-cell', grid); if (first) first.click(); }
  });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  drawTone(); drawCats(); draw();
  grid.dispatchEvent(new Event('scroll'));
  footer.textContent = 'Right-click an emoji for other skin tones';
  setTimeout(() => search.focus(), 30);
}
