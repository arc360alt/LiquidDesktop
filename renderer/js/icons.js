// Icon system: line symbols (SF-Symbols-like), app icons with Liquid Glass styles, and file icons.
import { store } from './store.js';

/* ------------------------------------------------------------------ symbols */
const S = (body, extra = '') => `<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;
const F = (body) => `<svg class="sym" viewBox="0 0 24 24" fill="currentColor">${body}</svg>`;

export const sym = {
  search: S('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>'),
  wifi: F('<path d="M12 18.6a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4z"/><path d="M12 13.2c2 0 3.8.8 5.1 2.1l-1.6 1.6A5 5 0 0 0 12 15.4a5 5 0 0 0-3.5 1.5l-1.6-1.6A7.2 7.2 0 0 1 12 13.2z"/><path d="M12 8.1c3.4 0 6.5 1.4 8.7 3.6l-1.6 1.6A10 10 0 0 0 12 10.3a10 10 0 0 0-7.1 3l-1.6-1.6A12.3 12.3 0 0 1 12 8.1z"/><path d="M12 3c4.8 0 9.1 1.9 12.3 5l-1.6 1.6A15 15 0 0 0 12 5.2 15 15 0 0 0 1.3 9.6L-.3 8C2.9 4.9 7.2 3 12 3z" transform="translate(0 .4) scale(1 .98)"/>'),
  wifiOff: S('<path d="M2 8.5a14 14 0 0 1 4-2.6M9.5 4.3A14 14 0 0 1 22 8.5M5 12a9.5 9.5 0 0 1 3-1.8M15 10.4a9.6 9.6 0 0 1 4 1.6M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor"/><path d="M3 3l18 18"/>'),
  ethernet: S('<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M8 9V5h8v4M8 14v2M12 14v2M16 14v2"/>'),
  bluetooth: S('<path d="M7 7l10 10-5 4.5V2.5L17 7 7 17"/>'),
  airplane: F('<path d="M21.5 15.5v-2l-8-5V3.6a1.5 1.5 0 0 0-3 0v4.9l-8 5v2l8-2.5v5.5l-2 1.5v1.5l3.5-1 3.5 1V20l-2-1.5V13z"/>'),
  moon: F('<path d="M20.5 14.6A8.7 8.7 0 0 1 9.4 3.5a8.7 8.7 0 1 0 11.1 11.1z"/>'),
  sun: S('<circle cx="12" cy="12" r="4.2" fill="currentColor"/><path d="M12 2v2.2M12 19.8V22M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2 12h2.2M19.8 12H22M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/>'),
  sunDim: S('<circle cx="12" cy="12" r="3.6" fill="currentColor"/><path d="M12 4.5v1M12 18.5v1M6.7 6.7l.7.7M16.6 16.6l.7.7M4.5 12h1M18.5 12h1M6.7 17.3l.7-.7M16.6 7.4l.7-.7"/>'),
  speaker: F('<path d="M3 9h4l5-4.5v15L7 15H3z"/><path d="M15.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M18.3 5.7a9 9 0 0 1 0 12.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  speakerLow: F('<path d="M3 9h4l5-4.5v15L7 15H3z"/><path d="M15.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  speakerMute: F('<path d="M3 9h4l5-4.5v15L7 15H3z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  controls: S('<rect x="2.5" y="4.5" width="19" height="6" rx="3"/><circle cx="18.5" cy="7.5" r="1.6" fill="currentColor"/><rect x="2.5" y="13.5" width="19" height="6" rx="3"/><circle cx="5.5" cy="16.5" r="1.6" fill="currentColor"/>'),
  chevronLeft: S('<path d="M15 5l-7 7 7 7"/>', 'stroke-width="2.2"'),
  chevronRight: S('<path d="M9 5l7 7-7 7"/>', 'stroke-width="2.2"'),
  chevronDown: S('<path d="M5 9l7 7 7-7"/>', 'stroke-width="2.2"'),
  chevronUp: S('<path d="M5 15l7-7 7 7"/>', 'stroke-width="2.2"'),
  plus: S('<path d="M12 4v16M4 12h16"/>', 'stroke-width="2"'),
  minus: S('<path d="M4 12h16"/>', 'stroke-width="2"'),
  close: S('<path d="M5 5l14 14M19 5L5 19"/>', 'stroke-width="2.6"'),
  check: S('<path d="M4 12.5l5 5L20 6.5"/>', 'stroke-width="2.4"'),
  gear: S('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  folder: S('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>'),
  folderPlus: S('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M12 10.5v6M9 13.5h6"/>'),
  home: S('<path d="M3.5 11L12 4l8.5 7"/><path d="M6 9.5V20h4.5v-5h3v5H18V9.5"/>'),
  desktop: S('<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M9 20.5h6M12 16.5v4"/>'),
  doc: S('<path d="M6.5 2.8h7.3L19 8v12.2a1 1 0 0 1-1 1H6.5a1 1 0 0 1-1-1V3.8a1 1 0 0 1 1-1z"/><path d="M13.5 3v5.3H19M8.5 13h7M8.5 16.5h7"/>'),
  download: S('<circle cx="12" cy="12" r="9.2"/><path d="M12 7v9M8 12.5l4 4 4-4"/>'),
  photo: S('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M3.5 17.5l5-4.5 4 3.5 3-2.5 5 4"/>'),
  music: S('<path d="M9 18V5.5l11-2.5v12.5"/><circle cx="6.5" cy="18" r="2.6"/><circle cx="17.5" cy="15.5" r="2.6"/>'),
  video: S('<rect x="2.5" y="5.5" width="14" height="13" rx="2.5"/><path d="M16.5 10l5-3v10l-5-3"/>'),
  trash: S('<path d="M4 6.5h16M9.5 6.5V4.2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2.3M6 6.5l1 13.2a1.5 1.5 0 0 0 1.5 1.3h7a1.5 1.5 0 0 0 1.5-1.3l1-13.2M10 10.5v6.5M14 10.5v6.5"/>'),
  clock: S('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'),
  star: S('<path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/>'),
  grid: F('<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>'),
  play: F('<path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z"/>'),
  pause: F('<rect x="5.5" y="4" width="4.5" height="16" rx="1.2"/><rect x="14" y="4" width="4.5" height="16" rx="1.2"/>'),
  next: F('<path d="M3 6.2v11.6a.8.8 0 0 0 1.2.7L12 13v4.8a.8.8 0 0 0 1.2.7l8.6-5.8a.8.8 0 0 0 0-1.4l-8.6-5.8a.8.8 0 0 0-1.2.7V11L4.2 5.5a.8.8 0 0 0-1.2.7z"/>'),
  prev: F('<path d="M21 6.2v11.6a.8.8 0 0 1-1.2.7L12 13v4.8a.8.8 0 0 1-1.2.7l-8.6-5.8a.8.8 0 0 1 0-1.4l8.6-5.8a.8.8 0 0 1 1.2.7V11l7.8-5.5a.8.8 0 0 1 1.2.7z"/>'),
  lock: S('<rect x="5" y="10.5" width="14" height="10.5" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>'),
  power: S('<path d="M12 3v8.5"/><path d="M6.3 6.6a8 8 0 1 0 11.4 0"/>'),
  restart: S('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/>'),
  user: S('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  globe: S('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>'),
  refresh: S('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/>'),
  share: S('<path d="M12 15V3M8 7l4-4 4 4"/><path d="M8.5 10.5H6a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 6 21.5h12a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5h-2.5"/>'),
  sidebar: S('<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M9.5 4.5v15M5.5 8.5h1.5M5.5 11.5h1.5"/>'),
  list: S('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".8" fill="currentColor"/><circle cx="4.5" cy="12" r=".8" fill="currentColor"/><circle cx="4.5" cy="18" r=".8" fill="currentColor"/>'),
  icons: S('<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>'),
  terminal: S('<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5"/>'),
  camera: S('<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.5-2.2h5.4L16.2 7h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.6" r="3.4"/>'),
  contrast: S('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>'),
  nightshift: S('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/><path d="M12 8a4 4 0 0 1 0 8z" fill="currentColor"/>'),
  keyboard: S('<rect x="2" y="6" width="20" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/>'),
  bell: S('<path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z"/><path d="M10 20a2.2 2.2 0 0 0 4 0"/>'),
  bellSlash: S('<path d="M8.6 4.1A6 6 0 0 1 18 9c0 2.6.5 4.3 1 5.4M17 16.5H3.5S6 15 6 9c0-.8.1-1.5.4-2.2"/><path d="M10 20a2.2 2.2 0 0 0 4 0M3 3l18 18"/>'),
  palette: S('<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-1.3-1.2-1.6-1.2-2.8 0-.9.7-1.6 1.6-1.6H17a4 4 0 0 0 4-4C21 6.4 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.2" fill="currentColor"/><circle cx="10" cy="7" r="1.2" fill="currentColor"/><circle cx="14.5" cy="7" r="1.2" fill="currentColor"/>'),
  dock: S('<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="M6.5 16h11"/>', 'stroke-width="1.8"'),
  display: S('<rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M8 20.5h8M12 16.5v4"/>'),
  info: S('<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r=".7" fill="currentColor"/>'),
  widgets: S('<rect x="3" y="3" width="8" height="8" rx="2.5"/><rect x="13" y="3" width="8" height="8" rx="2.5"/><rect x="3" y="13" width="18" height="8" rx="2.5"/>'),
  drive: S('<rect x="2.5" y="7" width="19" height="10" rx="2.5"/><circle cx="17.5" cy="12" r=".9" fill="currentColor"/><path d="M5.5 12h7"/>'),
  layers: S('<rect x="3" y="7" width="8" height="11" rx="2"/><rect x="13" y="7" width="8" height="11" rx="2"/><path d="M5 3.5h14"/>'),
  back: S('<path d="M15 5l-7 7 7 7"/>', 'stroke-width="2.2"'),
  forward: S('<path d="M9 5l7 7-7 7"/>', 'stroke-width="2.2"'),
  external: S('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  pencil: S('<path d="M15.5 4.5l4 4L8 20H4v-4z"/><path d="M13 7l4 4"/>'),
  compose: S('<path d="M11 4.5H6a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h11.5a2 2 0 0 0 2-2v-5"/><path d="M17.8 3.2a2 2 0 0 1 2.9 2.9L12 14.8l-3.8 1 1-3.8z"/>'),
  ellipsis: F('<circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/>'),
  battery: S('<rect x="2" y="7" width="17" height="10" rx="3"/><path d="M22 10.5v3"/>'),
  bolt: F('<path d="M13.5 2L4.5 13.5H11L10 22l9-11.5h-6.5z"/>'),
  mirror: S('<rect x="2.5" y="4" width="13" height="10" rx="2"/><rect x="8.5" y="10" width="13" height="10" rx="2" fill="currentColor" fill-opacity=".25"/>'),
  stop: S('<circle cx="12" cy="12" r="9"/><path d="M8 8l8 8"/>'),
  copy: S('<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  sparkles: F('<path d="M10 3l1.6 4.6L16 9.2l-4.4 1.6L10 15.4l-1.6-4.6L4 9.2l4.4-1.6zM18 13l.9 2.3 2.3.9-2.3.9L18 19.4l-.9-2.3-2.3-.9 2.3-.9z"/>'),
  calc: S('<rect x="5" y="2.5" width="14" height="19" rx="3"/><rect x="8" y="5.5" width="8" height="3.5" rx="1"/><path d="M8.5 13h.01M12 13h.01M15.5 13h.01M8.5 17h.01M12 17h.01M15.5 17h.01"/>'),
  hand: S('<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 7-6.5 7-3 0-4.5-1.5-6-4l-1.8-3a1.5 1.5 0 0 1 2.5-1.6L8 15"/>'),
  eye: S('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  tag: S('<path d="M3 12.6V4a1 1 0 0 1 1-1h8.6l8.4 8.4a1.5 1.5 0 0 1 0 2.1l-7.5 7.5a1.5 1.5 0 0 1-2.1 0z"/><circle cx="7.5" cy="7.5" r="1.3" fill="currentColor"/>'),
  location: F('<path d="M21 3L3 10.5l7.6 2.9L13.5 21z"/>'),
  cpu: S('<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>'),
};

/* ------------------------------------------------------------------ weather glyphs (colored) */
export const wx = {
  sun: '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="7" fill="#ffd60a"/><g stroke="#ffd60a" stroke-width="2.2" stroke-linecap="round"><path d="M16 2.5v3M16 26.5v3M2.5 16h3M26.5 16h3M6.5 6.5l2 2M23.5 23.5l2 2M6.5 25.5l2-2M23.5 8.5l2-2"/></g></svg>',
  moon: '<svg viewBox="0 0 32 32"><path d="M25 19.5A10 10 0 0 1 12.5 7a10 10 0 1 0 12.5 12.5z" fill="#f2f2f7"/></svg>',
  partly: '<svg viewBox="0 0 32 32"><circle cx="12" cy="12" r="6" fill="#ffd60a"/><g stroke="#ffd60a" stroke-width="2" stroke-linecap="round"><path d="M12 2v2.5M2 12h2.5M4.9 4.9l1.8 1.8M19.1 4.9l-1.8 1.8"/></g><path d="M10 27h14a5 5 0 0 0 .6-10 7 7 0 0 0-13.2 1.4A4.4 4.4 0 0 0 10 27z" fill="#fff"/></svg>',
  cloud: '<svg viewBox="0 0 32 32"><path d="M8.5 25h16a6 6 0 0 0 .8-12 8 8 0 0 0-15.2 2A5 5 0 0 0 8.5 25z" fill="#f2f2f7"/></svg>',
  rain: '<svg viewBox="0 0 32 32"><path d="M8.5 20h16a6 6 0 0 0 .8-12 8 8 0 0 0-15.2 2A5 5 0 0 0 8.5 20z" fill="#f2f2f7"/><g stroke="#64d2ff" stroke-width="2.2" stroke-linecap="round"><path d="M11 23l-1.5 4M17 23l-1.5 4M23 23l-1.5 4"/></g></svg>',
  snow: '<svg viewBox="0 0 32 32"><path d="M8.5 20h16a6 6 0 0 0 .8-12 8 8 0 0 0-15.2 2A5 5 0 0 0 8.5 20z" fill="#f2f2f7"/><g fill="#fff"><circle cx="11" cy="25" r="1.6"/><circle cx="17" cy="27" r="1.6"/><circle cx="23" cy="25" r="1.6"/></g></svg>',
  storm: '<svg viewBox="0 0 32 32"><path d="M8.5 19h16a6 6 0 0 0 .8-12 8 8 0 0 0-15.2 2A5 5 0 0 0 8.5 19z" fill="#d1d1d6"/><path d="M17 18l-4 6h4l-2 6 6-8h-4l2-4z" fill="#ffd60a"/></svg>',
  fog: '<svg viewBox="0 0 32 32"><g stroke="#f2f2f7" stroke-width="2.4" stroke-linecap="round"><path d="M5 11h22M3 16h24M7 21h20M10 26h14"/></g></svg>',
};

/* ------------------------------------------------------------------ system logo: a liquid drop */
export const logo = (fill = 'currentColor') => `<svg viewBox="0 0 24 24"><path fill="${fill}" d="M12 1.8c.4 0 .7.2.9.5 1.6 2.4 7.1 9 7.1 13.2a8 8 0 0 1-16 0c0-4.2 5.5-10.8 7.1-13.2.2-.3.5-.5.9-.5z"/><path fill="rgba(0,0,0,.35)" d="M8 15.3c.2 2.2 1.8 3.8 4 4.1.5.1.9-.3.9-.8s-.3-.8-.8-.9a3 3 0 0 1-2.5-2.6c-.1-.5-.5-.8-1-.8s-.7.5-.6 1z" style="mix-blend-mode:overlay"/></svg>`;

export function logoBadge() {
  return `<svg viewBox="0 0 100 100"><defs><linearGradient id="lgb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7cc7ff"/><stop offset=".5" stop-color="#3a7bff"/><stop offset="1" stop-color="#8a4dff"/></linearGradient>
  <radialGradient id="lgh" cx=".35" cy=".25" r=".6"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
  <path d="M50 6c1.6 0 3 .8 3.8 2.1C60.6 18.3 84 46.2 84 64a34 34 0 0 1-68 0c0-17.8 23.4-45.7 30.2-55.9A4.5 4.5 0 0 1 50 6z" fill="url(#lgb)"/>
  <path d="M50 6c1.6 0 3 .8 3.8 2.1C60.6 18.3 84 46.2 84 64a34 34 0 0 1-68 0c0-17.8 23.4-45.7 30.2-55.9A4.5 4.5 0 0 1 50 6z" fill="url(#lgh)"/>
  <path d="M30 64c.6 9.5 7.7 16.5 17 17.7" stroke="#fff" stroke-opacity=".75" stroke-width="5" fill="none" stroke-linecap="round"/></svg>`;
}

/* ------------------------------------------------------------------ app icons */
let uid = 0;
const gearPath = (cx, cy, ro, ri, n) => {
  let d = '';
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, step = (Math.PI * 2) / n;
    const pts = [[ri, a0], [ro, a0 + step * 0.18], [ro, a0 + step * 0.5], [ri, a0 + step * 0.68]];
    for (const [r, a] of pts) d += `${d ? 'L' : 'M'}${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  }
  return d + 'Z';
};

