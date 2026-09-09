/**
 * Conversation retention — the expiry side of the transcript.
 *
 * No scheduled job has ever touched `messages`, `participants` or `chat_sessions`.
 * The only path that deleted a transcript was a manual admin call to
 * `DELETE /api/v1/chats/bulk-delete`. Sweeps exist for webhook logs, audit logs,
 * agent traces, customer memory, booking coordinates and leads; the transcript —
 * the single largest store of end-customer personal data on the platform — had
 * none. That fails GDPR Art 5(1)(e) (storage limitation).
 *
 * Three decisions carry the design:
 *
 * **1. Default is KEEP.** `conversationRetentionDays` is unset for every existing
 * tenant, and unset means never expire — exactly like lead retention. Nothing is
 * deleted on deploy; a tenant has to choose a period. Silently deleting a
 * customer's conversation history on an upgrade is unrecoverable.
 *
 * **2. DELETE, not "anonymise".** Under EDPB Guidelines 02/2026 para 15 the data
 * stays personal for us as long as the controller can identify the person, so a
 * scrub we perform does not take it out of the GDPR. The honest control is
 * deletion.
 *
 * **3. It deletes the whole conversation, and says so.** `messages`,
 * `participants`, `conversation_bindings`, `handoff_requests`,
 * `conversation_commands` and `chatbot_customer_memory_runs` all cascade from
 * `chat_sessions`. `chatbot_judgments` does NOT — it has no foreign key at all —
 * so it is deleted explicitly here. Leaving it would keep the visitor id and the
 * model's verbatim `reasoning` for a conversation the tenant believes is gone.
 */
import { AppDataSource } from '../database/data-source';
import { notificationService } from '../services/notification.service';
import { logAudit } from '../utils/audit';
import { logComplianceEvent } from '../compliance/compliance-events.service';
import { logger } from '../utils/logger';

/** Guard rails on what a tenant may configure. Same shape as lead retention. */
export const MIN_CONVERSATION_RETENTION_DAYS = 30;
export const MAX_CONVERSATION_RETENTION_DAYS = 3650; // 10 years

/**
 * Per-tenant cap per run, so one large backlog cannot monopolise the sweep.
 *
 * Exported and overridable ONLY so a regression test can exercise the LIMIT
 * boundary without seeding hundreds of sessions. Production never overrides it.
 */
export const MAX_SESSIONS_PER_TENANT_PER_RUN = 500;

/** Tenant-settings key holding the chosen period. Absent = keep forever. */
export const CONVERSATION_RETENTION_SETTING = 'conversationRetentionDays';

let running = false;

export interface ConversationRetentionSweepResult {
  tenantsConsidered: number;
  sessionsDeleted: number;
  messagesDeleted: number;
  judgmentsDeleted: number;
}

/** Read a tenant's configured period, or null when they have not set one. */
export function readConversationRetentionDays(settings: unknown): number | null {
  const raw = (settings as { conversationRetentionDays?: unknown } | null)
    ?.conversationRetentionDays;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const n = Math.round(raw);
  // Out-of-range stored values (hand-edited jsonb) degrade to "no retention"
  // rather than to an aggressive default — fail towards keeping data, never
  // towards deleting it.
  if (n < MIN_CONVERSATION_RETENTION_DAYS || n > MAX_CONVERSATION_RETENTION_DAYS) return null;
  return n;
}

/**
 * Delete conversations whose last activity is older than their tenant's period.
 *
 * Sequential per tenant and capped per run: each tenant is a handful of
 * statements, and a sweep that saturates the database to delete cold rows would
 * be a worse bug than the one it fixes.
 */
