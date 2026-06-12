import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Orchestration tests for RefreshInsightsJob — the watermark/backfill/
 * completeness/flag-gating logic where the encrypted-content bug lived
 * (caught only by live validation; these lock the contract down).
 */

// ── Hoisted state ───────────────────────────────────────────────────────────

const st = vi.hoisted(() => ({
  // ChatSession query-builder result (eligible sessions)
  eligibleSessions: [] as Array<Record<string, unknown>>,
  capturedLimit: 0,
  capturedSinceParams: [] as Array<Record<string, unknown>>,
  // Judgment repo
  existingJudgments: new Set<string>(),
  savedJudgments: [] as Array<Record<string, unknown>>,
  /** Errors to throw on successive Judgment.save calls (null = succeed). */
  saveErrorQueue: [] as Array<Error | null>,
  // Refresh state repo
  state: null as Record<string, unknown> | null,
  savedState: null as Record<string, unknown> | null,
  // AppDataSource.query responses: transcript rows by session, completeness counts
  transcripts: {} as Record<string, Array<Record<string, unknown>>>,
  eligibleCount: 0,
  judgedInWindowCount: 0,
  // Tenants for the once-runner
  tenants: [] as Array<{ id: string }>,
  entitled: {} as Record<string, boolean>,
  refreshedTenants: [] as string[],
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../utils/encryption', () => ({
  decrypt: (s: string) => {
    if (s === 'BOOM') throw new Error('decrypt failed');
    return `plain:${s}`;
  },
}));

const judgeMock = vi.hoisted(() => vi.fn());
vi.mock('../../insights/judge.service', () => ({
  judgeTranscript: judgeMock,
}));

const canonMock = vi.hoisted(() => vi.fn());
vi.mock('../../insights/topics.service', () => ({
  canonicalizeTopic: canonMock,
}));

const aggregateMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock('../../insights/gap-aggregation.service', () => ({
  aggregateGaps: aggregateMock,
}));

vi.mock('../../billing/entitlements', () => ({
  getEntitlements: async (tenantId: string) => ({
    features: { gapInsights: st.entitled[tenantId] ?? false },
  }),
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name: string }) => {
      if (entity.name === 'ChatSession') {
        const qb: any = {};
        for (const m of ['select', 'addSelect', 'orderBy']) qb[m] = () => qb;
        qb.where = (_s: string, p?: Record<string, unknown>) => { if (p) st.capturedSinceParams.push(p); return qb; };
        qb.andWhere = qb.where;
        qb.limit = (n: number) => { st.capturedLimit = n; return qb; };
        qb.getRawMany = async () => st.eligibleSessions;
        return { createQueryBuilder: () => qb };
      }
      if (entity.name === 'Judgment') {
        return {
          findOne: async ({ where }: any) =>
            st.existingJudgments.has(where.sessionId) ? { sessionId: where.sessionId } : null,
          create: (j: Record<string, unknown>) => j,
          save: async (j: Record<string, unknown>) => {
            const err = st.saveErrorQueue.shift() ?? null;
            if (err) throw err;
            st.savedJudgments.push(j);
            return j;
          },
        };
      }
      if (entity.name === 'InsightsRefreshState') {
        return {
          findOne: async () => st.state,
          create: (s: Record<string, unknown>) => s,
          save: async (s: Record<string, unknown>) => { st.savedState = s; return s; },
        };
      }
      if (entity.name === 'Tenant') {
        const qb: any = {};
        for (const m of ['select', 'where']) qb[m] = () => qb;
        qb.getRawMany = async () => st.tenants;
        return { createQueryBuilder: () => qb };
      }
      throw new Error(`unexpected repo ${entity.name}`);
    },
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM messages')) return st.transcripts[params[0] as string] ?? [];
      if (sql.includes('judgedInWindow') || sql.includes('JOIN chatbot_judgments')) {
        return [{ judgedInWindow: st.judgedInWindowCount }];
      }
      return [{ eligible: st.eligibleCount }];
    },
  },
}));

