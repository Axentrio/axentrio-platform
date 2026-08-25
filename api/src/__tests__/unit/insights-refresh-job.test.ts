import { describe, it, expect, beforeEach, vi } from "vitest";

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
  capturedWhere: [] as string[],
  capturedQueries: [] as string[],
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
  /** tenantId → insights band; drives analysisPolicyFor in the job. */
  band: {} as Record<string, "essential" | "pro" | "enterprise">,
  refreshedTenants: [] as string[],
  /** tenantIds whose weekly digest row already exists (digest work derived from it). */
  digestsPresent: {} as Record<string, boolean>,
}));

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../utils/encryption", () => ({
  decrypt: (s: string) => {
    if (s === "BOOM") throw new Error("decrypt failed");
    return `plain:${s}`;
  },
}));

const judgeMock = vi.hoisted(() => vi.fn());
vi.mock("../../insights/judge.service", () => ({
  judgeTranscript: judgeMock,
}));

const canonMock = vi.hoisted(() => vi.fn());
vi.mock("../../insights/topics.service", () => ({
  canonicalizeTopic: canonMock,
}));

const aggregateMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => {}),
);
vi.mock("../../insights/gap-aggregation.service", () => ({
  aggregateGaps: aggregateMock,
}));

const recommendationMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../insights/gap-recommendation.service", () => ({
  generateGapRecommendations: recommendationMock,
}));

const highPriorityNotificationMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../insights/high-priority-notification.service", () => ({
  notifyHighPriorityGaps: highPriorityNotificationMock,
}));

const sentimentThemeMock = vi.hoisted(() => vi.fn());
vi.mock("../../insights/sentiment-themes.service", () => ({
  canonicalizeSentimentTheme: sentimentThemeMock,
}));

const aggregateSentimentMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../insights/sentiment-aggregation.service", () => ({
  aggregateSentiment: aggregateSentimentMock,
}));

const aggregateCorrelationsMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../insights/correlation.service", () => ({
  aggregateCorrelations: aggregateCorrelationsMock,
}));

// Digest generation + outbox have their own tests; this
// suite covers refresh orchestration only. Stub them so the once-runner's
// unconditional sendDueDigests() drain doesn't touch unmocked repos.
const sendDueDigestsMock = vi.hoisted(() =>
  vi.fn(async () => ({ sent: 0, failed: 0 })),
);
const generateDigestMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../insights/digest-send.service", () => ({
  sendDueDigests: sendDueDigestsMock,
}));
vi.mock("../../insights/digest.service", () => ({
  generateDigest: generateDigestMock,
  // The job derives weekly digest work from the missing (tenant, weekStart) row.
  weekStartFor: (now: Date) => {
    const d = new Date(now.getTime());
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
  },
}));

const claimLeaseMock = vi.hoisted(() =>
  vi.fn(async (_tenantId: string) => true),
);
const releaseLeaseMock = vi.hoisted(() =>
  vi.fn(async (_tenantId: string) => {}),
);
const claimRunMock = vi.hoisted(() => vi.fn(async (_tenantId: string) => true));
/** Per-tenant answer to "would this tenant's own Analyse button be allowed right now?" */
const scheduledEligible = vi.hoisted(() => ({ byTenant: {} as Record<string, boolean> }));
const analysisStatusMock = vi.hoisted(() =>
  vi.fn(async (tenantId: string) => ({
    eligible: scheduledEligible.byTenant[tenantId] ?? false,
    reason: scheduledEligible.byTenant[tenantId] ? null : ('not_enough_chats' as const),
  })),
);
vi.mock("../../insights/analysis-eligibility.service", () => ({
  claimInsightsLease: claimLeaseMock,
  claimAnalysisRun: claimRunMock,
  getAnalysisStatus: analysisStatusMock,
  releaseAnalysisRun: releaseLeaseMock,
}));

vi.mock("../../billing/entitlements", () => ({
  getEntitlements: async (tenantId: string) => ({
    features: {
      gapInsights: st.entitled[tenantId] ?? false,
      gapEvidence: ["pro", "enterprise"].includes(st.band[tenantId] ?? ""),
      aiBusinessInsights: (st.band[tenantId] ?? "") === "enterprise",
    },
  }),
}));

