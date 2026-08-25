import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (before imports) ──────────────────────────────────────────────────

const { state } = vi.hoisted(() => ({
  state: {
    tenantId: 'tenant-1' as string | undefined,
    role: 'admin' as string,
    features: { gapInsights: true, gapEvidence: true, aiBusinessInsights: false },
    gapRows: [] as Array<Record<string, unknown>>,
    experimentRows: [] as Array<Record<string, unknown>>,
    queryRows: [] as Array<Record<string, unknown>>,
    askRows: [] as Array<Record<string, unknown>>,
    gapEntity: null as Record<string, unknown> | null,
    savedGap: null as Record<string, unknown> | null,
    answerCalls: [] as Array<[string, string, string]>,
    answerError: null as Error | null,
  },
}));

vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (req: any, _res: any, next: any) => {
    req.user = state.tenantId ? { tenantId: state.tenantId, role: state.role } : {};
    req.userId = 'user-1';
    next();
  },
  autoProvision: (_req: any, _res: any, next: any) => next(),
}));

// The answer service owns the publish; these tests own the wiring around it (role gate,
// feature gate, body validation, audit). Its behaviour is proved against real Postgres
// in integration/gap-answer.test.ts.
vi.mock('../../insights/gap-answer.service', () => ({
  answerGap: async (tenantId: string, gapId: string, answer: string) => {
    state.answerCalls.push([tenantId, gapId, answer]);
    if (state.answerError) throw state.answerError;
    return { id: gapId, answerDocumentId: 'doc-1', answeredAt: new Date('2026-08-26T00:00:00Z') };
  },
}));

vi.mock('../../utils/audit', () => ({ logAudit: vi.fn(async () => undefined) }));

vi.mock('../../middleware/super-admin.middleware', () => ({
  resolveTenantContext: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../billing/entitlements', () => ({
  // ceiling == effective in these tests (no tenant toggles), so the gate's
  // disabled_by_tenant-vs-not_entitled check resolves to not_entitled → 403.
  getEntitlements: async () => ({ features: state.features, entitledFeatures: state.features }),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name: string }) => {
      if (entity.name === 'Gap') {
        const qb: any = {};
        for (const m of ['leftJoin', 'select', 'addSelect', 'where', 'andWhere', 'orderBy']) {
          qb[m] = () => qb;
        }
        qb.getRawMany = async () => state.gapRows;
        return {
          createQueryBuilder: () => qb,
          findOne: async () => state.gapEntity,
          save: async (g: Record<string, unknown>) => {
            state.savedGap = g;
            return g;
          },
        };
      }
      if (entity.name === 'InsightsRefreshState') {
        return {
          findOne: async () => ({
            lastRefreshedAt: new Date('2026-06-11T02:00:00Z'),
            judgmentsCompleteness: '1.0000',
          }),
        };
      }
      if (entity.name === 'Judgment') {
        const qb: any = {};
        for (const m of ['where', 'andWhere', 'orderBy', 'limit']) qb[m] = () => qb;
        qb.getMany = async () => [];
        return { createQueryBuilder: () => qb };
      }
      if (entity.name === 'InsightExperiment') {
        const qb: any = {};
        for (const m of ['where', 'andWhere', 'orderBy', 'addOrderBy']) qb[m] = () => qb;
        qb.getMany = async () => state.experimentRows;
        return { createQueryBuilder: () => qb };
      }
      return {};
    },
    // The list route runs two raw queries (trend, before/after asks), so the mock has to
    // tell them apart instead of handing both the same rows.
    query: async (sql: string) =>
      sql.includes('"asksBefore"') ? state.askRows : state.queryRows,
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import express from 'express';
import request from 'supertest';
import insightsRoutes from '../../routes/insights.routes';
import { errorHandler, ApiError } from '../../middleware/error-handler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/insights', insightsRoutes);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  state.tenantId = 'tenant-1';
  state.features = { gapInsights: true, gapEvidence: true, aiBusinessInsights: false };
  state.gapRows = [];
  state.experimentRows = [];
  state.queryRows = [];
  state.askRows = [];
  state.gapEntity = null;
  state.savedGap = null;
  state.role = 'admin';
  state.answerCalls = [];
  state.answerError = null;
});

