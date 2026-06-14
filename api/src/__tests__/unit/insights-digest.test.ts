import { describe, it, expect, beforeEach, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    counts: [] as number[],
    countIdx: 0,
    topExp: null as Record<string, unknown> | null,
    tenant: null as Record<string, unknown> | null,
    existing: null as Record<string, unknown> | null,
    saved: [] as Array<Record<string, unknown>>,
    narrative: 'A warm grounded summary.',
  },
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    // countSince(sql, params) → [{ count }]
    query: async () => [{ count: state.counts[state.countIdx++] ?? 0 }],
    getRepository: (entity: { name: string }) => {
      if (entity.name === 'InsightExperiment') return { findOne: async () => state.topExp };
      if (entity.name === 'Tenant') return { findOne: async () => state.tenant };
      if (entity.name === 'InsightDigest') {
        return {
          findOne: async () => state.existing,
          create: (e: Record<string, unknown>) => e,
          save: async (e: Record<string, unknown>) => { state.saved.push(e); return e; },
        };
      }
      throw new Error(`unexpected repo ${entity.name}`);
    },
  },
}));

vi.mock('../../llm/provider-factory', () => ({
  getProvider: () => ({
    chat: async () => ({ content: state.narrative, usage: { promptTokens: 1, completionTokens: 1 } }),
  }),
}));
vi.mock('../../llm/defaults', () => ({ DEFAULT_PROVIDER: 'openai', DEFAULT_MODEL: 'gpt' }));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { generateDigest, weekStartFor, digestEmailEnabled } from '../../insights/digest.service';

beforeEach(() => {
  state.counts = [10, 5, 3, 1, 2, 0, 4, 2]; // conv c/p, book c/p, lead c/p, gapsOpened, gapsWon
  state.countIdx = 0;
  state.topExp = null;
  state.tenant = { id: 't1', settings: {} };
  state.existing = null;
  state.saved = [];
});

describe('insights · digest weekStart (P3 D6)', () => {
  it('summarizes the COMPLETE prior week — a Monday run yields the Monday 7 days back', () => {
    // Mon 2026-06-15 02:00 UTC → week of Mon 2026-06-08.
    expect(weekStartFor(new Date('2026-06-15T02:00:00Z'))).toBe('2026-06-08');
  });

  it('is stable across any day of the running week', () => {
    // Any day Mon..Sun resolves to the most-recent-Monday-minus-7.
    expect(weekStartFor(new Date('2026-06-17T23:00:00Z'))).toBe('2026-06-08'); // Wed
    expect(weekStartFor(new Date('2026-06-21T10:00:00Z'))).toBe('2026-06-08'); // Sun
  });
});

describe('insights · digestEmailEnabled (default-ON)', () => {
  it('defaults on; only explicit false opts out', () => {
    expect(digestEmailEnabled({ settings: {} } as never)).toBe(true);
    expect(digestEmailEnabled({ settings: { insights: {} } } as never)).toBe(true);
    expect(digestEmailEnabled({ settings: { insights: { digestEmail: true } } } as never)).toBe(true);
    expect(digestEmailEnabled({ settings: { insights: { digestEmail: false } } } as never)).toBe(false);
  });
});

describe('insights · generateDigest (P3 D6)', () => {
  it('creates a pending digest with computed metrics + narrative', async () => {
    await generateDigest('t1', new Date('2026-06-15T02:00:00Z'));
    expect(state.saved).toHaveLength(1);
    const d = state.saved[0];
    expect(d.weekStart).toBe('2026-06-08');
    expect(d.sendState).toBe('pending');
    expect(d.sendNextAttemptAt).toBeInstanceOf(Date);
    expect(d.summaryMd).toBe('A warm grounded summary.');
    expect(d.metrics).toMatchObject({
      conversations: { current: 10, previous: 5 },
      bookings: { current: 3, previous: 1 },
      leads: { current: 2, previous: 0 },
      gapsOpened: 4,
      gapsWon: 2,
    });
  });

  it('writes skipped (no send) when the tenant opted out of the email', async () => {
    state.tenant = { id: 't1', settings: { insights: { digestEmail: false } } };
    await generateDigest('t1', new Date('2026-06-15T02:00:00Z'));
    expect(state.saved[0].sendState).toBe('skipped');
    expect(state.saved[0].sendNextAttemptAt).toBeNull();
  });

  it('refreshes an existing pending row in place (idempotent on tenant+week)', async () => {
    state.existing = { id: 'd1', tenantId: 't1', weekStart: '2026-06-08', sendState: 'pending', summaryMd: 'old' };
    await generateDigest('t1', new Date('2026-06-15T02:00:00Z'));
    expect(state.saved).toHaveLength(1);
    expect(state.saved[0].id).toBe('d1'); // same row, not a new insert
    expect(state.saved[0].summaryMd).toBe('A warm grounded summary.');
  });

  it('never disturbs a row already sent', async () => {
    state.existing = { id: 'd1', tenantId: 't1', weekStart: '2026-06-08', sendState: 'sent', summaryMd: 'old' };
    await generateDigest('t1', new Date('2026-06-15T02:00:00Z'));
    expect(state.saved[0].sendState).toBe('sent'); // content refreshed, state untouched
  });
});