import { refreshTenantInsights, runRefreshInsightsOnce } from '../../insights/refresh-insights.job';

const NOW = new Date('2026-06-12T02:00:00Z');
const T = 'tenant-1';

function session(id: string, endedAt: string) {
  return { id, visitorId: `v-${id}`, status: 'closed', startedAt: new Date(endedAt), effectiveEndedAt: endedAt };
}

beforeEach(() => {
  st.eligibleSessions = [];
  st.capturedLimit = 0;
  st.capturedSinceParams = [];
  st.existingJudgments = new Set();
  st.savedJudgments = [];
  st.saveErrorQueue = [];
  st.state = null;
  st.savedState = null;
  st.transcripts = {};
  st.eligibleCount = 0;
  st.judgedInWindowCount = 0;
  st.tenants = [];
  st.entitled = {};
  st.refreshedTenants = [];
  judgeMock.mockReset();
  canonMock.mockReset();
  aggregateMock.mockClear();
  judgeMock.mockResolvedValue({
    hadQuestion: false, satisfied: null, topicPhrase: null, evidenceMessageIds: [], reasoning: null,
  });
});

describe('refreshTenantInsights — watermark semantics', () => {
  it('advances the watermark to `now` on a clean run', async () => {
    st.eligibleSessions = [session('s1', '2026-06-11T10:00:00Z'), session('s2', '2026-06-11T11:00:00Z')];
    st.eligibleCount = 2; st.judgedInWindowCount = 2;
    await refreshTenantInsights(T, NOW);
    expect(st.savedJudgments).toHaveLength(2);
    expect(st.savedState!.lastRefreshedAt).toEqual(NOW);
    expect(st.savedState!.lastRunError).toBeNull();
  });

  it('freezes the watermark at the first failure but still attempts later sessions', async () => {
    st.eligibleSessions = [
      session('ok1', '2026-06-11T10:00:00Z'),
      session('fail', '2026-06-11T11:00:00Z'),
      session('ok2', '2026-06-11T12:00:00Z'),
    ];
    judgeMock.mockImplementation(async (transcript: Array<{ id: string }>) => {
      if (transcript[0]?.id === 'm-fail') throw new Error('LLM exploded');
      return { hadQuestion: false, satisfied: null, topicPhrase: null, evidenceMessageIds: [], reasoning: null };
    });
    st.transcripts = {
      ok1: [{ id: 'm-ok1', content: 'hi', contentEncrypted: false, sender: 'user' }],
      fail: [{ id: 'm-fail', content: 'hi', contentEncrypted: false, sender: 'user' }],
      ok2: [{ id: 'm-ok2', content: 'hi', contentEncrypted: false, sender: 'user' }],
    };
    await refreshTenantInsights(T, NOW);
    // ok2 was still judged (throughput), but the watermark stayed at ok1's
    // endedAt so `fail` retries next run.
    expect(st.savedJudgments.map((j) => j.sessionId)).toEqual(['ok1', 'ok2']);
    expect(st.savedState!.lastRefreshedAt).toEqual(new Date('2026-06-11T10:00:00Z'));
    expect(st.savedState!.lastRunError).toMatch(/1 session/);
  });

  it('treats a concurrent-run duplicate insert as a skip, not a failure', async () => {
    st.eligibleSessions = [session('dup', '2026-06-11T10:00:00Z'), session('s2', '2026-06-11T11:00:00Z')];
    // First save hits the unique constraint (a concurrent run already judged
    // the session); the second succeeds.
    st.saveErrorQueue = [
      new Error('duplicate key value violates unique constraint "uq_judgments_session"'),
      null,
    ];
    await refreshTenantInsights(T, NOW);
    expect(st.savedJudgments.map((j) => j.sessionId)).toEqual(['s2']);
    // Watermark advanced to `now` — the duplicate did NOT freeze it.
    expect(st.savedState!.lastRefreshedAt).toEqual(NOW);
    expect(st.savedState!.lastRunError).toBeNull();
  });
});

