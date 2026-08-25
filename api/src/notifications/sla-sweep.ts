/**
 * Handoff / guardrail-pause SLA sweep (.scratch/plan-enforce-derisk-p0.md Slice B2).
 * Re-alerts staff when a handoff or guardrail pause sits unacknowledged past the
 * SLA, so enforce-driven pauses/handoffs aren't silently abandoned. Delivery is the
 * Slice B1 path (createForTenant → WS broadcast + push); this only decides WHEN to
 * (re-)alert.
 *
 * Four overdue sources, kept disjoint:
 *  1. open handoff_requests (status='requested', unassigned);
 *  2. session-only handoffs (chat_sessions.status='handoff' with NO open
 *     handoff_requests row — the /handoffs/request path writes no HandoffRequest);
 *  3. guardrail pauses (ai_auto_reply_enabled=false AND guardrail_status<>'normal'),
 *     excluding closed sessions;
 *  4. SILENT BOT: a live bot-owned session, AI on and nothing paused, where the
 *     customer's last message never got an answer. Nothing else detects this.
 *     A guardrails freeze in Aug 2026 left a WhatsApp conversation dead for 40
 *     minutes and the only trace was one INFO log line, because every other
 *     source needs a handoff or a pause to exist. This one needs neither.
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
import { notifyOverdueHandoff } from '../services/handoff-notification.service';
import { logger } from '../utils/logger';

const SLA_MIN = 10; // overdue once unacknowledged this long
const REALERT_MIN = 30; // re-alert at most once per this window
const MAX_REALERTS = 3; // stop after this many buckets (bounds notification rows)
const BATCH = 100; // cap items per source per sweep

let running = false;

type OverdueKind = 'handoff' | 'guardrail' | 'silent';

const ALERT: Record<OverdueKind, {
  type: string;
  title: string;
  message: (ageMin: number) => string;
}> = {
  handoff: {
    type: 'handoff.overdue',
    title: 'A handoff is waiting',
    message: (m) => `A customer has been waiting ${m} min for a human. Open the Inbox to respond.`,
  },
  guardrail: {
    type: 'guardrail.overdue',
    title: 'A paused conversation needs review',
    message: (m) => `AI has been paused on a conversation for ${m} min with no action. Review it in the Inbox.`,
  },
  silent: {
    type: 'bot.silent',
    title: 'A customer got no reply',
    message: (m) => `A customer has waited ${m} min and the AI has not answered. Open the Inbox to respond.`,
  },
};

/** One overdue item. `since` is the raw timestamp the age is measured from; the
 *  age itself is derived in `overdue()`, never with the DB clock. `created_at`
 *  and `updated_at` are `timestamp without time zone`, so they round-trip through
 *  the driver in the API's own zone; mixing them with `now()` (timestamptz, read
 *  in the DB session zone) skews every age by the difference between the two.
 *  Production runs both in UTC, local development does not. */
interface OverdueRow {
  id: string;
  tenantId: string;
  sessionId: string;
  since: Date;
}

interface Overdue extends Omit<OverdueRow, 'since'> {
  ageMin: number;
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


  const handoffReqs = (await AppDataSource.getRepository(HandoffRequest)
    .createQueryBuilder('h')
    // Require the session to STILL be in handoff — autoCloseStaleSessions returns a
    // stale handoff session to 'bot' after 60 min without touching handoff_requests,
    // so an unjoined 'requested' row could alert after the handoff already ended.
    .innerJoin(ChatSession, 's', 's.id = h.sessionId')
    .select('h.id', 'id')
    .addSelect('h.tenantId', 'tenantId')
    .addSelect('h.sessionId', 'sessionId')
    .addSelect('h.requestedAt', 'since')
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
    .addSelect('s.updatedAt', 'since')
    .where('s.status = :st', { st: 'handoff' })
    .andWhere('s.updatedAt < :cutoff', { cutoff })
    .andWhere(
      'NOT EXISTS (SELECT 1 FROM handoff_requests hr WHERE hr.session_id = s.id AND hr.status = :req)',
      { req: 'requested' },
    )
    .limit(BATCH)
    .getRawMany()) as OverdueRow[];