export async function sweepConversationRetention(
  opts: { batchLimit?: number } = {},
): Promise<ConversationRetentionSweepResult> {
  const batchLimit = opts.batchLimit ?? MAX_SESSIONS_PER_TENANT_PER_RUN;
  const result: ConversationRetentionSweepResult = {
    tenantsConsidered: 0,
    sessionsDeleted: 0,
    messagesDeleted: 0,
    judgmentsDeleted: 0,
  };
  if (running) return result;
  running = true;

  try {
    // Only tenants that have actually chosen a period. The jsonb predicate keeps
    // this cheap — most tenants will never appear here.
    const tenants: Array<{ id: string; settings: Record<string, unknown> }> =
      await AppDataSource.query(
        `SELECT id, settings FROM tenants
          WHERE settings ? 'conversationRetentionDays'
            AND status <> 'suspended'`,
      );

    for (const tenant of tenants) {
      const days = readConversationRetentionDays(tenant.settings);
      if (days === null) {
        logger.warn('[conversation-retention] ignoring malformed conversationRetentionDays', {
          tenantId: tenant.id,
        });
        continue;
      }
      result.tenantsConsidered += 1;

      // Age is measured on last_activity_at, NOT started_at: a conversation the
      // customer kept returning to must not expire from under them. Status is
      // deliberately not filtered — a session untouched for the configured period
      // is over in every sense that matters, and leaving `bot`-status rows behind
      // forever would defeat the control.
      const sessions: Array<{ id: string }> = await AppDataSource.query(
        `SELECT id FROM chat_sessions
          WHERE tenant_id = $1
            AND last_activity_at < now() - ($2 || ' days')::interval
          ORDER BY last_activity_at ASC
          LIMIT $3`,
        [tenant.id, String(days), batchLimit],
      );
      if (sessions.length === 0) continue;

      const sessionIds = sessions.map((s) => s.id);

      // 1. Judgments first: no foreign key to chat_sessions, so nothing cascades.
      const judgments = await AppDataSource.query(
        `DELETE FROM chatbot_judgments
          WHERE tenant_id = $1 AND session_id = ANY($2::uuid[])
          RETURNING id`,
        [tenant.id, sessionIds],
      );

      // 2. Messages, so the notification can report how much text went.
      const messages = await AppDataSource.query(
        `DELETE FROM messages
          WHERE tenant_id = $1 AND session_id = ANY($2::uuid[])
          RETURNING id`,
        [tenant.id, sessionIds],
      );

      // 3. The sessions. participants, conversation_bindings, handoff_requests,
      //    conversation_commands and customer-memory runs cascade from here.
      const deleted = await AppDataSource.query(
        `DELETE FROM chat_sessions
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])
          RETURNING id`,
        [tenant.id, sessionIds],
      );

      const sessionsDeleted = rowCount(deleted);
      const messagesDeleted = rowCount(messages);
      const judgmentsDeleted = rowCount(judgments);
      result.sessionsDeleted += sessionsDeleted;
      result.messagesDeleted += messagesDeleted;
      result.judgmentsDeleted += judgmentsDeleted;

      if (sessionsDeleted > 0) {
        // ONE summary per run, not one notification per conversation.
        await notificationService
          .createForTenant({
            tenantId: tenant.id,
            type: 'conversations_retention_applied',
            title: 'Old conversations deleted',
            message: `${sessionsDeleted} conversation${sessionsDeleted === 1 ? '' : 's'} idle for more than ${days} days were permanently deleted, per your retention setting.`,
            data: { sessionsDeleted, messagesDeleted, retentionDays: days },
            dedupeBase: `conversation-retention:${tenant.id}:${new Date().toISOString().slice(0, 10)}`,
          })
          .catch(() => {});

        await logAudit(
          'system',
          'conversations.retention_applied',
          'tenant',
          tenant.id,
          tenant.id,
          {
            sessionsDeleted,
            messagesDeleted,
            judgmentsDeleted,
            retentionDays: days,
            cappedAtBatchLimit: sessions.length >= batchLimit,
          },
        ).catch(() => {});

        await logComplianceEvent({
          actorId: 'system',
          eventType: 'conversations.retention_applied',
          tenantId: tenant.id,
          subjectType: 'tenant',
          subjectId: tenant.id,
          details: {
            sessionsDeleted,
            messagesDeleted,
            judgmentsDeleted,
            retentionDays: days,
            cappedAtBatchLimit: sessions.length >= batchLimit,
          },
        });
      }
    }

    if (result.sessionsDeleted > 0 || result.tenantsConsidered > 0) {
      logger.info('[conversation-retention] sweep complete', result);
    }
    return result;
  } finally {
    running = false;
  }
}

/**
 * Daily, plus one run shortly after boot so a redeploy does not leave the sweep
 * silent until the first tick. Unflagged: it is a NO-OP for every tenant that has
 * not chosen a period, and a data-protection control should not depend on
 * remembering to set an environment variable.
 */
export function startConversationRetentionSweep(): NodeJS.Timeout[] {
  const run = () => {
    sweepConversationRetention().catch((error) => {
      logger.error('[conversation-retention] sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  return [setTimeout(run, 120_000), setInterval(run, 24 * 60 * 60 * 1000)];
}

/** `.query()` returns `[rows, affectedCount]` for DELETE in node-pg via TypeORM. */
function rowCount(res: unknown): number {
  if (Array.isArray(res) && typeof res[1] === 'number') return res[1];
  if (Array.isArray(res)) return res.length;
  return 0;
}
