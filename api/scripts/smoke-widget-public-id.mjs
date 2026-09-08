#!/usr/bin/env node
/**
 * Manual smoke: public widget id → session token → socket → bot reply roundtrip.
 *
 * Proves more than optimistic UI: waits for a distinct bot/agent `message:receive`
 * (or the same row via authenticated GET /widget/history).
 *
 * NOT CI-safe — each run writes to the target API/database:
 *   - creates a new widget chat session (open until idle-closed)
 *   - persists the customer message
 *   - may trigger a live LLM/agent turn (cost + latency)
 * No cleanup is performed; use a disposable dev/staging bot only.
 *
 * Usage:
 *   cd api && WIDGET_ID=<bot.publicKey> npm run smoke:widget-public-id
 *
 * Required env:
 *   WIDGET_ID=<bot.publicKey>   Bot.publicKey for a bot with AI enabled and
 *                               a tier that allows new widget sessions.
 *
 * Optional env:
 *   API_URL=http://localhost:4081
 *   SMOKE_TIMEOUT_MS=90000
 *
 * NEVER:
 *   - run against production or a real customer tenant without explicit intent
 *   - omit WIDGET_ID (no baked-in local keys)
 */
import { io } from 'socket.io-client';

const API = process.env.API_URL || 'http://localhost:4081';
const WIDGET_ID = process.env.WIDGET_ID?.trim();
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 90_000);

if (!WIDGET_ID) {
  console.error('WIDGET_ID is required (Bot.publicKey for a disposable dev/staging bot).');
  console.error('Example: WIDGET_ID=bk_… npm run smoke:widget-public-id');
  process.exit(2);
}

const visitorId = `smoke-widget-id-${Date.now()}`;
const customerText = `smoke widget-id ${Date.now()}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function init() {
  const res = await fetch(`${API}/api/v1/widget/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ widgetId: WIDGET_ID, visitorId }),
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(`init failed (${res.status}): ${JSON.stringify(json.error)}`);
  }
  return json.data;
}

async function fetchHistory(token) {
  const res = await fetch(`${API}/api/v1/widget/history`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(`history failed (${res.status}): ${JSON.stringify(json.error)}`);
  }
  return json.data;
}

function connectAndJoin({ token, sessionId }) {
  return new Promise((resolve, reject) => {
    const inbound = [];
    const socket = io(API, {
      transports: ['websocket'],
      auth: { widgetToken: token },
      reconnection: false,
      timeout: 8000,
    });

    const failTimer = setTimeout(() => {
      socket.close();
      reject(new Error('socket setup timeout'));
    }, 15_000);

    socket.on('connect_error', (err) => {
      clearTimeout(failTimer);
      reject(new Error(`connect_error: ${err.message}`));
    });

    socket.on('connect', () => {
      socket.emit('session:join', { sessionId });
    });

    socket.on('session:joined', () => {
      clearTimeout(failTimer);
      resolve({ socket, inbound });
    });

    socket.on('session:join:error', (e) => {
      clearTimeout(failTimer);
      reject(new Error(`session:join:error ${JSON.stringify(e)}`));
    });

    socket.on('message:receive', (data) => {
      inbound.push(data);
    });
  });
}

function isBotInbound(msg) {
  return msg.senderType && msg.senderType !== 'user' && typeof msg.content === 'string';
}

function historyBotAfterCustomer(history, customer) {
  const userIdx = history.findIndex((m) => m.content === customer);
  if (userIdx < 0) return null;
  return history.slice(userIdx + 1).find((m) => m.sender?.type && m.sender.type !== 'user') || null;
}

async function main() {
  console.log('=== smoke:widget-public-id (manual; writes session + messages) ===');
  console.log('API:', API);
  console.log('widgetId:', `${WIDGET_ID.slice(0, 8)}…`);
  console.log('visitor:', visitorId);

  const { token, session } = await init();
  console.log('init ok session=', session.id);

  const { socket, inbound } = await connectAndJoin({ token, sessionId: session.id });
  console.log('socket joined');

  const msgRes = await fetch(`${API}/api/v1/widget/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ content: customerText }),
  });
  const msgJson = await msgRes.json();
  if (!msgJson.success && msgRes.status >= 400) {
    throw new Error(`POST /widget/message failed: ${JSON.stringify(msgJson.error)}`);
  }
  console.log('customer message accepted status=', msgRes.status);

  const deadline = Date.now() + TIMEOUT_MS;
  let botViaSocket = null;
  let botViaHistory = null;

  while (Date.now() < deadline) {
    botViaSocket = inbound.find((m) => isBotInbound(m) && m.content !== customerText);
    if (botViaSocket) break;

    const history = await fetchHistory(token);
    botViaHistory = historyBotAfterCustomer(history, customerText);
    if (botViaHistory) break;

    await sleep(2000);
  }

  socket.close();

  if (!botViaSocket && !botViaHistory) {
    console.error('FAIL: no bot/agent reply within timeout');
    process.exit(1);
  }

  const via = botViaSocket ? 'socket message:receive' : 'GET /widget/history';
  const preview = (botViaSocket?.content || botViaHistory?.content || '').slice(0, 160);
  console.log('PASS: bot reply via', via);
  console.log('reply:', preview);
  console.log('NOTE: session', session.id, 'left open — no cleanup performed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