  // Source 3 ages a pause from the BLOCK that caused it, not from the session
  // row. `updated_at` is not the pause: `atomicDisableAutoReply` and the inbound
  // message counter are both raw UPDATEs that never touch it, so it still holds
  // whenever the row was last saved through the ORM — often hours earlier. That
  // inflated the age in the alert text and, worse, sent the re-alert bucket
  // straight to the cap, so a paused conversation was announced once and then
  // never reminded again.
  //
  // The journal row that disabled auto-reply IS the pause, to the millisecond.
  // It is `timestamptz` while `updated_at` is not, so the two are selected
  // separately and resolved in JS: casting between them in SQL would reintroduce
  // the very time-zone skew this file already warns about.
  const pausedAt = `(SELECT MAX(g.created_at) FROM guardrail_spam_logs g
      WHERE g.conversation_id = s.id AND g.ai_auto_reply_disabled = true)`;
  const pausedRows = (await AppDataSource.getRepository(ChatSession)
    .createQueryBuilder('s')
    .select('s.id', 'id')
    .addSelect('s.tenantId', 'tenantId')
    .addSelect('s.id', 'sessionId')
    .addSelect(pausedAt, 'since')
    .addSelect('s.updatedAt', 'fallback')
    .where('s.aiAutoReplyEnabled = false')
    .andWhere("s.guardrailStatus <> 'normal'")
    .andWhere("s.status <> 'closed'")
    // A pause with no journal row (a lost write, or a pre-journal code path) must
    // still alert, so it keeps the old clock rather than dropping out.
    .andWhere(`(${pausedAt} < :cutoff OR (${pausedAt} IS NULL AND s.updatedAt < :cutoff))`, { cutoff })
    .limit(BATCH)
    .getRawMany()) as (Omit<OverdueRow, 'since'> & { since: Date | null; fallback: Date })[];
  const pauses: OverdueRow[] = pausedRows.map(({ fallback, since, ...row }) => ({
    ...row,
    since: since ?? fallback,
  }));

  // Source 4. The customer's newest un-flagged message, and the newest reply of
  // any kind. A reply older than that message (or none at all) means the bot owes
  // an answer it never gave. Flagged messages are excluded: a blocked message is
  // deliberately unanswered, and source 3 alerts on the pause it caused.
  const lastAsk = `(SELECT MAX(m.created_at) FROM messages m
      JOIN participants p ON p.id = m.participant_id AND p.type = 'user'
     WHERE m.session_id = s.id AND m.is_deleted = false AND m.guardrail_flagged = false)`;
  const lastReply = `(SELECT MAX(b.created_at) FROM messages b
      JOIN participants bp ON bp.id = b.participant_id AND bp.type IN ('bot', 'agent')
     WHERE b.session_id = s.id AND b.is_deleted = false)`;
  const asked = (await AppDataSource.getRepository(ChatSession)
    .createQueryBuilder('s')
    .select('s.id', 'id')
    .addSelect('s.tenantId', 'tenantId')
    .addSelect('s.id', 'sessionId')
    .addSelect(lastAsk, 'since')
    // Only sessions the BOT owes an answer on: a human-owned or closed session is
    // someone else's job, and a paused one is source 3.
    .where("s.status IN ('bot', 'waiting')")
    .andWhere("s.ownership = 'bot_owned'")
    .andWhere('s.aiAutoReplyEnabled = true')
    .andWhere(`${lastAsk} < :cutoff`, { cutoff })
    .andWhere(`(${lastReply} IS NULL OR ${lastReply} < ${lastAsk})`)
    .limit(BATCH)
    .getRawMany()) as OverdueRow[];

  let alerted = 0;
  alerted += await alertAll('handoff', overdue(handoffReqs), true); // r.id IS a handoff id
  alerted += await alertAll('handoff', overdue(sessionHandoffs), false); // r.id is a session id
  alerted += await alertAll('guardrail', overdue(pauses), false);
  alerted += await alertAll('silent', overdue(asked), false);
  return { alerted };
}

/** Derive the waiting time from the app clock. See `OverdueRow.since`. */
function overdue(rows: OverdueRow[]): Overdue[] {
  return rows.map(({ since, ...row }) => ({
    ...row,
    ageMin: Math.max(0, (Date.now() - new Date(since).getTime()) / 60_000),
  }));
}

async function alertAll(
  kind: OverdueKind,
  rows: Overdue[],
  hasHandoffId: boolean,
): Promise<number> {
  const copy = ALERT[kind];
  let n = 0;
  for (const r of rows) {
    const ageMin = Math.floor(r.ageMin);
    // Clamp (don't skip) so even backlog older than the cap alerts once on first
    // sight; createForTenant's per-bucket dedupe then bounds it to MAX_REALERTS.
    const bucket = Math.min(Math.floor(ageMin / REALERT_MIN), MAX_REALERTS - 1);
    // A silent bot is a PLATFORM fault, not a staffing one: log it at error level
    // so it shows up in an ops log search, not only in the tenant's inbox.
    if (kind === 'silent') {
      logger.error('[sla-sweep] bot owes a reply and never sent one', {
        sessionId: r.sessionId, tenantId: r.tenantId, ageMin,
      });
    }
    try {
      await notificationService.createForTenant({
        tenantId: r.tenantId,
        type: copy.type,
        title: copy.title,
        message: copy.message(ageMin),
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

    // Email escalation for overdue HANDOFFS only (#131), decoupled from the
    // platform alert above so a mail failure never suppresses the toast/push.
    // sendDurable's per-(id,bucket,user) idempotency key bounds it to one email
    // per bucket per recipient, honouring the same handoffEmail preference.
    if (kind === 'handoff') {
      try {
        await notifyOverdueHandoff({
          tenantId: r.tenantId,
          overdueId: r.id,
          sessionId: r.sessionId,
          bucket,
          ageMinutes: ageMin,
        });
      } catch (err) {
        logger.warn('[sla-sweep] overdue handoff email failed', {
          id: r.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return n;
}