vi.mock("../../database/data-source", () => ({
  AppDataSource: {
    getRepository: (entity: { name: string }) => {
      if (entity.name === "ChatSession") {
        const qb: any = {};
        for (const m of ["select", "addSelect", "orderBy"]) qb[m] = () => qb;
        qb.where = (sql: string, p?: Record<string, unknown>) => {
          st.capturedWhere.push(sql);
          if (p) st.capturedSinceParams.push(p);
          return qb;
        };
        qb.andWhere = qb.where;
        qb.limit = (n: number) => {
          st.capturedLimit = n;
          return qb;
        };
        qb.getRawMany = async () => st.eligibleSessions;
        return { createQueryBuilder: () => qb };
      }
      if (entity.name === "Judgment") {
        return {
          findOne: async ({ where }: any) =>
            st.existingJudgments.has(where.sessionId)
              ? { sessionId: where.sessionId }
              : null,
          create: (j: Record<string, unknown>) => j,
          save: async (j: Record<string, unknown>) => {
            const err = st.saveErrorQueue.shift() ?? null;
            if (err) throw err;
            st.savedJudgments.push(j);
            return j;
          },
        };
      }
      if (entity.name === "InsightsRefreshState") {
        return {
          findOne: async () => st.state,
          create: (s: Record<string, unknown>) => s,
          save: async (s: Record<string, unknown>) => {
            st.savedState = s;
            return s;
          },
        };
      }
      if (entity.name === "Tenant") {
        const qb: any = {};
        for (const m of ["select", "where"]) qb[m] = () => qb;
        qb.getRawMany = async () => st.tenants;
        return { createQueryBuilder: () => qb };
      }
      if (entity.name === "InsightDigest") {
        return {
          findOne: async ({ where }: any) =>
            st.digestsPresent[where.tenantId]
              ? { weekStart: where.weekStart }
              : null,
        };
      }
      throw new Error(`unexpected repo ${entity.name}`);
    },
    query: async (sql: string, params: unknown[]) => {
      st.capturedQueries.push(sql);
      if (sql.includes("FROM messages")) {
        const rows = st.transcripts[params[0] as string] ?? [];
        return sql.includes("ORDER BY m.created_at DESC") ? [...rows].reverse() : rows;
      }
      if (sql.includes("session_id = ANY")) {
        const ids = (params[0] as string[]) ?? [];
        return [...st.existingJudgments]
          .filter((id) => ids.includes(id))
          .map((session_id) => ({ session_id }));
      }
      if (
        sql.includes("judgedInWindow") ||
        sql.includes("JOIN chatbot_judgments")
      ) {
        return [{ judgedInWindow: st.judgedInWindowCount }];
      }
      return [{ eligible: st.eligibleCount }];
    },
  },
}));

import {
  refreshTenantInsights,
  registerInsightsRefreshJob,
  runIntradayInsightsOnce,
  runRefreshInsightsOnce,
} from "../../insights/refresh-insights.job";

const NOW = new Date("2026-06-12T02:00:00Z");
const T = "tenant-1";

function session(id: string, endedAt: string) {
  return {
    id,
    visitorId: `v-${id}`,
    status: "closed",
    startedAt: new Date(endedAt),
    effectiveEndedAt: endedAt,
  };
}

beforeEach(() => {
  st.eligibleSessions = [];
  st.capturedLimit = 0;
  st.capturedSinceParams = [];
  st.capturedWhere = [];
  st.capturedQueries = [];
  st.existingJudgments = new Set();
  st.savedJudgments = [];
  st.saveErrorQueue = [];
  st.state = null;
  st.savedState = null;
  st.transcripts = {};
  st.eligibleCount = 0;
  st.judgedInWindowCount = 0;
  st.tenants = [];
  st.entitled = { [T]: true };
  st.band = {};
  st.refreshedTenants = [];
  judgeMock.mockReset();
  canonMock.mockReset();
  sentimentThemeMock.mockReset();
  aggregateMock.mockClear();
  recommendationMock.mockClear();
  highPriorityNotificationMock.mockClear();
  aggregateSentimentMock.mockClear();
  aggregateCorrelationsMock.mockClear();
  generateDigestMock.mockClear();
  sendDueDigestsMock.mockClear();
  claimLeaseMock.mockReset();
  claimLeaseMock.mockResolvedValue(true);
  releaseLeaseMock.mockReset();
  claimRunMock.mockClear();
  claimRunMock.mockResolvedValue(true);
  analysisStatusMock.mockClear();
  scheduledEligible.byTenant = {};
  judgeMock.mockResolvedValue({
    hadQuestion: false,
    satisfied: null,
    topicPhrase: null,
    evidenceMessageIds: [],
    reasoning: null,
  });
});

