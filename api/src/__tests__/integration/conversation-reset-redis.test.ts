/**
 * Superadmin reset must drop session-keyed Redis tool state, not only Postgres.
 *
 * A Map fake of `del` cannot prove `booking:confirm`, `booking:offered`, or
 * `gr:loop` are gone: the coordination lives in ioredis against a real server.
 * This file fails loudly when test-redis is missing instead of skipping.
 *
 * Requires the `test-redis` service from `docker-compose.test.yml`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Redis from 'ioredis';

let client: Redis;
vi.mock('../../config/redis', () => ({
  getRedisClient: () => client,
  isRedisAvailable: () => true,
  initializeRedis: async () => undefined,
}));

vi.mock('../../booking/booking-providers/calendar-sync', () => ({
  syncCalendarCancel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../booking/booking-providers/reminders', () => ({
  cancelReminders: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));
vi.mock('../../llm/localize', () => ({
  localizeMessage: vi.fn((message: string) => Promise.resolve(message)),
}));
vi.mock('../../channels/outbound-router', () => ({
  routeOutboundMessage: vi.fn().mockResolvedValue({ success: true }),
  routeTypingIndicator: vi.fn().mockResolvedValue(undefined),
  sendChannelTypingIndicator: vi.fn().mockResolvedValue(undefined),
}));

import {
  createTestTenant,
  createTestAnchorBot,
  createTestUser,
  createTestAgent,
  createTestSession,
} from '../helpers/factories';
import { conversationCommands } from '../../services/conversation-command.service';
import { peekPendingBooking, putPendingBooking } from '../../agent/pending-booking-confirmation';
import { peekOfferedSlots, rememberOfferedSlots } from '../../agent/offered-slots-store';
import { rememberRefusedNamedTime } from '../../agent/refused-named-time';
import { redisLoopStore } from '../../guardrails/loop-store';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';
const VISITOR = '32475126011';
const SLOT_START = '2026-10-26T10:00:00';
const TOOL_KEY_PREFIXES = ['booking:confirm:', 'booking:offered:', 'booking:refused-date:', 'gr:loop:'] as const;

async function resetActor(tenantId: string) {
  const user = await createTestUser(tenantId, { role: 'super_admin' });
  return createTestAgent(tenantId, user.id);
}

beforeAll(async () => {
  client = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
  try {
    await client.connect();
    await client.ping();
  } catch (err) {
    throw new Error(
      `Superadmin reset Redis proof needs real Redis. Start it with ` +
        `\`docker compose -f api/docker-compose.test.yml up -d test-redis\`. Tried ${REDIS_URL}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

afterAll(async () => {
  await client?.quit();
});

describe('Superadmin reset Redis scratch', () => {
  it('drops booking:confirm, booking:offered, and gr:loop for the closed session', async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant);
    const session = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId: VISITOR,
      channel: 'whatsapp',
      source: 'whatsapp',
      status: 'bot',
    });

    const written = await putPendingBooking(session.id, {
      startTime: SLOT_START,
      attendeeName: 'Tom Test',
      serviceId: 'svc-korting',
      runId: 'run-redis-1',
    });
    expect(written).toBe(true);
    await rememberOfferedSlots(session.id, ['2026-10-26T08:00:00.000Z'], 'Europe/Brussels');
    await rememberRefusedNamedTime(session.id, '2026-11-02', '10:00');
    await redisLoopStore.advance(session.id, {
      hash: 'slot-26-oct',
      meaningful: true,
      humanSignal: false,
      hasSuspiciousLink: false,
    });

    expect(await peekPendingBooking(session.id)).toMatchObject({ startTime: SLOT_START });
    expect(await peekOfferedSlots(session.id)).toEqual(['2026-10-26T08:00:00.000Z']);
    expect(await redisLoopStore.peek(session.id)).toMatchObject({ repeated: 1 });
    expect(await client.exists(`booking:confirm:${session.id}`)).toBe(1);
    expect(await client.exists(`booking:offered:${session.id}`)).toBe(1);
    expect(await client.exists(`booking:refused-date:${session.id}`)).toBe(1);
    expect(await client.exists(`gr:loop:${session.id}`)).toBe(1);

    const agent = await resetActor(tenant.id);
    const reset = await conversationCommands.resetConversation(
      session.id,
      { kind: 'agent', agentId: agent.id },
      undefined,
      { tenantId: tenant.id },
    );
    expect(reset.outcome).toBe('reset');
    expect(reset.scratchCleared).toBe(true);

    for (const prefix of TOOL_KEY_PREFIXES) {
      expect(await client.exists(`${prefix}${session.id}`)).toBe(0);
    }
    expect(await peekPendingBooking(session.id)).toBeNull();
    expect(await peekOfferedSlots(session.id)).toBeNull();
    expect(await redisLoopStore.peek(session.id)).toMatchObject({
      repeated: 0,
      botLike: 0,
      suspiciousLinkTurns: 0,
    });
  });

  it('retries a transient Redis DEL and still drops the three keys', async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant);
    const session = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId: VISITOR,
      channel: 'whatsapp',
      source: 'whatsapp',
      status: 'bot',
    });

    await client.set(`booking:confirm:${session.id}`, JSON.stringify({ startTime: SLOT_START }));
    await client.set(
      `booking:offered:${session.id}`,
      JSON.stringify({ starts: [SLOT_START], timezone: 'Europe/Brussels' }),
    );
    await client.hset(`gr:loop:${session.id}`, 'repeated', '3', 'botLike', '2', 'lastHash', 'abc');

    const realDel = client.del.bind(client);
    let failuresLeft = 2;
    client.del = (async (...args: unknown[]) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('ECONNRESET');
      }
      return realDel(...(args as Parameters<typeof realDel>));
    }) as typeof client.del;

    try {
      const agent = await resetActor(tenant.id);
      const reset = await conversationCommands.resetConversation(
        session.id,
        { kind: 'agent', agentId: agent.id },
        undefined,
        { tenantId: tenant.id },
      );
      expect(reset.scratchCleared).toBe(true);
      expect(failuresLeft).toBe(0);
      for (const prefix of TOOL_KEY_PREFIXES) {
        expect(await client.exists(`${prefix}${session.id}`)).toBe(0);
      }
    } finally {
      client.del = realDel;
    }
  });
});