// Each app icon: bg gradient, a "tone" (its signature color for dark/tinted styles) and a draw(c) that uses roles:
// c.fg (glyph on the plate), c.paper (light surfaces), c.ink (marks on paper), c.ac / c.ac2 (accent colors).
const APP_ICONS = {
  files: { bg: ['#6fd0ff', '#1677ff'], tone: '#3aa0ff', c: { fg: '#fff', ac: '#c9ecff', ac2: '#0b5bd3', paper: '#fff', ink: '#1677ff' },
    draw: (c) => `<path d="M24 36a6 6 0 0 1 6-6h13l5 5h22a6 6 0 0 1 6 6v25a6 6 0 0 1-6 6H30a6 6 0 0 1-6-6z" fill="${c.ac}" opacity=".85"/>
      <path d="M22 44a6 6 0 0 1 6-6h44a6 6 0 0 1 6 6v22a6 6 0 0 1-6 6H28a6 6 0 0 1-6-6z" fill="${c.fg}"/>
      <path d="M40 55c2.5 3 7 4.5 10 4.5s7.5-1.5 10-4.5" stroke="${c.ac2}" stroke-width="3" fill="none" stroke-linecap="round" opacity=".8"/>` },
  browser: { bg: ['#ffffff', '#dfe7f2'], tone: '#2f8cff', paper: true, c: { fg: '#fff', ac: '#0a7cff', ac2: '#5ad1ff', paper: '#fff', ink: '#0a7cff' },
    draw: (c) => `<defs><linearGradient id="gb${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.ac2}"/><stop offset="1" stop-color="${c.ac}"/></linearGradient></defs>
      <circle cx="50" cy="50" r="29" fill="url(#gb${uid})"/>
      <g stroke="${c.paper}" stroke-width="2.4" fill="none" opacity=".9"><ellipse cx="50" cy="50" rx="12" ry="29"/><path d="M21 50h58M25 36h50M25 64h50"/></g>
      <ellipse cx="50" cy="50" rx="36" ry="11" fill="none" stroke="${c.ink}" stroke-width="3" transform="rotate(-25 50 50)" opacity=".55"/>` },
  terminal: { bg: ['#3a3a40', '#0e0e11'], tone: '#30d158', c: { fg: '#fff', ac: '#30d158', paper: '#2c2c30', ink: '#fff' },
    draw: (c) => `<rect x="18" y="20" width="64" height="60" rx="9" fill="none" stroke="${c.fg}" stroke-opacity=".18" stroke-width="1.5"/>
      <path d="M28 36l11 9-11 9" stroke="${c.ac}" stroke-width="5.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M44 57h17" stroke="${c.fg}" stroke-width="5.5" stroke-linecap="round"/>` },
  notes: { bg: ['#ffffff', '#f1f1f4'], tone: '#ffd60a', paper: true, c: { fg: '#fff', ac: '#ffd60a', ac2: '#ffb800', paper: '#fff', ink: '#c7c7cc' },
    draw: (c) => `<path d="M8 27a19 19 0 0 1 19-19h46a19 19 0 0 1 19 19v6H8z" fill="${c.ac}"/>
      <path d="M8 33h84" stroke="${c.ac2}" stroke-width="1.2"/>
      <g stroke="${c.ink}" stroke-width="2.2" stroke-linecap="round"><path d="M20 47h60M20 59h60M20 71h44"/></g>
      <g fill="${c.ac2}" opacity=".9"><circle cx="22" cy="20" r="1.6"/><circle cx="30" cy="20" r="1.6"/><circle cx="38" cy="20" r="1.6"/><circle cx="46" cy="20" r="1.6"/><circle cx="54" cy="20" r="1.6"/><circle cx="62" cy="20" r="1.6"/><circle cx="70" cy="20" r="1.6"/><circle cx="78" cy="20" r="1.6"/></g>` },
  calendar: { bg: ['#ffffff', '#f2f2f5'], tone: '#ff3b30', paper: true, c: { fg: '#fff', ac: '#ff3b30', paper: '#fff', ink: '#1c1c1e' },
    draw: (c) => { const d = new Date(); const dow = d.toLocaleDateString('en', { weekday: 'short' }).toUpperCase();
      return `<text x="50" y="33" text-anchor="middle" font-family="Inter Variable, sans-serif" font-weight="600" font-size="13" fill="${c.ac}" letter-spacing=".5">${dow}</text>
      <text x="50" y="76" text-anchor="middle" font-family="Inter Variable, sans-serif" font-weight="400" font-size="44" fill="${c.ink}" letter-spacing="-1.5">${d.getDate()}</text>`; } },
  weather: { bg: ['#5ab8ff', '#1f63e0'], tone: '#4aa8ff', c: { fg: '#fff', ac: '#ffd60a', ac2: '#ffb000', paper: '#fff', ink: '#fff' },
    draw: (c) => `<circle cx="40" cy="40" r="15" fill="${c.ac}"/>
      <path d="M36 74h32a12 12 0 0 0 1.5-23.9A15 15 0 0 0 41 53.6 10.3 10.3 0 0 0 36 74z" fill="${c.fg}" opacity=".97"/>` },
  monitor: { bg: ['#2c2c30', '#0c0c0e'], tone: '#30d158', c: { fg: '#fff', ac: '#30d158', ac2: '#30d158', paper: '#1c1c1e', ink: '#fff' },
    draw: (c) => `<g stroke="${c.fg}" stroke-opacity=".12" stroke-width="1"><path d="M18 35h64M18 50h64M18 65h64M34 22v56M50 22v56M66 22v56"/></g>
      <path d="M16 56h14l6-16 9 30 8-38 7 30 5-12h19" stroke="${c.ac}" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` },
  calculator: { bg: ['#4a4a4f', '#1c1c1f'], tone: '#ff9f0a', c: { fg: '#d4d4d8', ac: '#ff9f0a', paper: '#2c2c30', ink: '#fff' },
    draw: (c) => `<g fill="${c.fg}"><circle cx="31" cy="31" r="8"/><circle cx="50" cy="31" r="8"/><circle cx="31" cy="50" r="8" opacity=".6"/><circle cx="50" cy="50" r="8" opacity=".6"/><circle cx="31" cy="69" r="8" opacity=".6"/><circle cx="50" cy="69" r="8" opacity=".6"/></g>
      <g fill="${c.ac}"><circle cx="69" cy="31" r="8"/><circle cx="69" cy="50" r="8"/><circle cx="69" cy="69" r="8"/></g>
      <g stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M66 50h6M66 69h6M66 66.5h6M69 28v6M66 31h6"/></g>` },
  settings: { bg: ['#e4e4ea', '#9a9aa2'], tone: '#8e8e93', c: { fg: '#5b5b62', ac: '#3a3a3f', ac2: '#d8d8de', paper: '#f2f2f7', ink: '#3a3a3f' },
    draw: (c) => `<path d="${gearPath(50, 50, 33, 27, 16)}" fill="${c.fg}"/>
      <circle cx="50" cy="50" r="22" fill="${c.ac2}"/><circle cx="50" cy="50" r="18" fill="${c.fg}"/>
      <path d="${gearPath(50, 50, 15, 11, 10)}" fill="${c.ac2}"/><circle cx="50" cy="50" r="5" fill="${c.fg}"/>` },
  texteditor: { bg: ['#ffffff', '#ececf0'], tone: '#5e5ce6', paper: true, c: { fg: '#fff', ac: '#5e5ce6', ac2: '#ff9f0a', paper: '#fff', ink: '#aeaeb2' },
    draw: (c) => `<g stroke="${c.ink}" stroke-width="2.4" stroke-linecap="round"><path d="M22 28h48M22 38h56M22 48h40M22 58h52M22 68h30"/></g>
      <path d="M58 76l22-22 6 6-22 22-9 3z" fill="${c.ac}"/><path d="M80 54l4-4a4 4 0 0 1 6 6l-4 4z" fill="${c.ac2}"/>` },
  preview: { bg: ['#ffffff', '#ececf0'], tone: '#34c759', paper: true, c: { fg: '#fff', ac: '#34c759', ac2: '#5ac8fa', paper: '#fff', ink: '#8e8e93' },
    draw: (c) => `<rect x="20" y="24" width="60" height="46" rx="5" fill="${c.ac2}"/>
      <path d="M20 62l16-15 12 11 9-7 23 17v2a5 5 0 0 1-5 5H25a5 5 0 0 1-5-5z" fill="${c.ac}"/>
      <circle cx="63" cy="38" r="5" fill="#ffd60a"/>
      <circle cx="62" cy="64" r="11" fill="none" stroke="${c.ink}" stroke-width="4"/><path d="M70 72l9 9" stroke="${c.ink}" stroke-width="5" stroke-linecap="round"/>` },
  appstore: { bg: ['#45b6ff', '#0d5bea'], tone: '#2f8cff', c: { fg: '#fff', ac: '#bfe6ff', ac2: '#0d5bea', paper: '#fff', ink: '#0d5bea' },
    // an original design: a shopping bag with a download arrow
    draw: (c) => `<path d="M30 38h40l-3.5 38a5 5 0 0 1-5 4.5h-23a5 5 0 0 1-5-4.5z" fill="${c.fg}"/>
      <path d="M40 38v-5a10 10 0 0 1 20 0v5" stroke="${c.fg}" stroke-width="5" fill="none" stroke-linecap="round"/>
      <path d="M50 48v18M42 59l8 8 8-8" stroke="${c.ac2}" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` },
  launchpad: { bg: ['#55555c', '#2a2a30'], tone: '#bf5af2', c: { fg: '#fff', ac: '#ff375f', ac2: '#0a84ff', paper: '#2c2c2e', ink: '#fff' },
    draw: () => { const cols = ['#ff375f', '#ff9f0a', '#ffd60a', '#30d158', '#64d2ff', '#0a84ff', '#5e5ce6', '#bf5af2', '#ff2d55'];
      return cols.map((col, i) => `<rect x="${22 + (i % 3) * 20}" y="${22 + Math.floor(i / 3) * 20}" width="15" height="15" rx="4.5" fill="${col}"/>`).join(''); } },
  about: { bg: ['#1a1a2e', '#0b0b14'], tone: '#5e8cff', c: { fg: '#fff', ac: '#5e8cff', paper: '#1c1c1e', ink: '#fff' },
    draw: () => `<g transform="translate(22 18) scale(.56)">${logoBadge().replace(/<\/?svg[^>]*>/g, '')}</g>` },
  linux: { bg: ['#6b7280', '#374151'], tone: '#9ca3af', c: { fg: '#fff', ac: '#fbbf24', paper: '#fff', ink: '#111' },
    draw: (c) => `<ellipse cx="50" cy="56" rx="17" ry="22" fill="#111"/><ellipse cx="50" cy="60" rx="11" ry="16" fill="${c.fg}"/>
      <circle cx="44" cy="40" r="3" fill="${c.fg}"/><circle cx="56" cy="40" r="3" fill="${c.fg}"/><path d="M45 47l5 4 5-4z" fill="${c.ac}"/>
      <ellipse cx="40" cy="78" rx="7" ry="3" fill="${c.ac}"/><ellipse cx="60" cy="78" rx="7" ry="3" fill="${c.ac}"/>` },
};

