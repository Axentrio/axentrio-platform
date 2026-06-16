/**
 * Entitlement resolver — reads `Tenant.tier`, merges `PLANS[tier]` with
 * per-tenant overrides (Enterprise only).
 *
 * Plan: .scratch/plan-billing.md § Entitlement shape, § Implementation outline step 2.
 */

import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import type { FeatureOverride, TenantStatus } from '../database/entities/Tenant';
import { cached, invalidate } from '../utils/cache';
import { logger } from '../utils/logger';
import { PLANS } from './plans';
import { enforceFeatureDependencies } from './feature-taxonomy';
import { TENANT_TOGGLEABLE_FEATURES } from './feature-toggles';
import type { TenantFeatureToggles } from '../contracts/entitlements';
import type { Entitlements, FeatureKey, InternalPlanId } from './types';

/**
 * Entitlements are read on the hot path (feature gates + LLM rate limit run on
 * effectively every request), but the underlying tier changes only on a
 * subscription event. Cache the resolved entitlements for a short TTL and
 * invalidate explicitly whenever `Tenant.tier` is written (see
 * `invalidateEntitlements`). The TTL is the backstop; invalidation makes a
 * plan change take effect immediately.
 */
const ENTITLEMENTS_TTL_SECONDS = 60;
const entitlementsCacheKey = (tenantId: string) => `entitlements:${tenantId}`;

/** Thrown by `getEntitlements` when no tenant row matches the id. */
export class TenantNotFoundError extends Error {
  constructor(tenantId: string) {
    super(`getEntitlements: tenant ${tenantId} not found`);
    this.name = 'TenantNotFoundError';
  }
}

/**
 * Resolve entitlements for a tenant. Reads the plan from `PLANS[tier]` and,
 * for Enterprise tenants, applies the per-tenant override columns
 * (`maxSessions`, `dailyLlmCallLimit`) on top of the plan defaults.
 *
 * For non-Enterprise plans the override columns are ignored — the plan
 * catalog is the authority, and tiers are managed through subscription
 * changes, not by directly editing tenant columns.
 */
export async function getEntitlements(tenantId: string): Promise<Entitlements> {
  return cached(entitlementsCacheKey(tenantId), ENTITLEMENTS_TTL_SECONDS, async () => {
    const tenant = await AppDataSource.getRepository(Tenant).findOne({
      where: { id: tenantId },
      select: ['id', 'tier', 'status', 'maxSessions', 'dailyLlmCallLimit', 'featureOverrides', 'featureToggles'],
    });

    if (!tenant) {
      throw new TenantNotFoundError(tenantId);
    }

    return entitlementsFor(
      tenant.tier,
      {
        maxSessions: tenant.maxSessions ?? null,
        dailyLlmCallLimit: tenant.dailyLlmCallLimit ?? null,
      },
      {
        status: tenant.status,
        featureOverrides: tenant.featureOverrides ?? {},
        featureToggles: tenant.featureToggles ?? {},
        tenantId,
      },
    );
  });
}

/**
 * Drop the cached entitlements for a tenant. MUST be called after any write to
 * `Tenant.tier` (or the Enterprise override columns) so plan changes take
 * effect without waiting for the TTL.
 */
export async function invalidateEntitlements(tenantId: string): Promise<void> {
  await invalidate(entitlementsCacheKey(tenantId));
}

/**
 * Pure resolver — useful for tests and synchronous code paths that already
 * have the tier in hand.
 *
 * `featureCtx` carries the per-tenant feature-override state:
 *   - When `tier === 'free'` or `status !== 'active'`, ALL boolean features
 *     resolve `false` (absolute deny — D2). Overrides are ignored entirely.
 *   - Otherwise each well-formed override entry's `value` is merged over a
 *     CLONE of the plan's features. Unknown keys and non-boolean values are
 *     ignored with a warning (manual JSONB drift must never throw or apply).
 *   - Limits are never affected by feature overrides (D3).
 *
 * Callers without `featureCtx` (tests, pure tier math) get plan defaults with
 * an implicit `active` status and no overrides.
 */
