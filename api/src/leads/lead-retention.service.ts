/**
 * Lead retention — the expiry side of lead capture.
 *
 * Story 3 added a lot of stored personal data (contact details, addresses, verbatim
 * requests, extracted attributes) with no expiry at all. Sweeps already exist for
 * webhook logs, audit logs and agent traces; leads were the only PII store without one,
 * which is the weakest point of the whole feature under GDPR storage-limitation.
 *
 * Two decisions carry most of the design:
 *
 * **1. It calls `eraseLead()`, not DELETE.** Retention then inherits everything erasure
 * already gets right — the identity-CHECK tombstone, the non-resurrectable dedupe key,
 * scrubbing of notifications / webhook bodies / agent traces, and the outbound
 * `lead.deleted` so a connected CRM drops its copy too. A bulk `DELETE FROM chatbot_leads`
 * would leave every one of those behind and quietly make retention a lie.
 *
 * **2. Default is KEEP.** `leadRetentionDays` is unset for every existing tenant, and an
 * unset value means never expire. Nothing is deleted on deploy; a tenant has to choose a
 * period. Silent bulk deletion of customer records on an upgrade is unrecoverable and
 * exactly the kind of surprise that destroys trust in a platform.
 *
 * Two carve-outs, because age alone is not sufficient reason to erase:
 *   - a lead with a LIVE booking (future, not cancelled) — the business still has to
 *     serve that appointment
 *   - a lead someone manually scored (`readiness_override`) — a human looked at it, and
 *     that is a signal the automatic policy should not override
 */
import { AppDataSource } from '../database/data-source';
import { eraseLead } from './lead-erasure.service';
import { notificationService } from '../services/notification.service';
import { logAudit } from '../utils/audit';
import { logger } from '../utils/logger';

/** Guard rails on what a tenant may configure. */
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650; // 10 years

/**
 * Per-tenant cap per run, so one large backlog cannot monopolise the sweep.
 *
 * Exported and overridable ONLY so the starvation regression test can exercise the
 * LIMIT boundary without seeding 200+ rows. Production never passes an override.
 */
export const MAX_ERASURES_PER_TENANT_PER_RUN = 200;

let running = false;

export interface RetentionSweepResult {
  tenantsConsidered: number;
  erased: number;
  skippedLiveBooking: number;
  skippedManuallyScored: number;
}

/** Read a tenant's configured retention, or null when they have not set one. */
export function readRetentionDays(settings: unknown): number | null {
  const raw = (settings as { leadRetentionDays?: unknown } | null)?.leadRetentionDays;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const n = Math.round(raw);
  // Out-of-range stored values (hand-edited jsonb) degrade to "no retention" rather
  // than to an aggressive default — fail towards keeping data, never towards deleting it.
  if (n < MIN_RETENTION_DAYS || n > MAX_RETENTION_DAYS) return null;
  return n;
}

/**
 * Erase leads past their tenant's retention period.
 *
 * Sequential and capped: each erasure is a multi-statement transaction plus an outbound
 * event, so this is deliberately not parallelised.
 */
