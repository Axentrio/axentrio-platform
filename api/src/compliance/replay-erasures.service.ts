/**
 * Replay the erasures a database restore undid.
 *
 * A `pg_dump` is immutable: a person erased today is still inside every dump taken
 * before the erasure, for up to the 30-day backup window. That is normal and
 * accepted — but it means a restore resurrects them, and nothing was doing
 * anything about it. `compliance_events` records every `leads.erased` and
 * `tenant.deleted` precisely so this replay is possible.
 *
 * Two rules:
 *
 * 1. **Idempotent.** `eraseLead` returns null for an already-erased lead, so
 *    replaying an event whose subject was never actually restored is a no-op, not
 *    an error.
 * 2. **Audited.** A real replay writes its own `erasure.replayed` compliance event
 *    naming the dump timestamp and the counts, so the next person can see it was
 *    done.
 *
 * `dryRun` reports what would happen without touching anything — the right first
 * step on a production restore.
 */
import { AppDataSource } from '../database/data-source';
import { eraseLead } from '../leads/lead-erasure.service';
import { executeTenantDeletion } from '../tenants/tenant-deletion.service';
import { logComplianceEvent } from './compliance-events.service';
import { logger } from '../utils/logger';

/** The events a restore can undo. Deliberately a closed list. */
export const REPLAYABLE_EVENTS = ['leads.erased', 'tenant.deleted'] as const;

export interface ReplayResult {
  since: string;
  dryRun: boolean;
  candidates: number;
  leadsErased: number;
  tenantsDeleted: number;
  /** Subjects whose row was not present (or already erased) — nothing to do. */
  skipped: number;
  failures: Array<{ eventType: string; subjectId: string; error: string }>;
}

export async function replayErasuresSince(
  since: Date,
  opts: { dryRun?: boolean; actorId?: string } = {},
): Promise<ReplayResult> {
  const dryRun = opts.dryRun ?? false;
  const rows: Array<{ event_type: string; tenant_id: string | null; subject_id: string | null }> =
    await AppDataSource.query(
      `SELECT event_type, tenant_id, subject_id
         FROM compliance_events
        WHERE event_type = ANY($1::text[])
          AND created_at > $2
        ORDER BY created_at ASC`,
      [REPLAYABLE_EVENTS as unknown as string[], since],
    );

  const result: ReplayResult = {
    since: since.toISOString(),
    dryRun,
    candidates: rows.length,
    leadsErased: 0,
    tenantsDeleted: 0,
    skipped: 0,
    failures: [],
  };

  if (dryRun) {
    logger.info('[erasure-replay] dry run', { since: result.since, candidates: rows.length });
    return result;
  }

  for (const row of rows) {
    if (!row.tenant_id || !row.subject_id) {
      result.skipped += 1;
      continue;
    }
    try {
      if (row.event_type === 'leads.erased') {
        const erased = await eraseLead(AppDataSource, row.tenant_id, row.subject_id);
        if (erased) result.leadsErased += 1;
        else result.skipped += 1;
      } else if (row.event_type === 'tenant.deleted') {
        await executeTenantDeletion(row.tenant_id);
        result.tenantsDeleted += 1;
      }
    } catch (error) {
      // One bad subject must not stop the replay; it is reported and retried by
      // the next run.
      result.failures.push({
        eventType: row.event_type,
        subjectId: row.subject_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await logComplianceEvent({
    actorId: opts.actorId ?? 'system',
    eventType: 'erasure.replayed',
    tenantId: null,
    subjectType: 'restore',
    subjectId: result.since,
    details: {
      candidates: result.candidates,
      leadsErased: result.leadsErased,
      tenantsDeleted: result.tenantsDeleted,
      skipped: result.skipped,
      failures: result.failures.length,
    },
  });

  logger.info('[erasure-replay] complete', result);
  return result;
}
