import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

let mockTenantId: string | undefined = 'tenant-1';

vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (req: any, _res: any, next: any) => {
    req.user = mockTenantId ? { tenantId: mockTenantId } : {};
    next();
  },
  autoProvision: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/super-admin.middleware', () => ({
  resolveTenantContext: (_req: any, _res: any, next: any) => next(),
}));

// cached() pass-through — outcomes tests assert computation, not caching.
vi.mock('../../utils/cache', () => ({
  cached: (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * Chainable query-builder mock. Each createQueryBuilder() call shifts the
 * next row-set off the repo's queue; `where`/`andWhere` params are recorded
 * for tenant-scoping assertions. Hoisted so the vi.mock factory below
 * (which vitest lifts above all declarations) can reference them.
 */
const { sessionQueue, bookingQueue, leadQueue, whereCalls, makeRepo } = vi.hoisted(() => {
  const sessionQueue: Array<Array<Record<string, string>>> = [];
  const bookingQueue: Array<Array<Record<string, string>>> = [];
  const leadQueue: Array<Array<Record<string, string>>> = [];
  const whereCalls: Array<Record<string, unknown>> = [];
  function makeRepo(queue: Array<Array<Record<string, string>>>) {
    return {
      createQueryBuilder: () => {
        const rows = queue.shift() ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const qb: any = {};
        for (const m of ['select', 'addSelect', 'groupBy', 'orderBy', 'limit']) {
          qb[m] = () => qb;
        }
        qb.where = (_sql: string, params?: Record<string, unknown>) => {
          if (params) whereCalls.push(params);
          return qb;
        };
        qb.andWhere = qb.where;
        qb.getRawMany = async () => rows;
        qb.getRawOne = async () => undefined;
        return qb;
      },
      find: async () => [],
    };
  }
  return { sessionQueue, bookingQueue, leadQueue, whereCalls, makeRepo };
});

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name: string }) => {
      if (entity.name === 'ChatSession') return makeRepo(sessionQueue);
      if (entity.name === 'Booking') return makeRepo(bookingQueue);
      if (entity.name === 'Lead') return makeRepo(leadQueue);
      return makeRepo([]);
    },
    query: vi.fn(),
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import express from 'express';
import request from 'supertest';
import analyticsRoutes from '../../routes/analytics.routes';
import { errorHandler } from '../../middleware/error-handler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/analytics', analyticsRoutes);
  app.use(errorHandler);
  return app;
}

describe('GET /analytics/outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTenantId = 'tenant-1';
    sessionQueue.length = 0;
    bookingQueue.length = 0;
    leadQueue.length = 0;
    whereCalls.length = 0;
  });

  it('returns current + previous aggregates with totals and breakdowns', async () => {
    // current window rows, then previous window rows (per repo)
    sessionQueue.push(
      [{ key: 'widget', count: '5' }, { key: 'whatsapp', count: '3' }],
      [{ key: 'widget', count: '2' }],
    );
    bookingQueue.push(
      [{ key: 'whatsapp', count: '2' }, { key: 'direct', count: '1' }],
      [],
    );
    leadQueue.push(
      [{ key: 'tool', count: '4' }],
      [{ key: 'tool', count: '1' }, { key: 'manual', count: '1' }],
    );

    const res = await request(createApp())
      .get('/analytics/outcomes')
      .query({ from: '2026-06-01', to: '2026-06-08' });

    expect(res.status).toBe(200);
    const { current, previous, range, previousRange } = res.body.data;

    expect(current.conversations).toEqual({ total: 8, byChannel: { widget: 5, whatsapp: 3 } });
    expect(current.bookings).toEqual({ total: 3, byChannel: { whatsapp: 2, direct: 1 } });
    expect(current.leads).toEqual({ total: 4, bySource: { tool: 4 } });

    expect(previous.conversations.total).toBe(2);
    expect(previous.bookings).toEqual({ total: 0, byChannel: {} });
    expect(previous.leads.total).toBe(2);

    // Previous window is the same-length window ending where current starts.
    expect(previousRange.to).toBe(range.from);
    expect(new Date(range.to).getTime() - new Date(range.from).getTime()).toBe(
      new Date(previousRange.to).getTime() - new Date(previousRange.from).getTime(),
    );
  });

  it('scopes every query to the authenticated tenant', async () => {
    sessionQueue.push([], []);
    bookingQueue.push([], []);
    leadQueue.push([], []);

    const res = await request(createApp())
      .get('/analytics/outcomes')
      .query({ from: '2026-06-01', to: '2026-06-08' });

    expect(res.status).toBe(200);
    const tenantParams = whereCalls.filter((p) => 'tenantId' in p);
    // 3 repos × 2 windows = 6 tenant-scoped queries
    expect(tenantParams).toHaveLength(6);
    for (const p of tenantParams) expect(p.tenantId).toBe('tenant-1');
  });

  it('defaults to a 7-day window when no range is given', async () => {
    sessionQueue.push([], []);
    bookingQueue.push([], []);
    leadQueue.push([], []);

    const res = await request(createApp()).get('/analytics/outcomes');

    expect(res.status).toBe(200);
    const { range } = res.body.data;
    const spanDays = (new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000;
    expect(spanDays).toBeCloseTo(7, 5);
  });

  it('400s without tenant context', async () => {
    mockTenantId = undefined;
    const res = await request(createApp()).get('/analytics/outcomes');
    expect(res.status).toBe(400);
  });
});

describe('GET /analytics/outcomes/timeseries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTenantId = 'tenant-1';
    sessionQueue.length = 0;
    bookingQueue.length = 0;
    leadQueue.length = 0;
    whereCalls.length = 0;
  });

  it('merges the three sparse series into one sorted row per active day', async () => {
    sessionQueue.push([
      { date: '2026-06-02', count: '4' },
      { date: '2026-06-03', count: '1' },
    ]);
    bookingQueue.push([{ date: '2026-06-03', count: '2' }]);
    leadQueue.push([{ date: '2026-06-01', count: '1' }]);

    const res = await request(createApp())
      .get('/analytics/outcomes/timeseries')
      .query({ from: '2026-06-01', to: '2026-06-08' });

    expect(res.status).toBe(200);
    expect(res.body.data.timeseries).toEqual([
      { date: '2026-06-01', conversations: 0, bookings: 0, leads: 1 },
      { date: '2026-06-02', conversations: 4, bookings: 0, leads: 0 },
      { date: '2026-06-03', conversations: 1, bookings: 2, leads: 0 },
    ]);
  });
});
