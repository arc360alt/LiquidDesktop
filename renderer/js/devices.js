// Shared bits for Bluetooth and sound devices: icons for kinds of devices, and one listener per event
// from the back end (each page subscribes once; panes and panels come and go).
import { api } from './sys.js';

const svg = (d) => `<svg class="sym" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const DEV_ICONS = {
  headphones: svg('<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="7" rx="1.8"/><rect x="16.5" y="14" width="4.5" height="7" rx="1.8"/>'),
  speaker: svg('<rect x="6" y="2.5" width="12" height="19" rx="3"/><circle cx="12" cy="14.5" r="3.4"/><circle cx="12" cy="7" r="1.2"/>'),
  display: svg('<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8.5 21h7M12 17v4"/>'),
  usb: svg('<path d="M12 3v14M12 3l-2.5 3M12 3l2.5 3M7 9v3l5 3M17 8v3l-5 3"/><circle cx="12" cy="19" r="2"/>'),
  mic: svg('<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
  camera: svg('<circle cx="12" cy="10" r="7"/><circle cx="12" cy="10" r="2.6"/><path d="M8 20.5h8"/>'),
  mouse: svg('<rect x="6" y="2.5" width="12" height="19" rx="6"/><path d="M12 6.5v3.5"/>'),
  keyboard: svg('<rect x="2" y="6" width="20" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  gamepad: svg('<path d="M7 7h10a5 5 0 0 1 4.8 6.3l-1 3.6a2.6 2.6 0 0 1-4.4 1.1L14 15.5h-4L7.6 18a2.6 2.6 0 0 1-4.4-1.1l-1-3.6A5 5 0 0 1 7 7z"/><path d="M8 10v3M6.5 11.5h3M15.5 11h.01M17.5 13h.01"/>'),
  phone: svg('<rect x="6.5" y="2" width="11" height="20" rx="2.5"/><path d="M11 18.5h2"/>'),
  computer: svg('<rect x="3" y="4.5" width="18" height="12" rx="1.8"/><path d="M1.5 19.5h21"/>'),
  watch: svg('<rect x="6.5" y="6" width="11" height="12" rx="3"/><path d="M8.5 6l1-3.5h5l1 3.5M8.5 18l1 3.5h5l1-3.5"/>'),
  bluetooth: svg('<path d="M7 7l10 10-5 4.5V2.5L17 7 7 17"/>'),
};
// BlueZ's "Icon" property (freedesktop icon names) → one of ours
export function btIcon(name = '') {
  if (/audio-head|headphone|headset/.test(name)) return DEV_ICONS.headphones;
  if (/audio-card|speaker/.test(name)) return DEV_ICONS.speaker;
  if (/input-mouse|input-tablet/.test(name)) return DEV_ICONS.mouse;
  if (/input-keyboard/.test(name)) return DEV_ICONS.keyboard;
  if (/input-gaming/.test(name)) return DEV_ICONS.gamepad;
  if (/phone/.test(name)) return DEV_ICONS.phone;
  if (/computer/.test(name)) return DEV_ICONS.computer;
  if (/watch/.test(name)) return DEV_ICONS.watch;
  if (/video-display|tv/.test(name)) return DEV_ICONS.display;
  return DEV_ICONS.bluetooth;
}

const listeners = { bt: new Set(), code: new Set() };
let hooked = false;
function hook() {
  if (hooked || !api.bt?.onChanged) return;
  hooked = true;
  api.bt.onChanged(() => listeners.bt.forEach((f) => f()));
  api.bt.onCode((c) => listeners.code.forEach((f) => f(c)));
}
/** Calls fn whenever Bluetooth changes, as long as `el` is on the page. */
export function onBluetooth(el, fn) {
  hook();
  const wrapped = () => { if (!el.isConnected) { listeners.bt.delete(wrapped); return; } fn(); };
  listeners.bt.add(wrapped);
}
/** Pairing codes from the Bluetooth agent ({ code, confirm } or null when it's over). */
export function onPairingCode(fn) { hook(); listeners.code.add(fn); return () => listeners.code.delete(fn); }
