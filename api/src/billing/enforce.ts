/**
 * Entitlement enforcement primitives — used by the seven feature/count gates
 * defined in .scratch/plan-billing.md § Implementation outline step 10.
 *
 * Two flavors of gate:
 *
 *   - **Count gates** (agents, sessions): caller already holds a DB
 *     transaction; helper locks the tenants row, reads entitlements from
 *     the locked tier, runs a count query, throws if at/over cap. (The
 *     legacy `channels` count gate was retired in the M0 plan-catalog
 *     reshape; channel availability is now a per-tier-by-feature boolean,
 *     not a numeric cap.)
 *
 *   - **Feature gates** (file upload, handoff, custom branding): no race
 *     window — boolean flag is read once. No tx required; a stale read just
 *     loses a few milliseconds of accuracy across a tier change.
 *
 * 402 is the HTTP status for "plan limit reached" — separate from 429 (rate
 * limit) and 403 (auth). The Stripe convention is 402-Payment-Required for
 * exactly this case ("upgrade your plan").
 */

import { EntityManager } from 'typeorm';
import { ApiError } from '../middleware/error-handler';
import { Tenant } from '../database/entities/Tenant';
import { entitlementsFor, getEntitlements, TenantNotFoundError } from './entitlements';
import type { Entitlements } from './types';

export class PlanLimitError extends ApiError {
  constructor(code: string, limit: number | null, meta: Record<string, unknown> = {}) {
    super(`Plan limit reached: ${code}`, 402, code, { limit, ...meta });
    this.name = 'PlanLimitError';
    Object.setPrototypeOf(this, PlanLimitError.prototype);
  }
}

/**
 * Open a row-level lock on `tenants(id = :tenantId)` and resolve entitlements
 * against the freshly-locked tier. The lock is released when the caller's
 * tx commits or rolls back.
 *
 * Use this directly when you need access to the locked Tenant entity too —
 * `enforceCountLimit` wraps this for the common count-then-check case.
 */
export async function lockTenantEntitlements(
  manager: EntityManager,
  tenantId: string,
): Promise<{ tenant: Tenant; entitlements: Entitlements }> {
  const tenant = await manager
    .createQueryBuilder(Tenant, 't')
    .setLock('pessimistic_write')
    .where('t.id = :tenantId', { tenantId })
    .getOne();
  if (!tenant) {
    throw new ApiError(`Tenant ${tenantId} not found`, 404, 'tenant_not_found');
  }
  const entitlements = entitlementsFor(
    tenant.tier,
    {
      maxSessions: tenant.maxSessions ?? null,
      dailyLlmCallLimit: tenant.dailyLlmCallLimit ?? null,
    },
    // Count gates only read .limits (feature overrides can't touch limits),
    // but resolve with full feature context so the returned .features is
    // never a stale tier-only view for any caller that inspects it.
    {
      status: tenant.status,
      featureOverrides: tenant.featureOverrides ?? {},
      tenantId,
    },
  );
  return { tenant, entitlements };
}

/**
 * Count-then-check gate for capacity-bound entitlements (agents / sessions /
 * channels). Acquires the tenants-row lock inside the caller's tx, runs the
 * supplied counter, and throws `PlanLimitError` when `current >= limit`.
 *
 * A `null` limit means unlimited — the function returns without throwing.
 *
 * The caller is responsible for inserting the new row INSIDE the same tx so
 * the count+create pair is atomic under the row lock.
 */
export async function enforceCountLimit(input: {
  manager: EntityManager;
  tenantId: string;
  capability: 'agents' | 'bots' | 'sessions';
  errorCode: string;
  countQuery: (manager: EntityManager) => Promise<number>;
}): Promise<{ limit: number | null; current: number; entitlements: Entitlements }> {
  const { entitlements } = await lockTenantEntitlements(input.manager, input.tenantId);
  const limit = entitlements.limits[input.capability];
  const current = await input.countQuery(input.manager);
  if (limit !== null && current >= limit) {
    throw new PlanLimitError(input.errorCode, limit, { current });
  }
  return { limit, current, entitlements };
}

/**
 * Boolean feature gate. Read-only — no lock required.
 *
 * Throws `PlanLimitError` (HTTP 402, code = `errorCode`) when the tenant's
 * tier does not include the requested feature.
 */
export async function requireFeature(
  tenantId: string,
  feature: keyof Entitlements['features'],
  errorCode: string,
): Promise<void> {
  // Cached read (entitlements:<tenantId>) — same resolution as the count gates,
  // but feature gates have no race window so they don't need the row lock.
  let entitlements: Entitlements;
  try {
    entitlements = await getEntitlements(tenantId);
  } catch (err) {
    if (err instanceof TenantNotFoundError) {
      throw new ApiError(`Tenant ${tenantId} not found`, 404, 'tenant_not_found');
    }
    throw err; // unknown-tier or other real errors surface as 500
  }
  if (!entitlements.features[feature]) {
    throw new PlanLimitError(errorCode, null, { feature });
  }
}
