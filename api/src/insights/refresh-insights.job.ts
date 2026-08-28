/**
 * RefreshInsightsJob — completeness-watermarked analysis (ADR-0006).
 * The nightly pass includes only tenants whose analysis policy is automatic
 * (Enterprise / `aiBusinessInsights`). Essential and Pro analyse on demand
 * (`POST /insights/analyse`) behind the min-conversations + cooldown gates
 * in analysis-policy.ts. Inclusion is always via the policy/flags, never a
 * tier name, so a flag flip moves a tenant between the two models without
 * a second source of truth (ADR-0013). Cost is two-layer: the prefilter
 * writes a Judgment without an LLM call when a conversation cannot yield a
 * topic; the watermark is the delta so each session is judged at most once.
 *
 * Per tenant, sequentially (no concurrent workers — eliminates the
 * canonical-topic merge race by construction):
 *   1. judge closed/handoff sessions since the watermark (first run:
 *      7-day backfill, capped at 500)
 *   2. persist one Judgment per session (unique on session_id)
 *   3. compute judgments_completeness for the 7-day window
 *   4. aggregate Gap state (ADR-0005)
 *
 * Watermark semantics: advances past consecutively-judged sessions only —
 * an LLM failure freezes it at the failed session so the next run retries,
 * while later sessions are still attempted for throughput.
 */
import { Repository } from "typeorm";
import { AppDataSource } from "../database/data-source";
import { Tenant } from "../database/entities/Tenant";
import { ChatSession } from "../database/entities/ChatSession";
import { Judgment } from "../database/entities/Judgment";
import { InsightsRefreshState } from "../database/entities/InsightsRefreshState";
import { InsightDigest } from "../database/entities/InsightDigest";
import { getEntitlements } from "../billing/entitlements";
import { analysisPolicyFor } from "./analysis-policy";
import {
  judgeTranscript,
  type JudgeVerdict,
  type TranscriptMessage,
  type UsageTally,
} from "./judge.service";
import {
  prefilterTranscript,
  emptyPrefilterTally,
  type PrefilterTally,
} from "./prefilter";
import { canonicalizeTopic } from "./topics.service";
import { canonicalizeSentimentTheme } from "./sentiment-themes.service";
import { aggregateSentiment } from "./sentiment-aggregation.service";
import { aggregateCorrelations } from "./correlation.service";
import { generateDigest, weekStartFor } from "./digest.service";
import { sendDueDigests } from "./digest-send.service";
import { aggregateGaps } from "./gap-aggregation.service";
import { generateGapRecommendations } from "./gap-recommendation.service";
import { notifyHighPriorityGaps } from "./high-priority-notification.service";
import {
  claimInsightsLease,
  claimAnalysisRun,
  getAnalysisStatus,
  releaseAnalysisRun,
} from "./analysis-eligibility.service";
import { logger } from "../utils/logger";
import { decrypt } from "../utils/encryption";

const BACKFILL_DAYS = 7;
const BACKFILL_CAP = 500;
const WINDOW_DAYS = 7;
export const INTRADAY_REFRESH_MINUTES = 60;

interface EligibleSession {
  id: string;
  visitorId: string;
  status: string;
  startedAt: Date;
  effectiveEndedAt: Date;
}

async function loadEligibleSessions(
  tenantId: string,
  since: Date,
  cap: number,
): Promise<EligibleSession[]> {
  const rows = await AppDataSource.getRepository(ChatSession)
    .createQueryBuilder("s")
    .select("s.id", "id")
    .addSelect("s.visitor_id", "visitorId")
    .addSelect("s.status", "status")
    .addSelect("s.started_at", "startedAt")
    .addSelect(
      "COALESCE(s.ended_at, s.last_activity_at, s.started_at)",
      "effectiveEndedAt",
    )
    .where("s.tenant_id = :tenantId", { tenantId })
    .andWhere("s.status IN ('closed', 'handoff')")
    // Guardrails: exclude spam/scam/bot-loop conversations from insights (AC20).
    .andWhere("s.guardrail_status = 'normal'")
    .andWhere(
      `NOT EXISTS (
        SELECT 1 FROM guardrail_spam_logs gsl
        WHERE gsl.conversation_id = s.id
          AND gsl.detected_category IN ('spam', 'scam', 'phishing', 'solicitation', 'bot_loop', 'suspicious_link')
      )`,
    )
    .andWhere(
      "COALESCE(s.ended_at, s.last_activity_at, s.started_at) > :since",
      { since },
    )
    .orderBy("COALESCE(s.ended_at, s.last_activity_at, s.started_at)", "ASC")
    .limit(cap)
    .getRawMany();
  return rows.map((r) => ({
    ...r,
    startedAt: new Date(r.startedAt),
    effectiveEndedAt: new Date(r.effectiveEndedAt),
  }));
}

