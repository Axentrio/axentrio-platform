/**
 * Self-service account deletion: request → dormancy → execution.
 *
 * The published promise (copilot docs, `cancelling-your-subscription`) told
 * customers to email support for permanent deletion, but nothing in the codebase
 * could delete a tenant: `Tenant.deletedAt` existed and was never set, and the
 * admin routes offered only suspend/activate. Art 28(3)(g) expects a processor to
 * delete or return the data at the end of the service, so this is that path.
 *
 * Four decisions carry the design:
 *
 * **1. The dormancy clock starts at the REQUEST, not at the first login.** Art 12(3)
 *    gives the controller one month to act on a rights request. A 30-day window
 *    that begins on the request fits inside it; one that begins when the customer
 *    next logs in does not.
 *
 * **2. Nothing is deleted during dormancy, but nothing is PROCESSED either.** The
 *    tenant's bots are paused (which is what stops the widget answering and stops
 *    new leads being captured) and reactivation resumes exactly the bots this
 *    request paused, so a bot the owner had deliberately paused stays paused.
 *
 * **3. The tenant ROW is kept and anonymised; its content is deleted.** A hard
 *    `DELETE FROM tenants` would cascade the accounting records with it
 *    (`legal_invoices`, `billing_events`, `tenant_billing_accounts` are all
 *    ON DELETE CASCADE), and invoicing records have a statutory retention that
 *    outranks an erasure request — Art 17(3)(b). So the content goes, the
 *    identifier goes, and the invoice does not.
 *
 * **4. The purge is an explicit list, guarded by a test.** Most tenant tables have
 *    no foreign key to `tenants` at all, so nothing cascades; a table added later
 *    would silently survive every deletion. `tenant-deletion-coverage.test.ts`
 *    enumerates the real schema and fails if a tenant-scoped table is neither
 *    purged nor explicitly retained.
 */
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { Bot } from '../database/entities/Bot';
import { createS3Client } from '../config/s3.config';
import { deleteClerkOrganization } from '../services/clerk-sync.service';
import { cancelAtPeriodEnd } from '../billing/service';
import { config } from '../config/environment';
import { logAudit } from '../utils/audit';
import { logComplianceEvent } from '../compliance/compliance-events.service';
import { logger } from '../utils/logger';

/**
 * How long the account stays recoverable. The clock starts at the REQUEST, so the
 * whole window has to fit inside the one month Art 12(3) allows.
 *
 * Configurable (`DELETION_DORMANCY_DAYS`) because the number is a legal decision;
 * 30 is the largest round value that still fits.
 */
export const DELETION_DORMANCY_DAYS = config.tenantDeletion.dormancyDays;

/** Purged by `tenant_id`. */
export const PURGE_BY_TENANT_ID = [
  'booking_logs',
  'chatbot_availability_calls',
  'chatbot_availability_rules',
  'chatbot_booking_offers',
  'chatbot_booking_settings',
  'chatbot_bookings',
  'chatbot_bot_knowledge_bases',
  'chatbot_bots',
  'chatbot_calendar_credentials',
  'chatbot_canonical_topics',
  'chatbot_copilot_conversations',
  'chatbot_copilot_messages',
  'chatbot_copilot_traces',
  'chatbot_customer_facts',
  'chatbot_customer_memory',
  'chatbot_customer_memory_runs',
  'chatbot_demand_signals',
  'chatbot_gaps',
  'chatbot_insight_digests',
  'chatbot_insight_experiments',
  'chatbot_insights_refresh_state',
  'chatbot_judgments',
  'chatbot_lead_conversations',
  'chatbot_leads',
  'chatbot_sentiment_themes',
  'chatbot_service_types',
  'chatbot_tenant_trial_reservations',
  'chatbot_travel_usage',
  'chat_sessions',
  'conversation_commands',
  'email_deliveries',
  'file_uploads',
  'guardrail_output_logs',
  'guardrail_spam_logs',
  'handoff_requests',
  'knowledge_storage_connections',
  'llm_usage_daily',
  'messages',
  'mobile_devices',
  'notification_outbox',
  'notifications',
  'pending_invites',
  'storage_import_jobs',
  'support_agents',
  'tenant_bot_templates',
  'tenant_modules',
  'tenant_token_balance',
  'upload_sessions',
  'users',
  'webhook_delivery_logs',
];