export function trashIcon(full) {
  // drawn in 22–78 × 20–94; shifted up so it sits centred like the other (8–92) icons
  return `<svg viewBox="0 -7 100 100"><defs><linearGradient id="tg" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".5" stop-color="#fff" stop-opacity=".25"/><stop offset="1" stop-color="#fff" stop-opacity=".5"/></linearGradient></defs>
    ${full ? '<path d="M28 24c6-8 18-10 22-4 6-6 18-4 21 4 3 6-6 10-22 10S23 31 28 24z" fill="#fff" opacity=".9"/><path d="M36 20l10 6M58 17l-6 9" stroke="#bbb" stroke-width="2"/>' : ''}
    <path d="M22 26h56l-6 62a6 6 0 0 1-6 5.5H34a6 6 0 0 1-6-5.5z" fill="url(#tg)" stroke="rgba(255,255,255,.75)" stroke-width="1.5"/>
    <ellipse cx="50" cy="26" rx="28" ry="5" fill="rgba(255,255,255,.35)" stroke="rgba(255,255,255,.9)" stroke-width="1.5"/>
    <g stroke="rgba(255,255,255,.55)" stroke-width="2.2" stroke-linecap="round"><path d="M38 38l2 46M50 38v47M62 38l-2 46"/></g></svg>`;
}

