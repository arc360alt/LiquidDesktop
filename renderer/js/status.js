// Polls hardware state (battery, volume, brightness, Wi-Fi, Bluetooth) and shares it.
import { api } from './sys.js';
import { bus } from './util.js';

export const status = {
  s: { battery: null, volume: null, brightness: null, wifi: null, bluetooth: null },
  async refresh() {
    try { this.s = await api.sys.status(); bus.emit('status', this.s); } catch { /* backend unavailable */ }
  },
  patch(part) { Object.assign(this.s, part); bus.emit('status', this.s); },
  start() { this.refresh(); setInterval(() => this.refresh(), 6000); },
};