/**
 * Pre-snake_case tables that key the tenant as a QUOTED camelCase column. They
 * predate the convention and cannot be reached by the loop above.
 */
export const PURGE_BY_CAMEL_TENANT_ID = [
  'agent_traces',
  'canned_responses',
  'channel_connections',
  'website_crawl_runs',
  'knowledge_bases',
  'knowledge_chunks',
  'knowledge_documents',
];

/** Reached through a session, not a tenant column. */
export const PURGE_BY_SESSION = [
  'participants',
  'chatbot_address_bindings',
  'chatbot_address_offers',
];

/** Same, but the session column predates snake_case. */
export const PURGE_BY_CAMEL_SESSION = ['conversation_bindings'];

/** Reached through a parent row (a connection, a notification, a user). */
export const PURGE_VIA_PARENT = [
  'message_deliveries',
  'webhook_event_log',
  'notification_deliveries',
  // Cascades from the `users` delete above (FK user_id ON DELETE CASCADE). A
  // consent record for a workspace that no longer exists has nothing left to
  // evidence; the invoices are the part that has to survive.
  'terms_acceptances',
];

/** Tables that deliberately survive, with the reason. */
export const RETAINED_TABLES: Record<string, string> = {
  tenants: 'the row itself: anonymised, not deleted (see decision 3)',
  compliance_events: "Axentrio's own proof trail",
  audit_logs: "Axentrio's own security trail (90-day sweep)",
  legal_invoices: 'statutory accounting retention — Art 17(3)(b)',
  billing_events: 'statutory accounting retention — Art 17(3)(b)',
  tenant_billing_accounts: 'statutory accounting retention — Art 17(3)(b)',
  chatbot_stripe_webhook_events: 'backs the invoices above',
  legal_holds: 'proof that a hold existed — part of the compliance trail',
  faq_sections: 'platform-wide FAQ, not tenant content',
  faq_items: 'platform-wide FAQ, not tenant content',
  bot_templates: 'global template catalogue',
  bot_template_versions: 'global template catalogue',
  chatbot_copilot_docs: 'platform documentation corpus',
};

export interface DeletionRequestState {
  requestedAt: string | null;
  scheduledFor: string | null;
  requestedBy: string | null;
  daysRemaining: number | null;
}

/** Read the request state for the portal's banner and modal. */
export async function getDeletionRequest(tenantId: string): Promise<DeletionRequestState> {
  const tenant = await AppDataSource.getRepository(Tenant).findOne({
    where: { id: tenantId },
    select: ['id', 'deletionRequestedAt', 'deletionScheduledFor', 'deletionRequestedBy'],
  });
  const scheduled = tenant?.deletionScheduledFor ?? null;
  const msLeft = scheduled ? scheduled.getTime() - Date.now() : null;
  return {
    requestedAt: tenant?.deletionRequestedAt?.toISOString() ?? null,
    scheduledFor: scheduled?.toISOString() ?? null,
    requestedBy: tenant?.deletionRequestedBy ?? null,
    daysRemaining: msLeft === null ? null : Math.max(0, Math.ceil(msLeft / 86_400_000)),
  };
}

/**
 * Start the dormancy window. Idempotent: a second request does NOT extend it,
 * because extending it would let an account sit in limbo indefinitely.
 */