export async function sweepLeadRetention(
  opts: { batchLimit?: number } = {},
): Promise<RetentionSweepResult> {
  const batchLimit = opts.batchLimit ?? MAX_ERASURES_PER_TENANT_PER_RUN;
  const result: RetentionSweepResult = {
    tenantsConsidered: 0,
    erased: 0,
    skippedLiveBooking: 0,
    skippedManuallyScored: 0,
  };
  if (running) return result;
  running = true;

  try {
    // Only tenants that have actually chosen a period. The jsonb predicate keeps this
    // cheap — most tenants will never appear here.
    const tenants: Array<{ id: string; settings: Record<string, unknown> }> = await AppDataSource.query(
      `SELECT id, settings FROM tenants
        WHERE settings ? 'leadRetentionDays'
          AND status <> 'suspended'`,
    );

    for (const tenant of tenants) {
      const days = readRetentionDays(tenant.settings);
      if (days === null) {
        logger.warn('[lead-retention] ignoring malformed leadRetentionDays', { tenantId: tenant.id });
        continue;
      }
      result.tenantsConsidered += 1;

      // The carve-outs live in the WHERE clause, NOT in the loop below.
      //
      // They used to be SELECT columns filtered app-side, which meant the LIMIT applied
      // BEFORE them: if the oldest N leads were all skippable, the run erased nothing and
      // the next run selected the same N again. Anything behind them was never reached —
      // silent starvation that only appears once a tenant accumulates skippable leads.
      const candidates: Array<{ id: string }> = await AppDataSource.query(
        `SELECT l.id
           FROM chatbot_leads l
          WHERE l.tenant_id = $1
            AND l.deleted_at IS NULL
            AND l.created_at < now() - ($2 || ' days')::interval
            -- a live future appointment: the business still has to serve it
            AND NOT EXISTS (
              SELECT 1 FROM chatbot_bookings b
               WHERE b.lead_id = l.id AND b.tenant_id = l.tenant_id
                 AND b.status NOT IN ('cancelled', 'failed')
                 AND b.start_utc >= now()
            )
            -- a human scored it, so the automatic policy defers
            AND l.readiness_override IS NULL
          ORDER BY l.created_at ASC
          LIMIT $3`,
        [tenant.id, String(days), batchLimit],
      );

      // Counted separately so the operator still learns WHY leads were kept — the
      // numbers are the point of the notification, and folding them into the erasure
      // query is what caused the starvation in the first place.
      const [skips]: Array<{ live_booking: number; manually_scored: number }> =
        await AppDataSource.query(
          `SELECT
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM chatbot_bookings b
                WHERE b.lead_id = l.id AND b.tenant_id = l.tenant_id
                  AND b.status NOT IN ('cancelled', 'failed')
                  AND b.start_utc >= now()
             ))::int AS live_booking,
             count(*) FILTER (WHERE l.readiness_override IS NOT NULL)::int AS manually_scored
           FROM chatbot_leads l
          WHERE l.tenant_id = $1
            AND l.deleted_at IS NULL
            AND l.created_at < now() - ($2 || ' days')::interval`,
          [tenant.id, String(days)],
        );
      result.skippedLiveBooking += skips?.live_booking ?? 0;
      result.skippedManuallyScored += skips?.manually_scored ?? 0;

      let erasedForTenant = 0;
      for (const row of candidates) {
        try {
          const erased = await eraseLead(AppDataSource, tenant.id, row.id);
          if (erased) {
            erasedForTenant += 1;
            result.erased += 1;
          }
        } catch (error) {
          // One bad row must not abort the tenant's sweep, let alone the whole run.
          logger.error('[lead-retention] erase failed', {
            tenantId: tenant.id,
            leadId: row.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (erasedForTenant > 0) {
        // Tell the tenant. Bulk deletion of customer records that happens invisibly is
        // how you get a support ticket nobody can answer; ONE summary per run, not one
        // notification per lead.
        await notificationService
          .createForTenant({
            tenantId: tenant.id,
            type: 'leads_retention_applied',
            title: 'Old leads removed',
            message: `${erasedForTenant} lead${erasedForTenant === 1 ? '' : 's'} older than ${days} days had their personal data erased, per your retention setting.`,
            data: { erased: erasedForTenant, retentionDays: days },
            dedupeBase: `lead-retention:${tenant.id}:${new Date().toISOString().slice(0, 10)}`,
          })
          .catch(() => {});

        await logAudit('system', 'leads.retention_applied', 'tenant', tenant.id, tenant.id, {
          erased: erasedForTenant,
          retentionDays: days,
          cappedAtBatchLimit: candidates.length >= batchLimit,
        }).catch(() => {});
      }
    }

    if (result.erased > 0 || result.tenantsConsidered > 0) {
      logger.info('[lead-retention] sweep complete', result);
    }
    return result;
  } finally {
    running = false;
  }
}
