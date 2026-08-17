/**
 * B-PR4b §1 - GET /chats/:sessionId/thread (read-only customer thread).
 *
 * Covers: widget identity sessions oldest→newest with messages + boundaries;
 * external identity via the binding triple INCLUDING prior sessions whose
 * binding was reassigned on reopen (they match on the identity facts stamped
 * on the row); tenant isolation; the prior-session cap + truncated signal;
 * possibleDuplicates surfaces weaker-signal sessions and never unrelated ones.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
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

vi.mock('../../services/message-forwarding.service', () => ({
  forwardMessageToN8n: vi.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { ConversationBinding } from '../../database/entities/ConversationBinding';
import { encrypt } from '../../utils/encryption';
import {
  createTestTenant,
  createTestUser,
  createTestSession,
  createTestParticipant,
  createTestMessage,
  createTestAnchorBot,
} from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

const DAY = 24 * 60 * 60 * 1000;

/** Closed widget session at a given age, same identity when overrides say so. */
async function closedSessionAt(
  tenantId: string,
  ageMs: number,
  overrides: Partial<ChatSession> = {},
): Promise<ChatSession> {
  const startedAt = new Date(Date.now() - ageMs);
  return createTestSession(tenantId, {
    status: 'closed',
    startedAt,
    lastActivityAt: new Date(startedAt.getTime() + 60_000),
    endedAt: new Date(startedAt.getTime() + 60_000),
    ...overrides,
  });
}

async function addUserMessage(session: ChatSession, tenantId: string, content: string) {
  const participant = await createTestParticipant(session.id, { type: 'user', name: 'Customer' });
  return createTestMessage(session.id, tenantId, participant.id, { content });
}

async function makeConnection(tenantId: string): Promise<ChannelConnection> {
  const repo = AppDataSource.getRepository(ChannelConnection);
  return repo.save(
    repo.create({
      tenantId,
      channel: 'messenger',
      status: 'active',
      platformAccountId: `page_${crypto.randomBytes(4).toString('hex')}`,
    }),
  );
}

/** External session with the identity facts the inbound pipeline stamps. */
async function makeExternalSession(
  tenant: Tenant,
  connection: ChannelConnection,
  externalUserId: string,
  externalThreadId: string,
  overrides: Partial<ChatSession> = {},
): Promise<ChatSession> {
  return createTestSession(tenant.id, {
    source: 'messenger',
    channel: 'messenger',
    visitorId: externalUserId,
    channelConnectionId: connection.id,
    metadata: { customData: { externalUserId, externalThreadId } },
    ...overrides,
  });
}

async function bindSession(
  session: ChatSession,
  connection: ChannelConnection,
  externalUserId: string,
  externalThreadId: string,
): Promise<ConversationBinding> {
  const repo = AppDataSource.getRepository(ConversationBinding);
  return repo.save(
    repo.create({
      sessionId: session.id,
      channelConnectionId: connection.id,
      externalUserId,
      externalThreadId,
    }),
  );
}

function getThread(sessionId: string) {
  return request(app).get(`/api/v1/chats/${sessionId}/thread`);
}