export async function requestTenantDeletion(
  tenantId: string,
  userId: string,
): Promise<DeletionRequestState> {
  const repo = AppDataSource.getRepository(Tenant);
  const tenant = await repo.findOne({ where: { id: tenantId } });
  if (!tenant) throw new Error(`tenant ${tenantId} not found`);

  if (tenant.deletionRequestedAt && tenant.deletionScheduledFor) {
    return getDeletionRequest(tenantId);
  }

  // Pause the bots and remember WHICH ones, so cancelling is exact.
  const bots = await AppDataSource.getRepository(Bot).find({
    where: { tenantId, status: 'active' },
    select: ['id'],
  });
  const pausedBotIds = bots.map((b) => b.id);
  if (pausedBotIds.length > 0) {
    await AppDataSource.query(`UPDATE chatbot_bots SET status = 'paused' WHERE id = ANY($1::uuid[])`, [
      pausedBotIds,
    ]);
  }

  const now = new Date();
  const scheduledFor = new Date(now.getTime() + DELETION_DORMANCY_DAYS * 86_400_000);
  await repo.update(tenantId, {
    deletionRequestedAt: now,
    deletionRequestedBy: userId,
    deletionScheduledFor: scheduledFor,
    deletionPausedBotIds: pausedBotIds,
  });

  await logAudit(userId, 'tenant.deletion_requested', 'tenant', tenantId, tenantId, {
    scheduledFor: scheduledFor.toISOString(),
    pausedBots: pausedBotIds.length,
  });
  await logComplianceEvent({
    actorId: userId,
    eventType: 'tenant.deletion_requested',
    tenantId,
    subjectType: 'tenant',
    subjectId: tenantId,
    details: { scheduledFor: scheduledFor.toISOString(), pausedBots: pausedBotIds.length },
  });

  logger.info('[tenant-deletion] requested', { tenantId, scheduledFor });
  return getDeletionRequest(tenantId);
}

/** Cancel the window and resume exactly the bots the request paused. */
export async function cancelTenantDeletion(
  tenantId: string,
  userId: string,
): Promise<DeletionRequestState> {
  const repo = AppDataSource.getRepository(Tenant);
  const tenant = await repo.findOne({ where: { id: tenantId } });
  if (!tenant) throw new Error(`tenant ${tenantId} not found`);
  if (!tenant.deletionRequestedAt) return getDeletionRequest(tenantId);

  const paused = tenant.deletionPausedBotIds ?? [];
  if (paused.length > 0) {
    await AppDataSource.query(`UPDATE chatbot_bots SET status = 'active' WHERE id = ANY($1::uuid[])`, [
      paused,
    ]);
  }

  await repo.update(tenantId, {
    deletionRequestedAt: null,
    deletionRequestedBy: null,
    deletionScheduledFor: null,
    deletionPausedBotIds: null,
  });

  await logAudit(userId, 'tenant.deletion_cancelled', 'tenant', tenantId, tenantId, {
    resumedBots: paused.length,
  });
  await logComplianceEvent({
    actorId: userId,
    eventType: 'tenant.deletion_cancelled',
    tenantId,
    subjectType: 'tenant',
    subjectId: tenantId,
    details: { resumedBots: paused.length },
  });

  logger.info('[tenant-deletion] cancelled', { tenantId });
  return getDeletionRequest(tenantId);
}

/**
 * Purge one tenant's content, then anonymise the row. Irreversible.
 *
 * Returns the per-table row counts so the caller (and the compliance event) can
 * say what actually went.
 */
