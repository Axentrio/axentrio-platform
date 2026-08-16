/**
 * Real-socket delivery for operator notifications (#129).
 *
 * The unit/integration suites mock the socket emit, so they cannot see WHICH
 * room a toast lands in. This boots the real `initializeSocketIO` on a throwaway
 * http server, connects real socket.io clients as operators, and proves the toast
 * actually reaches the recipient over the wire.
 *
 * It is the regression guard for the id-space bug this file was written to catch:
 * an operator socket's `data.user.id` is the Agent.id, but notifications are keyed
 * by User.id. Emitting to `agent:<userId>` (the old code) reached an empty room, so
 * NO operator got the desktop toast. The fix joins a `user:<userId>` room and emits
 * there via `emitToUser`. This test fails against the old code and passes against
 * the fix.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'http';
import { randomUUID } from 'crypto';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

// Socket handshake auth verifies a Clerk token; map fake tokens to seeded users.
const tokenMap = vi.hoisted(() => ({}) as Record<string, { sub: string }>);
vi.mock('@clerk/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clerk/backend')>()),
  verifyToken: (token: string) => Promise.resolve(tokenMap[token] ?? { sub: 'unknown' }),
}));

// Keep createForUsers' push enqueue off a real queue.
vi.mock('../../queue/message-queue', () => ({
  addNotificationJob: vi.fn().mockResolvedValue(undefined),
}));

import { initializeSocketIO, emitToUser, emitToAgent } from '../../websocket/socket.handler';
import { notificationService } from '../../services/notification.service';
import { createTestTenant, createTestUser, createTestAgent } from '../helpers/factories';

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

/** Connect a client and resolve once the server has finished joining its rooms. */
async function connectOperator(token: string): Promise<ClientSocket> {
  const client = ioClient(`http://localhost:${port}`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`connect timeout for ${token}`)), 4000);
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

/** Resolve with the first event payload, or null after the timeout. */
function waitForEvent(client: ClientSocket, event: string, ms = 1500): Promise<unknown> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    client.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

describe('operator notification socket delivery (#129)', () => {
  it('delivers a per-recipient toast to that operator over a real socket, and to no one else', async () => {
    const tenant = await createTestTenant({ name: 'Socket Co' });
    const user1 = await createTestUser(tenant.id, { clerkUserId: `clerk-sock-${randomUUID()}` });
    const user2 = await createTestUser(tenant.id, { clerkUserId: `clerk-sock-${randomUUID()}` });
    const agent1 = await createTestAgent(tenant.id, user1.id);
    await createTestAgent(tenant.id, user2.id);
    tokenMap['tok-1'] = { sub: user1.clerkUserId! };
    tokenMap['tok-2'] = { sub: user2.clerkUserId! };

    const client1 = await connectOperator('tok-1');
    const client2 = await connectOperator('tok-2');
    try {
      // Realistic path: a notification addressed to user1 only.
      const got1 = waitForEvent(client1, 'notification');
      const got2 = waitForEvent(client2, 'notification');
      await notificationService.createForRecipients({
        tenantId: tenant.id,
        type: 'handoff_requested',
        title: 'New handoff request',
        message: 'A visitor needs help',
        data: { sessionId: 's1' },
        dedupeBase: `handoff:${randomUUID()}`,
        recipientUserIds: [user1.id],
      });

      // The recipient's socket receives it (proves emitToUser -> user room -> socket);
      // the other operator does not (per-recipient, not a tenant broadcast).
      expect(await got1).toMatchObject({ type: 'handoff_requested', title: 'New handoff request' });
      expect(await got2).toBeNull();

      // Pin the bug's mechanism: the same operator's User.id room receives, but the
      // Agent.id placed in the user room reaches no one (that mismatch was the bug).
      const byUserId = waitForEvent(client1, 'probe-user', 800);
      const byAgentId = waitForEvent(client1, 'probe-agent', 800);
      emitToUser(user1.id, 'probe-user', { ok: true });
      emitToUser(agent1.id, 'probe-agent', { ok: true }); // Agent.id in a user room = empty
      expect(await byUserId).toMatchObject({ ok: true });
      expect(await byAgentId).toBeNull();

      // And the agent room still works for its own id (sanity for emitToAgent).
      const byAgentRoom = waitForEvent(client1, 'probe-agentroom', 800);
      emitToAgent(agent1.id, 'probe-agentroom', { ok: true });
      expect(await byAgentRoom).toMatchObject({ ok: true });
    } finally {
      client1.disconnect();
      client2.disconnect();
    }
  });
});
