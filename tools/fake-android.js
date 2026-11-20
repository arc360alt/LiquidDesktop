// A pretend Android phone that speaks the KDE Connect protocol (v8), for testing Messages, Phone, the Phone
// widgets and Control Center without a real phone. It has text message threads, contacts, notifications,
// battery, signal, music and incoming calls, and answers what KDE Connect asks for like the Android app does.
//   node tools/fake-android.js [--port 1716] [--name "Pixel 9"] [--no-contacts] [--quiet-sent] [--reuse-ids]     (--stop: stop the one that's running)
// It connects to the kdeconnectd on this machine (127.0.0.1 only), asks to pair, then waits. Accept
// the request in Settings › Phone (or tools/fake-phone.sh android does it for you).
// While it runs, write commands to the control pipe (path printed at start), one per line:
//   sms <number> <text…>       an incoming text (spaces in numbers as _: +1_555_0101)          notify <app> <title> <text…>   a notification
//   battery <percent> [charging]                          call <number> [name]           the phone rings
//   play | pause | track <title> - <artist>              unpair
//   file <path>                share a file to the computer (like Share › KDE Connect on the phone)
//   badfile                    a file that never arrives (to see what failing looks like)
// Needs openssl (for the certificate). State (identity, certificate, messages) lives in $XDG_RUNTIME_DIR.
const tls = require('tls');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const DIR = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'liquid-fake-android');
fs.mkdirSync(DIR, { recursive: true });
const NAME = arg('--name', 'Pixel 9 (test)');
// one phone at a time: a copy that's still running is replaced
const PIDFILE = path.join(DIR, 'pid');
try { const old = Number(fs.readFileSync(PIDFILE, 'utf8')); if (old && old !== process.pid) process.kill(old); } catch { /* none running */ }
fs.writeFileSync(PIDFILE, String(process.pid));
if (process.argv.includes('--stop')) process.exit(0);
const DAEMON_PORT = Number(arg('--port', 1716));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// identity + certificate (CN must be the device id), kept so pairing survives restarts
let id;
try { id = fs.readFileSync(path.join(DIR, 'id'), 'utf8').trim(); } catch { id = 'fake_android_' + require('crypto').randomBytes(10).toString('hex'); fs.writeFileSync(path.join(DIR, 'id'), id); }
const KEY = path.join(DIR, 'key.pem'), CERT = path.join(DIR, 'cert.pem');
if (!fs.existsSync(CERT)) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', KEY, '-out', CERT, '-days', '3650', '-subj', `/O=KDE/OU=KDE Connect/CN=${id}`], { stdio: 'ignore' });

/* ------------------------------------------------------------------ the phone's data */
const now = Date.now(), MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const contacts = [
  { uid: '101', name: 'Alex Rivera', tel: '+1 555 0101' },
  { uid: '102', name: 'Mom', tel: '+1 555 0102' },
  { uid: '103', name: 'Jordan Lee', tel: '+1 555 0103' },
  { uid: '104', name: 'Sam Patel', tel: '+1 555 0104' },
  { uid: '105', name: 'Pizza Place', tel: '+1 555 0199' },
];
let msgId = 1000;
const M = (thread, addr, body, ago, type = 1, read = 1) => ({ event: 1, body, addresses: [{ address: addr }], date: now - ago, type, read, thread_id: thread, _id: ++msgId, sub_id: 1 });
const messages = [
  M(1, '+1 555 0101', 'Hey! Are we still on for tonight?', 3 * HOUR), M(1, '+1 555 0101', 'Yes! 7pm at the usual place', 2.9 * HOUR, 2),
  M(1, '+1 555 0101', 'Perfect 👍', 2.8 * HOUR), M(1, '+1 555 0101', 'Running 10 min late, sorry!', 12 * MIN, 1, 0),
  M(2, '+1 555 0102', 'Call me when you get a chance', 2 * DAY), M(2, '+1 555 0102', 'Will do, love you', 2 * DAY - 30 * MIN, 2),
  M(2, '+1 555 0102', 'Did you eat yet?', 5 * HOUR),
  M(3, '+1 555 0103', 'Sending the slides now', 6 * DAY), M(3, '+1 555 0103', 'Got them, thanks!', 6 * DAY - HOUR, 2),
  M(4, '+1 555 0199', 'Your order #4821 is out for delivery 🍕', 40 * MIN),
  // a group chat
  { ...M(5, '+1 555 0104', 'Who’s bringing snacks?', 1 * DAY), addresses: [{ address: '+1 555 0104' }, { address: '+1 555 0103' }] },
  // (in a group, the sender comes first)
  { ...M(5, '+1 555 0103', 'I got chips', 1 * DAY - 20 * MIN), addresses: [{ address: '+1 555 0103' }, { address: '+1 555 0104' }] },
];
const state = { battery: 76, charging: false, playing: true, title: 'Midnight City', artist: 'M83', album: 'Hurry Up, We’re Dreaming', pos: 42_000 };