const TRANSCRIPT_MESSAGE_CAP = 80;

async function loadExistingJudgmentSessionIds(sessionIds: string[]): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const rows: Array<{ session_id: string }> = await AppDataSource.query(
    `SELECT session_id FROM chatbot_judgments WHERE session_id = ANY($1::uuid[])`,
    [sessionIds],
  );
  return new Set(rows.map((r) => r.session_id));
}

async function loadTranscript(sessionId: string): Promise<TranscriptMessage[]> {
  const rows: Array<{
    id: string;
    content: string;
    contentEncrypted: boolean;
    sender: string;
  }> =
    // pi-lens-ignore: no-sql-in-code
    await AppDataSource.query(
      `SELECT m.id, m.content, m.content_encrypted AS "contentEncrypted", p.type AS sender
       FROM messages m
       JOIN participants p ON p.id = m.participant_id
       WHERE m.session_id = $1 AND m.type = 'text'
       ORDER BY m.created_at DESC
       LIMIT ${TRANSCRIPT_MESSAGE_CAP}`,
      [sessionId],
    );
  rows.reverse();
  return rows.map((r) => {
    // Message content is encrypted at rest — the judge must see plaintext.
    // (Caught live: the first prod run judged ciphertext and reported
    // "no questions" for every session.) A row that fails to decrypt
    // throws, failing this session's judgment → watermark freezes → retried.
    const content = r.contentEncrypted ? decrypt(r.content) : r.content;
    return {
      id: r.id,
      content,
      sender: (["user", "agent", "bot", "system"].includes(r.sender)
        ? r.sender
        : "system") as TranscriptMessage["sender"],
    };
  });
}

interface JudgeFeatureFlags {
  withSentiment: boolean;
  withSentimentThemes: boolean;
}

/** Per-verdict outcome of ADR-0009 topic validation + registry contact. */
interface TopicResolution {
  canonicalTopicId: string | null;
  rejectedTopic: string | null;
  rejectReason: string | null;
}

async function resolveTopic(
  tenantId: string,
  verdict: JudgeVerdict,
  tally: UsageTally,
): Promise<TopicResolution> {
  if (!verdict.hadQuestion || !verdict.topicPhrase) {
    return { canonicalTopicId: null, rejectedTopic: null, rejectReason: null };
  }
  const canon = await canonicalizeTopic(
    tenantId,
    verdict.topicPhrase,
    verdict.evidenceMessageIds,
    tally,
  );
  if (canon.ok) {
    return {
      canonicalTopicId: canon.canonicalTopicId,
      rejectedTopic: null,
      rejectReason: null,
    };
  }
  // ADR-0009 layer 3: unmapped diagnostics, no Gap contribution.
  return {
    canonicalTopicId: null,
    rejectedTopic: verdict.topicPhrase.slice(0, 200),
    rejectReason: canon.rejectReason,
  };
}

/**
 * Sentiment theme (Enterprise-only, D5). Forward-only; a reject just
 * stores no theme on this judgment.
 */
async function resolveSentimentThemeId(
  tenantId: string,
  verdict: JudgeVerdict,
  withSentimentThemes: boolean,
): Promise<string | null> {
  if (!withSentimentThemes || !verdict.sentiment || !verdict.sentimentTheme) {
    return null;
  }
  const theme = await canonicalizeSentimentTheme(
    tenantId,
    verdict.sentimentTheme,
    verdict.sentiment,
  );
  return theme.ok ? theme.themeId : null;
}

