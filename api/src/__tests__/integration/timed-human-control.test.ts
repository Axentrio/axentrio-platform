/**
 * Timed human control (B-PR5a) - Integration Tests
 *
 * The backend half of capability B3: the /takeover route now exposes
 * mode:'timed' because the expiry worker exists (the codex-locked ordering).
 * Covered here:
 *   - timed takeover via REST: policy persisted, until = started + hours;
 *     invalid hours (0 / 25 / non-integer / missing) → 400 invalid_takeover_hours
 *   - same-owner re-claim with an explicit mode updates the policy in place
 *     ("change duration"); the shipped portal's EMPTY body cannot rewrite it
 *   - expiry worker (sweepExpiredTimedControl): expired timed → bot_owned +
 *     policy cleared + handoff completed + ONE conversation:upsert; indefinite
 *     and unexpired timed untouched; re-entrant (operator released meanwhile);
 *     FOR UPDATE SKIP LOCKED never double-processes
 *   - inbound expiry: a customer message on an EXPIRED timed session releases
 *     to bot BEFORE routing (the AI answers it) on BOTH the legacy path
 *     (forwardMessageToN8n) and the coalesced path (runTurn); an unexpired one
 *     stays human_owned (AI fenced)
 *   - slide: a committed human reply on a timed session moves
 *     human_control_until forward by the full duration; indefinite unchanged
 *
 * Real DB; mocked external boundaries (sockets, outbound router, localization,
 * agent service) - the same seams the conversation-commands suite mocks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../llm/localize', () => ({
  localizeMessage: (message: string) => Promise.resolve(message),
}));

const mockRouteOutboundMessage = vi.fn().mockResolvedValue({ success: true });
vi.mock('../../channels/outbound-router', () => ({
  routeOutboundMessage: (...args: unknown[]) => mockRouteOutboundMessage(...args),
  routeTypingIndicator: vi.fn().mockResolvedValue(undefined),
  sendChannelTypingIndicator: vi.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { Message } from '../../database/entities/Message';
import { HandoffRequest } from '../../database/entities/HandoffRequest';
import { BotSettings } from '../../database/entities/Bot';
import { emitToTenantAgents } from '../../websocket/socket.handler';
import {
  createTestTenant,
  createTestAnchorBot,
  createTestUser,
  createTestAgent,
  createTestSession,
  createTestParticipant,
  createTestMessage,
  createTestHandoffRequest,
} from '../helpers/factories';
import { conversationCommands } from '../../services/conversation-command.service';
import {
  forwardMessageToN8n,
  runTurn,
  initializeAgentService,
} from '../../services/message-forwarding.service';
import { sweepExpiredTimedControl } from '../../services/timed-control-expiry.service';
import type { AgentService } from '../../agent/agent.service';

const sessionRepo = AppDataSource.getRepository(ChatSession);
const messageRepo = AppDataSource.getRepository(Message);
const handoffRepo = AppDataSource.getRepository(HandoffRequest);

const AI = {
  enabled: true,
  provider: 'openai' as const,
  model: 'gpt-4o-mini',
  brandVoice: { name: 'TestBot', tone: 'friendly' as const },
  guardrails: {
    topicsToAvoid: [],
    escalationKeywords: [],
    confidenceThreshold: 0.5,
    maxResponseLength: 500,
    greetingMessage: 'Hi',
    fallbackMessage: 'Connecting you to a human.',
    offHoursMessage: 'Closed.',
  },
};

async function makeTenantWithAi() {
  const tenant = await createTestTenant({ settings: { ai: { apiKey: 'sk-test' } } as never });
  await createTestAnchorBot(tenant, { settings: { ai: AI } as BotSettings });
  return tenant;
}

async function makeOperator(tenantId: string) {
  const user = await createTestUser(tenantId, { role: 'admin' });
  const agent = await createTestAgent(tenantId, user.id);
  return { user, agent };
}

async function stateOf(sessionId: string) {
  const [row] = await AppDataSource.query(
    `SELECT ownership, status, ownership_version, assigned_agent_id,
            human_control_mode, human_control_duration_hours,
            human_control_until, human_control_started_at
       FROM chat_sessions WHERE id = $1`,
    [sessionId],
  );
  return row as {
    ownership: string;
    status: string;
    ownership_version: number;
    assigned_agent_id: string | null;
    human_control_mode: string | null;
    human_control_duration_hours: number | null;
    human_control_until: string | null;
    human_control_started_at: string | null;
  };
}

/** Force the timed deadline into the past/future without moving anything else. */
async function setControlUntil(sessionId: string, until: Date): Promise<void> {
  await AppDataSource.query(
    `UPDATE chat_sessions SET human_control_until = $2 WHERE id = $1`,
    [sessionId, until],
  );
}