/* ------------------------------------------------------------------ connection */
let sock = null, asked = false, paired = fs.existsSync(path.join(DIR, 'paired'));
const caps = {
  incoming: ['kdeconnect.ping', 'kdeconnect.findmyphone.request', 'kdeconnect.sms.request', 'kdeconnect.sms.request_conversations', 'kdeconnect.sms.request_conversation',
    'kdeconnect.sms.request_attachment', 'kdeconnect.contacts.request_all_uids_timestamps', 'kdeconnect.contacts.request_vcards_by_uid', 'kdeconnect.notification.request',
    'kdeconnect.notification.reply', 'kdeconnect.notification.action', 'kdeconnect.mpris.request', 'kdeconnect.clipboard', 'kdeconnect.clipboard.connect', 'kdeconnect.share.request',
    'kdeconnect.telephony.request_mute', 'kdeconnect.connectivity_report.request', 'kdeconnect.battery.request', 'kdeconnect.sftp.request', 'kdeconnect.mousepad.request'],
  outgoing: ['kdeconnect.ping', 'kdeconnect.battery', 'kdeconnect.connectivity_report', 'kdeconnect.sms.messages', 'kdeconnect.sms.attachment_file', 'kdeconnect.contacts.response_uids_timestamps',
    'kdeconnect.contacts.response_vcards', 'kdeconnect.notification', 'kdeconnect.mpris', 'kdeconnect.clipboard', 'kdeconnect.share.request', 'kdeconnect.telephony', 'kdeconnect.sftp',
    'kdeconnect.findmyphone.request', 'kdeconnect.mousepad.echo', 'kdeconnect.mousepad.keyboardstate'],
};
const identity = (tcpPort) => ({ id: Date.now(), type: 'kdeconnect.identity', body: { deviceId: id, deviceName: NAME, deviceType: 'phone', protocolVersion: 8,
  incomingCapabilities: caps.incoming, outgoingCapabilities: caps.outgoing, ...(tcpPort ? { tcpPort } : {}) } });
const send = (type, body) => { if (!sock) return; sock.write(JSON.stringify({ id: Date.now(), type, body }) + '\n'); log('→', type); };

function lineReader(s, onPacket) {
  let buf = '';
  s.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) try { onPacket(JSON.parse(line)); } catch (e) { log('bad packet', e.message); }
    }
  });
}

