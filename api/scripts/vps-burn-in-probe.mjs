/**
 * End-to-end probe: widget init -> socket -> message -> bot reply.
 *
 * Proves HTTP, TLS, Postgres, Redis, Socket.IO rooms, the LLM path and the
 * outbound reply on ONE host. Used to burn in and then continuously watch the
 * prod VPS.
 *
 * Usage:
 *   cd api && PROBE_API=https://api-vps.axentrio.com PROBE_BOT_KEY=<publicKey> \
 *     node scripts/vps-burn-in-probe.mjs
 */
import { io } from 'socket.io-client';

const api = process.env.PROBE_API;
const apiKey = process.env.PROBE_BOT_KEY;
if (!api || !apiKey) {
  console.error('set PROBE_API and PROBE_BOT_KEY');
  process.exit(1);
}

// Prefix must stay `vps-probe-`: the scheduled purge matches on it.
const visitorId = `vps-probe-${Date.now()}`;
const startedAt = Date.now();
const initRes = await fetch(`${api}/api/v1/widget/init`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ apiKey, visitorId }),
});
if (!initRes.ok) {
  console.error(`widget/init ${initRes.status}: ${await initRes.text()}`);
  process.exit(1);
}
const { data } = await initRes.json();
const sessionId = data.session.id;
console.log(`init ok - session ${sessionId}`);

const socket = io(api, {
  transports: ['websocket'],
  auth: { widgetToken: data.token },
  query: { apiKey },
});

const reply = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no bot reply within 60s')), 60_000);
  socket.on('connect_error', (err) => { clearTimeout(timer); reject(err); });
  socket.on('error', (err) => { clearTimeout(timer); reject(new Error(JSON.stringify(err))); });
  socket.on('connect', () => socket.emit('session:join', { sessionId }));
  socket.on('session:joined', () =>
    socket.emit('message:send', { sessionId, content: 'Wat zijn jullie openingsuren?', type: 'text' }));
  socket.on('message:receive', (msg) => {
    if (msg.senderType === 'user') return;
    clearTimeout(timer);
    resolve(msg);
  });
}).catch((err) => { console.error(`probe failed: ${err.message}`); socket.close(); process.exit(1); });

socket.close();
console.log(`bot replied in ${Date.now() - startedAt}ms (${String(reply.content ?? '').length} chars)`);
process.exit(0);
