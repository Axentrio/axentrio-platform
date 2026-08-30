/**
 * Superadmin reset must wipe conversation-scoped stores that leak into the
 * next inbound from the same visitor. Close is not enough: customer memory,
 * pending confirmation, offered slots, address bindings, and lead extraction
 * all survive a new ChatSession id. Confirmed calendar bookings stay.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const redisData = new Map<string, string>();

const redisDel = vi.hoisted(() => ({
  impl: async (_keys: string[]): Promise<number> => 0,
}));

const redisClient = vi.hoisted(() => ({
  live: true,
}));

vi.mock('../../config/redis', () => ({
  getRedisClient: () => {
    if (!redisClient.live) return null;
    return {
      get: async (key: string) => redisData.get(key) ?? null,
      set: async (key: string, value: string) => {
        redisData.set(key, value);
        return 'OK';
      },
      del: async (...keys: string[]) => redisDel.impl(keys),
    };
  },
  initializeRedis: async () => undefined,
  isRedisAvailable: () => redisClient.live,
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

import { AppDataSource } from '../../database/data-source';
import { Lead } from '../../database/entities/Lead';
import { LeadConversation } from '../../database/entities/LeadConversation';
import {
  createTestTenant,
  createTestAnchorBot,
  createTestUser,
  createTestAgent,
  createTestSession,
  createTestParticipant,
  createTestMessage,
} from '../helpers/factories';
import { conversationCommands } from '../../services/conversation-command.service';
import {
  sessionScratchKeys,
} from '../../services/conversation-reset-state';
import {
  loadLiveFacts,
  renderMemoryForPrompt,
  upsertMemorySubject,
  writeMemoryFact,
} from '../../memory/memory-store';
import { computeSubjectKey } from '../../memory/subject-key';
import { peekPendingBooking, putPendingBooking } from '../../agent/pending-booking-confirmation';
import { peekOfferedSlots, rememberOfferedSlots } from '../../agent/offered-slots-store';
import { bindAddress, getBoundAddress } from '../../booking/travel/address-binding';

const VISITOR = '32475126010';
const SLOT_TEXT = 'Monday 26 October 2026 at 10:00';
const SLOT_START = '2026-10-26T10:00:00';
const SLOT_UTC = new Date('2026-10-26T08:00:00.000Z');
const ADDRESS = 'Kerkstraat 12, 2000 Antwerpen';
const ATTENDEE_EMAIL = 'tom.reset@example.com';
const INTAKE = { q1: 'leaking roof' };

async function resetActor(tenantId: string) {
  const user = await createTestUser(tenantId, { role: 'super_admin' });
  const agent = await createTestAgent(tenantId, user.id);
  return agent;
}

async function seedMemory(session: {
  id: string;
  tenantId: string;
  botId: string;
  channel: string | null;
  visitorId: string | null;
}) {
  const subjectKey = computeSubjectKey(session);
  if (!subjectKey) throw new Error('expected a WhatsApp subject key');
  const memory = await upsertMemorySubject({
    tenantId: session.tenantId,
    subjectKey,
    channel: session.channel,
  });
  const facts: Array<{ factKey: 'preferred_contact_time' | 'service_interest' | 'open_request' | 'past_booking_summary'; value: string }> = [
    { factKey: 'preferred_contact_time', value: SLOT_TEXT },
    { factKey: 'service_interest', value: 'Korting booking test' },
    { factKey: 'open_request', value: `Ik wil boeken ${SLOT_TEXT}` },
    { factKey: 'past_booking_summary', value: `Booked for ${SLOT_TEXT}` },
  ];
  for (const fact of facts) {
    await writeMemoryFact(AppDataSource, {
      tenantId: session.tenantId,
      memoryId: memory.id,
      factKey: fact.factKey,
      value: fact.value,
      confidence: 90,
      evidenceMessageId: null,
      evidenceSpan: fact.value,
      sourceSessionId: session.id,
      model: 'test',
      promptVersion: 'test',
      extractionVersion: 1,
    });
  }
  return subjectKey;
}

async function seedBooking(input: {
  tenantId: string;
  botId: string;
  sessionId: string;
  status: 'confirmed' | 'request_created';
  reminderJobIds?: string[];
}): Promise<string> {
  const id = randomUUID();
  const end = new Date(SLOT_UTC.getTime() + 3_600_000);
  await AppDataSource.query(
    `INSERT INTO chatbot_bookings
       (id, tenant_id, bot_id, provider, status, start_utc, end_utc, calendar_key,
        blocked_range, ics_uid, attendee_name, attendee_email, customer_phone,
        session_id, intake_answers, ai_summary, reminder_job_ids, created_at, updated_at)
     VALUES ($1,$2,$3,'internal',$4,$5,$6,$7, tstzrange($5,$6,'[)'),$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb, now(), now())`,
    [
      id,
      input.tenantId,
      input.botId,
      input.status,
      SLOT_UTC,
      end,
      `reset-test:${id}`,
      `uid-${id}`,
      'Tom Test',
      ATTENDEE_EMAIL,
      VISITOR,
      input.sessionId,
      JSON.stringify(INTAKE),
      `Customer wants ${SLOT_TEXT}`,
      JSON.stringify(input.reminderJobIds ?? []),
    ],
  );
  return id;
}

beforeEach(() => {
  redisData.clear();
  redisClient.live = true;
  redisDel.impl = async (keys: string[]) => {
    let n = 0;
    for (const key of keys) {
      if (redisData.delete(key)) n += 1;
    }
    return n;
  };
});

describe('Superadmin conversation reset', () => {
  it('wipes every store so the next Ik wil boeken turn cannot reuse the previous booking', async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant);
    const first = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId: VISITOR,
      channel: 'whatsapp',
      source: 'whatsapp',
      status: 'bot',
    });
    const participant = await createTestParticipant(first.id, { type: 'user' });
    const inbound = await createTestMessage(first.id, tenant.id, participant.id, {
      content: `Ik wil boeken ${SLOT_TEXT}`,
    });
    await AppDataSource.query(
      `UPDATE chat_sessions
          SET last_coalesced_answer_message_id = $2,
              last_coalesced_answer_at = now(),
              message_count = 3,
              unread_count = 1
        WHERE id = $1`,
      [first.id, inbound.id],
    );

    const older = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId: VISITOR,
      channel: 'whatsapp',
      source: 'whatsapp',
      status: 'closed',
    });
    const olderParticipant = await createTestParticipant(older.id, { type: 'user' });
    await createTestMessage(older.id, tenant.id, olderParticipant.id, {
      content: `Earlier booking ${SLOT_TEXT}`,
    });

    const widget = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId: VISITOR,
      channel: 'widget',
      source: 'widget',
      status: 'closed',
    });
    const widgetParticipant = await createTestParticipant(widget.id, { type: 'user' });
    const widgetMessage = await createTestMessage(widget.id, tenant.id, widgetParticipant.id, {
      content: `Widget booking ${SLOT_TEXT}`,
    });

    const messenger = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId: VISITOR,
      channel: 'messenger',
      source: 'messenger',
      status: 'closed',
    });
    const messengerParticipant = await createTestParticipant(messenger.id, { type: 'user' });
    const messengerMessage = await createTestMessage(messenger.id, tenant.id, messengerParticipant.id, {
      content: `Messenger booking ${SLOT_TEXT}`,
    });

    const subjectKey = await seedMemory(first);
    expect(await renderMemoryForPrompt(first)).toContain(SLOT_TEXT);

    await putPendingBooking(first.id, {
      startTime: SLOT_START,
      attendeeName: 'Tom Test',
      serviceId: 'svc-korting',
      runId: 'run-1',
    });
    await rememberOfferedSlots(first.id, ['2026-10-26T08:00:00.000Z'], 'Europe/Brussels');
    redisData.set(`gr:loop:${first.id}`, '1');
    redisData.set(`turn:state:${first.id}`, '1');
    redisData.set(`agent:lock:${first.id}`, 'token');

    await bindAddress(first.id, { formattedAddress: ADDRESS, placeId: 'ChIJ_reset_test' });
    expect(await getBoundAddress(first.id)).toEqual({
      formattedAddress: ADDRESS,
      placeId: 'ChIJ_reset_test',
    });

    const confirmedId = await seedBooking({
      tenantId: tenant.id,
      botId: bot.id,
      sessionId: first.id,
      status: 'confirmed',
      reminderJobIds: ['job-reset-1'],
    });
    const requestId = await seedBooking({
      tenantId: tenant.id,
      botId: bot.id,
      sessionId: first.id,
      status: 'request_created',
    });

    const leadRepo = AppDataSource.getRepository(Lead);
    const lead = await leadRepo.save(
      leadRepo.create({
        tenantId: tenant.id,
        botId: bot.id,
        sessionId: first.id,
        phone: VISITOR,
        externalUserId: VISITOR,
        channel: 'whatsapp',
        dedupeKey: `whatsapp:${VISITOR}`,
        name: 'Tom Test',
        source: 'tool',
      }),
    );
    const convRepo = AppDataSource.getRepository(LeadConversation);
    const conv = await convRepo.save(
      convRepo.create({
        tenantId: tenant.id,
        leadId: lead.id,
        sessionId: first.id,
        botId: bot.id,
        channel: 'whatsapp',
        request: `Ik wil boeken ${SLOT_TEXT}`,
        serviceRequested: 'Korting booking test',
        address: ADDRESS,
        preferredAt: SLOT_UTC,
        preferredAtText: SLOT_TEXT,
        enrichState: 'enriched',
      }),
    );

    await AppDataSource.query(
      `UPDATE chat_sessions
          SET subject = $2,
              metadata = $3::jsonb
        WHERE id = $1`,
      [
        first.id,
        `Booking ${SLOT_TEXT}`,
        JSON.stringify({
          leadAsk: { askedAt: '2026-10-20T10:00:00.000Z' },
          lead: { name: 'Tom Test' },
          leadCallback: { phone: VISITOR },
        }),
      ],
    );

    const agent = await resetActor(tenant.id);
    const reset = await conversationCommands.resetConversation(
      first.id,
      { kind: 'agent', agentId: agent.id },
      undefined,
      { tenantId: tenant.id },
    );
    expect(reset.outcome).toBe('reset');
    expect(reset.scratchCleared).toBe(true);

    const second = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId: VISITOR,
      channel: 'whatsapp',
      source: 'whatsapp',
      status: 'bot',
    });

    const memoryBlock = await renderMemoryForPrompt(second);
    expect(memoryBlock).toBe('');
    expect(memoryBlock).not.toMatch(/26 October|26 oktober|2026-10-26|10:00/i);
    expect(await loadLiveFacts(tenant.id, subjectKey)).toEqual([]);

    const newMessages = await AppDataSource.query(
      `SELECT count(*)::int AS n FROM messages WHERE session_id = $1 AND type <> 'system'`,
      [second.id],
    );
    expect(Number(newMessages[0].n)).toBe(0);

    const selectedLeft = await AppDataSource.query(
      `SELECT count(*)::int AS n FROM messages WHERE session_id = $1`,
      [first.id],
    );
    expect(Number(selectedLeft[0].n)).toBe(0);

    const olderLeft = await AppDataSource.query(
      `SELECT count(*)::int AS n FROM messages WHERE session_id = $1`,
      [older.id],
    );
    expect(Number(olderLeft[0].n)).toBe(0);

    const widgetLeft = await AppDataSource.query(
      `SELECT id FROM messages WHERE session_id = $1`,
      [widget.id],
    );
    expect(widgetLeft).toHaveLength(1);
    expect(widgetLeft[0].id).toBe(widgetMessage.id);

    const messengerLeft = await AppDataSource.query(
      `SELECT id FROM messages WHERE session_id = $1`,
      [messenger.id],
    );
    expect(messengerLeft).toHaveLength(1);
    expect(messengerLeft[0].id).toBe(messengerMessage.id);

    expect(reset.transcriptSessionIds).toEqual(expect.arrayContaining([first.id, older.id]));
    expect(reset.transcriptSessionIds).not.toContain(widget.id);
    expect(reset.transcriptSessionIds).not.toContain(messenger.id);

    const sessionStats = await AppDataSource.query(
      `SELECT message_count, unread_count, last_coalesced_answer_message_id
         FROM chat_sessions WHERE id = $1`,
      [first.id],
    );
    expect(sessionStats[0].message_count).toBe(0);
    expect(sessionStats[0].unread_count).toBe(0);
    expect(sessionStats[0].last_coalesced_answer_message_id).toBeNull();

    expect(await peekPendingBooking(first.id)).toBeNull();
    expect(await peekPendingBooking(second.id)).toBeNull();
    expect(await peekOfferedSlots(first.id)).toBeNull();
    expect(await peekOfferedSlots(second.id)).toBeNull();
    for (const key of sessionScratchKeys(first.id)) {
      expect(redisData.has(key)).toBe(false);
    }

    expect(await getBoundAddress(first.id)).toBeNull();
    expect(await getBoundAddress(second.id)).toBeNull();

    const bookingRows = await AppDataSource.query(
      `SELECT id, status, intake_answers, start_utc
         FROM chatbot_bookings
        WHERE id = ANY($1::uuid[])`,
      [[confirmedId, requestId]],
    );
    const confirmed = bookingRows.find((row: { id: string }) => row.id === confirmedId);
    const requested = bookingRows.find((row: { id: string }) => row.id === requestId);
    expect(confirmed).toMatchObject({
      status: 'confirmed',
      intake_answers: INTAKE,
    });
    expect(new Date(confirmed.start_utc).toISOString()).toBe(SLOT_UTC.toISOString());
    expect(requested).toMatchObject({ status: 'request_created' });

    const afterConv = await convRepo.findOneByOrFail({ id: conv.id });
    expect(afterConv.preferredAt).toBeNull();
    expect(afterConv.preferredAtText).toBeNull();
    expect(afterConv.serviceRequested).toBeNull();
    expect(afterConv.request).toBeNull();
    expect(afterConv.address).toBeNull();

    const afterSession = await AppDataSource.query(
      `SELECT subject, metadata FROM chat_sessions WHERE id = $1`,
      [first.id],
    );
    expect(afterSession[0].subject).toBeNull();
    expect(afterSession[0].metadata).not.toHaveProperty('leadAsk');
    expect(afterSession[0].metadata).not.toHaveProperty('lead');
    expect(afterSession[0].metadata).not.toHaveProperty('leadCallback');
  });

  it('leaves a confirmed booking intact after reset', async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant);
    const session = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId: VISITOR,
      channel: 'whatsapp',
      source: 'whatsapp',
      status: 'bot',
    });
    const confirmedId = await seedBooking({
      tenantId: tenant.id,
      botId: bot.id,
      sessionId: session.id,
      status: 'confirmed',
      reminderJobIds: ['job-keep-1'],
    });

    const agent = await resetActor(tenant.id);
    await conversationCommands.resetConversation(
      session.id,
      { kind: 'agent', agentId: agent.id },
      undefined,
      { tenantId: tenant.id },
    );

    const row = await AppDataSource.query(
      `SELECT status, start_utc, intake_answers, ai_summary,
              reminder_job_ids, attendee_email, customer_phone, session_id
         FROM chatbot_bookings
        WHERE id = $1`,
      [confirmedId],
    );
    expect(row).toHaveLength(1);
    expect(row[0].status).toBe('confirmed');
    expect(new Date(row[0].start_utc).toISOString()).toBe(SLOT_UTC.toISOString());
    expect(row[0].intake_answers).toEqual(INTAKE);
    expect(row[0].ai_summary).toBe(`Customer wants ${SLOT_TEXT}`);
    expect(row[0].attendee_email).toBe(ATTENDEE_EMAIL);
    expect(row[0].customer_phone).toBe(VISITOR);
    expect(row[0].session_id).toBe(session.id);
    expect(row[0].reminder_job_ids).toEqual(['job-keep-1']);
  });

  it('does not let a late memory extract rewrite the preferred time after reset', async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant);
    const session = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId: VISITOR,
      channel: 'whatsapp',
      source: 'whatsapp',
      status: 'bot',
    });
    await seedMemory(session);
    const agent = await resetActor(tenant.id);
    await conversationCommands.resetConversation(
      session.id,
      { kind: 'agent', agentId: agent.id },
      undefined,
      { tenantId: tenant.id },
    );

    const runs = await AppDataSource.query(
      `SELECT state FROM chatbot_customer_memory_runs WHERE session_id = $1`,
      [session.id],
    );
    expect(runs[0].state).toBe('skipped_reset');
  });

  it('returns 503 reset_scratch_incomplete when Redis still holds tool state', async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant);
    const session = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId: VISITOR,
      channel: 'whatsapp',
      source: 'whatsapp',
      status: 'bot',
    });
    redisData.set(`booking:confirm:${session.id}`, JSON.stringify({ startTime: SLOT_START }));
    redisData.set(`booking:offered:${session.id}`, JSON.stringify({ starts: [SLOT_START] }));
    redisData.set(`gr:loop:${session.id}`, '1');

    redisDel.impl = async () => {
      throw new Error('ECONNRESET');
    };

    const agent = await resetActor(tenant.id);
    await expect(
      conversationCommands.resetConversation(
        session.id,
        { kind: 'agent', agentId: agent.id },
        undefined,
        { tenantId: tenant.id },
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'reset_scratch_incomplete',
      details: expect.objectContaining({
        conversation: expect.objectContaining({
          sessionId: session.id,
          ownership: 'closed',
          status: 'closed',
        }),
      }),
    });

    const state = await AppDataSource.query(
      `SELECT ownership, status FROM chat_sessions WHERE id = $1`,
      [session.id],
    );
    expect(state[0]).toMatchObject({ ownership: 'closed', status: 'closed' });
    expect(redisData.has(`booking:confirm:${session.id}`)).toBe(true);
    expect(redisData.has(`booking:offered:${session.id}`)).toBe(true);
    expect(redisData.has(`gr:loop:${session.id}`)).toBe(true);

    redisDel.impl = async (keys: string[]) => {
      let n = 0;
      for (const key of keys) {
        if (redisData.delete(key)) n += 1;
      }
      return n;
    };
    const retried = await conversationCommands.resetConversation(
      session.id,
      { kind: 'agent', agentId: agent.id },
      undefined,
      { tenantId: tenant.id },
    );
    expect(retried.outcome).toBe('reset');
    expect(retried.scratchCleared).toBe(true);
    expect(redisData.has(`booking:confirm:${session.id}`)).toBe(false);
    expect(redisData.has(`booking:offered:${session.id}`)).toBe(false);
    expect(redisData.has(`gr:loop:${session.id}`)).toBe(false);
  });

  it('returns 503 reset_scratch_incomplete when Redis client is missing', async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant);
    const session = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId: VISITOR,
      channel: 'whatsapp',
      source: 'whatsapp',
      status: 'bot',
    });
    redisData.set(`booking:confirm:${session.id}`, JSON.stringify({ startTime: SLOT_START }));
    redisData.set(`booking:offered:${session.id}`, JSON.stringify({ starts: [SLOT_START] }));
    redisData.set(`gr:loop:${session.id}`, '1');

    redisClient.live = false;

    const agent = await resetActor(tenant.id);
    await expect(
      conversationCommands.resetConversation(
        session.id,
        { kind: 'agent', agentId: agent.id },
        undefined,
        { tenantId: tenant.id },
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'reset_scratch_incomplete',
      details: expect.objectContaining({
        conversation: expect.objectContaining({
          sessionId: session.id,
          ownership: 'closed',
          status: 'closed',
        }),
      }),
    });

    const state = await AppDataSource.query(
      `SELECT ownership, status FROM chat_sessions WHERE id = $1`,
      [session.id],
    );
    expect(state[0]).toMatchObject({ ownership: 'closed', status: 'closed' });
    expect(redisData.has(`booking:confirm:${session.id}`)).toBe(true);
    expect(redisData.has(`booking:offered:${session.id}`)).toBe(true);
    expect(redisData.has(`gr:loop:${session.id}`)).toBe(true);

    redisClient.live = true;
    const retried = await conversationCommands.resetConversation(
      session.id,
      { kind: 'agent', agentId: agent.id },
      undefined,
      { tenantId: tenant.id },
    );
    expect(retried.outcome).toBe('reset');
    expect(retried.scratchCleared).toBe(true);
    expect(redisData.has(`booking:confirm:${session.id}`)).toBe(false);
    expect(redisData.has(`booking:offered:${session.id}`)).toBe(false);
    expect(redisData.has(`gr:loop:${session.id}`)).toBe(false);
  });
});