/** A claimed TIMED session whose deadline is `msFromNow` away (negative = expired). */
async function makeTimedSession(tenantId: string, agentId: string, msFromNow: number) {
  const session = await createTestSession(tenantId, { status: 'handoff', ownership: 'handoff_requested' });
  const handoff = await createTestHandoffRequest(session.id, tenantId);
  await conversationCommands.claimConversation(session.id, agentId, { mode: 'timed', hours: 1 });
  await setControlUntil(session.id, new Date(Date.now() + msFromNow));
  return { session, handoff };
}

function upsertEmitsFor(sessionId: string): number {
  return vi
    .mocked(emitToTenantAgents)
    .mock.calls.filter(
      (c) =>
        c[1] === 'conversation:upsert' &&
        (c[2] as { conversation?: { id?: string } })?.conversation?.id === sessionId,
    ).length;
}

async function countBotTextMessages(sessionId: string): Promise<number> {
  return messageRepo
    .createQueryBuilder('m')
    .innerJoin('m.participant', 'p')
    .where('m.sessionId = :sid', { sid: sessionId })
    .andWhere("p.type = 'bot'")
    .getCount();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRouteOutboundMessage.mockReset().mockResolvedValue({ success: true });
});

afterEach(() => {
  initializeAgentService(null as unknown as AgentService);
});

// ═════════════════════════════════════════════════════════════════════════════

