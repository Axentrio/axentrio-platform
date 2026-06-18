/**
 * Handoff / guardrail-pause SLA sweep (.scratch/plan-enforce-derisk-p0.md Slice B2).
 * Re-alerts staff when a handoff or guardrail pause sits unacknowledged past the
 * SLA, so enforce-driven pauses/handoffs aren't silently abandoned. Delivery is the
 * Slice B1 path (createForTenant → WS broadcast + push); this only decides WHEN to
 * (re-)alert.
 *
 * Three overdue sources, kept disjoint:
 *  1. open handoff_requests (status='requested', unassigned);
 *  2. session-only handoffs (chat_sessions.status='handoff' with NO open
 *     handoff_requests row — the /handoffs/request path writes no HandoffRequest);
 *  3. guardrail pauses (ai_auto_reply_enabled=false AND guardrail_status<>'normal'),
 *     excluding closed sessions.
 *
 * Re-alert cadence is bucketed (once per REALERT_MIN) and capped (MAX_REALERTS) so a
 * stuck item re-pings a few times then stops — bounded, not once-ever and not spammy.
 * Acknowledgement is implicit: an accepted/assigned handoff or a resumed pause drops
 * out of the query and stops alerting on its own. Dedupe is via createForTenant's
 * dedupeBase (per-recipient), so the same bucket never double-alerts a user.
 */
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { HandoffRequest } from '../database/entities/HandoffRequest';
import { notificationService } from '../services/notification.service';
import { logger } from '../utils/logger';

const SLA_MIN = 10; // overdue once unacknowledged this long
const REALERT_MIN = 30; // re-alert at most once per this window
const MAX_REALERTS = 3; // stop after this many buckets (bounds notification rows)
const BATCH = 100; // cap items per source per sweep

let running = false;

interface OverdueRow {
  id: string;
  tenantId: string;
  sessionId: string;
  ageMin: string;
}

export async function sweepOverdueHandoffsAndPauses(): Promise<{ alerted: number }> {
  if (running) return { alerted: 0 };
  running = true;
  try {
    return await doSweep();
  } finally {
    running = false;
  }
}

async function doSweep(): Promise<{ alerted: number }> {
  const cutoff = new Date(Date.now() - SLA_MIN * 60_000);
  const ageExpr = (alias: string, col: string) => `EXTRACT(EPOCH FROM (now() - ${alias}.${col})) / 60`;

  const handoffReqs = (await AppDataSource.getRepository(HandoffRequest)
    .createQueryBuilder('h')
    // Require the session to STILL be in handoff — autoCloseStaleSessions returns a
    // stale handoff session to 'bot' after 60 min without touching handoff_requests,
    // so an unjoined 'requested' row could alert after the handoff already ended.
    .innerJoin(ChatSession, 's', 's.id = h.sessionId')
    .select('h.id', 'id')
    .addSelect('h.tenantId', 'tenantId')
    .addSelect('h.sessionId', 'sessionId')
    .addSelect(ageExpr('h', 'requestedAt'), 'ageMin')
    .where('h.status = :st', { st: 'requested' })
    .andWhere('h.assignedAgentId IS NULL')
    .andWhere("s.status = 'handoff'")
    .andWhere('h.requestedAt < :cutoff', { cutoff })
    .limit(BATCH)
    .getRawMany()) as OverdueRow[];

  const sessionHandoffs = (await AppDataSource.getRepository(ChatSession)
    .createQueryBuilder('s')
    .select('s.id', 'id')
    .addSelect('s.tenantId', 'tenantId')
    .addSelect('s.id', 'sessionId')
    .addSelect(ageExpr('s', 'updatedAt'), 'ageMin')
    .where('s.status = :st', { st: 'handoff' })
    .andWhere('s.updatedAt < :cutoff', { cutoff })
    .andWhere(
      'NOT EXISTS (SELECT 1 FROM handoff_requests hr WHERE hr.session_id = s.id AND hr.status = :req)',
      { req: 'requested' },
    )
    .limit(BATCH)
    .getRawMany()) as OverdueRow[];

  const pauses = (await AppDataSource.getRepository(ChatSession)
    .createQueryBuilder('s')
    .select('s.id', 'id')
    .addSelect('s.tenantId', 'tenantId')
    .addSelect('s.id', 'sessionId')
    .addSelect(ageExpr('s', 'updatedAt'), 'ageMin')
    .where('s.aiAutoReplyEnabled = false')
    .andWhere("s.guardrailStatus <> 'normal'")
    .andWhere("s.status <> 'closed'")
    .andWhere('s.updatedAt < :cutoff', { cutoff })
    .limit(BATCH)
    .getRawMany()) as OverdueRow[];

  let alerted = 0;
  alerted += await alertAll('handoff', true, handoffReqs); // r.id IS a handoff id
  alerted += await alertAll('handoff', false, sessionHandoffs); // r.id is a session id
  alerted += await alertAll('guardrail', false, pauses);
  return { alerted };
}

async function alertAll(
  kind: 'handoff' | 'guardrail',
  hasHandoffId: boolean,
  rows: OverdueRow[],
): Promise<number> {
  let n = 0;
  for (const r of rows) {
    const ageMin = Math.floor(Number(r.ageMin) || 0);
    // Clamp (don't skip) so even backlog older than the cap alerts once on first
    // sight; createForTenant's per-bucket dedupe then bounds it to MAX_REALERTS.
    const bucket = Math.min(Math.floor(ageMin / REALERT_MIN), MAX_REALERTS - 1);
    try {
      await notificationService.createForTenant({
        tenantId: r.tenantId,
        type: kind === 'handoff' ? 'handoff.overdue' : 'guardrail.overdue',
        title: kind === 'handoff' ? 'A handoff is waiting' : 'A paused conversation needs review',
        message:
          kind === 'handoff'
            ? `A customer has been waiting ${ageMin} min for a human. Open the Inbox to respond.`
            : `AI has been paused on a conversation for ${ageMin} min with no action. Review it in the Inbox.`,
        data: { sessionId: r.sessionId, handoffId: hasHandoffId ? r.id : null, ageMinutes: ageMin },
        // Bucketed → re-alerts once per REALERT_MIN; createForTenant dedupes within a bucket.
        dedupeBase: `${kind}_overdue:${r.id}:${bucket}`,
      });
      n++;
    } catch (err) {
      logger.warn('[sla-sweep] alert failed', {
        kind,
        id: r.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return n;
}
