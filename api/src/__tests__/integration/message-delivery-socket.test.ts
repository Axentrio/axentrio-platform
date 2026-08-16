/**
 * Real-socket per-message delivery state (#128).
 *
 * When an operator reply fails to reach an external channel, the composer's
 * FAILED/retry affordance must light up — which means a `message:created` event
 * carrying `status:'failed'` has to actually arrive on the operator's socket, and
 * a successful retry has to arrive as `status:'sent'`. The unit tests mock the
 * emit, so they cannot see the event traverse the socket. This boots the real
 * `initializeSocketIO`, connects a real operator client, drives the delivery path
 * with a mock-failing channel, and asserts the events land over the wire.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'http';
import { randomUUID } from 'crypto';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

const tokenMap = vi.hoisted(() => ({}) as Record<string, { sub: string }>);
vi.mock('@clerk/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clerk/backend')>()),
  verifyToken: (token: string) => Promise.resolve(tokenMap[token] ?? { sub: 'unknown' }),
}));

// The channel send is the thing we make fail; everything downstream is real.
const mockRoute = vi.hoisted(() => vi.fn());
vi.mock('../../channels/outbound-router', () => ({
  routeOutboundMessage: (...a: unknown[]) => mockRoute(...a),
  routeTypingIndicator: vi.fn().mockResolvedValue(undefined),
  sendChannelTypingIndicator: vi.fn().mockResolvedValue(undefined),
}));

import { initializeSocketIO } from '../../websocket/socket.handler';
import { deliverOperatorReply, claimFailedForRetry } from '../../channels/delivery-state';
import { AppDataSource } from '../../database/data-source';
import { Message } from '../../database/entities/Message';
import {
  createTestTenant,
  createTestUser,
  createTestAgent,
  createTestSession,
  createTestParticipant,
  createTestMessage,
} from '../helpers/factories';

let httpServer: HttpServer;
let port: number;

beforeAll(async () => {
  httpServer = createServer();
  initializeSocketIO(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

async function connectOperator(token: string): Promise<ClientSocket> {
  const client = ioClient(`http://localhost:${port}`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 4000);
    client.on('connection:ack', () => {
      clearTimeout(t);
      resolve();
    });
    client.on('connect_error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
  return client;
}

/** First `message:created` payload for a message id, or null after the timeout. */
function waitForMessageStatus(client: ClientSocket, messageId: string, ms = 1500): Promise<string | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    const handler = (payload: { message?: { id?: string; status?: string } }) => {
      if (payload?.message?.id === messageId) {
        clearTimeout(t);
        client.off('message:created', handler);
        resolve(payload.message.status ?? null);
      }
    };
    client.on('message:created', handler);
  });
}

describe('operator reply delivery state over a real socket (#128)', () => {
  it('emits message:created status=failed on a channel failure, then status=sent on retry', async () => {
    const tenant = await createTestTenant({ name: 'Delivery Co' });
    const user = await createTestUser(tenant.id, { clerkUserId: `clerk-del-${randomUUID()}` });
    await createTestAgent(tenant.id, user.id);
    const session = await createTestSession(tenant.id, { channel: 'telegram', channelConnectionId: randomUUID() });
    const participant = await createTestParticipant(session.id, { type: 'agent', name: 'Operator' });
    const clientMessageId = `cmid-${randomUUID()}`;
    const message = await createTestMessage(session.id, tenant.id, participant.id, {
      content: 'Operator reply',
      status: 'sent',
      metadata: { clientMessageId } as unknown as Message['metadata'],
    });
    tokenMap['tok-op'] = { sub: user.clerkUserId! };

    const reply = {
      sessionId: session.id,
      tenantId: tenant.id,
      messageId: message.id,
      clientMessageId,
      content: 'Operator reply',
      createdAt: message.createdAt.toISOString(),
    };
    const messageRepo = AppDataSource.getRepository(Message);
    const client = await connectOperator('tok-op');

    try {
      // 1) Channel rejects the send -> failed event on the operator's socket + failed row.
      mockRoute.mockResolvedValueOnce({ success: false, error: 'token expired' });
      const failedStatus = waitForMessageStatus(client, message.id);
      await deliverOperatorReply(reply);
      expect(await failedStatus).toBe('failed');
      expect((await messageRepo.findOneByOrFail({ id: message.id })).status).toBe('failed');

      // 2) Retry: claim the failed message, channel now accepts -> sent event + sent row.
      expect(await claimFailedForRetry(message.id)).toBe(true);
      mockRoute.mockResolvedValueOnce({ success: true });
      const sentStatus = waitForMessageStatus(client, message.id);
      await deliverOperatorReply(reply);
      expect(await sentStatus).toBe('sent');
      expect((await messageRepo.findOneByOrFail({ id: message.id })).status).toBe('sent');
    } finally {
      client.disconnect();
    }
  });
});