/** Judge one session and write its single Judgment row. */
async function judgeAndPersistSession(
  judgmentRepo: Repository<Judgment>,
  tenantId: string,
  session: EligibleSession,
  flags: JudgeFeatureFlags,
  tally: UsageTally,
  layer1: PrefilterTally,
): Promise<void> {
  const transcript = await loadTranscript(session.id);

  // Layer 1 (cheap, no model): when a conversation cannot possibly yield a topic,
  // the verdict is knowable without paying for one. The judgment is still WRITTEN —
  // completeness is judged/eligible, so dropping these would make the UI announce
  // "Insights incomplete" for conversations that were correctly found empty.
  const gate = prefilterTranscript({
    messages: transcript,
    isHandoff: session.status === "handoff",
  });
  if (!gate.judge) {
    layer1.skipped += 1;
    layer1.byReason[gate.reason] += 1;
    await judgmentRepo.save(
      judgmentRepo.create({
        tenantId,
        sessionId: session.id,
        visitorId: session.visitorId,
        sessionStartedAt: session.startedAt,
        hadQuestion: false,
        // Deliberately null, not false: `satisfied` answers "was their question
        // answered", and there was no question. False would read as a failure.
        satisfied: null,
        evidenceMessageIds: [],
        reasoning: gate.note,
      }),
    );
    return;
  }
  layer1.judged += 1;

  const verdict = await judgeTranscript(
    tenantId,
    transcript,
    session.status === "handoff",
    tally,
    {
      withSentiment: flags.withSentiment,
      withSentimentThemes: flags.withSentimentThemes,
    },
  );

  const topic = await resolveTopic(tenantId, verdict, tally);
  const sentimentThemeId = await resolveSentimentThemeId(
    tenantId,
    verdict,
    flags.withSentimentThemes,
  );

  await judgmentRepo.save(
    judgmentRepo.create({
      tenantId,
      sessionId: session.id,
      visitorId: session.visitorId,
      sessionStartedAt: session.startedAt,
      hadQuestion: verdict.hadQuestion,
      satisfied: verdict.satisfied,
      topicPhrase: verdict.topicPhrase,
      canonicalTopicId: topic.canonicalTopicId,
      rejectedTopic: topic.rejectedTopic,
      rejectReason: topic.rejectReason,
      evidenceMessageIds: verdict.evidenceMessageIds,
      reasoning: verdict.reasoning,
      sentiment: verdict.sentiment,
      sentimentThemeId,
    }),
  );
}

interface JudgePassResult {
  /** Last consecutively-judged session end; null when nothing advanced. */
  watermark: Date | null;
  watermarkFrozen: boolean;
  judged: number;
  failed: number;
}

async function judgeSessions(
  judgmentRepo: Repository<Judgment>,
  tenantId: string,
  sessions: EligibleSession[],
  alreadyIds: Set<string>,
  flags: JudgeFeatureFlags,
  tally: UsageTally,
  layer1: PrefilterTally,
): Promise<JudgePassResult> {
  const pass: JudgePassResult = {
    watermark: null,
    watermarkFrozen: false,
    judged: 0,
    failed: 0,
  };

  for (const session of sessions) {
    // Unique(session_id) makes re-judging a no-op risk; skip cheaply instead.
    if (alreadyIds.has(session.id)) {
      if (!pass.watermarkFrozen) pass.watermark = session.effectiveEndedAt;
      continue;
    }

    try {
      await judgeAndPersistSession(
        judgmentRepo,
        tenantId,
        session,
        flags,
        tally,
        layer1,
      );
      pass.judged += 1;
      if (!pass.watermarkFrozen) pass.watermark = session.effectiveEndedAt;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      // A concurrent run (manual ops script vs the nightly pass) may have
      // judged this session between our pre-check and insert — that's a
      // skip, not a failure: the judgment exists, the watermark can advance.
      if (message.includes("uq_judgments_session")) {
        if (!pass.watermarkFrozen) pass.watermark = session.effectiveEndedAt;
        continue;
      }
      pass.failed += 1;
      pass.watermarkFrozen = true; // failed session retries next run
      logger.warn("[insights-refresh] judge failed for session", {
        tenantId,
        sessionId: session.id,
        error: message,
      });
    }
  }

  return pass;
}

