/**
 * A language model must not write a customer's email address or phone number
 * into the aggregate insight stores (GDPR Tier 1, item 7).
 *
 * Driven end to end: the real insight services write to the test database, and
 * the real GET /insights endpoints then serve what the portal would show. Only
 * Clerk authentication and the LLM provider are stubbed — the model is the
 * external boundary whose output the guard exists to filter.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';

const auth = vi.hoisted(() => ({ userId: '', tenantId: '', role: 'admin' }));
const chatMock = vi.hoisted(() => vi.fn());

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (req: any, _res: any, next: any) => {
    req.userId = auth.userId;
    req.tenantId = auth.tenantId;
    req.userRole = auth.role;
    req.user = { id: auth.userId, email: 'test@example.com', role: auth.role, tenantId: auth.tenantId };
    next();
  },
  autoProvision: (_req: any, _res: any, next: any) => next(),
  invalidateProvisionCache: () => {},
  resolveClerkIds: () => ({}),
}));

vi.mock('../../llm/provider-factory', () => ({
  getProvider: () => ({ chat: chatMock }),
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Gap } from '../../database/entities/Gap';
import { CanonicalTopic } from '../../database/entities/CanonicalTopic';
import { Judgment } from '../../database/entities/Judgment';
import { SentimentTheme } from '../../database/entities/SentimentTheme';
import { InsightExperiment } from '../../database/entities/InsightExperiment';
import { generateGapRecommendations } from '../../insights/gap-recommendation.service';
import { aggregateSentiment } from '../../insights/sentiment-aggregation.service';
import { generateDigest } from '../../insights/digest.service';
import { createTestTenant, createTestUser, createTestBillingAccount } from '../helpers/factories';

const NOW = new Date();

let tenantId: string;

async function seedTopicAndGap(
  topic: string,
  overrides: Partial<Gap> = {},
): Promise<{ topicId: string; gapId: string }> {
  const topicRepo = AppDataSource.getRepository(CanonicalTopic);
  const canonical = await topicRepo.save(topicRepo.create({ tenantId, topic }));
  const gapRepo = AppDataSource.getRepository(Gap);
  const gap = await gapRepo.save(
    gapRepo.create({
      tenantId,
      canonicalTopicId: canonical.id,
      status: 'open',
      severity: 'red',
      occurrences: 6,
      distinctVisitors: 4,
      firstDetectedAt: new Date(NOW.getTime() - 10 * 86_400_000),
      lastSeenAt: NOW,
      ...overrides,
    }),
  );
  return { topicId: canonical.id, gapId: gap.id };
}

async function seedUnsatisfiedJudgment(topicId: string, reasoning: string): Promise<void> {
  const repo = AppDataSource.getRepository(Judgment);
  await repo.save(
    repo.create({
      tenantId,
      sessionId: randomUUID(),
      visitorId: `visitor-${randomUUID().slice(0, 8)}`,
      sessionStartedAt: new Date(NOW.getTime() - 86_400_000),
      hadQuestion: true,
      satisfied: false,
      canonicalTopicId: topicId,
      reasoning,
    }),
  );
}

async function servedGaps(): Promise<Array<Record<string, unknown>>> {
  const res = await request(app).get('/api/v1/insights');
  expect(res.status).toBe(200);
  return res.body.data.gaps as Array<Record<string, unknown>>;
}

beforeEach(async () => {
  const tenant = await createTestTenant({ tier: 'enterprise' });
  tenantId = tenant.id;
  await createTestBillingAccount(tenantId, { status: 'active', currentPlanId: 'enterprise' });
  const user = await createTestUser(tenantId, { role: 'admin' });
  Object.assign(auth, { userId: user.id, tenantId, role: 'admin' });
  chatMock.mockReset();
});

describe('gap recommendations — contact data never reaches the insights surface', () => {
  it('removes a stored suggestion that carries an email, even with no fresh evidence', async () => {
    // A row written before the guard existed. Its topic has no recent evidence,
    // so generation returns early: the value must still be cleared.
    const { topicId } = await seedTopicAndGap('pricing', {
      recommendation: 'Email jane.doe@acme.com to explain pricing.',
      recommendationUpdatedAt: new Date(NOW.getTime() - 30 * 86_400_000),
    });
    expect((await servedGaps())[0].recommendation).toContain('jane.doe@acme.com');

    await generateGapRecommendations(tenantId, undefined, NOW);

    expect(chatMock).not.toHaveBeenCalled();
    const stored = await AppDataSource.getRepository(Gap).findOne({ where: { canonicalTopicId: topicId } });
    expect(stored?.recommendation).toBeNull();
    expect(stored?.recommendationUpdatedAt).toBeNull();
    expect((await servedGaps())[0].recommendation).toBeNull();
  });

  it('does not store a generated sentence that carries a phone number', async () => {
    const { topicId } = await seedTopicAndGap('emergency callout');
    await seedUnsatisfiedJudgment(topicId, 'The Agent could not say whether night callouts are possible.');
    chatMock.mockResolvedValue({
      content: 'Call Jan on 0470 12 34 56 to confirm the night callout price.',
      usage: { promptTokens: 20, completionTokens: 9 },
    });

    await generateGapRecommendations(tenantId, undefined, NOW);

    expect(chatMock).toHaveBeenCalledTimes(1);
    const stored = await AppDataSource.getRepository(Gap).findOne({ where: { canonicalTopicId: topicId } });
    expect(stored?.recommendation).toBeNull();
    expect((await servedGaps())[0].recommendation).toBeNull();
  });

  it('still serves a clean sentence that names two dates', async () => {
    const { topicId } = await seedTopicAndGap('opening hours');
    await seedUnsatisfiedJudgment(topicId, 'The Agent could not give the holiday opening hours.');
    const clean = 'Publish the opening hours for 09/09/2026 and 10/09/2026 on the hours page.';
    chatMock.mockResolvedValue({ content: clean, usage: { promptTokens: 20, completionTokens: 9 } });

    await generateGapRecommendations(tenantId, undefined, NOW);

    const stored = await AppDataSource.getRepository(Gap).findOne({ where: { canonicalTopicId: topicId } });
    expect(stored?.recommendation).toBe(clean);
    expect((await servedGaps())[0].recommendation).toBe(clean);
  });
});

describe('weekly digest — contact data never reaches the digest surface', () => {
  it('serves the deterministic summary when the narrative carries a phone number', async () => {
    const expRepo = AppDataSource.getRepository(InsightExperiment);
    await expRepo.save(
      expRepo.create({
        tenantId,
        kind: 'correlation',
        fingerprint: 'fp-1',
        severity: 'red',
        title: 'Chats after 18:00 tend to go unanswered — 41% vs 12%',
        payload: {},
        state: 'active',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      }),
    );
    chatMock.mockResolvedValue({
      content: 'A quiet week. Call Sara back on 0470 12 34 56 about her quote.',
      usage: { promptTokens: 30, completionTokens: 20 },
    });

    await generateDigest(tenantId, NOW);

    const res = await request(app).get('/api/v1/insights/digest');
    expect(res.status).toBe(200);
    const summary = res.body.data.digest.summaryMd as string;
    expect(summary).not.toContain('0470');
    expect(summary).toContain('conversations');
  });
});

describe('sentiment experiments — contact data never reaches the experiments surface', () => {
  async function seedTheme(theme: string, polarity: 'negative' | 'positive'): Promise<string> {
    const repo = AppDataSource.getRepository(SentimentTheme);
    const row = await repo.save(repo.create({ tenantId, theme, polarity }));
    for (let i = 0; i < 3; i += 1) {
      const judgments = AppDataSource.getRepository(Judgment);
      await judgments.save(
        judgments.create({
          tenantId,
          sessionId: randomUUID(),
          visitorId: `visitor-${randomUUID().slice(0, 8)}`,
          sessionStartedAt: new Date(NOW.getTime() - (i + 1) * 3_600_000),
          hadQuestion: true,
          satisfied: false,
          sentiment: polarity,
          sentimentThemeId: row.id,
        }),
      );
    }
    return row.id;
  }

  it('drops a theme whose phrase carries an email and removes the row already stored', async () => {
    const taintedId = await seedTheme('slow reply to sara@acme.com', 'negative');
    const cleanId = await seedTheme('long wait for a quote', 'negative');
    const expRepo = AppDataSource.getRepository(InsightExperiment);
    await expRepo.save(
      expRepo.create({
        tenantId,
        kind: 'sentiment',
        fingerprint: taintedId,
        severity: 'orange',
        title: 'Customers frequently mention "slow reply to sara@acme.com" — 3 sessions in 30 days',
        payload: { theme: 'slow reply to sara@acme.com', polarity: 'negative', sessions: 3 },
        state: 'active',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      }),
    );

    await aggregateSentiment(tenantId, NOW);

    const res = await request(app).get('/api/v1/insights/experiments');
    expect(res.status).toBe(200);
    const titles = (res.body.data.experiments as Array<{ title: string }>).map((e) => e.title);
    expect(titles.join(' ')).not.toContain('sara@acme.com');
    expect(titles.some((t) => t.includes('long wait for a quote'))).toBe(true);
    expect(await expRepo.findOne({ where: { fingerprint: taintedId } })).toBeNull();
    expect(await expRepo.findOne({ where: { fingerprint: cleanId } })).not.toBeNull();
  });
});