describe("refreshTenantInsights — feature guard", () => {
  it("does nothing when gapInsights is disabled", async () => {
    st.entitled[T] = false;
    st.eligibleSessions = [session("s1", "2026-06-11T10:00:00Z")];

    await refreshTenantInsights(T, NOW);

    expect(st.capturedLimit).toBe(0);
    expect(judgeMock).not.toHaveBeenCalled();
    expect(aggregateMock).not.toHaveBeenCalled();
    expect(st.savedState).toBeNull();
  });
});

describe("refreshTenantInsights — sentiment tiers", () => {
  it("records basic sentiment for Essential without creating or aggregating themes", async () => {
    st.band[T] = "essential";
    st.eligibleSessions = [session("s1", "2026-06-11T10:00:00Z")];
    st.transcripts = {
      s1: [
        {
          id: "m1",
          content: "your answer was not helpful",
          contentEncrypted: false,
          sender: "user",
        },
      ],
    };
    judgeMock.mockResolvedValue({
      hadQuestion: true,
      satisfied: false,
      topicPhrase: null,
      evidenceMessageIds: ["m1"],
      reasoning: "The customer was unhappy.",
      sentiment: "negative",
      sentimentTheme: "unclear answers",
    });

    await refreshTenantInsights(T, NOW);

    expect(judgeMock).toHaveBeenCalledWith(
      expect.any(Array),
      false,
      expect.any(Object),
      {
        withSentiment: true,
        withSentimentThemes: false,
      },
    );
    expect(st.savedJudgments[0]).toMatchObject({
      sentiment: "negative",
      sentimentThemeId: null,
    });
    expect(sentimentThemeMock).not.toHaveBeenCalled();
    expect(aggregateSentimentMock).not.toHaveBeenCalled();
    expect(recommendationMock).not.toHaveBeenCalled();
    expect(highPriorityNotificationMock).not.toHaveBeenCalled();
  });

  it("generates optimization suggestions for Pro after aggregating Gaps", async () => {
    st.band[T] = "pro";

    await refreshTenantInsights(T, NOW);

    expect(aggregateMock).toHaveBeenCalledWith(T, NOW);
    expect(recommendationMock).toHaveBeenCalledWith(T, expect.any(Object), NOW);
    expect(highPriorityNotificationMock).not.toHaveBeenCalled();
  });

  it("keeps sentiment theme canonicalisation and aggregation for Enterprise", async () => {
    st.band[T] = "enterprise";
    st.eligibleSessions = [session("s1", "2026-06-11T10:00:00Z")];
    st.transcripts = {
      s1: [
        {
          id: "m1",
          content: "your answer was not helpful",
          contentEncrypted: false,
          sender: "user",
        },
      ],
    };
    judgeMock.mockResolvedValue({
      hadQuestion: true,
      satisfied: false,
      topicPhrase: null,
      evidenceMessageIds: ["m1"],
      reasoning: "The customer was unhappy.",
      sentiment: "negative",
      sentimentTheme: "unclear answers",
    });
    sentimentThemeMock.mockResolvedValue({ ok: true, themeId: "theme-1" });

    await refreshTenantInsights(T, NOW);

    expect(sentimentThemeMock).toHaveBeenCalledWith(
      T,
      "unclear answers",
      "negative",
    );
    expect(st.savedJudgments[0]).toMatchObject({
      sentiment: "negative",
      sentimentThemeId: "theme-1",
    });
    expect(highPriorityNotificationMock).toHaveBeenCalledWith(T, NOW);
    expect(aggregateSentimentMock).toHaveBeenCalledWith(T, NOW);
  });
});

