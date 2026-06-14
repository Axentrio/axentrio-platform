import { describe, it, expect, beforeEach, vi } from 'vitest';

const { facts, rules, existing, saved, removed } = vi.hoisted(() => ({
  facts: { current: [] as Array<Record<string, unknown>> },
  rules: { current: [] as unknown[] },
  existing: { current: [] as Array<Record<string, unknown>> },
  saved: [] as Array<Record<string, unknown>>,
  removed: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    query: async () => facts.current,
    getRepository: (entity: { name: string }) => {
      if (entity.name === 'AvailabilityRule') return { find: async () => rules.current };
      if (entity.name === 'InsightExperiment') {
        return {
          find: async () => existing.current,
          findOne: async ({ where }: any) =>
            existing.current.find((e) => e.fingerprint === where.fingerprint) ?? null,
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

import { aggregateCorrelations } from '../../insights/correlation.service';

const NOW = new Date('2026-06-15T02:00:00Z');

/** n sessions on a channel, `conv` of them converted. */
function sessions(channel: string, n: number, conv: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${channel}-${i}`,
    botId: null,
    channel,
    startedAt: '2026-06-10T12:00:00Z',
    status: 'closed',
    messageCount: 5,
    booked: i < conv,
    hasLead: false,
    hitOpenGap: false,
  }));
}

beforeEach(() => {
  facts.current = [];
  rules.current = [];
  existing.current = [];
  saved.length = 0;
  removed.length = 0;
});

describe('insights · correlation gate (P3 D2)', () => {
  it('surfaces a strong channel↔conversion correlation with non-causal copy', async () => {
    // WhatsApp converts 40/60 = 67%, widget 6/60 = 10% — strong, n≥30 each.
    facts.current = [...sessions('whatsapp', 60, 40), ...sessions('widget', 60, 6)];
    await aggregateCorrelations('t1', NOW);

    const wa = saved.find((e) => e.fingerprint === 'channel-conv:whatsapp:conversion');
    expect(wa).toBeDefined();
    expect(wa!.kind).toBe('correlation');
    expect(wa!.state).toBe('active');
    expect(wa!.title).toMatch(/tend to convert more often — 67% vs 10%/);
    // NON-CAUSAL (D4): the claim must not assert causation...
    expect(String(wa!.title)).not.toMatch(/because|causes|due to/i);
    // ...and the body carries an explicit "observed, not proven cause" disclaimer.
    expect(String(wa!.detail)).toMatch(/observed pattern, not a proven cause/i);
  });

  it('suppresses when no side clears the n>=30 floor', async () => {
    facts.current = [...sessions('whatsapp', 20, 18), ...sessions('widget', 20, 2)];
    await aggregateCorrelations('t1', NOW);
    expect(saved).toHaveLength(0);
  });

  it('suppresses a real-n but weak-effect correlation', async () => {
    // 33% vs 30% — significant-ish n but RR≈1.1, below the 1.5 effect floor.
    facts.current = [...sessions('whatsapp', 100, 33), ...sessions('widget', 100, 30)];
    await aggregateCorrelations('t1', NOW);
    expect(saved.find((e) => e.fingerprint?.toString().startsWith('channel-conv'))).toBeUndefined();
  });

  it('prunes a no-longer-surviving correlation but keeps dismissed ones', async () => {
    existing.current = [
      { tenantId: 't1', kind: 'correlation', fingerprint: 'stale', state: 'active' },
      { tenantId: 't1', kind: 'correlation', fingerprint: 'stale-dismissed', state: 'dismissed' },
    ];
    facts.current = []; // nothing surfaces
    await aggregateCorrelations('t1', NOW);
    expect(removed.map((r) => r.fingerprint)).toEqual(['stale']);
  });
});
