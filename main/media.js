// Now Playing: talks to media players over D-Bus (MPRIS), the way playerctl does, so it works without
// playerctl installed. Every player that's open is asked; the one that's playing wins (else the one that
// played most recently, else the first).
let dbus = null;
try { dbus = require('dbus-next'); } catch { dbus = null; }

let bus = null;
const lastPlaying = new Map();   // bus name -> when it was last seen playing
function getBus() {
  if (bus || !dbus || !process.env.DBUS_SESSION_BUS_ADDRESS) return bus;
  try { bus = dbus.sessionBus(); bus.on('error', () => {}); } catch { bus = null; }
  return bus;
}
const call = (dest, path, iface, member, signature = '', body = []) =>
  bus.call(new dbus.Message({ destination: dest, path, interface: iface, member, signature, body })).then((r) => r.body);
const plain = (v) => (v instanceof dbus.Variant ? plain(v.value) : Array.isArray(v) ? v.map(plain) : v);
const timeout = (p, ms = 1500) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function players() {
  if (!getBus()) return [];
  const [names] = await timeout(call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames'));
  const list = names.filter((n) => n.startsWith('org.mpris.MediaPlayer2.')).sort();
  const out = await Promise.all(list.map(async (name) => {
    try {
      const [props] = await timeout(call(name, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'GetAll', 's', ['org.mpris.MediaPlayer2.Player']));
      const meta = plain(props.Metadata) || {};
      const status = plain(props.PlaybackStatus) || 'Stopped';
      if (status === 'Playing') lastPlaying.set(name, Date.now());
      const artist = plain(meta['xesam:artist']);
      return {
        bus: name, status,
        title: plain(meta['xesam:title']) || '',
        artist: Array.isArray(artist) ? artist.join(', ') : artist || '',
        album: plain(meta['xesam:album']) || '',
        art: plain(meta['mpris:artUrl']) || '',
        length: Number(plain(meta['mpris:length']) || 0) / 1e6,
        player: name.replace('org.mpris.MediaPlayer2.', '').split('.')[0],
      };
    } catch { return null; }
  }));
  return out.filter(Boolean);
}
async function current() {
  const ps = await players().catch(() => []);
  const rank = (p) => (p.status === 'Playing' ? 2e15 : 0) + (p.title ? 1e15 : 0) + (lastPlaying.get(p.bus) || 0);
  const p = ps.sort((a, b) => rank(b) - rank(a))[0];
  return p && (p.title || p.status !== 'Stopped') ? p : null;
}
const COMMANDS = { 'play-pause': 'PlayPause', play: 'Play', pause: 'Pause', next: 'Next', previous: 'Previous', stop: 'Stop' };
async function command(cmd) {
  const p = await current();
  if (!p || !COMMANDS[cmd]) return false;
  await call(p.bus, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', COMMANDS[cmd]).catch(() => {});
  return true;
}

module.exports = { current, command, available: () => !!getBus() };