const ICON_MODES = {
  dark: (spec) => ({ bg: ['#3a3a3f', '#141417'], c: { ...spec.c, fg: spec.paper ? spec.c.fg : spec.tone, paper: '#2c2c30', ink: spec.paper ? '#d1d1d6' : spec.c.ink } }),
  clear: (spec) => ({ bg: ['rgba(255,255,255,.34)', 'rgba(255,255,255,.12)'], c: { fg: 'rgba(255,255,255,.95)', ac: 'rgba(255,255,255,.85)', ac2: 'rgba(255,255,255,.55)', paper: 'rgba(255,255,255,.25)', ink: 'rgba(255,255,255,.9)' } }),
  tinted: (spec) => { const a = store.get('accent'); return { bg: ['#2e2e33', '#121215'], c: { fg: a, ac: a, ac2: a + 'aa', paper: '#2c2c30', ink: a } }; },
};

export function appIconSVG(id, mode = store.get('iconStyle')) {
  const spec = APP_ICONS[id] || APP_ICONS.linux;
  const m = mode !== 'default' && ICON_MODES[mode] ? ICON_MODES[mode](spec) : { bg: spec.bg, c: spec.c };
  const n = ++uid;
  const clear = mode === 'clear';
  return `<svg viewBox="0 0 100 100"><defs>
    <linearGradient id="bg${n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${m.bg[0]}"/><stop offset="1" stop-color="${m.bg[1]}"/></linearGradient>
    <linearGradient id="hl${n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${clear ? 0.35 : 0.28}"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <clipPath id="cp${n}"><rect x="8" y="8" width="84" height="84" rx="19.5"/></clipPath></defs>
    <rect x="8" y="8" width="84" height="84" rx="19.5" fill="url(#bg${n})"/>
    <g clip-path="url(#cp${n})">${spec.draw(m.c)}</g>
    <rect x="8" y="8" width="84" height="84" rx="19.5" fill="url(#hl${n})"/>
    <rect x="8.5" y="8.5" width="83" height="83" rx="19" fill="none" stroke="#fff" stroke-opacity="${clear ? 0.7 : 0.35}" stroke-width="1"/>
  </svg>`;
}

