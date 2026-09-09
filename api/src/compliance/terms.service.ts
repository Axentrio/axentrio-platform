/**
 * Accepted terms.
 *
 * The portal asks once per version and the answer is recorded here. Two rules:
 *
 * 1. **Idempotent per version.** Accepting the same version twice is a no-op; a new
 *    version adds a row, so the history is the evidence rather than a single
 *    mutable "accepted" flag.
 * 2. **Recorded, not inferred.** Logging in is not acceptance, and neither is
 *    continuing to use the product — an inference is exactly what a regulator will
 *    not accept as proof.
 */
import { AppDataSource } from '../database/data-source';
import { TermsAcceptance } from '../database/entities/TermsAcceptance';
import { CURRENT_TERMS_VERSION } from '../config/terms';
import { logger } from '../utils/logger';

export interface TermsStatus {
  currentVersion: string;
  acceptedVersion: string | null;
  acceptedAt: string | null;
  upToDate: boolean;
}

export async function recordTermsAcceptance(input: {
  tenantId: string;
  userId: string;
  version?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<TermsAcceptance> {
  const version = input.version ?? CURRENT_TERMS_VERSION;
  const repo = AppDataSource.getRepository(TermsAcceptance);

  const existing = await repo.findOne({
    where: { tenantId: input.tenantId, userId: input.userId, termsVersion: version },
  });
  if (existing) return existing;

  const row = await repo.save(
    repo.create({
      tenantId: input.tenantId,
      userId: input.userId,
      termsVersion: version,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent?.slice(0, 255) ?? null,
    }),
  );
  logger.info('[terms] accepted', {
    tenantId: input.tenantId,
    userId: input.userId,
    version,
  });
  return row;
}

/** What the portal needs to decide whether to ask. */
export async function getTermsStatus(
  tenantId: string,
  userId: string,
): Promise<TermsStatus> {
  const row = await AppDataSource.getRepository(TermsAcceptance).findOne({
    where: { tenantId, userId, termsVersion: CURRENT_TERMS_VERSION },
  });
  return {
    currentVersion: CURRENT_TERMS_VERSION,
    acceptedVersion: row?.termsVersion ?? null,
    acceptedAt: row?.acceptedAt?.toISOString() ?? null,
    upToDate: Boolean(row),
  };
}