/** Completeness over the rolling 7-day window (ADR-0006). */
async function judgmentsCompleteness(
  tenantId: string,
  windowStart: Date,
): Promise<number> {
  // pi-lens-ignore: no-sql-in-code
  const [{ eligible }] = await AppDataSource.query(
    `SELECT COUNT(*)::int AS eligible FROM chat_sessions s
     WHERE s.tenant_id = $1 AND s.status IN ('closed','handoff')
       AND s.guardrail_status = 'normal'
       AND NOT EXISTS (
         SELECT 1 FROM guardrail_spam_logs gsl
         WHERE gsl.conversation_id = s.id
           AND gsl.detected_category IN ('spam', 'scam', 'phishing', 'solicitation', 'bot_loop', 'suspicious_link')
       )
       AND COALESCE(s.ended_at, s.last_activity_at, s.started_at) >= $2`,
    [tenantId, windowStart],
  );
  // pi-lens-ignore: no-sql-in-code
  const [{ judgedInWindow }] = await AppDataSource.query(
    `SELECT COUNT(*)::int AS "judgedInWindow" FROM chat_sessions s
     JOIN chatbot_judgments j ON j.session_id = s.id
     WHERE s.tenant_id = $1 AND s.status IN ('closed','handoff')
       AND s.guardrail_status = 'normal'
       AND NOT EXISTS (
         SELECT 1 FROM guardrail_spam_logs gsl
         WHERE gsl.conversation_id = s.id
           AND gsl.detected_category IN ('spam', 'scam', 'phishing', 'solicitation', 'bot_loop', 'suspicious_link')
       )
       AND COALESCE(s.ended_at, s.last_activity_at, s.started_at) >= $2`,
    [tenantId, windowStart],
  );
  return eligible > 0 ? judgedInWindow / eligible : 1;
}