describe("refreshTenantInsights — watermark semantics", () => {
  it("advances the watermark to `now` on a clean run", async () => {
    st.eligibleSessions = [
      session("s1", "2026-06-11T10:00:00Z"),
      session("s2", "2026-06-11T11:00:00Z"),
    ];
    st.eligibleCount = 2;
    st.judgedInWindowCount = 2;
    await refreshTenantInsights(T, NOW);
    expect(st.savedJudgments).toHaveLength(2);
    expect(st.savedState!.lastRefreshedAt).toEqual(NOW);
    expect(st.savedState!.lastRunError).toBeNull();
  });

  it("freezes the watermark at the first failure but still attempts later sessions", async () => {
    st.eligibleSessions = [
      session("ok1", "2026-06-11T10:00:00Z"),
      session("fail", "2026-06-11T11:00:00Z"),
      session("ok2", "2026-06-11T12:00:00Z"),
    ];
    judgeMock.mockImplementation(async (transcript: Array<{ id: string }>) => {
      if (transcript[0]?.id === "m-fail") throw new Error("LLM exploded");
      return {
        hadQuestion: false,
        satisfied: null,
        topicPhrase: null,
        evidenceMessageIds: [],
        reasoning: null,
      };
    });
    // Real customer content, not "hi": Layer 1 now skips greeting-only conversations
    // before the judge sees them, so a fixture testing JUDGE failure has to give it
    // something worth judging.
    st.transcripts = {
      ok1: [
        {
          id: "m-ok1",
          content: "my boiler is broken",
          contentEncrypted: false,
          sender: "user",
        },
      ],
      fail: [
        {
          id: "m-fail",
          content: "my radiator leaks",
          contentEncrypted: false,
          sender: "user",
        },
      ],
      ok2: [
        {
          id: "m-ok2",
          content: "my tap is dripping",
          contentEncrypted: false,
          sender: "user",
        },
      ],
    };
    await refreshTenantInsights(T, NOW);
    // ok2 was still judged (throughput), but the watermark stayed at ok1's
    // endedAt so `fail` retries next run.
    expect(st.savedJudgments.map((j) => j.sessionId)).toEqual(["ok1", "ok2"]);
    expect(st.savedState!.lastRefreshedAt).toEqual(
      new Date("2026-06-11T10:00:00Z"),
    );
    expect(st.savedState!.lastRunError).toMatch(/1 session/);
  });

  it("treats a concurrent-run duplicate insert as a skip, not a failure", async () => {
    st.eligibleSessions = [
      session("dup", "2026-06-11T10:00:00Z"),
      session("s2", "2026-06-11T11:00:00Z"),
    ];
    // First save hits the unique constraint (a concurrent run already judged
    // the session); the second succeeds.
    st.saveErrorQueue = [
      new Error(
        'duplicate key value violates unique constraint "uq_judgments_session"',
      ),
      null,
    ];
    await refreshTenantInsights(T, NOW);
    expect(st.savedJudgments.map((j) => j.sessionId)).toEqual(["s2"]);
    // Watermark advanced to `now` — the duplicate did NOT freeze it.
    expect(st.savedState!.lastRefreshedAt).toEqual(NOW);
    expect(st.savedState!.lastRunError).toBeNull();
  });
});

