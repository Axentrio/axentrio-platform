/**
 * "Can this tenant analyse right now, and if not, why?" — the DB-backed half of
 * `analysis-policy.ts`.
 *
 * The new-conversation count uses the SAME predicate the refresh job uses to select
 * sessions (`loadEligibleSessions`): closed or handed off, guardrail-clean, ended after
 * the watermark. Counting anything else would let the button unlock on conversations the
 * judge will then skip, and the tenant would burn their 72-hour cooldown on a run that
 * analysed nothing. If that predicate ever changes, this must change with it — the
 * duplication is deliberate (a shared query builder would drag the job's cap and
 * ordering into a counter that wants neither) but it is a coupling worth knowing about.
 */
import { AppDataSource } from '../database/data-source';
import { InsightsRefreshState } from '../database/entities/InsightsRefreshState';
import { getEntitlements } from '../billing/entitlements';
import {
  analysisPolicyFor,
  checkEligibility,
  type AnalysisPolicy,
  type Eligibility,
} from './analysis-policy';

export interface AnalysisStatus extends Eligibility {
  policy: AnalysisPolicy;
  /** Last time analysis actually ran, manual or automatic. */
  lastRefreshedAt: Date | null;
}

/**
 * Conversations the judge would consider, closed since the watermark.
 *
 * Counted, never listed: on a busy tenant this is thousands of rows and the caller only
 * needs the number. No cap either — a cap would make "you have 500 new chats" the
 * permanent answer for anyone above it.
 */
export async function countNewAnalysableChats(tenantId: string, since: Date | null): Promise<number> {
  const rows: Array<{ n: number }> = await AppDataSource.query(
    `SELECT count(*)::int AS n
       FROM chat_sessions s
      WHERE s.tenant_id = $1
        AND s.status IN ('closed', 'handoff')
        AND s.guardrail_status = 'normal'
        AND ($2::timestamptz IS NULL
             OR COALESCE(s.ended_at, s.last_activity_at, s.started_at) > $2::timestamptz)`,
    [tenantId, since ? since.toISOString() : null],
  );
  return rows[0]?.n ?? 0;
}

export async function getAnalysisStatus(tenantId: string, now = new Date()): Promise<AnalysisStatus> {
  const { features } = await getEntitlements(tenantId);
  const policy = analysisPolicyFor(features);

  const state = await AppDataSource.getRepository(InsightsRefreshState).findOne({
    where: { tenantId },
  });
  const lastRefreshedAt = state?.lastRefreshedAt ?? null;
  const lastManualRunAt = state?.lastManualRunAt ?? null;

  // Skip the count entirely for tenants who could not act on it — an unentitled tenant
  // and an Enterprise one both have no button, and this runs on every page load.
  const needsCount = policy.tier !== 'none' && !policy.automatic;
  const newChats = needsCount ? await countNewAnalysableChats(tenantId, lastRefreshedAt) : 0;

  return {
    ...checkEligibility({ policy, newChats, lastManualRunAt, now }),
    policy,
    lastRefreshedAt,
  };
}

/**
 * Stamp the manual-run clock. Written BEFORE the analysis rather than after: a run that
 * crashes half way has still spent the LLM calls, and letting the tenant immediately
 * retry would turn a failing tenant into an unbounded bill. The cost of erring this way
 * is one lost run; the cost of the other way is repeated at their expense.
 */
export async function markManualRun(tenantId: string, now = new Date()): Promise<void> {
  await AppDataSource.query(
    `INSERT INTO chatbot_insights_refresh_state (tenant_id, last_manual_run_at)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET last_manual_run_at = EXCLUDED.last_manual_run_at`,
    [tenantId, now.toISOString()],
  );
}
