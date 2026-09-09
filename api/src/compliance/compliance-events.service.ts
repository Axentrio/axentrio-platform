/**
 * Compliance events — the proof trail that must outlive the security log.
 *
 * Two rules carry the design:
 *
 * **1. Writing one must never fail the thing it records.** These rows are written
 *    next to an erasure or a retention sweep. If the proof write throws, the
 *    erasure must still succeed — the customer asked to be forgotten, not to be
 *    forgotten-provided-the-log-accepts-it. Every call here is best-effort and
 *    logs its own failure, exactly like `logAudit`.
 *
 * **2. It does not replace `audit_logs`.** The security trail keeps its own 90-day
 *    period and its own noise; this table holds only the events someone may have
 *    to produce evidence for later. Writing both is deliberate.
 *
 * The retention period is an engineering default pending the legal decision on
 * what a dispute actually needs; it is env-configurable so that decision does not
 * need a deploy.
 */
import { LessThan } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { ComplianceEvent } from '../database/entities/ComplianceEvent';
import { config } from '../config/environment';
import { logger } from '../utils/logger';

/** How long proof is kept. Overridable via `COMPLIANCE_EVENT_RETENTION_DAYS`. */
export const COMPLIANCE_EVENT_RETENTION_DAYS = config.compliance.retentionDays;

export interface ComplianceEventInput {
  /** `system` for a scheduled sweep. */
  actorId: string;
  eventType: string;
  tenantId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  details?: Record<string, unknown> | null;
}

/** Best-effort. Never throws into the caller. */
export async function logComplianceEvent(input: ComplianceEventInput): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(ComplianceEvent);
    await repo.save(
      repo.create({
        tenantId: input.tenantId ?? null,
        actorId: input.actorId,
        eventType: input.eventType,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        details: input.details ?? null,
      }),
    );
  } catch (error) {
    logger.error('[compliance] failed to write compliance event', {
      error: error instanceof Error ? error.message : String(error),
      eventType: input.eventType,
      tenantId: input.tenantId,
    });
  }
}

/** Delete proof older than the period. Returns how many rows went. */
export async function sweepComplianceEvents(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - COMPLIANCE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await AppDataSource.getRepository(ComplianceEvent).delete({
    createdAt: LessThan(cutoff),
  });
  const deleted = result.affected ?? 0;
  if (deleted > 0) {
    logger.info('[compliance] retention swept', { deleted, retentionDays: COMPLIANCE_EVENT_RETENTION_DAYS });
  }
  return { deleted };
}

/** Daily, plus one run shortly after boot so a redeploy does not leave it silent. */
export function startComplianceEventRetentionSweep(): NodeJS.Timeout[] {
  const run = () => {
    sweepComplianceEvents().catch((error) => {
      logger.error('[compliance] retention sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  return [setTimeout(run, 150_000), setInterval(run, 24 * 60 * 60 * 1000)];
}