export function entitlementsFor(
  tier: InternalPlanId,
  overrides: { maxSessions: number | null; dailyLlmCallLimit: number | null } = {
    maxSessions: null,
    dailyLlmCallLimit: null,
  },
  featureCtx?: {
    status?: TenantStatus;
    featureOverrides?: Record<string, FeatureOverride>;
    /**
     * Tenant's own on/off preferences. Can only turn a feature OFF (never on
     * above the entitlement ceiling). Absent/true key = on. Only keys in
     * TENANT_TOGGLEABLE_FEATURES are honoured; anything else is ignored.
     */
    featureToggles?: TenantFeatureToggles;
    /** Only used to make warnings attributable. */
    tenantId?: string;
  },
): Entitlements {
  const plan = PLANS[tier];
  if (!plan) {
    throw new Error(`entitlementsFor: unknown tier ${tier}`);
  }

  const limits = { ...plan.limits };
  if (tier === 'enterprise') {
    if (overrides.maxSessions !== null) limits.sessions = overrides.maxSessions;
    if (overrides.dailyLlmCallLimit !== null) limits.dailyLlmCalls = overrides.dailyLlmCallLimit;
  }

  // Clone before any mutation — plan.features is the shared catalog object;
  // writing through it would leak one tenant's state into every tenant on
  // the tier.
  const features = { ...plan.features };

  const billable = tier !== 'free' && (featureCtx?.status ?? 'active') === 'active';
  if (!billable) {
    for (const key of Object.keys(features) as FeatureKey[]) {
      features[key] = false;
    }
  } else if (featureCtx?.featureOverrides) {
    for (const [key, entry] of Object.entries(featureCtx.featureOverrides)) {
      if (!(key in features)) {
        logger.warn('entitlementsFor: ignoring unknown feature override key', {
          tenantId: featureCtx.tenantId,
          key,
        });
        continue;
      }
      if (typeof entry?.value !== 'boolean') {
        logger.warn('entitlementsFor: ignoring malformed feature override', {
          tenantId: featureCtx.tenantId,
          key,
        });
        continue;
      }
      features[key as FeatureKey] = entry.value;
    }
  }

  // Dependency pass (taxonomy `requires`): a child feature can never be on
  // while its parent is off, regardless of tier defaults or overrides —
  // e.g. calendarSync without bookings has nothing to sync.
  enforceFeatureDependencies(features);

  // ── Entitlement CEILING is now finalized. Snapshot it before the tenant's
  // own preference is layered on; this is what upsell/"locked" UI reads so a
  // tenant-disabled feature shows an off switch, not an upgrade prompt.
  const entitledFeatures = { ...features };

  // Tenant preference layer: can only turn a toggleable feature OFF (never on
  // above the ceiling). Ignored entirely for non-billable tenants (everything
  // is already false). Malformed/non-toggleable entries are dropped.
  const featureToggles = sanitizeFeatureToggles(featureCtx?.featureToggles, featureCtx?.tenantId);
  if (billable) {
    for (const key of TENANT_TOGGLEABLE_FEATURES) {
      if (featureToggles[key] === false) features[key] = false;
    }
    // Cascade a toggled-off parent to its children (e.g. bookings off ⇒
    // calendarSync off; gapInsights off ⇒ gapEvidence/aiBusinessInsights off).
    enforceFeatureDependencies(features);
  }

  return {
    planId: plan.id,
    billable,
    limits,
    features,
    entitledFeatures,
    featureToggles,
    support: plan.support,
  };
}

/**
 * Keep only well-formed, toggleable entries from a raw `featureToggles` blob.
 * Like the override reader, manual JSONB drift must never throw or leak —
 * unknown keys and non-boolean values are dropped with a warning.
 */
function sanitizeFeatureToggles(
  raw: TenantFeatureToggles | undefined,
  tenantId: string | undefined,
): TenantFeatureToggles {
  if (!raw) return {};
  const clean: TenantFeatureToggles = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!TENANT_TOGGLEABLE_FEATURES.includes(key as never)) {
      logger.warn('entitlementsFor: ignoring non-toggleable feature toggle key', { tenantId, key });
      continue;
    }
    if (typeof value !== 'boolean') {
      logger.warn('entitlementsFor: ignoring malformed feature toggle', { tenantId, key });
      continue;
    }
    clean[key as keyof TenantFeatureToggles] = value;
  }
  return clean;
}
