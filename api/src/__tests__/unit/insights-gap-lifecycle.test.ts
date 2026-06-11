import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (before imports) ──────────────────────────────────────────────────

const { judgmentRows, gapRows, savedGaps } = vi.hoisted(() => ({
  judgmentRows: [] as Array<Record<string, unknown>>,
  gapRows: [] as Array<Record<string, unknown>>,
  savedGaps: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name: string }) => {
      if (entity.name === 'Judgment') {
        const qb: any = {};
        for (const m of ['where', 'andWhere']) qb[m] = () => qb;
        qb.getMany = async () => judgmentRows;
        return { createQueryBuilder: () => qb };
      }
      if (entity.name === 'Gap') {
        return {
          find: async () => gapRows,
          create: (g: Record<string, unknown>) => g,
          save: async (g: Record<string, unknown>) => {
            savedGaps.push(g);
            return g;
          },
        };
      }
      throw new Error(`unexpected repo: ${entity.name}`);
    },
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { aggregateGaps } from '../../insights/gap-aggregation.service';

const NOW = new Date('2026-06-11T02:00:00Z');
const T = 'topic-1';

function judgment(visitorId: string, satisfied: boolean, daysAgo = 1) {
  return {
    visitorId,
    satisfied,
    canonicalTopicId: T,
    sessionStartedAt: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000),
  };
}

beforeEach(() => {
  judgmentRows.length = 0;
  gapRows.length = 0;
  savedGaps.length = 0;
});

describe('insights · gap lifecycle (ADR-0005)', () => {
  it('opens a new Gap only at Qualifying Pain (≥3 distinct unsatisfied visitors)', async () => {
    judgmentRows.push(judgment('v1', false), judgment('v2', false));
    await aggregateGaps('t1', NOW);
    expect(savedGaps).toHaveLength(0); // 2 visitors — below the bar

    judgmentRows.push(judgment('v3', false));
    await aggregateGaps('t1', NOW);
    expect(savedGaps).toHaveLength(1);
    expect(savedGaps[0]).toMatchObject({ status: 'open', severity: 'orange', distinctVisitors: 3 });
  });

  it('repeat asks from the same visitor do not qualify', async () => {
    judgmentRows.push(judgment('v1', false), judgment('v1', false), judgment('v1', false));
    await aggregateGaps('t1', NOW);
    expect(savedGaps).toHaveLength(0);
  });

  it('escalates severity to red at ≥5 distinct unsatisfied visitors', async () => {
    judgmentRows.push(...['v1', 'v2', 'v3', 'v4', 'v5'].map((v) => judgment(v, false)));
    await aggregateGaps('t1', NOW);
    expect(savedGaps[0]).toMatchObject({ status: 'open', severity: 'red' });
  });

  it('resolves open → resolved_data on positive evidence (≥3 asked, ≤1 unsatisfied)', async () => {
    gapRows.push({
      tenantId: 't1', canonicalTopicId: T, status: 'open', severity: 'orange',
      occurrences: 4, distinctVisitors: 3, lastSeenAt: new Date(NOW.getTime() - 86400000),
    });
    judgmentRows.push(judgment('v1', true), judgment('v2', true), judgment('v3', false));
    await aggregateGaps('t1', NOW);
    const saved = savedGaps.find((g) => g.status === 'resolved_data');
    expect(saved).toBeDefined();
    expect(saved).toMatchObject({ severity: 'green' });
    expect(saved!.resolvedAt).toEqual(NOW);
  });

  it('reopens resolved/archived gaps only at the full bar — a single ask never reopens', async () => {
    gapRows.push({
      tenantId: 't1', canonicalTopicId: T, status: 'resolved_data', severity: 'green',
      occurrences: 0, distinctVisitors: 0, lastSeenAt: new Date(NOW.getTime() - 86400000),
      resolvedAt: new Date(NOW.getTime() - 5 * 86400000),
    });
    judgmentRows.push(judgment('v9', false));
    await aggregateGaps('t1', NOW);
    expect(savedGaps.filter((g) => g.status === 'open')).toHaveLength(0);

    judgmentRows.push(judgment('v10', false), judgment('v11', false));
    await aggregateGaps('t1', NOW);
    const reopened = savedGaps.find((g) => g.status === 'open');
    expect(reopened).toBeDefined();
    expect(reopened!.resolvedAt).toBeNull();
  });

  it('sends open gaps dormant after 14 quiet days', async () => {
    gapRows.push({
      tenantId: 't1', canonicalTopicId: 'topic-quiet', status: 'open', severity: 'orange',
      occurrences: 3, distinctVisitors: 3,
      lastSeenAt: new Date(NOW.getTime() - 15 * 86400000),
    });
    await aggregateGaps('t1', NOW);
    expect(savedGaps.find((g) => g.status === 'dormant')).toBeDefined();
  });

  it('satisfied asks are not regression — no counters from satisfied-only windows', async () => {
    gapRows.push({
      tenantId: 't1', canonicalTopicId: T, status: 'dormant', severity: 'orange',
      occurrences: 0, distinctVisitors: 0, lastSeenAt: new Date(NOW.getTime() - 20 * 86400000),
    });
    judgmentRows.push(judgment('v1', true), judgment('v2', true));
    await aggregateGaps('t1', NOW);
    expect(savedGaps.find((g) => g.status === 'open')).toBeUndefined();
  });
});
