/**
 * Legal holds — the Art 17(3)(e) exception, wired into the retention sweeps.
 *
 * The sweeps delete on age alone. A dispute needs specific rows kept, and the only
 * lever before this was to turn a tenant's retention period off entirely, which
 * keeps everything forever. A hold names what it protects, why, and when it must be
 * reviewed.
 *
 * The predicate lives here as SQL so the sweeps cannot drift from each other: one
 * `NOT EXISTS` clause, one definition of "protected".
 */
import { IsNull } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { LegalHold } from '../database/entities/LegalHold';
import { logAudit } from '../utils/audit';
import { logComplianceEvent } from '../compliance/compliance-events.service';
import { logger } from '../utils/logger';

/** How far ahead a hold may be opened before it must be reviewed. */
export const MAX_HOLD_DAYS = 365;

export interface OpenHoldInput {
  tenantId: string;
  reason: string;
  scope: { all?: boolean; sessionIds?: string[]; leadIds?: string[] };
  openedBy: string;
  reviewDueAt: Date;
}

export async function openLegalHold(input: OpenHoldInput): Promise<LegalHold> {
  const reason = input.reason.trim();
  if (reason.length < 10) {
    throw new Error('A legal hold needs a reason — it IS the legal basis');
  }
  const scope = input.scope ?? {};
  if (!scope.all && !(scope.sessionIds?.length ?? 0) && !(scope.leadIds?.length ?? 0)) {
    throw new Error('A legal hold must name what it protects (or { all: true })');
  }
  if (input.reviewDueAt.getTime() <= Date.now()) {
    throw new Error('reviewDueAt must be in the future — a hold that is never reviewed is just indefinite retention');
  }

  const repo = AppDataSource.getRepository(LegalHold);
  const hold = await repo.save(
    repo.create({
      tenantId: input.tenantId,
      reason,
      scope,
      openedBy: input.openedBy,
      reviewDueAt: input.reviewDueAt,
    }),
  );

  await logAudit(input.openedBy, 'legal_hold.opened', 'tenant', input.tenantId, input.tenantId, {
    holdId: hold.id,
    scope,
    reviewDueAt: input.reviewDueAt.toISOString(),
  });
  await logComplianceEvent({
    actorId: input.openedBy,
    eventType: 'legal_hold.opened',
    tenantId: input.tenantId,
    subjectType: 'legal_hold',
    subjectId: hold.id,
    details: { scope, reviewDueAt: input.reviewDueAt.toISOString(), reason },
  });

  logger.info('[legal-hold] opened', { tenantId: input.tenantId, holdId: hold.id });
  return hold;
}

export async function releaseLegalHold(params: {
  tenantId: string;
  holdId: string;
  releasedBy: string;
  releaseReason: string;
}): Promise<LegalHold | null> {
  const repo = AppDataSource.getRepository(LegalHold);
  const hold = await repo.findOne({ where: { id: params.holdId, tenantId: params.tenantId } });
  if (!hold) return null;
  if (hold.releasedAt) return hold; // idempotent

  hold.releasedAt = new Date();
  hold.releasedBy = params.releasedBy;
  hold.releaseReason = params.releaseReason.trim() || 'released';
  await repo.save(hold);

  await logAudit(params.releasedBy, 'legal_hold.released', 'tenant', params.tenantId, params.tenantId, {
    holdId: hold.id,
  });
  await logComplianceEvent({
    actorId: params.releasedBy,
    eventType: 'legal_hold.released',
    tenantId: params.tenantId,
    subjectType: 'legal_hold',
    subjectId: hold.id,
    details: { releaseReason: hold.releaseReason },
  });

  logger.info('[legal-hold] released', { tenantId: params.tenantId, holdId: hold.id });
  return hold;
}

export async function listLegalHolds(
  tenantId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<LegalHold[]> {
  return AppDataSource.getRepository(LegalHold).find({
    where: opts.activeOnly ? { tenantId, releasedAt: IsNull() } : { tenantId },
    order: { openedAt: 'DESC' },
  });
}

/**
 * SQL predicate: does an ACTIVE hold protect this row?
 *
 * `$1` is the tenant, `$2` the table alias of the candidate, `$3` the column
 * holding the id, `$4` the jsonb key the hold would list it under (`sessionIds` or
 * `leadIds`). Kept as one string so every sweep asks the same question.
 */
export function holdPredicate(alias: string, idColumn: string, scopeKey: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM legal_holds h
     WHERE h.tenant_id = $1
       AND h.released_at IS NULL
       AND (
         COALESCE((h.scope->>'all')::boolean, false)
         OR h.scope->'${scopeKey}' ? ${alias}.${idColumn}::text
       )
  )`;
}
