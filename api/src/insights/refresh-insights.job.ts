/**
 * RefreshInsightsJob — pure nightly refresh with completeness watermark
 * (ADR-0006), tier-aware per ADR-0013: tenants are included by the
 * `gapInsights` Feature (never by tier name), so Free costs nothing and a
 * flag flipped by plan change / upgrade / override starts the 7-day
 * backfill automatically on the next run.
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
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { ChatSession } from '../database/entities/ChatSession';
import { Judgment } from '../database/entities/Judgment';
import { InsightsRefreshState } from '../database/entities/InsightsRefreshState';
import { getEntitlements } from '../billing/entitlements';
import { judgeTranscript, TranscriptMessage } from './judge.service';
import { canonicalizeTopic } from './topics.service';
import { aggregateGaps } from './gap-aggregation.service';
import { logger } from '../utils/logger';

const BACKFILL_DAYS = 7;
const BACKFILL_CAP = 500;
const WINDOW_DAYS = 7;

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
    .createQueryBuilder('s')
    .select('s.id', 'id')
    .addSelect('s.visitor_id', 'visitorId')
    .addSelect('s.status', 'status')
    .addSelect('s.started_at', 'startedAt')
    .addSelect('COALESCE(s.ended_at, s.last_activity_at, s.started_at)', 'effectiveEndedAt')
    .where('s.tenant_id = :tenantId', { tenantId })
    .andWhere("s.status IN ('closed', 'handoff')")
    .andWhere('COALESCE(s.ended_at, s.last_activity_at, s.started_at) > :since', { since })
    .orderBy('COALESCE(s.ended_at, s.last_activity_at, s.started_at)', 'ASC')
    .limit(cap)
    .getRawMany();
  return rows.map((r) => ({
    ...r,
    startedAt: new Date(r.startedAt),
    effectiveEndedAt: new Date(r.effectiveEndedAt),
  }));
}

async function loadTranscript(sessionId: string): Promise<TranscriptMessage[]> {
  const rows: Array<{ id: string; content: string; sender: string }> = await AppDataSource.query(
    `SELECT m.id, m.content, p.type AS sender
     FROM messages m
     JOIN participants p ON p.id = m.participant_id
     WHERE m.session_id = $1 AND m.type = 'text'
     ORDER BY m.created_at ASC`,
    [sessionId],
  );
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    sender: (['user', 'agent', 'bot', 'system'].includes(r.sender) ? r.sender : 'system') as TranscriptMessage['sender'],
  }));
}

/** Refresh one tenant. Exported for tests and manual (admin) triggering. */
export async function refreshTenantInsights(tenantId: string, now = new Date()): Promise<void> {
  const stateRepo = AppDataSource.getRepository(InsightsRefreshState);
  const judgmentRepo = AppDataSource.getRepository(Judgment);

  let state = await stateRepo.findOne({ where: { tenantId } });
  if (!state) {
    state = stateRepo.create({ tenantId, lastRefreshedAt: null });
  }

  const since = state.lastRefreshedAt ?? new Date(now.getTime() - BACKFILL_DAYS * 24 * 60 * 60 * 1000);
  const sessions = await loadEligibleSessions(tenantId, since, BACKFILL_CAP);

  let watermark: Date | null = null;
  let watermarkFrozen = false;
  let judged = 0;
  let failed = 0;

  for (const session of sessions) {
    // Unique(session_id) makes re-judging a no-op risk; skip cheaply instead.
    const already = await judgmentRepo.findOne({ where: { sessionId: session.id } });
    if (already) {
      if (!watermarkFrozen) watermark = session.effectiveEndedAt;
      continue;
    }

    try {
      const transcript = await loadTranscript(session.id);
      const verdict = await judgeTranscript(transcript, session.status === 'handoff');

      let canonicalTopicId: string | null = null;
      let rejectedTopic: string | null = null;
      let rejectReason: string | null = null;

      if (verdict.hadQuestion && verdict.topicPhrase) {
        const canon = await canonicalizeTopic(tenantId, verdict.topicPhrase, verdict.evidenceMessageIds);
        if (canon.ok) {
          canonicalTopicId = canon.canonicalTopicId;
        } else {
          // ADR-0009 layer 3: unmapped diagnostics, no Gap contribution.
          rejectedTopic = verdict.topicPhrase.slice(0, 200);
          rejectReason = canon.rejectReason;
        }
      }

      await judgmentRepo.save(
        judgmentRepo.create({
          tenantId,
          sessionId: session.id,
          visitorId: session.visitorId,
          sessionStartedAt: session.startedAt,
          hadQuestion: verdict.hadQuestion,
          satisfied: verdict.satisfied,
          topicPhrase: verdict.topicPhrase,
          canonicalTopicId,
          rejectedTopic,
          rejectReason,
          evidenceMessageIds: verdict.evidenceMessageIds,
          reasoning: verdict.reasoning,
        }),
      );
      judged += 1;
      if (!watermarkFrozen) watermark = session.effectiveEndedAt;
    } catch (err) {
      failed += 1;
      watermarkFrozen = true; // failed session retries next run
      logger.warn('[insights-refresh] judge failed for session', {
        tenantId,
        sessionId: session.id,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  // Completeness over the rolling 7-day window (ADR-0006).
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [{ eligible }] = await AppDataSource.query(
    `SELECT COUNT(*)::int AS eligible FROM chat_sessions s
     WHERE s.tenant_id = $1 AND s.status IN ('closed','handoff')
       AND COALESCE(s.ended_at, s.last_activity_at, s.started_at) >= $2`,
    [tenantId, windowStart],
  );
  const [{ judgedInWindow }] = await AppDataSource.query(
    `SELECT COUNT(*)::int AS "judgedInWindow" FROM chat_sessions s
     JOIN chatbot_judgments j ON j.session_id = s.id
     WHERE s.tenant_id = $1 AND s.status IN ('closed','handoff')
       AND COALESCE(s.ended_at, s.last_activity_at, s.started_at) >= $2`,
    [tenantId, windowStart],
  );
  const completeness = eligible > 0 ? judgedInWindow / eligible : 1;

  await aggregateGaps(tenantId, now);

  state.lastRefreshedAt = watermarkFrozen ? watermark : now;
  state.judgmentsCompleteness = completeness.toFixed(4);
  state.lastRunError = failed > 0 ? `${failed} session(s) failed judging` : null;
  await stateRepo.save(state);

  logger.info('[insights-refresh] tenant refreshed', {
    tenantId,
    judged,
    failed,
    completeness: Number(completeness.toFixed(3)),
  });
}

/** One full pass over all entitled tenants. Sequential — cost is bounded by volume, not tenants. */
export async function runRefreshInsightsOnce(now = new Date()): Promise<void> {
  const tenants: Array<{ id: string }> = await AppDataSource.getRepository(Tenant)
    .createQueryBuilder('t')
    .select('t.id', 'id')
    .where("t.status = 'active'")
    .getRawMany();

  for (const { id } of tenants) {
    try {
      const entitlements = await getEntitlements(id);
      if (!entitlements.features.gapInsights) continue; // flag, never tier (ADR-0013)
      await refreshTenantInsights(id, now);
    } catch (err) {
      logger.error('[insights-refresh] tenant pass failed', {
        tenantId: id,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }
}

/**
 * Register the nightly schedule: a 10-minute tick that fires the pass once
 * per UTC day after 02:00 (ADR-0006). In-memory last-run marker — a restart
 * may re-run the pass, which is safe (judgments are unique per session).
 */
export function registerInsightsRefreshJob(): void {
  let lastRunDay: string | null = null;
  let running = false;

  setInterval(async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() < 2 || lastRunDay === day || running) return;
    running = true;
    lastRunDay = day;
    try {
      await runRefreshInsightsOnce(now);
    } catch (err) {
      logger.error('[insights-refresh] nightly pass crashed', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    } finally {
      running = false;
    }
  }, 10 * 60 * 1000);

  logger.info('[insights-refresh] nightly job registered (02:00 UTC)');
}