/** Refresh one tenant. Exported for tests and manual (admin) triggering. */
export async function refreshTenantInsights(
  tenantId: string,
  now = new Date(),
  options: { generateDigest?: boolean; digestAt?: Date } = {},
): Promise<void> {
  const { features } = await getEntitlements(tenantId);
  // Fail closed here as well as in callers: manual/admin runs must not bypass
  // a tenant's disabled Success Meter feature.
  if (!features.gapInsights) return;

  const stateRepo = AppDataSource.getRepository(InsightsRefreshState);
  const judgmentRepo = AppDataSource.getRepository(Judgment);

  const flags: JudgeFeatureFlags = {
    withSentiment: features.gapInsights,
    withSentimentThemes: features.aiBusinessInsights,
  };

  let state = await stateRepo.findOne({ where: { tenantId } });
  if (!state) {
    state = stateRepo.create({ tenantId, lastRefreshedAt: null });
  }

  const since =
    state.lastRefreshedAt ??
    new Date(now.getTime() - BACKFILL_DAYS * 24 * 60 * 60 * 1000);
  const sessions = await loadEligibleSessions(tenantId, since, BACKFILL_CAP);
  const alreadyIds = await loadExistingJudgmentSessionIds(sessions.map((s) => s.id));

  const tally: UsageTally = { promptTokens: 0, completionTokens: 0, calls: 0 };
  const layer1 = emptyPrefilterTally();
  const pass = await judgeSessions(
    judgmentRepo,
    tenantId,
    sessions,
    alreadyIds,
    flags,
    tally,
    layer1,
  );

  const windowStart = new Date(
    now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const completeness = await judgmentsCompleteness(tenantId, windowStart);

  await aggregateGaps(tenantId, now);
  if (features.gapEvidence) {
    await generateGapRecommendations(tenantId, tally, now);
  }
  // Enterprise-only experiment aggregation (P3). Gated by the flag, not tier.
  if (flags.withSentimentThemes) {
    await notifyHighPriorityGaps(tenantId, now);
    await aggregateSentiment(tenantId, now);
    await aggregateCorrelations(tenantId, now);
  }
  // Pro+ weekly improvement snapshot. Idempotent on (tenant, weekStart);
  // sending remains a separate reconciler pass. Digest work is OWNED by the
  // pass loop (derived from the missing weekly row), so this is explicit
  // opt-in only — a manual on-demand analysis never generates a digest, and
  // a deferred Monday retry landing on Tuesday still runs (no day gate).
  const digestAt = options.digestAt ?? now;
  if (features.gapEvidence && options.generateDigest === true) {
    await generateDigest(tenantId, digestAt);
  }

  state.lastRefreshedAt = pass.watermarkFrozen ? pass.watermark : now;
  state.judgmentsCompleteness = completeness.toFixed(4);
  state.lastRunError =
    pass.failed > 0 ? `${pass.failed} session(s) failed judging` : null;
  await stateRepo.save(state);

  logger.info("[insights-refresh] tenant refreshed", {
    tenantId,
    judged: pass.judged,
    failed: pass.failed,
    completeness: Number(completeness.toFixed(3)),
    llm: tally, // per-tenant token telemetry (ADR-0006 cost monitoring)
    // Layer 1's actual effect, per run. Logged rather than asserted: the share of
    // conversations that cannot yield a topic is a property of a tenant's traffic, not
    // something to estimate once and quote forever.
    layer1: {
      ...layer1,
      savedShare:
        layer1.judged + layer1.skipped > 0
          ? Number(
              (layer1.skipped / (layer1.judged + layer1.skipped)).toFixed(3),
            )
          : 0,
    },
  });
}

interface DeferredNightlyPass {
  id: string;
  digestAt: Date;
  automatic: boolean;
}

/**
 * Digest work is DERIVED from the missing weekly digest row, not from
 * process-local state: a restart after a failed Monday generation still
 * retries on the next pass (review round 3, finding 2).
 */
async function weeklyDigestMissing(
  tenantId: string,
  now: Date,
): Promise<boolean> {
  const weekStartStr = weekStartFor(now);
  return !(await AppDataSource.getRepository(InsightDigest).findOne({
    where: { tenantId, weekStart: weekStartStr },
  }));
}

/**
 * Essential and Pro have a button instead of a schedule, and that button is the only
 * thing that ever ran for them - so on production every one of those tenants sat months
 * out of date with a hundred unjudged conversations, and the feature they pay for was
 * silently switched off. A control nobody remembers to press is not a control.
 *
 * So the schedule now runs their analysis too, but ONLY when their OWN button would be
 * allowed to right now: the same minimum-conversations gate and the same cooldown
 * (analysis-policy.ts). That spends exactly what a diligent owner pressing it would
 * spend and never more - at most one run a day on Pro, one in three days on Essential,
 * and nothing at all for a tenant with no new chats. `claimAnalysisRun` stamps the same
 * clock the button reads, so the two share one cooldown instead of racing each other.
 */
async function runOnDemandTenantPass(
  id: string,
  now: Date,
  nightly: boolean,
  digestAt: Date | undefined,
  deferredNightly: DeferredNightlyPass[],
): Promise<void> {
  const scheduled = (await getAnalysisStatus(id, now)).eligible;
  if (!scheduled) {
    // Not due. Fall through to the digest-only path, which reads existing
    // aggregates and spends no LLM budget.
    if (!digestAt) return;
    if (!(await claimInsightsLease(id, now))) {
      if (nightly) deferredNightly.push({ id, digestAt, automatic: false });
      return;
    }
    try {
      await generateDigest(id, digestAt);
    } finally {
      await releaseAnalysisRun(id);
    }
    return;
  }
  if (!(await claimAnalysisRun(id, now))) {
    if (nightly && digestAt) deferredNightly.push({ id, digestAt, automatic: false });
    return;
  }
  try {
    await refreshTenantInsights(id, now, {
      generateDigest: digestAt !== undefined,
      digestAt,
    });
  } finally {
    await releaseAnalysisRun(id);
  }
}

async function runTenantPass(
  id: string,
  now: Date,
  nightly: boolean,
  deferredNightly: DeferredNightlyPass[],
): Promise<void> {
  const entitlements = await getEntitlements(id);
  const automatic = analysisPolicyFor(entitlements.features).automatic;
  const digestDue =
    entitlements.features.gapEvidence && (await weeklyDigestMissing(id, now));
  const digestAt = digestDue ? now : undefined;
  // Enterprise analyses continuously; everyone else goes through the
  // button-equivalent gates in runOnDemandTenantPass.
  if (!automatic) {
    await runOnDemandTenantPass(id, now, nightly, digestAt, deferredNightly);
    return;
  }
  if (!(await claimInsightsLease(id, now))) {
    if (nightly && digestAt)
      deferredNightly.push({ id, digestAt, automatic: true });
    return;
  }
  try {
    await refreshTenantInsights(id, now, {
      generateDigest: digestAt !== undefined,
      digestAt,
    });
  } finally {
    await releaseAnalysisRun(id);
  }
}

async function runDeferredNightlyPasses(
  deferredNightly: DeferredNightlyPass[],
  now: Date,
): Promise<void> {
  for (const { id, digestAt, automatic } of deferredNightly) {
    try {
      if (!(await claimInsightsLease(id, now))) continue;
      try {
        if (automatic) {
          await refreshTenantInsights(id, now, {
            generateDigest: true,
            digestAt,
          });
        } else {
          await generateDigest(id, digestAt);
        }
      } finally {
        await releaseAnalysisRun(id);
      }
    } catch (err) {
      logger.error("[insights-refresh] deferred nightly tenant pass failed", {
        tenantId: id,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }
}

async function runAutomaticInsightsPass(
  now: Date,
  nightly: boolean,
): Promise<void> {
  const deferredNightly: DeferredNightlyPass[] = [];
  const tenants: Array<{ id: string }> = await AppDataSource.getRepository(
    Tenant,
  )
    .createQueryBuilder("t")
    .select("t.id", "id")
    .where("t.status = 'active'")
    .getRawMany();

  for (const { id } of tenants) {
    try {
      await runTenantPass(id, now, nightly, deferredNightly);
    } catch (err) {
      logger.error("[insights-refresh] tenant pass failed", {
        tenantId: id,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  await runDeferredNightlyPasses(deferredNightly, now);

  if (!nightly) return;

  // Drain the digest outbox once per nightly pass — retries failed sends with backoff and
  // delivers digests generated this run (P3 / ADR-0014 D6). Deliberately OUTSIDE the
  // automatic-tier filter above: this is delivery of already-generated digests, so a
  // tenant who analysed manually still gets theirs sent.
  try {
    await sendDueDigests(now);
  } catch (err) {
    logger.error("[insights-refresh] digest reconciler failed", {
      error: err instanceof Error ? err.message : "unknown",
    });
  }
}

/** Nightly full pass, including digest generation and delivery. */
export async function runRefreshInsightsOnce(now = new Date()): Promise<void> {
  await runAutomaticInsightsPass(now, true);
}

/** Hourly Enterprise delta pass; the watermark keeps this incremental. */
export async function runIntradayInsightsOnce(now = new Date()): Promise<void> {
  await runAutomaticInsightsPass(now, false);
}

/**
 * Register the nightly 02:00 UTC pass plus an hourly Enterprise delta pass.
 * The shared DB lease prevents overlap across processes and manual/ops runs.
 */
export function registerInsightsRefreshJob(): void {
  let lastRunDay: string | null = null;
  let lastIntradayAt = Date.now();
  let running = false;
  let nightlyDue: { day: string; at: Date } | null = null;

  setInterval(
    async () => {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      if (now.getUTCHours() === 2 && lastRunDay !== day && !nightlyDue) {
        nightlyDue = { day, at: now };
      }
      const nightly = nightlyDue !== null;
      const intraday =
        now.getTime() - lastIntradayAt >= INTRADAY_REFRESH_MINUTES * 60_000;
      if ((!nightly && !intraday) || running) return;
      running = true;
      lastIntradayAt = now.getTime();
      try {
        if (nightly) {
          const due = nightlyDue!;
          await runRefreshInsightsOnce(due.at);
          lastRunDay = due.day;
          nightlyDue = null;
        } else {
          await runIntradayInsightsOnce(now);
        }
      } catch (err) {
        logger.error(
          `[insights-refresh] ${nightly ? "nightly" : "intraday"} pass crashed`,
          {
            error: err instanceof Error ? err.message : "unknown",
          },
        );
      } finally {
        running = false;
      }
    },
    10 * 60 * 1000,
  );

  logger.info(
    `[insights-refresh] jobs registered (02:00 UTC + ${INTRADAY_REFRESH_MINUTES}m delta)`,
  );
}