export async function executeTenantDeletion(tenantId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  // Captured before the scrub clears it: the Clerk org has to be removed after
  // our own transaction commits, and the id is the only handle we have.
  const [tenantRow]: Array<{ clerk_org_id: string | null }> = await AppDataSource.query(
    `SELECT clerk_org_id FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const clerkOrgId = tenantRow?.clerk_org_id ?? null;

  // Billing stops at the end of the period the customer already paid for, which
  // is what the cancellation policy promises. `no_stripe_subscription` is the
  // normal case for a free workspace, not a failure; anything else is logged and
  // the deletion proceeds, because a billing hiccup must not keep customer data.
  try {
    await cancelAtPeriodEnd(tenantId);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code !== 'no_stripe_subscription') {
      logger.error('[tenant-deletion] billing cancel failed', {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Objects FIRST: the row is the only pointer to the key, so a purge that stops
  // at the database leaves the customer's actual documents in the bucket.
  counts.s3Objects = await purgeTenantObjects(tenantId);

  await AppDataSource.transaction(async (manager) => {
    const sessionSubquery = `SELECT id FROM chat_sessions WHERE tenant_id = $1`;

    // Order is leaf-first, because several foreign keys are NO ACTION rather than
    // CASCADE: `messages.participant_id`, `handoff_requests.agent_id`,
    // `chat_sessions.channel_connection_id`. Deleting a parent before its children
    // fails the whole transaction, and a partial purge would be worse than none.

    // 1. Messages before participants — `messages` references `participants`.
    const msgs = await manager.query(`DELETE FROM messages WHERE tenant_id = $1`, [tenantId]);
    counts.messages = rowCount(msgs);

    // 2. Session children.
    for (const table of PURGE_BY_SESSION) {
      const res = await manager.query(
        `DELETE FROM ${table} WHERE session_id IN (${sessionSubquery})`,
        [tenantId],
      );
      counts[table] = rowCount(res);
    }
    const bindings = await manager.query(
      `DELETE FROM conversation_bindings WHERE "sessionId" IN (${sessionSubquery})`,
      [tenantId],
    );
    counts.conversation_bindings = rowCount(bindings);

    // 3. Deliveries keyed off a channel connection or a notification.
    const deliveries = await manager.query(
      `DELETE FROM message_deliveries
        WHERE "channelConnectionId" IN (SELECT id FROM channel_connections WHERE "tenantId" = $1)`,
      [tenantId],
    );
    counts.message_deliveries = rowCount(deliveries);
    const webhookLogs = await manager.query(
      `DELETE FROM webhook_event_log
        WHERE "channelConnectionId" IN (SELECT id FROM channel_connections WHERE "tenantId" = $1)`,
      [tenantId],
    );
    counts.webhook_event_log = rowCount(webhookLogs);
    const notifDeliveries = await manager.query(
      `DELETE FROM notification_deliveries
        WHERE notification_id IN (SELECT id FROM notifications WHERE tenant_id = $1)`,
      [tenantId],
    );
    counts.notification_deliveries = rowCount(notifDeliveries);

    // 4. Sessions, now that nothing below them is left.
    const sessions = await manager.query(`DELETE FROM chat_sessions WHERE tenant_id = $1`, [
      tenantId,
    ]);
    counts.chat_sessions = rowCount(sessions);

    // 5. The pre-snake_case tables.
    for (const table of PURGE_BY_CAMEL_TENANT_ID) {
      const res = await manager.query(`DELETE FROM ${table} WHERE "tenantId" = $1`, [tenantId]);
      counts[table] = rowCount(res);
    }

    // 6. Everything else that carries `tenant_id`.
    for (const table of PURGE_BY_TENANT_ID) {
      if (table === 'messages' || table === 'chat_sessions') continue;
      const res = await manager.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
      counts[table] = rowCount(res);
    }

    // 7. The row itself. `slug` and `api_key` are NOT NULL and UNIQUE, so they get
    //    a unique placeholder rather than NULL — the row has to survive for the
    //    invoices, and two deleted workspaces cannot share a slug.
    await manager.query(
      `UPDATE tenants
          SET name = 'Deleted workspace',
              slug = 'deleted-' || id::text,
              api_key = 'deleted-' || id::text,
              webhook_url = NULL,
              settings = '{}'::jsonb,
              clerk_org_id = NULL,
              deleted_at = COALESCE(deleted_at, now()),
              deletion_requested_at = NULL,
              deletion_requested_by = NULL,
              deletion_scheduled_for = NULL,
              deletion_paused_bot_ids = NULL,
              updated_at = now()
        WHERE id = $1`,
      [tenantId],
    );
  });

  const purged = Object.values(counts).reduce((a, b) => a + b, 0);
  await logAudit('system', 'tenant.deleted', 'tenant', tenantId, tenantId, { purged, counts });
  await logComplianceEvent({
    actorId: 'system',
    eventType: 'tenant.deleted',
    tenantId,
    subjectType: 'tenant',
    subjectId: tenantId,
    details: { purged, tables: Object.keys(counts).length },
  });

  // The logins go with the workspace. Best-effort: a Clerk outage must not leave
  // the content undeleted, and the org id is already cleared on our side.
  if (clerkOrgId) {
    try {
      const removed = await deleteClerkOrganization(clerkOrgId);
      if (!removed) {
        logger.warn('[tenant-deletion] Clerk org not removed', { tenantId, clerkOrgId });
      }
    } catch (error) {
      logger.error('[tenant-deletion] Clerk org removal threw', {
        tenantId,
        clerkOrgId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('[tenant-deletion] executed', { tenantId, purged });
  return counts;
}

/**
 * Delete a set of storage keys, best-effort per key.
 *
 * Exported and injectable so the failure handling can be tested without a bucket.
 * One missing key must not strand the rest: the caller still purges the rows, and
 * a half-purged account that reports an error is worse than one that deletes what
 * it can and says so.
 */
export async function purgeObjects(
  keys: string[],
  deps: { bucket: string; send: (key: string) => Promise<unknown> },
): Promise<number> {
  let deleted = 0;
  for (const key of keys) {
    try {
      await deps.send(key);
      deleted += 1;
    } catch (error) {
      logger.error('[tenant-deletion] object delete failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return deleted;
}

/**
 * Delete the tenant's stored objects.
 *
 * Chat uploads and knowledge documents both live in the bucket, and the database
 * row is the only thing pointing at them. A purge that deletes the row and not the
 * object reports success while the customer's files stay readable — the exact
 * failure the erasure path already guards against elsewhere.
 */
async function purgeTenantObjects(tenantId: string): Promise<number> {
  const bucket = config.s3?.bucket;
  if (!bucket) {
    logger.warn('[tenant-deletion] no S3 bucket configured; objects not purged', { tenantId });
    return 0;
  }

  const rows: Array<{ key: string }> = await AppDataSource.query(
    `SELECT storage_path AS key FROM file_uploads
      WHERE tenant_id = $1 AND storage_path IS NOT NULL
     UNION
     SELECT storage_path AS key FROM knowledge_documents
      WHERE "tenantId" = $1 AND storage_path IS NOT NULL`,
    [tenantId],
  );
  if (rows.length === 0) return 0;

  const client = createS3Client();
  return purgeObjects(
    rows.map((r) => r.key),
    {
      bucket,
      send: (key) => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
    },
  );
}

/** Execute every tenant whose window has closed. */
export async function sweepDueTenantDeletions(): Promise<{ tenants: number; purged: number }> {
  // A live legal hold wins: an open dispute means the rows are evidence, and
  // deleting them would destroy the very thing the hold was opened to preserve.
  // The window stays expired, so releasing the hold lets the next run proceed —
  // no data is lost by waiting, and none is lost by deleting either.
  const due: Array<{ id: string }> = await AppDataSource.query(
    `SELECT id FROM tenants t
      WHERE deletion_scheduled_for IS NOT NULL
        AND deletion_scheduled_for <= now()
        AND NOT EXISTS (
          SELECT 1 FROM legal_holds h
           WHERE h.tenant_id = t.id AND h.released_at IS NULL
        )
      ORDER BY deletion_scheduled_for ASC`,
  );

  const [held]: Array<{ count: number }> = await AppDataSource.query(
    `SELECT count(*)::int AS count FROM tenants t
      WHERE deletion_scheduled_for <= now()
        AND EXISTS (SELECT 1 FROM legal_holds h WHERE h.tenant_id = t.id AND h.released_at IS NULL)`,
  );
  if ((held?.count ?? 0) > 0) {
    logger.warn('[tenant-deletion] skipping tenants under an active legal hold', {
      tenants: held.count,
    });
  }

  let purged = 0;
  for (const row of due) {
    try {
      const counts = await executeTenantDeletion(row.id);
      purged += Object.values(counts).reduce((a, b) => a + b, 0);
    } catch (error) {
      // One bad tenant must not stop the others; the next run retries it.
      logger.error('[tenant-deletion] failed', {
        tenantId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (due.length > 0) logger.info('[tenant-deletion] sweep complete', { tenants: due.length, purged });
  return { tenants: due.length, purged };
}

/** Daily, plus one run shortly after boot. */
export function startTenantDeletionSweep(): NodeJS.Timeout[] {
  const run = () => {
    sweepDueTenantDeletions().catch((error) => {
      logger.error('[tenant-deletion] sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  return [setTimeout(run, 180_000), setInterval(run, 24 * 60 * 60 * 1000)];
}

/** `.query()` returns `[rows, affectedCount]` for DELETE in node-pg via TypeORM. */
function rowCount(res: unknown): number {
  if (Array.isArray(res) && typeof res[1] === 'number') return res[1];
  if (Array.isArray(res)) return res.length;
  return 0;
}
