import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (before imports) ──────────────────────────────────────────────────

const { state } = vi.hoisted(() => ({
  state: {
    tenantId: 'tenant-1' as string | undefined,
    features: { gapInsights: true, gapEvidence: true, aiBusinessInsights: false },
    gapRows: [] as Array<Record<string, unknown>>,
    gapEntity: null as Record<string, unknown> | null,
    savedGap: null as Record<string, unknown> | null,
  },
}));

vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (req: any, _res: any, next: any) => {
    req.user = state.tenantId ? { tenantId: state.tenantId } : {};
    next();
  },
  autoProvision: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/super-admin.middleware', () => ({
  resolveTenantContext: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../billing/entitlements', () => ({
  getEntitlements: async () => ({ features: state.features }),
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
      return {};
    },
    query: async () => [],
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import express from 'express';
import request from 'supertest';
import insightsRoutes from '../../routes/insights.routes';
import { errorHandler } from '../../middleware/error-handler';

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
  state.gapEntity = null;
  state.savedGap = null;
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
      first_detected_at: '2026-06-08', last_seen_at: '2026-06-10',
      resolved_at: null, archived_at: null, recommendation: null,
    }];
    const res = await request(createApp()).get('/insights');
    expect(res.status).toBe(200);
    expect(res.body.data.gaps).toEqual([
      expect.objectContaining({ id: 'g1', topic: 'pricing', severity: 'red', distinctVisitors: 5 }),
    ]);
    expect(res.body.data.meta).toMatchObject({
      retentionDays: 90,
      evidenceEnabled: true,
      completeness: 1,
    });
  });

  it('retention 365d with aiBusinessInsights, 30d with neither', async () => {
    state.features = { gapInsights: true, gapEvidence: true, aiBusinessInsights: true };
    let res = await request(createApp()).get('/insights');
    expect(res.body.data.meta.retentionDays).toBe(365);

    state.features = { gapInsights: true, gapEvidence: false, aiBusinessInsights: false };
    res = await request(createApp()).get('/insights');
    expect(res.body.data.meta.retentionDays).toBe(30);
    expect(res.body.data.meta.evidenceEnabled).toBe(false);
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