describe('GET /chats/:sessionId/thread (B-PR4b)', () => {
  let tenant: Tenant;
  let tenantId: string;

  beforeEach(async () => {
    tenant = await createTestTenant();
    tenantId = tenant.id;
    const user = await createTestUser(tenantId, { role: 'admin' });
    configureMockAuth(auth, { userId: user.id, tenantId, role: 'admin' });
  });

  it('widget: returns the identity sessions oldest→newest with messages and boundaries', async () => {
    const bot = await createTestAnchorBot(tenant);
    const visitorId = 'cust-widget-1';

    const oldest = await closedSessionAt(tenantId, 3 * DAY, { botId: bot.id, visitorId });
    const middle = await closedSessionAt(tenantId, 2 * DAY, { botId: bot.id, visitorId });
    const current = await createTestSession(tenantId, {
      botId: bot.id,
      visitorId,
      status: 'active',
      startedAt: new Date(),
    });

    await addUserMessage(oldest, tenantId, 'first visit');
    // Encrypted message: the thread must serve decrypted plaintext, same as
    // the detail GET.
    const middleParticipant = await createTestParticipant(middle.id, { type: 'user', name: 'Customer' });
    await createTestMessage(middle.id, tenantId, middleParticipant.id, {
      content: encrypt('second visit, encrypted'),
      contentEncrypted: true,
    });
    await addUserMessage(current, tenantId, 'live message');

    // Same tenant, same bot, DIFFERENT visitor - must never join the thread.
    const unrelated = await closedSessionAt(tenantId, 1 * DAY, { botId: bot.id, visitorId: 'someone-else' });
    await addUserMessage(unrelated, tenantId, 'not this customer');

    const res = await getThread(current.id);
    expect(res.status).toBe(200);
    const data = res.body.data;

    expect(data.identity).toBe('widget');
    expect(data.customerThreadId).toBe(`w:${tenantId}:${bot.id}:${visitorId}`);
    expect(data.totalSessions).toBe(3);
    expect(data.truncated).toBe(false);

    const ids = data.sessions.map((s: any) => s.summary.id);
    expect(ids).toEqual([oldest.id, middle.id, current.id]);
    expect(ids).not.toContain(unrelated.id);

    // Every summary reports the SAME durable customer-thread key.
    for (const s of data.sessions) {
      expect(s.summary.customerThreadId).toBe(data.customerThreadId);
    }

    // Boundary facts per block.
    const [first, second, third] = data.sessions;
    expect(first.boundary.status).toBe('closed');
    expect(first.boundary.endedAt).not.toBeNull();
    expect(first.isCurrent).toBe(false);
    expect(third.isCurrent).toBe(true);
    expect(third.boundary.status).toBe('active');
    expect(third.boundary.endedAt).toBeNull();

    // Messages: decrypted plaintext in the detail-GET shape.
    expect(first.messages.map((m: any) => m.content)).toEqual(['first visit']);
    expect(second.messages.map((m: any) => m.content)).toEqual(['second visit, encrypted']);
    expect(second.messages[0]).toMatchObject({
      sender: 'user',
      senderName: 'Customer',
      sessionId: middle.id,
    });
    expect(third.messages.map((m: any) => m.content)).toEqual(['live message']);
  });

  it('external: the binding triple resolves the thread, including prior sessions whose binding was reassigned', async () => {
    const connection = await makeConnection(tenantId);
    const userId = 'psid-1001';
    const threadId = userId; // DM: thread id == user id (messenger convention)

    // The prior session LOST its binding when the conversation reopened (the
    // pipeline reassigns the row) - only the identity stamps remain.
    const prior = await makeExternalSession(tenant, connection, userId, threadId, {
      status: 'closed',
      startedAt: new Date(Date.now() - 2 * DAY),
      endedAt: new Date(Date.now() - 2 * DAY + 60_000),
    });
    const currentSession = await makeExternalSession(tenant, connection, userId, threadId, {
      status: 'waiting',
      startedAt: new Date(),
    });
    await bindSession(currentSession, connection, userId, threadId);

    await addUserMessage(prior, tenantId, 'old messenger chat');
    await addUserMessage(currentSession, tenantId, 'new messenger chat');

    // Same user in a GROUP thread - a different externalThreadId, so it stays
    // OUT of the strict thread but surfaces in possibleDuplicates.
    const groupSession = await makeExternalSession(tenant, connection, userId, 'group-42', {
      status: 'closed',
      startedAt: new Date(Date.now() - 1 * DAY),
      endedAt: new Date(Date.now() - 1 * DAY + 60_000),
    });

    // Selecting the CURRENT (bound) session finds the reassigned prior too.
    const res = await getThread(currentSession.id);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.identity).toBe('external');
    expect(data.customerThreadId).toBe(`e:${connection.id}:${userId}:${threadId}`);
    expect(data.sessions.map((s: any) => s.summary.id)).toEqual([prior.id, currentSession.id]);
    expect(data.sessions[1].isCurrent).toBe(true);
    expect(data.sessions[0].messages[0].content).toBe('old messenger chat');

    const dupIds = data.possibleDuplicates.map((d: any) => d.summary.id);
    expect(dupIds).toContain(groupSession.id);
    expect(dupIds).not.toContain(prior.id);
    expect(dupIds).not.toContain(currentSession.id);

    // Selecting the PRIOR (metadata-only) session resolves the same identity,
    // but the timeline ends AT the selected session: the newer active sibling
    // is neither read-only history NOR a possible duplicate.
    const resPrior = await getThread(prior.id);
    expect(resPrior.status).toBe(200);
    expect(resPrior.body.data.customerThreadId).toBe(`e:${connection.id}:${userId}:${threadId}`);
    expect(resPrior.body.data.sessions.map((s: any) => s.summary.id)).toEqual([prior.id]);
    expect(resPrior.body.data.sessions[0].isCurrent).toBe(true);
    const priorDupIds = resPrior.body.data.possibleDuplicates.map((d: any) => d.summary.id);
    expect(priorDupIds).not.toContain(currentSession.id);
    expect(priorDupIds).toContain(groupSession.id);
  });

  it('tenant isolation: another tenant\'s sessions never leak, and a foreign session id is a 404', async () => {
    const bot = await createTestAnchorBot(tenant);
    const visitorId = 'shared-visitor-id';
    const current = await createTestSession(tenantId, { botId: bot.id, visitorId, status: 'active' });

    // Tenant B has a session with the SAME visitor id string.
    const tenantB = await createTestTenant();
    const botB = await createTestAnchorBot(tenantB);
    const foreign = await createTestSession(tenantB.id, {
      botId: botB.id,
      visitorId,
      status: 'active',
    });

    const res = await getThread(current.id);
    expect(res.status).toBe(200);
    const ids = res.body.data.sessions.map((s: any) => s.summary.id);
    expect(ids).toEqual([current.id]);
    expect(ids).not.toContain(foreign.id);
    expect(res.body.data.possibleDuplicates.map((d: any) => d.summary.id)).not.toContain(foreign.id);

    // Asking for the foreign session under tenant A's auth is a 404.
    const forbidden = await getThread(foreign.id);
    expect(forbidden.status).toBe(404);
  });

  it('caps prior sessions at the newest 20 and signals truncation', async () => {
    const bot = await createTestAnchorBot(tenant);
    const visitorId = 'busy-customer';

    const priors: ChatSession[] = [];
    for (let i = 0; i < 25; i++) {
      // Oldest first: ages 26d … 2d.
      priors.push(
        await closedSessionAt(tenantId, (26 - i) * DAY, { botId: bot.id, visitorId }),
      );
    }
    const current = await createTestSession(tenantId, {
      botId: bot.id,
      visitorId,
      status: 'active',
      startedAt: new Date(),
    });

    const res = await getThread(current.id);
    expect(res.status).toBe(200);
    const data = res.body.data;

    expect(data.totalSessions).toBe(26);
    expect(data.sessions).toHaveLength(21); // newest 20 priors + current
    expect(data.truncated).toBe(true);

    const ids = data.sessions.map((s: any) => s.summary.id);
    // The newest 20 priors survive; the 5 oldest are cut.
    const expectedPriors = priors.slice(5).map((s) => s.id);
    expect(ids).toEqual([...expectedPriors, current.id]);
    expect(data.sessions[20].isCurrent).toBe(true);
  });

  it('selecting an OLD session ends the thread there - a newer/active sibling is never read-only history', async () => {
    const bot = await createTestAnchorBot(tenant);
    const visitorId = 'returning-visitor';

    const oldest = await closedSessionAt(tenantId, 3 * DAY, { botId: bot.id, visitorId });
    const middle = await closedSessionAt(tenantId, 2 * DAY, { botId: bot.id, visitorId });
    const newestActive = await createTestSession(tenantId, {
      botId: bot.id,
      visitorId,
      status: 'active',
      startedAt: new Date(),
    });

    // Selecting the MIDDLE session: only strictly-older sessions above it.
    const res = await getThread(middle.id);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.sessions.map((s: any) => s.summary.id)).toEqual([oldest.id, middle.id]);
    expect(data.sessions[1].isCurrent).toBe(true);
    expect(data.totalSessions).toBe(2);
    // The newer ACTIVE sibling is neither history nor a possible duplicate.
    expect(data.sessions.map((s: any) => s.summary.id)).not.toContain(newestActive.id);
    expect(data.possibleDuplicates.map((d: any) => d.summary.id)).not.toContain(newestActive.id);

    // Selecting the OLDEST session: no history at all above it.
    const resOldest = await getThread(oldest.id);
    expect(resOldest.status).toBe(200);
    expect(resOldest.body.data.sessions.map((s: any) => s.summary.id)).toEqual([oldest.id]);
    expect(resOldest.body.data.sessions[0].isCurrent).toBe(true);
    expect(resOldest.body.data.totalSessions).toBe(1);
  });

  it('an incomplete external identity falls back to the one-session thread, never a null-match', async () => {
    const connection = await makeConnection(tenantId);
    const userId = 'psid-2002';

    // Incomplete identity on BOTH seams: empty binding thread id AND an
    // empty stamped metadata thread id. #166 made computeCustomerThreadId
    // fall back to the stamped triple, so a complete stamp would still emit
    // e: even when the binding is empty.
    const selected = await makeExternalSession(tenant, connection, userId, '', {
      status: 'waiting',
      startedAt: new Date(),
    });
    await bindSession(selected, connection, userId, '');

    // A sibling of the same user with a VALID thread id - must not be silently
    // dropped: it surfaces as a possible duplicate, not as thread history.
    const sibling = await makeExternalSession(tenant, connection, userId, userId, {
      status: 'closed',
      startedAt: new Date(Date.now() - 1 * DAY),
      endedAt: new Date(Date.now() - 1 * DAY + 60_000),
    });

    const res = await getThread(selected.id);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.identity).toBe('session');
    expect(data.customerThreadId).toBe(`s:${selected.id}`);
    expect(data.sessions.map((s: any) => s.summary.id)).toEqual([selected.id]);
    expect(data.possibleDuplicates.map((d: any) => d.summary.id)).toContain(sibling.id);
  });

  it('a DM and the same user\'s GROUP chat stay separate threads; two users in one group are never merged', async () => {
    const connection = await makeConnection(tenantId);
    const userA = 'tg-user-a';
    const userB = 'tg-user-b';
    const groupThread = 'tg-group-42';

    // User A: a DM thread (thread id == user id) with a closed prior + a
    // current bound session.
    const dmPrior = await makeExternalSession(tenant, connection, userA, userA, {
      status: 'closed',
      startedAt: new Date(Date.now() - 2 * DAY),
      endedAt: new Date(Date.now() - 2 * DAY + 60_000),
    });
    const dmCurrent = await makeExternalSession(tenant, connection, userA, userA, {
      status: 'waiting',
      startedAt: new Date(),
    });
    await bindSession(dmCurrent, connection, userA, userA);

    // User A also talks in a GROUP chat - a different externalThreadId.
    const groupA = await makeExternalSession(tenant, connection, userA, groupThread, {
      status: 'waiting',
      startedAt: new Date(Date.now() - 1 * DAY),
    });
    await bindSession(groupA, connection, userA, groupThread);

    // User B talks in the SAME group thread.
    const groupB = await makeExternalSession(tenant, connection, userB, groupThread, {
      status: 'waiting',
      startedAt: new Date(Date.now() - 1 * DAY),
    });
    await bindSession(groupB, connection, userB, groupThread);

    // Selecting the DM: only DM sessions; the group session is a WEAKER
    // signal (audit), and user B never appears anywhere.
    const dmRes = await getThread(dmCurrent.id);
    expect(dmRes.status).toBe(200);
    expect(dmRes.body.data.customerThreadId).toBe(`e:${connection.id}:${userA}:${userA}`);
    expect(dmRes.body.data.sessions.map((s: any) => s.summary.id)).toEqual([
      dmPrior.id,
      dmCurrent.id,
    ]);
    const dmDupIds = dmRes.body.data.possibleDuplicates.map((d: any) => d.summary.id);
    expect(dmDupIds).toContain(groupA.id);
    expect(dmDupIds).not.toContain(groupB.id);

    // Selecting user A's GROUP session: its own thread, DMs in the audit,
    // and user B's group session in NEITHER list (different customer).
    const groupRes = await getThread(groupA.id);
    expect(groupRes.status).toBe(200);
    expect(groupRes.body.data.customerThreadId).toBe(
      `e:${connection.id}:${userA}:${groupThread}`,
    );
    expect(groupRes.body.data.sessions.map((s: any) => s.summary.id)).toEqual([groupA.id]);
    const groupDupIds = groupRes.body.data.possibleDuplicates.map((d: any) => d.summary.id);
    expect(groupDupIds).toContain(dmPrior.id);
    expect(groupDupIds).toContain(dmCurrent.id);
    expect(groupDupIds).not.toContain(groupB.id);
  });

  it('a mis-associated cross-tenant message row never surfaces in the thread', async () => {
    const bot = await createTestAnchorBot(tenant);
    const session = await createTestSession(tenantId, {
      botId: bot.id,
      visitorId: 'cust-x',
      status: 'active',
    });
    const participant = await createTestParticipant(session.id, { type: 'user', name: 'Customer' });
    await createTestMessage(session.id, tenantId, participant.id, { content: 'legit message' });

    // A corrupt row: right session id, WRONG tenant. The tenant filter on the
    // message queries must keep it out of the decrypt-and-return path.
    const tenantB = await createTestTenant();
    await createTestMessage(session.id, tenantB.id, participant.id, { content: 'foreign row' });

    const res = await getThread(session.id);
    expect(res.status).toBe(200);
    const contents = res.body.data.sessions[0].messages.map((m: any) => m.content);
    expect(contents).toEqual(['legit message']);
    expect(contents).not.toContain('foreign row');
  });

  it('possibleDuplicates: same widget visitor on ANOTHER bot appears there - never an unrelated visitor', async () => {
    const bot = await createTestAnchorBot(tenant);
    const otherBot = await createTestAnchorBot(tenant, {
      publicKey: `pk_${crypto.randomBytes(8).toString('hex')}`,
      isDefault: false,
      name: 'Second bot',
    });
    const visitorId = 'multi-bot-visitor';

    const current = await createTestSession(tenantId, { botId: bot.id, visitorId, status: 'active' });
    const sameVisitorOtherBot = await createTestSession(tenantId, {
      botId: otherBot.id,
      visitorId,
      status: 'active',
    });
    const unrelated = await createTestSession(tenantId, {
      botId: otherBot.id,
      visitorId: 'nobody-we-know',
      status: 'active',
    });

    const res = await getThread(current.id);
    expect(res.status).toBe(200);
    const data = res.body.data;

    // The other-bot session is a WEAKER signal: audit list only, never the thread.
    expect(data.sessions.map((s: any) => s.summary.id)).toEqual([current.id]);
    const dupIds = data.possibleDuplicates.map((d: any) => d.summary.id);
    expect(dupIds).toEqual([sameVisitorOtherBot.id]);
    expect(dupIds).not.toContain(unrelated.id);
  });
});