describe("refreshTenantInsights — backfill + skip + completeness", () => {
  it("first run uses the 7-day backfill window capped at 500", async () => {
    await refreshTenantInsights(T, NOW);
    expect(st.capturedLimit).toBe(500);
    const since = st.capturedSinceParams.find((p) => "since" in p)
      ?.since as Date;
    expect(NOW.getTime() - since.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("subsequent runs start from the stored watermark", async () => {
    const mark = new Date("2026-06-11T20:00:00Z");
    st.state = { tenantId: T, lastRefreshedAt: mark };
    await refreshTenantInsights(T, NOW);
    const since = st.capturedSinceParams.find((p) => "since" in p)?.since;
    expect(since).toEqual(mark);
  });

  it("skips already-judged sessions and still advances the watermark past them", async () => {
    st.eligibleSessions = [session("done", "2026-06-11T10:00:00Z")];
    st.existingJudgments = new Set(["done"]);
    await refreshTenantInsights(T, NOW);
    expect(st.savedJudgments).toHaveLength(0);
    expect(judgeMock).not.toHaveBeenCalled();
    expect(st.savedState!.lastRefreshedAt).toEqual(NOW);
  });

  it("computes completeness = judged/eligible for the 7-day window", async () => {
    st.eligibleCount = 10;
    st.judgedInWindowCount = 9;
    await refreshTenantInsights(T, NOW);
    expect(st.savedState!.judgmentsCompleteness).toBe("0.9000");
    expect(aggregateMock).toHaveBeenCalledWith(T, NOW);
  });

  it("excludes detection journals in any mode but not missing-identity journals", async () => {
    await refreshTenantInsights(T, NOW);

    const selection = st.capturedWhere.find((sql) =>
      sql.includes("guardrail_spam_logs"),
    );
    expect(selection).toBeDefined();
    const completenessQueries = st.capturedQueries.filter((sql) =>
      sql.includes("FROM chat_sessions s"),
    );
    expect(completenessQueries).toHaveLength(2);
    for (const sql of [selection!, ...completenessQueries]) {
      expect(sql).toContain(
        "gsl.detected_category IN ('spam', 'scam', 'phishing', 'solicitation', 'bot_loop', 'suspicious_link')",
      );
      expect(sql).not.toContain("missing_tenant");
      expect(sql).not.toContain("missing_bot");
      expect(sql).not.toContain("gsl.enforced");
    }
  });
});

describe("refreshTenantInsights — transcript window", () => {
  it("loads the newest 80 text messages, not the whole thread", async () => {
    st.eligibleSessions = [session("s1", "2026-06-11T10:00:00Z")];
    st.transcripts = {
      s1: [{ id: "m1", content: "hi", contentEncrypted: false, sender: "user" }],
    };
    await refreshTenantInsights(T, NOW);
    const sql = st.capturedQueries.find((q) => q.includes("FROM messages"));
    expect(sql).toMatch(/LIMIT 80/);
    expect(sql).toMatch(/ORDER BY m.created_at DESC/);
  });
});

describe("refreshTenantInsights — transcript decryption", () => {
  it("decrypts encrypted rows before judging (the live-caught bug)", async () => {
    st.eligibleSessions = [session("s1", "2026-06-11T10:00:00Z")];
    st.transcripts = {
      s1: [
        { id: "m1", content: "CIPHER", contentEncrypted: true, sender: "user" },
        {
          id: "m2",
          content: "already-plain",
          contentEncrypted: false,
          sender: "bot",
        },
      ],
    };
    await refreshTenantInsights(T, NOW);
    const transcript = judgeMock.mock.calls[0][0];
    expect(transcript[0].content).toBe("plain:CIPHER");
    expect(transcript[1].content).toBe("already-plain");
  });

  it("a decrypt failure fails the session and freezes the watermark for retry", async () => {
    st.eligibleSessions = [session("bad", "2026-06-11T10:00:00Z")];
    st.transcripts = {
      bad: [
        { id: "m1", content: "BOOM", contentEncrypted: true, sender: "user" },
      ],
    };
    await refreshTenantInsights(T, NOW);
    expect(st.savedJudgments).toHaveLength(0);
    expect(st.savedState!.lastRefreshedAt).toBeNull(); // nothing succeeded before the failure
    expect(st.savedState!.lastRunError).toMatch(/1 session/);
  });
});

describe("runRefreshInsightsOnce — who the schedule analyses (ADR-0013: flags, never tiers)", () => {
  /** Monday 00:00 UTC of the week containing `d` — mirrors weekStartFor in digest.service. */
  function weekStartOf(d: Date): string {
    const x = new Date(d.getTime());
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
    x.setUTCHours(0, 0, 0, 0);
    return x.toISOString().slice(0, 10);
  }

  it("analyses Enterprise always, and leaves an on-demand tier alone until its own gate opens", async () => {
    // Essential and Pro carry a minimum-conversations gate and a cooldown. The schedule
    // now runs their analysis too, but only when their own button would be allowed - so
    // with nobody due, this pass must still touch Enterprise only.
    st.tenants = [
      { id: "ent-1" },
      { id: "ess-1" },
      { id: "pro-1" },
      { id: "free-1" },
      { id: "ent-2" },
    ];
    st.entitled = {
      "ent-1": true,
      "ess-1": true,
      "pro-1": true,
      "free-1": false,
      "ent-2": true,
    };
    st.band = {
      "ent-1": "enterprise",
      "ess-1": "essential",
      "pro-1": "pro",
      "ent-2": "enterprise",
    };

    await runRefreshInsightsOnce(NOW);

    // Only Enterprise runs the analysis (aggregate) path.
    expect(aggregateMock.mock.calls.map((c) => c[0])).toEqual([
      "ent-1",
      "ent-2",
    ]);
    // Pro claims the lease only to generate its weekly snapshot (no analysis).
    expect(claimLeaseMock.mock.calls.map((c) => c[0])).toEqual([
      "ent-1",
      "pro-1",
      "ent-2",
    ]);
    expect(releaseLeaseMock.mock.calls.map((c) => c[0])).toEqual([
      "ent-1",
      "pro-1",
      "ent-2",
    ]);
    expect(generateDigestMock).toHaveBeenCalledWith("pro-1", expect.any(Date));
  });

  it("analyses a Pro tenant on the schedule once its own gate would let the button run", async () => {
    // The bug this fixes: below Enterprise nothing ever ran unless a human pressed
    // Analyse, and on production nobody had since 2026-08-13 while 131 conversations
    // waited. Being due is the tenant's own rule, not a new one.
    st.tenants = [{ id: "pro-1" }, { id: "ess-1" }];
    st.entitled = { "pro-1": true, "ess-1": true };
    st.band = { "pro-1": "pro", "ess-1": "essential" };
    scheduledEligible.byTenant = { "pro-1": true };

    await runIntradayInsightsOnce(NOW);

    expect(aggregateMock.mock.calls.map((c) => c[0])).toEqual(["pro-1"]);
    // Through claimAnalysisRun, NOT the plain lease: that stamps the same clock the
    // button reads, so a scheduled run puts the button into its cooldown instead of the
    // two firing back to back.
    expect(claimRunMock.mock.calls.map((c) => c[0])).toEqual(["pro-1"]);
    expect(claimLeaseMock).not.toHaveBeenCalledWith("pro-1", expect.anything());
    expect(releaseLeaseMock.mock.calls.map((c) => c[0])).toEqual(["pro-1"]);
  });

  it("does not analyse when a manual run already holds the claim", async () => {
    st.tenants = [{ id: "pro-1" }];
    st.entitled = { "pro-1": true };
    st.band = { "pro-1": "pro" };
    scheduledEligible.byTenant = { "pro-1": true };
    claimRunMock.mockResolvedValueOnce(false);

    await runIntradayInsightsOnce(NOW);

    expect(aggregateMock).not.toHaveBeenCalled();
  });

  it("does one run for a due Pro tenant that also owes a Monday snapshot", async () => {
    const monday = new Date("2026-06-15T02:00:00Z");
    st.tenants = [{ id: "pro-1" }];
    st.entitled = { "pro-1": true };
    st.band = { "pro-1": "pro" };
    scheduledEligible.byTenant = { "pro-1": true };

    await runRefreshInsightsOnce(monday);

    expect(aggregateMock.mock.calls.map((c) => c[0])).toEqual(["pro-1"]);
    expect(generateDigestMock).toHaveBeenCalledTimes(1);
    expect(claimRunMock).toHaveBeenCalledTimes(1);
  });

  it("still refreshes nobody when no tenant has insights at all", async () => {
    st.tenants = [{ id: "free-1" }, { id: "free-2" }];
    st.entitled = { "free-1": false, "free-2": false };
    await runRefreshInsightsOnce(NOW);
    expect(aggregateMock.mock.calls).toHaveLength(0);
  });

  it("generates the Monday snapshot for Pro without running automatic analysis", async () => {
    const monday = new Date("2026-06-15T02:00:00Z");
    st.tenants = [{ id: "pro-1" }, { id: "ess-1" }];
    st.entitled = { "pro-1": true, "ess-1": true };
    st.band = { "pro-1": "pro", "ess-1": "essential" };

    await runRefreshInsightsOnce(monday);

    expect(aggregateMock).not.toHaveBeenCalled();
    expect(generateDigestMock).toHaveBeenCalledTimes(1);
    expect(generateDigestMock).toHaveBeenCalledWith("pro-1", monday);
    expect(claimLeaseMock).toHaveBeenCalledWith("pro-1", monday);
    expect(releaseLeaseMock).toHaveBeenCalledWith("pro-1");
  });

  it("retries a failed Pro Monday snapshot on the next hourly pass", async () => {
    const monday = new Date("2026-06-15T02:00:00Z");
    const wednesday = new Date("2026-06-17T12:00:00Z");
    st.tenants = [{ id: "pro-1" }];
    st.entitled = { "pro-1": true };
    st.band = { "pro-1": "pro" };
    generateDigestMock.mockRejectedValueOnce(new Error("database unavailable"));

    await runRefreshInsightsOnce(monday);
    await runIntradayInsightsOnce(wednesday);

    expect(aggregateMock).not.toHaveBeenCalled();
    expect(generateDigestMock).toHaveBeenCalledTimes(2);
    // The digest is derived from the missing weekly row, so the retry passes the
    // pass time; generateDigest normalizes to the same Monday via weekStartFor.
    const secondCall = generateDigestMock.mock.calls[1] as unknown as [
      string,
      Date,
    ];
    expect(secondCall[1]).toBeInstanceOf(Date);
    expect(weekStartOf(monday)).toBe(weekStartOf(secondCall[1]));
    expect(claimLeaseMock).toHaveBeenCalledTimes(2);
    expect(releaseLeaseMock).toHaveBeenCalledTimes(2);
  });

  it("skips an intraday tenant while a manual or scheduled run holds the lease", async () => {
    st.tenants = [{ id: "ent-1" }];
    st.entitled = { "ent-1": true };
    st.band = { "ent-1": "enterprise" };
    claimLeaseMock.mockResolvedValue(false);

    await runIntradayInsightsOnce(NOW);

    expect(aggregateMock).not.toHaveBeenCalled();
    expect(releaseLeaseMock).not.toHaveBeenCalled();
  });

  it("defers Monday digest generation and sending until a held lease clears", async () => {
    const monday = new Date("2026-06-15T02:00:00Z");
    const tuesday = new Date("2026-06-16T00:10:00Z");
    st.tenants = [{ id: "ent-1" }];
    st.entitled = { "ent-1": true };
    st.band = { "ent-1": "enterprise" };
    claimLeaseMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await runRefreshInsightsOnce(monday);
    expect(generateDigestMock).not.toHaveBeenCalled();

    await runIntradayInsightsOnce(tuesday);
    expect(generateDigestMock).toHaveBeenCalledTimes(1);
    const retriedCall = generateDigestMock.mock.calls[0] as unknown as [
      string,
      Date,
    ];
    expect(retriedCall[0]).toBe("ent-1");
    expect(weekStartOf(retriedCall[1])).toBe(weekStartOf(monday));
    // Digest SENDING stays a nightly reconciler action; the intraday pass only
    // generates the deferred snapshot (a fresh row is what the send pass picks up).
    expect(sendDueDigestsMock).not.toHaveBeenCalledWith(tuesday);
  });

  it("runs a nightly due while an hourly pass overruns 03:00 UTC", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T00:00:00Z"));
    st.tenants = [{ id: "ent-1" }];
    st.entitled = { "ent-1": true };
    st.band = { "ent-1": "enterprise" };
    let clearHourlyLease!: (claimed: boolean) => void;
    claimLeaseMock
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            clearHourlyLease = resolve;
          }),
      )
      .mockResolvedValue(true);

    registerInsightsRefreshJob();
    vi.advanceTimersByTime(60 * 60_000);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(claimLeaseMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2 * 60 * 60_000);
    expect(generateDigestMock).not.toHaveBeenCalled();
    clearHourlyLease(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(generateDigestMock).toHaveBeenCalledWith(
      "ent-1",
      new Date("2026-06-15T02:00:00Z"),
    );
    expect(sendDueDigestsMock).toHaveBeenCalledWith(
      new Date("2026-06-15T02:00:00Z"),
    );
    vi.useRealTimers();
  });

  it("lets the 02:00 nightly pass win when the hourly pass is also due", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T01:00:00Z"));
    st.tenants = [{ id: "ent-1" }];
    st.entitled = { "ent-1": true };
    st.band = { "ent-1": "enterprise" };

    registerInsightsRefreshJob();
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(claimLeaseMock).toHaveBeenCalledTimes(1);
    expect(aggregateMock).toHaveBeenCalledTimes(1);
    expect(generateDigestMock).toHaveBeenCalledTimes(1);
    expect(sendDueDigestsMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("runs the hourly intraday delta cadence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T12:00:00Z"));
    st.tenants = [{ id: "ent-1" }];
    st.entitled = { "ent-1": true };
    st.band = { "ent-1": "enterprise" };

    registerInsightsRefreshJob();
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(aggregateMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(aggregateMock).toHaveBeenCalledWith(
      "ent-1",
      new Date("2026-06-12T13:00:00Z"),
    );
    vi.useRealTimers();
  });
});

