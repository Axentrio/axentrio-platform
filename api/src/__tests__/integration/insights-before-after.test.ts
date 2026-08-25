/**
 * Before/after evidence on an answered Gap: "4 people asked before. 0 since your answer."
 *
 * Against real Postgres, because the whole feature IS one grouped SQL statement. A mocked
 * data source proves only that a string was passed along - it cannot tell you that the
 * FILTER splits on each Gap's own `answered_at`, that a satisfied judgment stays out, or
 * that history before the retention window still counts as "before".
 *
 * Auth-mocking + app-bootstrap pattern mirrors the other router tests (helpers/auth.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { randomUUID } from 'crypto';
import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { CanonicalTopic } from '../../database/entities/CanonicalTopic';
import { Gap } from '../../database/entities/Gap';
import { Judgment } from '../../database/entities/Judgment';
import { KnowledgeDocument } from '../../database/entities/KnowledgeDocument';
import { KnowledgeBase } from '../../database/entities/KnowledgeBase';
import { createTestTenant, createTestUser } from '../helpers/factories';
import type { GapDto } from '../../contracts/insights';

const ANSWERED_AT = new Date('2026-06-10T12:00:00Z');
const days = (n: number) => new Date(ANSWERED_AT.getTime() + n * 86_400_000);

let tenantId: string;
/** One bot-less KB per tenant is all the schema allows, so it is made once per test. */
let knowledgeBaseId: string;

async function seedTopic(topic: string): Promise<string> {
  const repo = AppDataSource.getRepository(CanonicalTopic);
  const row = await repo.save(repo.create({ tenantId, topic }));
  return row.id;
}

/** A document to point the Gap at. The FK is the answered flag, so it must be real. */
async function seedDocument(title: string): Promise<string> {
  const docRepo = AppDataSource.getRepository(KnowledgeDocument);
  const doc = await docRepo.save(
    docRepo.create({ tenantId, knowledgeBaseId, type: 'text', title, sourceContent: title }),
  );
  return doc.id;
}

async function seedGap(opts: {
  canonicalTopicId: string;
  answerDocumentId?: string | null;
  answeredAt?: Date | null;
  tenantId?: string;
}): Promise<Gap> {
  const repo = AppDataSource.getRepository(Gap);
  return repo.save(
    repo.create({
      tenantId: opts.tenantId ?? tenantId,
      canonicalTopicId: opts.canonicalTopicId,
      status: 'open',
      severity: 'red',
      occurrences: 2,
      distinctVisitors: 2,
      firstDetectedAt: days(-30),
      lastSeenAt: days(1),
      answerDocumentId: opts.answerDocumentId ?? null,
      answeredAt: opts.answeredAt ?? null,
    }),
  );
}

async function seedJudgment(opts: {
  canonicalTopicId: string | null;
  sessionStartedAt: Date;
  satisfied: boolean | null;
  tenantId?: string;
}): Promise<void> {
  const repo = AppDataSource.getRepository(Judgment);
  await repo.save(
    repo.create({
      tenantId: opts.tenantId ?? tenantId,
      sessionId: randomUUID(),
      visitorId: `visitor-${randomUUID()}`,
      sessionStartedAt: opts.sessionStartedAt,
      hadQuestion: true,
      satisfied: opts.satisfied,
      canonicalTopicId: opts.canonicalTopicId,
    }),
  );
}

async function listGaps(): Promise<GapDto[]> {
  const res = await request(app).get('/api/v1/insights');
  expect(res.status).toBe(200);
  return res.body.data.gaps as GapDto[];
}

beforeEach(async () => {
  // Pro carries gapInsights, so the list route is open to this tenant.
  const tenant = await createTestTenant({ tier: 'pro' });
  const admin = await createTestUser(tenant.id, { role: 'admin' });
  tenantId = tenant.id;
  const kbRepo = AppDataSource.getRepository(KnowledgeBase);
  knowledgeBaseId = (await kbRepo.save(kbRepo.create({ tenantId, botId: null }))).id;
  configureMockAuth(auth, { tenantId: tenant.id, userId: admin.id, role: 'admin' });
});