/** Icon element for any app: built-in id, a Linux .desktop app object, or 'trash'. */
export function appIcon(app, cls = '') {
  const el = document.createElement('div');
  el.className = 'app-icon ' + cls;
  if (typeof app === 'string') app = { id: app, builtin: true };
  if (app.id === 'trash' || app.id === 'trash-full') el.innerHTML = trashIcon(app.id === 'trash-full');
  else if (app.builtin || APP_ICONS[app.id]) {
    el.innerHTML = appIconSVG(app.icon || app.id);
    if (store.get('iconStyle') === 'clear') el.classList.add('clear-bg');
  } else if (app.icon) {
    el.classList.add('native');
    if (store.get('uniformIcons')) { el.classList.add('framed'); el.append(Object.assign(document.createElement('i'), { className: 'frame' })); }
    const img = new Image();
    img.src = 'file://' + app.icon;
    img.onerror = () => { el.className = 'app-icon ' + cls; el.innerHTML = appIconSVG('linux'); };
    el.append(img);
  } else el.innerHTML = appIconSVG('linux');
  return el;
}

/* ------------------------------------------------------------------ file icons */
const FOLDER_GLYPHS = { Desktop: sym.desktop, Documents: sym.doc, Downloads: sym.download, Pictures: sym.photo, Music: sym.music, Videos: sym.video, Home: sym.home, Public: sym.user, Templates: sym.doc };
export function folderIcon(name) {
  const g = FOLDER_GLYPHS[name];
  return `<svg viewBox="0 0 64 64"><defs><linearGradient id="fb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fd3ff"/><stop offset="1" stop-color="#4fb0f5"/></linearGradient>
    <linearGradient id="ff" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a8ddff"/><stop offset="1" stop-color="#6cc1fa"/></linearGradient></defs>
    <path d="M4 13a4 4 0 0 1 4-4h14l4 4h30a4 4 0 0 1 4 4v32a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="url(#fb)"/>
    <path d="M4 21a4 4 0 0 1 4-4h48a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="url(#ff)"/>
    <path d="M4.5 21.5a4 4 0 0 1 4-4h47" stroke="#fff" stroke-opacity=".7" stroke-width="1" fill="none"/>
    ${g ? `<g transform="translate(22 25) scale(.83)" color="#3d97d8" opacity=".85">${g.replace('class="sym"', '')}</g>` : ''}</svg>`;
}
const EXT_COLORS = {
  pdf: '#ff3b30', zip: '#8e8e93', gz: '#8e8e93', xz: '#8e8e93', tar: '#8e8e93', '7z': '#8e8e93', rar: '#8e8e93', deb: '#a2845e', rpm: '#a2845e', appimage: '#5e5ce6',
  js: '#f7c600', mjs: '#f7c600', ts: '#3178c6', py: '#3572a5', rs: '#dea584', go: '#00add8', c: '#555', cpp: '#f34b7d', h: '#555', java: '#b07219', sh: '#30d158', json: '#8e8e93',
  html: '#e34c26', css: '#563d7c', md: '#0a84ff', txt: '#8e8e93', mp3: '#ff2d55', flac: '#ff2d55', wav: '#ff2d55', ogg: '#ff2d55', mp4: '#5e5ce6', mkv: '#5e5ce6', webm: '#5e5ce6', mov: '#5e5ce6',
  png: '#34c759', jpg: '#34c759', jpeg: '#34c759', gif: '#34c759', webp: '#34c759', svg: '#ff9f0a', iso: '#8e8e93', doc: '#2b579a', docx: '#2b579a', xls: '#217346', xlsx: '#217346', ppt: '#d24726', pptx: '#d24726', odt: '#2b579a',
};
export function docIcon(ext) {
  const col = EXT_COLORS[ext] || '#8e8e93';
  const label = (ext || '').slice(0, 4).toUpperCase();
  return `<svg viewBox="0 0 64 64"><defs><linearGradient id="dg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#f0f0f3"/></linearGradient></defs>
    <path d="M14 4h24l14 14v40a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="url(#dg)" stroke="rgba(0,0,0,.14)" stroke-width="1"/>
    <path d="M38 4v12a2 2 0 0 0 2 2h12" fill="#e4e4e9" stroke="rgba(0,0,0,.12)" stroke-width="1"/>
    <g stroke="#d1d1d6" stroke-width="2" stroke-linecap="round"><path d="M19 27h26M19 33h26M19 39h18"/></g>
    ${label ? `<rect x="15" y="44" width="34" height="11" rx="3" fill="${col}"/><text x="32" y="52.6" text-anchor="middle" font-family="Inter Variable, sans-serif" font-size="7.5" font-weight="700" fill="#fff">${label}</text>` : ''}</svg>`;
}
export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
export const TEXT_EXT = new Set(['txt', 'md', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'py', 'sh', 'bash', 'zsh', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'java', 'css', 'html', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'log', 'csv', 'lua', 'rb', 'php', 'sql', 'desktop', 'env', 'gitignore', '']);
