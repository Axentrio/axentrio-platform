import { describe, it, expect, beforeEach, vi } from 'vitest';

const { themeStats, existingExperiments, saved, removed } = vi.hoisted(() => ({
  themeStats: [] as Array<Record<string, unknown>>,
  existingExperiments: [] as Array<Record<string, unknown>>,
  saved: [] as Array<Record<string, unknown>>,
  removed: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name: string }) => {
      if (entity.name === 'Judgment') {
        const qb: any = {};
        for (const m of ['select', 'addSelect', 'innerJoin', 'where', 'andWhere', 'groupBy', 'addGroupBy']) {
          qb[m] = () => qb;
        }
        qb.getRawMany = async () => themeStats;
        return { createQueryBuilder: () => qb };
      }
      if (entity.name === 'InsightExperiment') {
        return {
          find: async () => existingExperiments,
          create: (e: Record<string, unknown>) => e,
          save: async (e: Record<string, unknown>) => { saved.push(e); return e; },
          remove: async (e: Record<string, unknown>) => { removed.push(e); return e; },
        };
      }
      throw new Error(`unexpected repo ${entity.name}`);
    },
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { aggregateSentiment } from '../../insights/sentiment-aggregation.service';

const NOW = new Date('2026-06-15T02:00:00Z');

function stat(themeId: string, sessions: number, polarity = 'negative', theme = 'slow response') {
  return { themeId, theme, polarity, sessions: String(sessions), lastAt: '2026-06-14T00:00:00Z' };
}

beforeEach(() => {
  themeStats.length = 0;
  existingExperiments.length = 0;
  saved.length = 0;
  removed.length = 0;
});

describe('insights · sentiment aggregation (P3 D5)', () => {
  it('surfaces a theme only at >= 3 distinct sessions (recurrence gate)', async () => {
    themeStats.push(stat('t1', 2), stat('t2', 3));
    await aggregateSentiment('tenant-1', NOW);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ kind: 'sentiment', fingerprint: 't2', state: 'active' });
    expect(saved[0].title).toMatch(/slow response.*3 sessions/);
  });

  it('escalates to red for a negative theme at >= 8 sessions', async () => {
    themeStats.push(stat('t1', 8, 'negative'));
    await aggregateSentiment('tenant-1', NOW);
    expect(saved[0]).toMatchObject({ severity: 'red' });
  });

  it('keeps orange for positive/low-volume themes', async () => {
    themeStats.push(stat('t1', 9, 'positive', 'friendly staff'));
    await aggregateSentiment('tenant-1', NOW);
    expect(saved[0]).toMatchObject({ severity: 'orange' });
    expect(saved[0].title).toMatch(/praise "friendly staff"/);
  });

  it('upserts an existing active experiment, preserving its state', async () => {
    existingExperiments.push({ tenantId: 'tenant-1', kind: 'sentiment', fingerprint: 't1', state: 'active', severity: 'orange' });
    themeStats.push(stat('t1', 5));
    await aggregateSentiment('tenant-1', NOW);
    expect(removed).toHaveLength(0);
    expect(saved[0]).toMatchObject({ fingerprint: 't1', state: 'active' });
  });

  it('prunes a fallen-below-threshold experiment — unless dismissed', async () => {
    existingExperiments.push(
      { tenantId: 'tenant-1', kind: 'sentiment', fingerprint: 'gone', state: 'active' },
      { tenantId: 'tenant-1', kind: 'sentiment', fingerprint: 'dismissed-gone', state: 'dismissed' },
    );
    themeStats.length = 0; // nothing qualifies this window
    await aggregateSentiment('tenant-1', NOW);
    expect(removed.map((r) => r.fingerprint)).toEqual(['gone']); // dismissed one survives
  });

  it('never writes a resolved state (experiments are not resolvable)', async () => {
    themeStats.push(stat('t1', 5));
    await aggregateSentiment('tenant-1', NOW);
    for (const s of saved) expect(['active', 'dismissed']).toContain(s.state);
  });
});