describe('POST /takeover mode timed - exposed with hours validation', () => {
  it('persists mode/duration and until = started + hours', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

    const res = await request(app)
      .post(`/api/v1/chats/${session.id}/takeover`)
      .send({ idempotencyKey: 'tt-1', mode: 'timed', hours: 2 });
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('claimed');
    expect(res.body.data.conversation).toMatchObject({
      ownership: 'human_owned',
      assignedAgentId: agent.id,
      humanControlMode: 'timed',
      humanControlDurationHours: 2,
    });

    const s = await stateOf(session.id);
    expect(s.human_control_mode).toBe('timed');
    expect(s.human_control_duration_hours).toBe(2);
    // until and started_at derive from the same clock read: exactly 2h apart.
    expect(
      new Date(s.human_control_until!).getTime() - new Date(s.human_control_started_at!).getTime(),
    ).toBe(2 * 3_600_000);
  });

  it.each([0, 25, 1.5, '2', null, undefined])(
    'rejects hours=%p with 400 invalid_takeover_hours',
    async (hours) => {
      const tenant = await makeTenantWithAi();
      const { agent } = await makeOperator(tenant.id);
      const session = await createTestSession(tenant.id, { status: 'bot' });
      configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

      const res = await request(app)
        .post(`/api/v1/chats/${session.id}/takeover`)
        .send({ mode: 'timed', ...(hours !== undefined ? { hours } : {}) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_takeover_hours');
      // Nothing moved.
      expect(await stateOf(session.id)).toMatchObject({ ownership: 'bot_owned', human_control_mode: null });
    },
  );

  it('same-owner re-claim with an explicit mode updates the policy in place; an empty body cannot', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

    await request(app)
      .post(`/api/v1/chats/${session.id}/takeover`)
      .send({ mode: 'timed', hours: 2 });
    const before = await stateOf(session.id);

    // Change duration: explicit timed re-claim by the SAME owner.
    const change = await request(app)
      .post(`/api/v1/chats/${session.id}/takeover`)
      .send({ mode: 'timed', hours: 5 });
    expect(change.status).toBe(200);
    expect(change.body.data.outcome).toBe('already_owned');
    expect(change.body.data.conversation.humanControlDurationHours).toBe(5);

    let s = await stateOf(session.id);
    expect(s.human_control_duration_hours).toBe(5);
    // A policy change is not an ownership transition: the version stays put
    // (same convention as the reply slide).
    expect(s.ownership_version).toBe(before.ownership_version);

    // The SHIPPED portal's empty-body retry must NOT rewrite timed→indefinite.
    const emptyRetry = await request(app).post(`/api/v1/chats/${session.id}/takeover`).send({});
    expect(emptyRetry.status).toBe(200);
    expect(emptyRetry.body.data.outcome).toBe('already_owned');
    s = await stateOf(session.id);
    expect(s.human_control_mode).toBe('timed');
    expect(s.human_control_duration_hours).toBe(5);

    // Explicit switch to indefinite is allowed (the "until released" action).
    const toIndef = await request(app)
      .post(`/api/v1/chats/${session.id}/takeover`)
      .send({ mode: 'indefinite' });
    expect(toIndef.status).toBe(200);
    s = await stateOf(session.id);
    expect(s.human_control_mode).toBe('indefinite');
    expect(s.human_control_until).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('expiry worker - sweepExpiredTimedControl', () => {
  it('releases an expired timed session (policy cleared, handoff completed, ONE upsert); leaves indefinite and unexpired untouched', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);

    const expired = await makeTimedSession(tenant.id, agent.id, -60_000);
    const unexpired = await makeTimedSession(tenant.id, agent.id, 60 * 60_000);
    const indefSession = await createTestSession(tenant.id, { status: 'bot' });
    await conversationCommands.claimConversation(indefSession.id, agent.id, { mode: 'indefinite' });

    const vBefore = (await stateOf(expired.session.id)).ownership_version;
    vi.mocked(emitToTenantAgents).mockClear();

    const released = await sweepExpiredTimedControl();
    expect(released).toBe(1);

    const s = await stateOf(expired.session.id);
    expect(s).toMatchObject({
      ownership: 'bot_owned',
      status: 'bot',
      assigned_agent_id: null,
      human_control_mode: null,
      human_control_duration_hours: null,
      human_control_until: null,
      human_control_started_at: null,
    });
    expect(s.ownership_version).toBe(vBefore + 1);
    expect((await handoffRepo.findOneOrFail({ where: { id: expired.handoff.id } })).status).toBe('completed');

    // Exactly ONE committed conversation:upsert, for the released session only.
    expect(upsertEmitsFor(expired.session.id)).toBe(1);
    expect(upsertEmitsFor(unexpired.session.id)).toBe(0);
    expect(upsertEmitsFor(indefSession.id)).toBe(0);

    // The other two sessions did not move.
    expect(await stateOf(unexpired.session.id)).toMatchObject({
      ownership: 'human_owned',
      human_control_mode: 'timed',
    });
    expect(await stateOf(indefSession.id)).toMatchObject({
      ownership: 'human_owned',
      human_control_mode: 'indefinite',
    });
  });

  it('is re-entrant: a session the operator released meanwhile is a no-op, and a second sweep releases nothing', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const { session } = await makeTimedSession(tenant.id, agent.id, -60_000);

    // Operator returns it to the bot first - the sweep predicate no longer matches.
    await conversationCommands.releaseConversation(session.id, agent.id);
    const vAfterRelease = (await stateOf(session.id)).ownership_version;

    expect(await sweepExpiredTimedControl()).toBe(0);
    // Direct call on the released session: the command's own state check no-ops.
    const direct = await conversationCommands.releaseExpiredHumanControl(session.id);
    expect(direct.outcome).toBe('not_applicable');
    expect((await stateOf(session.id)).ownership_version).toBe(vAfterRelease);

    // A slide/re-claim that moved the deadline forward is honored too.
    const { session: fresh } = await makeTimedSession(tenant.id, agent.id, 60 * 60_000);
    const notYet = await conversationCommands.releaseExpiredHumanControl(fresh.id);
    expect(notYet.outcome).toBe('not_expired');
    expect(await stateOf(fresh.id)).toMatchObject({ ownership: 'human_owned', human_control_mode: 'timed' });
  });

  it('FOR UPDATE SKIP LOCKED: a row locked by another transaction is skipped, then picked up after commit', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const { session } = await makeTimedSession(tenant.id, agent.id, -60_000);

    const qr = AppDataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`SELECT id FROM chat_sessions WHERE id = $1 FOR UPDATE`, [session.id]);
      // Sweep runs while an "operator command" holds the row lock: skipped, no wait.
      expect(await sweepExpiredTimedControl()).toBe(0);
      expect((await stateOf(session.id)).ownership).toBe('human_owned');
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }

    // Lock gone → the next tick releases it.
    expect(await sweepExpiredTimedControl()).toBe(1);
    expect((await stateOf(session.id)).ownership).toBe('bot_owned');
  });

  it('two concurrent sweeps release one expired session exactly once (no double-process)', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const { session, handoff } = await makeTimedSession(tenant.id, agent.id, -60_000);
    const vBefore = (await stateOf(session.id)).ownership_version;

    const [a, b] = await Promise.all([sweepExpiredTimedControl(), sweepExpiredTimedControl()]);
    expect(a + b).toBe(1);

    const s = await stateOf(session.id);
    expect(s.ownership).toBe('bot_owned');
    expect(s.ownership_version).toBe(vBefore + 1); // applied once, not twice
    expect((await handoffRepo.findOneOrFail({ where: { id: handoff.id } })).status).toBe('completed');
    // Exactly one system event about the expiry.
    const events = await AppDataSource.query(
      `SELECT id FROM messages WHERE session_id = $1 AND type = 'system' AND content LIKE 'Timed human control expired%'`,
      [session.id],
    );
    expect(events).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('inbound-message expiry - released to bot BEFORE routing', () => {
  it('legacy path: the AI answers a message that arrives on an EXPIRED timed session', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const { session } = await makeTimedSession(tenant.id, agent.id, -60_000);

    initializeAgentService({
      run: vi.fn().mockResolvedValue({ type: 'response', content: 'The AI is back.' }),
    } as unknown as AgentService);

    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
    const msg = await createTestMessage(session.id, tenant.id, user.id, { content: 'hello again' });

    const fresh = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    expect(await forwardMessageToN8n(fresh, msg)).toBe(true);

    // Released BEFORE routing, then answered by the bot.
    expect(await stateOf(session.id)).toMatchObject({
      ownership: 'bot_owned',
      status: 'bot',
      human_control_mode: null,
    });
    expect(await countBotTextMessages(session.id)).toBe(1);
    expect(upsertEmitsFor(session.id)).toBeGreaterThanOrEqual(1);
  });

  it('legacy path: an UNEXPIRED timed session stays human_owned and the AI stays fenced', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const { session } = await makeTimedSession(tenant.id, agent.id, 60 * 60_000);

    const agentRun = vi.fn().mockResolvedValue({ type: 'response', content: 'Should never send.' });
    initializeAgentService({ run: agentRun } as unknown as AgentService);

    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
    const msg = await createTestMessage(session.id, tenant.id, user.id, { content: 'still there?' });

    const fresh = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    expect(await forwardMessageToN8n(fresh, msg)).toBe(false);

    expect(agentRun).not.toHaveBeenCalled();
    expect(await countBotTextMessages(session.id)).toBe(0);
    expect(await stateOf(session.id)).toMatchObject({
      ownership: 'human_owned',
      human_control_mode: 'timed',
    });
  });

  it('coalesced path: runTurn releases an expired session and answers; an unexpired one is a noop', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);

    initializeAgentService({
      run: vi.fn().mockResolvedValue({ type: 'response', content: 'Coalesced AI reply.' }),
    } as unknown as AgentService);

    const { session: expired } = await makeTimedSession(tenant.id, agent.id, -60_000);
    const eUser = await createTestParticipant(expired.id, { type: 'user', name: 'Visitor' });
    const eMsg = await createTestMessage(expired.id, tenant.id, eUser.id, { content: 'anyone?' });
    const eFresh = await sessionRepo.findOneOrFail({ where: { id: expired.id } });
    expect(await runTurn(eFresh, eMsg)).toBe('answered');
    expect(await stateOf(expired.id)).toMatchObject({ ownership: 'bot_owned', human_control_mode: null });
    expect(await countBotTextMessages(expired.id)).toBe(1);

    const { session: active } = await makeTimedSession(tenant.id, agent.id, 60 * 60_000);
    const aUser = await createTestParticipant(active.id, { type: 'user', name: 'Visitor' });
    const aMsg = await createTestMessage(active.id, tenant.id, aUser.id, { content: 'hi' });
    const aFresh = await sessionRepo.findOneOrFail({ where: { id: active.id } });
    expect(await runTurn(aFresh, aMsg)).toBe('noop');
    expect(await stateOf(active.id)).toMatchObject({ ownership: 'human_owned', human_control_mode: 'timed' });
    expect(await countBotTextMessages(active.id)).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('slide - a committed human reply moves the timed deadline forward', () => {
  it('timed: until becomes now + duration after the reply; indefinite: until stays null', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);

    // 1h-duration control with only 5 minutes left on the clock.
    const { session } = await makeTimedSession(tenant.id, agent.id, 5 * 60_000);
    const beforeUntil = new Date((await stateOf(session.id)).human_control_until!).getTime();

    const sent = await conversationCommands.sendHumanMessage(
      session.id, agent.id, 'slide-1', 'Still with you!', { tenantId: tenant.id },
    );
    expect(sent.outcome).toBe('sent');

    const after = await stateOf(session.id);
    const afterUntil = new Date(after.human_control_until!).getTime();
    expect(afterUntil).toBeGreaterThan(beforeUntil);
    // Slid to now + the FULL duration (1h), within test tolerance.
    expect(Math.abs(afterUntil - (Date.now() + 3_600_000))).toBeLessThan(10_000);
    // Mode/duration/assignment untouched; a slide is not an ownership transition.
    expect(after).toMatchObject({
      ownership: 'human_owned',
      human_control_mode: 'timed',
      human_control_duration_hours: 1,
      assigned_agent_id: agent.id,
    });

    // Indefinite control: a reply changes nothing about the policy.
    const indef = await createTestSession(tenant.id, { status: 'bot' });
    await conversationCommands.claimConversation(indef.id, agent.id, { mode: 'indefinite' });
    await conversationCommands.sendHumanMessage(indef.id, agent.id, 'slide-2', 'Here.', { tenantId: tenant.id });
    expect(await stateOf(indef.id)).toMatchObject({
      human_control_mode: 'indefinite',
      human_control_until: null,
    });
  });

  it('a stale expired read cannot release control that a post-deadline reply legitimately re-established', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    // Deadline in the past - the reply does NOT slide it (codex fix 2): it
    // materializes the expiry and re-claims FRESH (indefinite).
    const { session } = await makeTimedSession(tenant.id, agent.id, -60_000);
    await conversationCommands.sendHumanMessage(
      session.id, agent.id, 'slide-3', 'I am still handling this', { tenantId: tenant.id },
    );

    // A caller that read the session BEFORE the reply sees an expired timed
    // deadline; the command re-checks the locked row and finds a fresh
    // INDEFINITE control - nothing to release.
    const result = await conversationCommands.releaseExpiredHumanControl(session.id);
    expect(result.outcome).toBe('not_applicable');
    expect(await stateOf(session.id)).toMatchObject({
      ownership: 'human_owned',
      human_control_mode: 'indefinite',
      human_control_until: null,
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('DB-clock authority (codex review fix 1)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('claim deadlines are computed by the DB clock, not the JS clock', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const realNow = Date.now();

    // Skew the JS clock 2 hours BEHIND. Only Date is faked; timers stay real
    // so the DB driver is unaffected.
    vi.useFakeTimers({ now: realNow - 2 * 3_600_000, toFake: ['Date'] });
    await conversationCommands.claimConversation(session.id, agent.id, { mode: 'timed', hours: 1 });
    vi.useRealTimers();

    const s = await stateOf(session.id);
    const until = new Date(s.human_control_until!).getTime();
    const started = new Date(s.human_control_started_at!).getTime();
    // Anchored to REAL (DB) time + 1h, not to the skewed JS clock.
    expect(Math.abs(until - (realNow + 3_600_000))).toBeLessThan(15_000);
    expect(until - started).toBe(3_600_000);
  });

  it('a JS clock running BEHIND the DB still releases a DB-expired control (the starvation bug)', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    // Deadline one minute in the REAL past.
    const { session } = await makeTimedSession(tenant.id, agent.id, -60_000);

    // The skewed JS clock believes the deadline is ~2h in the future. Before
    // the fix this returned 'not_expired' forever, so the worker re-selected
    // the same row every tick and starved later-expired sessions.
    vi.useFakeTimers({ now: Date.now() - 2 * 3_600_000, toFake: ['Date'] });
    const result = await conversationCommands.releaseExpiredHumanControl(session.id);
    vi.useRealTimers();

    expect(result.outcome).toBe('released');
    expect(await stateOf(session.id)).toMatchObject({ ownership: 'bot_owned', human_control_mode: null });
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('no resurrection of an expired control (codex review fix 2)', () => {
  it('a reply AFTER the deadline does not slide - it materializes the expiry and re-claims FRESH', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const { session } = await makeTimedSession(tenant.id, agent.id, -60_000);
    const vBefore = (await stateOf(session.id)).ownership_version;

    const sent = await conversationCommands.sendHumanMessage(
      session.id, agent.id, 'res-1', 'sorry, still here', { tenantId: tenant.id },
    );
    expect(sent.outcome).toBe('sent');
    expect(sent.autoClaimed).toBe(true); // FRESH control, not a renewal

    const s = await stateOf(session.id);
    expect(s).toMatchObject({
      ownership: 'human_owned',
      assigned_agent_id: agent.id,
      human_control_mode: 'indefinite', // the auto-claim default, never 'timed'
      human_control_until: null,
    });
    // The expiry was materialized (release) and control re-established (claim):
    // two ownership transitions, and the expiry event is on the record.
    expect(s.ownership_version).toBe(vBefore + 2);
    const events = await AppDataSource.query(
      `SELECT id FROM messages WHERE session_id = $1 AND type = 'system' AND content LIKE 'Timed human control expired%'`,
      [session.id],
    );
    expect(events).toHaveLength(1);
  });

  it('a same-owner policy update AFTER the deadline is a FRESH takeover, not a silent renewal', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const { session, handoff } = await makeTimedSession(tenant.id, agent.id, -60_000);
    const originalUntil = new Date((await stateOf(session.id)).human_control_until!).getTime();

    const res = await conversationCommands.claimConversation(
      session.id, agent.id, { mode: 'timed', hours: 3 }, undefined, { updatePolicyIfOwned: true },
    );
    expect(res.outcome).toBe('claimed'); // NOT 'already_owned'

    const s = await stateOf(session.id);
    expect(s.human_control_mode).toBe('timed');
    expect(s.human_control_duration_hours).toBe(3);
    const started = new Date(s.human_control_started_at!).getTime();
    // The new window starts fresh AFTER the old deadline; exact 3h span.
    expect(started).toBeGreaterThan(originalUntil);
    expect(new Date(s.human_control_until!).getTime() - started).toBe(3 * 3_600_000);
    // The old accepted handoff was completed by the materialized expiry.
    expect((await handoffRepo.findOneOrFail({ where: { id: handoff.id } })).status).toBe('completed');
    const events = await AppDataSource.query(
      `SELECT id FROM messages WHERE session_id = $1 AND type = 'system' AND content LIKE 'Timed human control expired%'`,
      [session.id],
    );
    expect(events).toHaveLength(1);
  });

  it('concurrency: an expired reply racing the expiry sweep ends in FRESH control, never an extension', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const { session } = await makeTimedSession(tenant.id, agent.id, -60_000);

    const [, sent] = await Promise.all([
      sweepExpiredTimedControl(),
      conversationCommands.sendHumanMessage(session.id, agent.id, 'race-1', 'here!', { tenantId: tenant.id }),
    ]);
    // Whichever side wins the row lock, the reply re-establishes control
    // FRESH: sweep-first lands in the bot_owned auto-claim branch, reply-first
    // materializes the expiry itself.
    expect(sent.outcome).toBe('sent');
    expect(sent.autoClaimed).toBe(true);
    expect(await stateOf(session.id)).toMatchObject({
      ownership: 'human_owned',
      assigned_agent_id: agent.id,
      human_control_mode: 'indefinite',
      human_control_until: null,
    });
  });

  it('concurrency: an expired policy update racing the sweep ends as a FRESH takeover past the old deadline', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const { session } = await makeTimedSession(tenant.id, agent.id, -60_000);
    const originalUntil = new Date((await stateOf(session.id)).human_control_until!).getTime();

    const [, res] = await Promise.all([
      sweepExpiredTimedControl(),
      conversationCommands.claimConversation(
        session.id, agent.id, { mode: 'timed', hours: 2 }, undefined, { updatePolicyIfOwned: true },
      ),
    ]);
    // Sweep-first: a normal fresh claim on the released session. Update-first:
    // the expired-branch fresh takeover. Both report 'claimed'.
    expect(res.outcome).toBe('claimed');

    const s = await stateOf(session.id);
    expect(s).toMatchObject({ ownership: 'human_owned', human_control_mode: 'timed', human_control_duration_hours: 2 });
    // Never a silent renewal: the new window starts AFTER the old deadline.
    expect(new Date(s.human_control_started_at!).getTime()).toBeGreaterThan(originalUntil);
  });
});