describe('insights list — before/after an answer', () => {
  it('counts unsatisfied asks on each side of the answer, and counts nothing else', async () => {
    const topicId = await seedTopic('call-out fee');
    const gap = await seedGap({
      canonicalTopicId: topicId,
      answerDocumentId: await seedDocument('call-out fee'),
      answeredAt: ANSWERED_AT,
    });

    // Three real asks before the answer. One of them is 200 days old: "before" means all
    // of history, so the 90-day retention window must NOT reach these counts.
    await seedJudgment({ canonicalTopicId: topicId, sessionStartedAt: days(-200), satisfied: false });
    await seedJudgment({ canonicalTopicId: topicId, sessionStartedAt: days(-5), satisfied: false });
    await seedJudgment({ canonicalTopicId: topicId, sessionStartedAt: days(-1), satisfied: false });
    // One after, so "since" is not silently always zero.
    await seedJudgment({ canonicalTopicId: topicId, sessionStartedAt: days(3), satisfied: false });

    // None of these are an unmet ask for this topic.
    await seedJudgment({ canonicalTopicId: topicId, sessionStartedAt: days(-4), satisfied: true });
    await seedJudgment({ canonicalTopicId: topicId, sessionStartedAt: days(-4), satisfied: null });
    await seedJudgment({ canonicalTopicId: null, sessionStartedAt: days(-4), satisfied: false });
    await seedJudgment({
      canonicalTopicId: await seedTopic('opening hours'),
      sessionStartedAt: days(-4),
      satisfied: false,
    });
    const other = await createTestTenant({ tier: 'pro' });
    await seedJudgment({
      canonicalTopicId: topicId,
      sessionStartedAt: days(-4),
      satisfied: false,
      tenantId: other.id,
    });

    const [dto] = await listGaps();
    expect(dto.id).toBe(gap.id);
    expect(dto.asksBeforeAnswer).toBe(3);
    expect(dto.asksSinceAnswer).toBe(1);
  });

  it('splits each Gap on its own answered_at, and reports a real zero since', async () => {
    // The good news case, and the reason the query joins chatbot_gaps instead of taking
    // one timestamp for the whole list: these two answers are a week apart.
    const early = await seedTopic('call-out fee');
    const late = await seedTopic('opening hours');
    const earlyGap = await seedGap({
      canonicalTopicId: early,
      answerDocumentId: await seedDocument('call-out fee'),
      answeredAt: days(-7),
    });
    const lateGap = await seedGap({
      canonicalTopicId: late,
      answerDocumentId: await seedDocument('opening hours'),
      answeredAt: days(0),
    });

    // Asked on day -3: after the early answer, before the late one.
    await seedJudgment({ canonicalTopicId: early, sessionStartedAt: days(-3), satisfied: false });
    await seedJudgment({ canonicalTopicId: late, sessionStartedAt: days(-3), satisfied: false });
    await seedJudgment({ canonicalTopicId: late, sessionStartedAt: days(-2), satisfied: false });

    const byId = new Map((await listGaps()).map((g) => [g.id, g]));
    expect(byId.get(earlyGap.id)).toMatchObject({ asksBeforeAnswer: 0, asksSinceAnswer: 1 });
    // Zero since the answer is the headline, so it must be 0 and never null.
    expect(byId.get(lateGap.id)).toMatchObject({ asksBeforeAnswer: 2, asksSinceAnswer: 0 });
  });

  it('reports 0 and 0 for an answered topic nobody ever asked about', async () => {
    const topicId = await seedTopic('call-out fee');
    await seedGap({
      canonicalTopicId: topicId,
      answerDocumentId: await seedDocument('call-out fee'),
      answeredAt: ANSWERED_AT,
    });

    const [dto] = await listGaps();
    expect(dto.asksBeforeAnswer).toBe(0);
    expect(dto.asksSinceAnswer).toBe(0);
  });

  it('goes back to null once the answer document is gone, even though answered_at stays', async () => {
    // The owner deletes the published answer on the Knowledge page. In production the FK
    // empties `answer_document_id` (ON DELETE SET NULL, asserted in
    // migration-gap-answer.test.ts); `synchronize` builds no FK here, so the column is
    // cleared by hand, the same way gap-answer.test.ts does it.
    const topicId = await seedTopic('call-out fee');
    const documentId = await seedDocument('call-out fee');
    const gap = await seedGap({
      canonicalTopicId: topicId,
      answerDocumentId: documentId,
      answeredAt: ANSWERED_AT,
    });
    await seedJudgment({ canonicalTopicId: topicId, sessionStartedAt: days(-2), satisfied: false });

    expect((await listGaps())[0].asksBeforeAnswer).toBe(1);

    await AppDataSource.getRepository(Gap).update(gap.id, { answerDocumentId: null });
    await AppDataSource.getRepository(KnowledgeDocument).delete({ id: documentId });

    const [dto] = await listGaps();
    expect(dto.answerDocumentId).toBeNull();
    expect(dto.answeredAt).not.toBeNull();
    expect(dto.asksBeforeAnswer).toBeNull();
    expect(dto.asksSinceAnswer).toBeNull();
  });
});
