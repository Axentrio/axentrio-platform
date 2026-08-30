/**
 * Customer memory against the real DB: facts survive session close, person_key
 * merge, compare-and-swap, the per-bot toggle, default-on, and retention.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const extract = vi.hoisted(() => ({
  impl: async (): Promise<{
    facts: Array<{
      factKey: 'address';
      value: string;
      confidence: number;
      evidenceMessageId: string;
      span: string;
    }>;
    abstained: boolean;
    model: string;
    promptVersion: string;
    extractionVersion: number;
  }> => ({
    facts: [],
    abstained: true,
    model: 'gpt-4.1-mini',
    promptVersion: 'customer-memory-v1',
    extractionVersion: 1,
  }),
}));

vi.mock('../../config/redis', () => ({
  getRedisClient: () => ({
    del: async () => 0,
    get: async () => null,
    set: async () => 'OK',
  }),
  initializeRedis: async () => undefined,
  isRedisAvailable: () => true,
}));

vi.mock('../../memory/fact-extractor.service', () => ({
  extractMemoryFacts: () => extract.impl(),
  MEMORY_EXTRACTION_VERSION: 1,
  MEMORY_PROMPT_VERSION: 'customer-memory-v1',
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
import { CustomerMemory } from '../../database/entities/CustomerMemory';
import { CustomerMemoryFact } from '../../database/entities/CustomerMemoryFact';
import { CustomerMemoryRun } from '../../database/entities/CustomerMemoryRun';
import { extractOne } from '../../memory/memory-sweep.job';
import { loadLiveFacts, renderMemoryForPrompt, upsertMemorySubject } from '../../memory/memory-store';
import { sweepCustomerMemory } from '../../memory/memory-retention.service';
import { computePersonKey } from '../../leads/person-key';
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
import { computeSubjectKey } from '../../memory/subject-key';

const ADDRESS = 'Kerkstraat 12, 2000 Antwerpen';
const PHONE = '+32475123456';

async function addressResult(evidenceMessageId: string) {
  return {
    facts: [
      {
        factKey: 'address' as const,
        value: ADDRESS,
        confidence: 90,
        evidenceMessageId,
        span: ADDRESS,
      },
    ],
    abstained: false,
    model: 'gpt-4.1-mini',
    promptVersion: 'customer-memory-v1',
    extractionVersion: 1,
  };
}

async function claimedRun(tenantId: string, sessionId: string): Promise<{ id: string }> {
  const repo = AppDataSource.getRepository(CustomerMemoryRun);
  return repo.save(
    repo.create({
      tenantId,
      sessionId,
      state: 'claimed',
      attempts: 0,
    }),
  );
}

beforeEach(() => {
  extract.impl = async () => ({
    facts: [],
    abstained: true,
    model: 'gpt-4.1-mini',
    promptVersion: 'customer-memory-v1',
    extractionVersion: 1,
  });
});

describe('customer memory', () => {
  it('injects facts from a closed session into a new session with the same visitor', async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant);
    const visitorId = 'widget-memory-1';
    const first = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId,
      channel: 'widget',
      status: 'closed',
    });
    const participant = await createTestParticipant(first.id, { type: 'user' });
    const msg = await createTestMessage(first.id, tenant.id, participant.id, {
      content: `My address is ${ADDRESS}`,
    });
    extract.impl = () => addressResult(msg.id);
    const run = await claimedRun(tenant.id, first.id);
    await extractOne({ id: run.id, tenant_id: tenant.id, session_id: first.id, attempts: 0 });

    const second = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId,
      channel: 'widget',
      status: 'active',
    });
    const block = await renderMemoryForPrompt(second);
    expect(block).toContain('CUSTOMER_MEMORY');
    expect(block).toContain(ADDRESS);
  });

  it('returns another subject\'s fact when person_key matches', async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant);
    const visitorId = 'widget-memory-2';
    const widget = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId,
      channel: 'widget',
    });
    const participant = await createTestParticipant(widget.id, { type: 'user' });
    const msg = await createTestMessage(widget.id, tenant.id, participant.id, {
      content: `My address is ${ADDRESS}`,
    });
    const leadRepo = AppDataSource.getRepository(Lead);
    await leadRepo.save(
      leadRepo.create({
        tenantId: tenant.id,
        phone: PHONE,
        sessionId: widget.id,
        source: 'tool',
        channel: 'widget',
      }),
    );
    extract.impl = () => addressResult(msg.id);
    const run = await claimedRun(tenant.id, widget.id);
    await extractOne({ id: run.id, tenant_id: tenant.id, session_id: widget.id, attempts: 0 });

    const personKey = computePersonKey({ phone: PHONE });
    expect(personKey).toBeTruthy();
    const [memoryA] = await AppDataSource.query(
      `SELECT id, person_key FROM chatbot_customer_memory WHERE tenant_id = $1`,
      [tenant.id],
    );
    expect(memoryA.person_key).toBe(personKey);

    const subjectB = `whatsapp:${PHONE.replace('+', '')}`;
    const upserted = await upsertMemorySubject({
      tenantId: tenant.id,
      subjectKey: subjectB,
      channel: 'whatsapp',
    });
    await AppDataSource.query(
      `UPDATE chatbot_customer_memory SET person_key = $1 WHERE id = $2`,
      [personKey, upserted.id],
    );

    const facts = await loadLiveFacts(tenant.id, subjectB);
    expect(facts.some((f) => f.factKey === 'address' && f.value === ADDRESS)).toBe(true);
  });

  it('refuses the write when the transcript moves mid-extraction', async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant);
    const session = await createTestSession(tenant.id, { botId: bot.id, channel: 'widget' });
    const participant = await createTestParticipant(session.id, { type: 'user' });
    const msg = await createTestMessage(session.id, tenant.id, participant.id, {
      content: `My address is ${ADDRESS}`,
    });
    extract.impl = async () => {
      await createTestMessage(session.id, tenant.id, participant.id, {
        content: 'Wait, I also need the bathroom boiler checked.',
      });
      return addressResult(msg.id);
    };
    const run = await claimedRun(tenant.id, session.id);
    await extractOne({ id: run.id, tenant_id: tenant.id, session_id: session.id, attempts: 0 });

    const facts = await AppDataSource.getRepository(CustomerMemoryFact).count({
      where: { tenantId: tenant.id },
    });
    expect(facts).toBe(0);
    const after = await AppDataSource.getRepository(CustomerMemoryRun).findOneByOrFail({ id: run.id });
    expect(after.state).toBe('failed');
    expect(after.attempts).toBe(1);
  });

  it('writes nothing when the per-bot toggle is off', async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant, {
      settings: {
        features: { fileUploadEnabled: true, handoffEnabled: true, customerMemoryEnabled: false },
      },
    });
    const session = await createTestSession(tenant.id, { botId: bot.id, channel: 'widget' });
    const participant = await createTestParticipant(session.id, { type: 'user' });
    const msg = await createTestMessage(session.id, tenant.id, participant.id, {
      content: `My address is ${ADDRESS}`,
    });
    extract.impl = () => addressResult(msg.id);
    const run = await claimedRun(tenant.id, session.id);
    await extractOne({ id: run.id, tenant_id: tenant.id, session_id: session.id, attempts: 0 });

    const after = await AppDataSource.getRepository(CustomerMemoryRun).findOneByOrFail({ id: run.id });
    expect(after.state).toBe('skipped_disabled');
    const facts = await AppDataSource.getRepository(CustomerMemoryFact).count({
      where: { tenantId: tenant.id },
    });
    expect(facts).toBe(0);
  });

  it('still injects when features has only fileUploadEnabled and handoffEnabled', async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant, {
      settings: {
        features: { fileUploadEnabled: true, handoffEnabled: true },
      },
    });
    const visitorId = 'widget-memory-default-on';
    const first = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId,
      channel: 'widget',
      status: 'closed',
    });
    const participant = await createTestParticipant(first.id, { type: 'user' });
    const msg = await createTestMessage(first.id, tenant.id, participant.id, {
      content: `My address is ${ADDRESS}`,
    });
    extract.impl = () => addressResult(msg.id);
    const run = await claimedRun(tenant.id, first.id);
    await extractOne({ id: run.id, tenant_id: tenant.id, session_id: first.id, attempts: 0 });

    const second = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId,
      channel: 'widget',
    });
    const block = await renderMemoryForPrompt(second);
    expect(block).toContain('CUSTOMER_MEMORY');
    expect(block).toContain(ADDRESS);
  });

  it('deletes subjects whose lastSeenAt is older than 365 days', async () => {
    const tenant = await createTestTenant();
    const oldSubject = await upsertMemorySubject({
      tenantId: tenant.id,
      subjectKey: 'widget:old:visitor',
      channel: 'widget',
    });
    const youngSubject = await upsertMemorySubject({
      tenantId: tenant.id,
      subjectKey: 'widget:young:visitor',
      channel: 'widget',
    });
    await AppDataSource.query(
      `INSERT INTO chatbot_customer_facts
         (tenant_id, memory_id, fact_key, value_enc, confidence, model, prompt_version, extraction_version)
       VALUES ($1, $2, 'address', 'plain', 90, 'gpt-4.1-mini', 'customer-memory-v1', 1)`,
      [tenant.id, oldSubject.id],
    );
    await AppDataSource.query(
      `UPDATE chatbot_customer_memory SET last_seen_at = now() - interval '400 days' WHERE id = $1`,
      [oldSubject.id],
    );
    await AppDataSource.query(
      `UPDATE chatbot_customer_memory SET last_seen_at = now() - interval '300 days' WHERE id = $1`,
      [youngSubject.id],
    );

    const { deleted } = await sweepCustomerMemory();
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await AppDataSource.getRepository(CustomerMemory).findOneBy({ id: oldSubject.id })).toBeNull();
    expect(await AppDataSource.getRepository(CustomerMemoryFact).count({ where: { memoryId: oldSubject.id } })).toBe(0);
    expect(await AppDataSource.getRepository(CustomerMemory).findOneBy({ id: youngSubject.id })).not.toBeNull();
  });

  it('super-admin reset clears facts so a new session has an empty memory prompt', async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant);
    const visitorId = '32475111999';
    const first = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId,
      channel: 'whatsapp',
      source: 'whatsapp',
      status: 'bot',
    });
    const participant = await createTestParticipant(first.id, { type: 'user' });
    const msg = await createTestMessage(first.id, tenant.id, participant.id, {
      content: `My address is ${ADDRESS}`,
    });
    extract.impl = () => addressResult(msg.id);
    const run = await claimedRun(tenant.id, first.id);
    await extractOne({ id: run.id, tenant_id: tenant.id, session_id: first.id, attempts: 0 });

    const user = await createTestUser(tenant.id, { role: 'super_admin' });
    const agent = await createTestAgent(tenant.id, user.id);
    const reset = await conversationCommands.resetConversation(
      first.id,
      { kind: 'agent', agentId: agent.id },
      undefined,
      { tenantId: tenant.id },
    );
    expect(reset.outcome).toBe('reset');

    const second = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId,
      channel: 'whatsapp',
      source: 'whatsapp',
      status: 'bot',
    });
    const block = await renderMemoryForPrompt(second);
    expect(block).toBe('');
    const subjectKey = computeSubjectKey(second);
    expect(subjectKey).toBe('whatsapp:32475111999');
    expect(await loadLiveFacts(tenant.id, subjectKey!)).toEqual([]);
  });

  it('does not rewrite facts when extraction finishes after a reset', async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant);
    const visitorId = '32475111888';
    const session = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId,
      channel: 'whatsapp',
      source: 'whatsapp',
      status: 'bot',
    });
    const participant = await createTestParticipant(session.id, { type: 'user' });
    const msg = await createTestMessage(session.id, tenant.id, participant.id, {
      content: `My address is ${ADDRESS}`,
    });
    const run = await claimedRun(tenant.id, session.id);

    const user = await createTestUser(tenant.id, { role: 'super_admin' });
    const agent = await createTestAgent(tenant.id, user.id);
    await conversationCommands.resetConversation(
      session.id,
      { kind: 'agent', agentId: agent.id },
      undefined,
      { tenantId: tenant.id },
    );

    extract.impl = () => addressResult(msg.id);
    await extractOne({ id: run.id, tenant_id: tenant.id, session_id: session.id, attempts: 0 });

    const after = await AppDataSource.getRepository(CustomerMemoryRun).findOneByOrFail({ id: run.id });
    expect(after.state).toBe('skipped_reset');
    const live = await AppDataSource.query(
      `SELECT count(*)::int AS n FROM chatbot_customer_facts
        WHERE tenant_id = $1 AND superseded_at IS NULL`,
      [tenant.id],
    );
    expect(Number(live[0].n)).toBe(0);
  });

});
