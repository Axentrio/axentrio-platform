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

/** Per-tenant cap per run, so one large backlog cannot monopolise the sweep. */
const MAX_ERASURES_PER_TENANT_PER_RUN = 200;

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
export async function sweepLeadRetention(): Promise<RetentionSweepResult> {
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

      // Candidates: older than the cutoff, not already erased, no live booking, and
      // not manually scored. Selected in one query so the carve-outs are visible in
      // one place rather than scattered through a loop.
      const candidates: Array<{ id: string; has_live_booking: boolean; manually_scored: boolean }> =
        await AppDataSource.query(
          `SELECT l.id,
                  EXISTS (
                    SELECT 1 FROM chatbot_bookings b
                     WHERE b.lead_id = l.id AND b.tenant_id = l.tenant_id
                       AND b.status NOT IN ('cancelled', 'failed')
                       AND b.start_utc >= now()
                  ) AS has_live_booking,
                  (l.readiness_override IS NOT NULL) AS manually_scored
             FROM chatbot_leads l
            WHERE l.tenant_id = $1
              AND l.deleted_at IS NULL
              AND l.created_at < now() - ($2 || ' days')::interval
            ORDER BY l.created_at ASC
            LIMIT $3`,
          [tenant.id, String(days), MAX_ERASURES_PER_TENANT_PER_RUN],
        );

      let erasedForTenant = 0;
      for (const row of candidates) {
        if (row.has_live_booking) {
          result.skippedLiveBooking += 1;
          continue;
        }
        if (row.manually_scored) {
          result.skippedManuallyScored += 1;
          continue;
        }
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
          cappedAtBatchLimit: candidates.length >= MAX_ERASURES_PER_TENANT_PER_RUN,
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