describe('refreshTenantInsights — backfill + skip + completeness', () => {
  it('first run uses the 7-day backfill window capped at 500', async () => {
    await refreshTenantInsights(T, NOW);
    expect(st.capturedLimit).toBe(500);
    const since = st.capturedSinceParams.find((p) => 'since' in p)?.since as Date;
    expect(NOW.getTime() - since.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('subsequent runs start from the stored watermark', async () => {
    const mark = new Date('2026-06-11T20:00:00Z');
    st.state = { tenantId: T, lastRefreshedAt: mark };
    await refreshTenantInsights(T, NOW);
    const since = st.capturedSinceParams.find((p) => 'since' in p)?.since;
    expect(since).toEqual(mark);
  });

  it('skips already-judged sessions and still advances the watermark past them', async () => {
    st.eligibleSessions = [session('done', '2026-06-11T10:00:00Z')];
    st.existingJudgments = new Set(['done']);
    await refreshTenantInsights(T, NOW);
    expect(st.savedJudgments).toHaveLength(0);
    expect(judgeMock).not.toHaveBeenCalled();
    expect(st.savedState!.lastRefreshedAt).toEqual(NOW);
  });

  it('computes completeness = judged/eligible for the 7-day window', async () => {
    st.eligibleCount = 10; st.judgedInWindowCount = 9;
    await refreshTenantInsights(T, NOW);
    expect(st.savedState!.judgmentsCompleteness).toBe('0.9000');
    expect(aggregateMock).toHaveBeenCalledWith(T, NOW);
  });
});

describe('refreshTenantInsights — transcript decryption', () => {
  it('decrypts encrypted rows before judging (the live-caught bug)', async () => {
    st.eligibleSessions = [session('s1', '2026-06-11T10:00:00Z')];
    st.transcripts = {
      s1: [
        { id: 'm1', content: 'CIPHER', contentEncrypted: true, sender: 'user' },
        { id: 'm2', content: 'already-plain', contentEncrypted: false, sender: 'bot' },
      ],
    };
    await refreshTenantInsights(T, NOW);
    const transcript = judgeMock.mock.calls[0][0];
    expect(transcript[0].content).toBe('plain:CIPHER');
    expect(transcript[1].content).toBe('already-plain');
  });

  it('a decrypt failure fails the session and freezes the watermark for retry', async () => {
    st.eligibleSessions = [session('bad', '2026-06-11T10:00:00Z')];
    st.transcripts = { bad: [{ id: 'm1', content: 'BOOM', contentEncrypted: true, sender: 'user' }] };
    await refreshTenantInsights(T, NOW);
    expect(st.savedJudgments).toHaveLength(0);
    expect(st.savedState!.lastRefreshedAt).toBeNull(); // nothing succeeded before the failure
    expect(st.savedState!.lastRunError).toMatch(/1 session/);
  });
});

describe('runRefreshInsightsOnce — flag gating (ADR-0013: flags, never tiers)', () => {
  it('refreshes only tenants whose gapInsights flag is on', async () => {
    st.tenants = [{ id: 'entitled-1' }, { id: 'free-1' }, { id: 'entitled-2' }];
    st.entitled = { 'entitled-1': true, 'free-1': false, 'entitled-2': true };
    await runRefreshInsightsOnce(NOW);
    // refreshTenantInsights persists a state row per refreshed tenant; the
    // unentitled tenant must not produce one. We observe via savedState
    // writes: 2 tenants → state saved twice (last one retained in st).
    // Cheaper assertion: aggregateGaps called once per entitled tenant only.
    expect(aggregateMock.mock.calls.map((c) => c[0])).toEqual(['entitled-1', 'entitled-2']);
  });
});