describe('insights routes — feature gating (ADR-0013)', () => {
  it('403s the whole surface without gapInsights', async () => {
    state.features = { gapInsights: false, gapEvidence: false, aiBusinessInsights: false };
    const res = await request(createApp()).get('/insights');
    expect(res.status).toBe(403);
  });

  it('403s evidence without gapEvidence even when gapInsights is on', async () => {
    state.features = { gapInsights: true, gapEvidence: false, aiBusinessInsights: false };
    const res = await request(createApp()).get('/insights/some-gap/evidence');
    expect(res.status).toBe(403);
  });

  it('lists gaps with meta; retention follows the flag set (gapEvidence → 90d)', async () => {
    state.gapRows = [{
      id: 'g1', topic: 'pricing', status: 'open', severity: 'red',
      occurrences: 7, distinct_visitors: 5,
      recommendation: 'Publish clear pricing in the knowledge base.',
      first_detected_at: '2026-06-08', last_seen_at: '2026-06-10',
      resolved_at: null, archived_at: null,
    }];
    const res = await request(createApp()).get('/insights');
    expect(res.status).toBe(200);
    expect(res.body.data.gaps).toEqual([
      expect.objectContaining({
        id: 'g1',
        topic: 'pricing',
        severity: 'red',
        priorityScore: 21,
        recommendation: 'Publish clear pricing in the knowledge base.',
        distinctVisitors: 5,
      }),
    ]);
    expect(res.body.data.meta).toMatchObject({
      retentionDays: 90,
      evidenceEnabled: true,
      completeness: 1,
    });
  });

  it('leaves the before/after counts null while the Gap has no answer document', async () => {
    state.gapRows = [{
      id: 'g1', canonical_topic_id: 't1', topic: 'pricing', status: 'open', severity: 'red',
      occurrences: 7, distinct_visitors: 5,
      first_detected_at: '2026-06-08', last_seen_at: '2026-06-10',
      resolved_at: null, archived_at: null,
      answer_document_id: null, answered_at: null,
    }];
    // Rows exist for the topic; the null answer document, not the absence of evidence,
    // is what keeps the counts null.
    state.askRows = [{ canonicalTopicId: 't1', asksBefore: 4, asksSince: 2 }];

    const res = await request(createApp()).get('/insights');
    expect(res.status).toBe(200);
    expect(res.body.data.gaps[0].asksBeforeAnswer).toBeNull();
    expect(res.body.data.gaps[0].asksSinceAnswer).toBeNull();
  });

  it('reports the before/after counts for an answered Gap, and 0 since is a real number', async () => {
    state.gapRows = [
      {
        id: 'g1', canonical_topic_id: 't1', topic: 'pricing', status: 'open', severity: 'red',
        occurrences: 7, distinct_visitors: 5,
        first_detected_at: '2026-06-08', last_seen_at: '2026-06-10',
        resolved_at: null, archived_at: null,
        answer_document_id: 'doc-1', answered_at: '2026-06-09',
      },
      {
        id: 'g2', canonical_topic_id: 't2', topic: 'delivery', status: 'open', severity: 'orange',
        occurrences: 1, distinct_visitors: 1,
        first_detected_at: '2026-06-08', last_seen_at: '2026-06-09',
        resolved_at: null, archived_at: null,
        answer_document_id: 'doc-2', answered_at: '2026-06-09',
      },
    ];
    // t2 has no row at all: an answered topic nobody ever asked still counts as 0/0.
    state.askRows = [{ canonicalTopicId: 't1', asksBefore: 4, asksSince: 0 }];

    const res = await request(createApp()).get('/insights');
    expect(res.status).toBe(200);
    const byId = new Map(
      (res.body.data.gaps as Array<{ id: string }>).map((gap) => [gap.id, gap]),
    );
    expect(byId.get('g1')).toMatchObject({ asksBeforeAnswer: 4, asksSinceAnswer: 0 });
    expect(byId.get('g2')).toMatchObject({ asksBeforeAnswer: 0, asksSinceAnswer: 0 });
  });

  it('hides optimization suggestions from Essential and from closed Gaps', async () => {
    state.gapRows = [{
      id: 'g1', topic: 'pricing', status: 'resolved_data', severity: 'green',
      occurrences: 2, distinct_visitors: 2,
      recommendation: 'Stale suggestion',
      first_detected_at: '2026-06-08', last_seen_at: '2026-06-10',
      resolved_at: '2026-06-11', archived_at: null,
    }];

    let res = await request(createApp()).get('/insights');
    expect(res.body.data.gaps[0].recommendation).toBeNull();

    state.features = { gapInsights: true, gapEvidence: false, aiBusinessInsights: false };
    state.gapRows[0].status = 'open';
    res = await request(createApp()).get('/insights');
    expect(res.body.data.gaps[0].recommendation).toBeNull();
  });

  it('retention 365d with aiBusinessInsights, 30d with neither', async () => {
    state.features = { gapInsights: true, gapEvidence: true, aiBusinessInsights: true };
    let res = await request(createApp()).get('/insights');
    expect(res.body.data.meta.retentionDays).toBe(365);

    state.features = { gapInsights: true, gapEvidence: false, aiBusinessInsights: false };
    res = await request(createApp()).get('/insights');
    expect(res.body.data.meta.retentionDays).toBe(30);
    expect(res.body.data.meta.evidenceEnabled).toBe(false);
    expect(res.body.data.gaps).toEqual([]);
  });

  it('exposes sentiment trends to Pro+ and rejects Essential', async () => {
    state.queryRows = [{ date: new Date().toISOString().slice(0, 10), sentiment: 'positive', count: 2 }];
    let res = await request(createApp()).get('/insights/sentiment/trend?days=7');
    expect(res.status).toBe(200);
    expect(res.body.data.windowDays).toBe(7);
    expect(res.body.data.timeseries).toHaveLength(7);
    expect(res.body.data.timeseries.at(-1).positive).toBe(2);

    state.features = { gapInsights: true, gapEvidence: false, aiBusinessInsights: false };
    res = await request(createApp()).get('/insights/sentiment/trend');
    expect(res.status).toBe(403);
  });

  it('adds and sorts experiment priority scores', async () => {
    state.features = { gapInsights: true, gapEvidence: true, aiBusinessInsights: true };
    state.experimentRows = [
      {
        id: 'low',
        kind: 'sentiment',
        severity: 'orange',
        title: 'Low',
        payload: { sessions: 3 },
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
      {
        id: 'high',
        kind: 'correlation',
        severity: 'red',
        title: 'High',
        payload: { a: 10, b: 10, c: 10, d: 10 },
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
    ];

    const res = await request(createApp()).get('/insights/experiments');
    expect(res.status).toBe(200);
    expect(res.body.data.experiments.map((experiment: { id: string }) => experiment.id)).toEqual([
      'high',
      'low',
    ]);
    expect(res.body.data.experiments[0].priorityScore).toBe(120);
  });
});

describe('insights routes — tenant lifecycle actions (ADR-0005)', () => {
  it('resolve marks an open gap resolved_manual + green', async () => {
    state.gapEntity = { id: 'g1', tenantId: 'tenant-1', status: 'open', severity: 'red' };
    const res = await request(createApp()).post('/insights/g1/resolve');
    expect(res.status).toBe(200);
    expect(state.savedGap).toMatchObject({ status: 'resolved_manual', severity: 'green' });
  });

  it('archive marks an open gap archived', async () => {
    state.gapEntity = { id: 'g1', tenantId: 'tenant-1', status: 'open', severity: 'orange' };
    const res = await request(createApp()).post('/insights/g1/archive');
    expect(res.status).toBe(200);
    expect(state.savedGap).toMatchObject({ status: 'archived' });
  });

  it('rejects transitions from resolved states (single asks never round-trip via the API)', async () => {
    state.gapEntity = { id: 'g1', tenantId: 'tenant-1', status: 'resolved_data' };
    const res = await request(createApp()).post('/insights/g1/archive');
    expect(res.status).toBe(400);
  });

  it('404s a gap from another tenant (findOne is tenant-scoped)', async () => {
    state.gapEntity = null;
    const res = await request(createApp()).post('/insights/g1/resolve');
    expect(res.status).toBe(404);
  });
});

describe('insights routes — publishing an answer', () => {
  const body = { answer: 'Our call-out fee is 65 euro during office hours.' };

  it('publishes for an admin and passes the tenant, gap and text through', async () => {
    const res = await request(createApp()).post('/insights/g1/answer').send(body);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 'g1', answerDocumentId: 'doc-1' });
    expect(state.answerCalls).toEqual([['tenant-1', 'g1', body.answer]]);
  });

  it('403s a non-admin member: this text is repeated to customers', async () => {
    // The rest of the router has no role gate, so without the one on this route an
    // `agent` seat could publish tenant knowledge.
    state.role = 'agent';
    const res = await request(createApp()).post('/insights/g1/answer').send(body);
    expect(res.status).toBe(403);
    expect(state.answerCalls).toEqual([]);
  });

  it('403s without gapInsights', async () => {
    state.features = { gapInsights: false, gapEvidence: false, aiBusinessInsights: false };
    const res = await request(createApp()).post('/insights/g1/answer').send(body);
    expect(res.status).toBe(403);
    expect(state.answerCalls).toEqual([]);
  });

  it('422s an answer that is too short, and never reaches the service', async () => {
    const res = await request(createApp()).post('/insights/g1/answer').send({ answer: 'yes' });
    expect(res.status).toBe(422);
    expect(state.answerCalls).toEqual([]);
  });

  it('422s a missing body', async () => {
    const res = await request(createApp()).post('/insights/g1/answer').send({});
    expect(res.status).toBe(422);
  });

  it('passes the service status code through instead of a 500', async () => {
    const conflict = new ApiError('already answered', 409, 'GAP_ALREADY_ANSWERED');
    state.answerError = conflict;
    const res = await request(createApp()).post('/insights/g1/answer').send(body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GAP_ALREADY_ANSWERED');
  });
});