// We connect to KDE Connect's TCP port (it ignores discovery packets from this machine), send our identity in
// plain text, and then — the side that connected is the TLS server — encrypt; then both send their identity
// again, encrypted (protocol 8). Nothing is broadcast on the network.
function connect() {
  if (sock || connecting) return;
  connecting = true;
  const raw = net.connect(DAEMON_PORT, '127.0.0.1', () => {
    raw.write(JSON.stringify(identity(1764)) + '\n');
    const t = new tls.TLSSocket(raw, { isServer: true, key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT), requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    t.on('secure', () => {
      log('encrypted');
      t.write(JSON.stringify(identity()) + '\n');
      let gotIdentity = false;
      lineReader(t, (p) => {
        if (!gotIdentity && p.type === 'kdeconnect.identity') { gotIdentity = true; sock = t; connecting = false; log('daemon:', p.body.deviceName); onConnected(); return; }
        handle(p);
      });
    });
    t.on('error', (e) => log('tls error', e.message));
    t.on('close', () => { connecting = false; if (sock === t) { sock = null; log('disconnected'); } });
  });
  raw.on('error', (e) => { connecting = false; log('can’t reach KDE Connect on port', DAEMON_PORT, '-', e.code); });
  raw.on('close', () => { if (!sock) connecting = false; });
}
let connecting = false;

function onConnected() {
  log('connected; paired =', paired);
  if (!paired) { asked = true; send('kdeconnect.pair', { pair: true, timestamp: Math.floor(Date.now() / 1000) }); }
  else sendStatus();
}
function sendStatus() {
  send('kdeconnect.battery', { currentCharge: state.battery, isCharging: state.charging, thresholdEvent: 0 });
  send('kdeconnect.connectivity_report', { signalStrengths: { 1: { networkType: '5G', signalStrength: 3 } } });
  send('kdeconnect.mpris', { playerList: ['Spotify', 'YouTube Music'], supportAlbumArtPayload: false });
  sendNotification('n1', 'Calendar', 'Dentist appointment', 'Tomorrow at 9:30 AM', false);
  sendNotification('n2', 'Messages', 'Alex Rivera', 'Running 10 min late, sorry!', true);
}
function sendNotification(key, app, title, text, replyable) {
  send('kdeconnect.notification', { id: key, appName: app, title, text, ticker: `${title}: ${text}`, isClearable: true, time: String(Date.now()), silent: 'false',
    ...(replyable ? { requestReplyId: 'reply-' + key } : {}), actions: replyable ? ['Mark as read'] : [] });
}
const threads = () => [...new Set(messages.map((m) => m.thread_id))];
const latest = (t) => messages.filter((m) => m.thread_id === t).sort((a, b) => b.date - a.date)[0];
const vcard = (c) => `BEGIN:VCARD\nVERSION:2.1\nFN:${c.name}\nTEL;CELL:${c.tel}\nX-KDECONNECT-ID-DEV-${id}:${c.uid}\nX-KDECONNECT-TIMESTAMP:${now}\nEND:VCARD\n`;

function handle(p) {
  const b = p.body || {};
  log('←', p.type, Object.keys(b).length ? JSON.stringify(b).slice(0, 160) : '');
  switch (p.type) {
    case 'kdeconnect.pair':
      // an answer to our request just completes it; a request from the computer is accepted (with an answer)
      if (b.pair) {
        if (paired) return;
        if (!asked) send('kdeconnect.pair', { pair: true, timestamp: Math.floor(Date.now() / 1000) });
        asked = false; paired = true; fs.writeFileSync(path.join(DIR, 'paired'), '1'); sendStatus();
      } else { asked = false; if (paired) log('unpaired by the computer'); paired = false; fs.rmSync(path.join(DIR, 'paired'), { force: true }); }
      return;
    case 'kdeconnect.ping': return;
    case 'kdeconnect.findmyphone.request': log('🔔 RING RING (find my phone)'); return;
    case 'kdeconnect.battery.request': return send('kdeconnect.battery', { currentCharge: state.battery, isCharging: state.charging, thresholdEvent: 0 });
    case 'kdeconnect.connectivity_report.request': return send('kdeconnect.connectivity_report', { signalStrengths: { 1: { networkType: '5G', signalStrength: 3 } } });
    case 'kdeconnect.sms.request_conversations':
      return send('kdeconnect.sms.messages', { messages: threads().map(latest), version: 2 });
    case 'kdeconnect.sms.request_conversation': {
      const start = b.rangeStartTimestamp > 0 ? b.rangeStartTimestamp : Infinity;
      const list = messages.filter((m) => m.thread_id === Number(b.threadID) && m.date < start).sort((x, y) => y.date - x.date).slice(0, b.numberToRequest > 0 ? b.numberToRequest : 1000);
      return send('kdeconnect.sms.messages', { messages: list, version: 2 });
    }
    case 'kdeconnect.sms.request': {
      // sending a text: it shows up in its thread as sent (like Android's message database telling KDE Connect)
      const addrs = (b.addresses || []).map((a) => a.address);
      const key = addrs.slice().sort().join(',');
      const existing = messages.find((m) => m.addresses.map((a) => a.address).sort().join(',') === key);
      const thread = existing ? existing.thread_id : Math.max(...threads()) + 1;
      // --reuse-ids: like phones that report every text sent for KDE Connect with the same id
      const m = { event: 1, body: b.messageBody, addresses: addrs.map((address) => ({ address })), date: Date.now(), type: 2, read: 1, thread_id: thread, _id: process.argv.includes('--reuse-ids') ? 7777 : ++msgId, sub_id: 1 };
      messages.push(m);
      log(`✉ sent to ${addrs.join(', ')}: ${b.messageBody}`);
      // --quiet-sent: like phones that don't report texts sent for KDE Connect (it's only in the history)
      if (!process.argv.includes('--quiet-sent')) send('kdeconnect.sms.messages', { messages: [m], version: 2 });
      // a reply a moment later, so live updates can be seen
      setTimeout(() => {
        const r = { ...m, body: `Got it: “${b.messageBody.slice(0, 40)}”`, date: Date.now(), type: 1, read: 0, _id: ++msgId, addresses: m.addresses.slice(0, 1) };
        if (m.addresses.length > 1) r.addresses = m.addresses;
        messages.push(r);
        send('kdeconnect.sms.messages', { messages: [r], version: 2 });
      }, 3000);
      return;
    }
    // --no-contacts: like a phone where KDE Connect isn't allowed to read contacts (it doesn't answer)
    case 'kdeconnect.contacts.request_all_uids_timestamps':
      if (process.argv.includes('--no-contacts')) return;
      return send('kdeconnect.contacts.response_uids_timestamps', { uids: contacts.map((c) => c.uid), ...Object.fromEntries(contacts.map((c) => [c.uid, now])) });
    case 'kdeconnect.contacts.request_vcards_by_uid':
      return send('kdeconnect.contacts.response_vcards', { uids: b.uids, ...Object.fromEntries(contacts.filter((c) => b.uids.includes(c.uid)).map((c) => [c.uid, vcard(c)])) });
    case 'kdeconnect.mpris.request':
      if (b.requestPlayerList) send('kdeconnect.mpris', { playerList: ['Spotify', 'YouTube Music'], supportAlbumArtPayload: false });
      if (b.action === 'PlayPause') state.playing = !state.playing;
      if (b.action === 'Next') { state.title = 'Wait'; state.pos = 0; }
      if (b.action === 'Previous') { state.title = 'Midnight City'; state.pos = 0; }
      if (b.requestNowPlaying || b.action) send('kdeconnect.mpris', { player: b.player || 'Spotify', title: state.title, artist: state.artist, album: state.album, isPlaying: state.playing,
        pos: state.pos, length: 243_000, volume: 70, canPause: true, canPlay: true, canGoNext: true, canGoPrevious: true, canSeek: true });
      return;
    case 'kdeconnect.notification.reply': log(`💬 reply to ${b.requestReplyId}: ${b.message}`); return;
    case 'kdeconnect.notification.request': if (b.cancel) log('notification dismissed:', b.cancel); return;
    case 'kdeconnect.sftp.request': return send('kdeconnect.sftp', { errorMessage: 'The test phone has no files to share.' });
    case 'kdeconnect.mousepad.request': if (b.key || b.specialKey) log('⌨ typed on phone:', b.key || `[special ${b.specialKey}]`); return;
    default: return;
  }
}

/* ------------------------------------------------------------------ control pipe */
const CTL = path.join(DIR, 'control');
try { fs.rmSync(CTL, { force: true }); execFileSync('mkfifo', [CTL]); } catch { /* no fifo */ }
function readControl() {
  const s = fs.createReadStream(CTL, { encoding: 'utf8' });
  let buf = '';
  s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { command(buf.slice(0, i).trim()); buf = buf.slice(i + 1); } });
  s.on('end', () => setTimeout(readControl, 50));
  s.on('error', () => {});
}
// Sharing a file from the phone (what Android's "Share › KDE Connect" does): the packet says what's coming and
// on which port; KDE Connect connects there, the phone is the TLS server, and the file's bytes follow.
function sendFile(file) {
  let data;
  try { data = fs.readFileSync(file); } catch (e) { log('can’t read', file, e.message); return; }
  const srv = net.createServer((raw) => {
    const t = new tls.TLSSocket(raw, { isServer: true, key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT), requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    t.on('secure', () => { t.end(data); log('📤 file sent:', path.basename(file), data.length, 'bytes'); });
    t.on('error', (e) => log('payload tls error', e.message));
    t.on('close', () => srv.close());
  });
  let port = 1739;
  srv.on('error', (e) => { if (e.code === 'EADDRINUSE' && port < 1764) srv.listen(++port); else log('no payload port', e.message); });
  srv.listen(port, () => {
    const pkt = { id: Date.now(), type: 'kdeconnect.share.request', body: { filename: path.basename(file), open: false, numberOfFiles: 1, totalPayloadSize: data.length, lastModified: Date.now() },
      payloadSize: data.length, payloadTransferInfo: { port: srv.address().port } };
    sock?.write(JSON.stringify(pkt) + '\n');
    log('→ kdeconnect.share.request (file', path.basename(file) + ', port', srv.address().port + ')');
  });
}

function command(line) {
  const [cmd, ...rest] = line.split(' ');
  if (cmd === 'file') { sendFile(rest.join(' ')); return; }
  // badfile: announce a file on a port nobody listens on (a transfer that fails)
  if (cmd === 'badfile') { sock?.write(JSON.stringify({ id: Date.now(), type: 'kdeconnect.share.request', body: { filename: 'broken.jpg', numberOfFiles: 1, totalPayloadSize: 5000 }, payloadSize: 5000, payloadTransferInfo: { port: 1763 } }) + '\n'); return; }
  if (cmd === 'sms') {
    const [addr, ...words] = rest;
    const number = addr.replace(/_/g, ' ');
    const existing = messages.find((m) => m.addresses.length === 1 && m.addresses[0].address === number);
    const m = { event: 1, body: words.join(' '), addresses: [{ address: number }], date: Date.now(), type: 1, read: 0, thread_id: existing ? existing.thread_id : Math.max(...threads()) + 1, _id: ++msgId, sub_id: 1 };
    messages.push(m);
    send('kdeconnect.sms.messages', { messages: [m], version: 2 });
  } else if (cmd === 'notify') { const [app, title, ...t] = rest; sendNotification('n' + Date.now(), app, title, t.join(' '), false); }
  else if (cmd === 'battery') { state.battery = Number(rest[0]); state.charging = rest[1] === 'charging'; send('kdeconnect.battery', { currentCharge: state.battery, isCharging: state.charging, thresholdEvent: 0 }); }
  else if (cmd === 'call') send('kdeconnect.telephony', { event: 'ringing', phoneNumber: rest[0].replace(/_/g, ' '), contactName: rest.slice(1).join(' ') || rest[0].replace(/_/g, ' ') });
  else if (cmd === 'play' || cmd === 'pause') { state.playing = cmd === 'play'; handle({ type: 'kdeconnect.mpris.request', body: { requestNowPlaying: true } }); }
  else if (cmd === 'track') { const [t, a] = rest.join(' ').split(' - '); state.title = t; state.artist = a || ''; handle({ type: 'kdeconnect.mpris.request', body: { requestNowPlaying: true } }); }
  else if (cmd === 'unpair') { send('kdeconnect.pair', { pair: false }); paired = false; fs.rmSync(path.join(DIR, 'paired'), { force: true }); }
}

log(`${NAME} (${id}); control pipe: ${CTL}`);
readControl();
connect();
setInterval(connect, 4000);