/**
 * Layer 1 in the job.
 *
 * Two properties, and the second is the one that makes the first safe: the model is not
 * called for a conversation that cannot yield a topic, AND a judgment is still written
 * for it. Completeness is judged/eligible, so skipping without writing would have driven
 * it toward 0.45 on production data and made the UI announce "Insights incomplete" about
 * conversations that were correctly found empty.
 */
describe("refreshTenantInsights — Layer 1 gates the model", () => {
  it("writes a judgment WITHOUT calling the model when nobody wrote anything", async () => {
    st.eligibleSessions = [session("silent", "2026-06-11T10:00:00Z")];
    st.transcripts = {
      silent: [
        {
          id: "m1",
          content: "Welcome! How can I help?",
          contentEncrypted: false,
          sender: "bot",
        },
      ],
    };

    await refreshTenantInsights(T, NOW);

    expect(judgeMock).not.toHaveBeenCalled();
    expect(st.savedJudgments).toHaveLength(1);
    const j = st.savedJudgments[0];
    expect(j.hadQuestion).toBe(false);
    // null, not false: `satisfied` answers "was their question answered", and there was
    // no question. False would read as a failure to help.
    expect(j.satisfied).toBeNull();
    expect(j.reasoning).toMatch(/Layer 1/);
    // The watermark still advances — a skipped session is handled, not pending.
    expect(st.savedState!.lastRefreshedAt).not.toBeNull();
  });

  it("still pays for the model when the customer actually asked something", async () => {
    st.eligibleSessions = [session("real", "2026-06-11T10:00:00Z")];
    st.transcripts = {
      real: [
        {
          id: "m1",
          content: "do you replace radiators?",
          contentEncrypted: false,
          sender: "user",
        },
      ],
    };

    await refreshTenantInsights(T, NOW);

    expect(judgeMock).toHaveBeenCalledTimes(1);
  });

  it("always pays for the judge on a handoff, whatever the customer wrote", async () => {
    // The bot said it could not cope. That conversation is never gated.
    st.eligibleSessions = [
      { ...session("esc", "2026-06-11T10:00:00Z"), status: "handoff" },
    ];
    st.transcripts = {
      esc: [
        { id: "m1", content: "hi", contentEncrypted: false, sender: "user" },
      ],
    };

    await refreshTenantInsights(T, NOW);

    expect(judgeMock).toHaveBeenCalledTimes(1);
  });

  it("mixes both in one pass without losing either", async () => {
    st.eligibleSessions = [
      session("silent", "2026-06-11T10:00:00Z"),
      session("real", "2026-06-11T11:00:00Z"),
    ];
    st.transcripts = {
      silent: [
        {
          id: "m1",
          content: "Welcome!",
          contentEncrypted: false,
          sender: "bot",
        },
      ],
      real: [
        {
          id: "m2",
          content: "my boiler is leaking badly",
          contentEncrypted: false,
          sender: "user",
        },
      ],
    };

    await refreshTenantInsights(T, NOW);

    expect(judgeMock).toHaveBeenCalledTimes(1); // only the one with something in it
    expect(st.savedJudgments).toHaveLength(2); // but both are accounted for
  });
});
