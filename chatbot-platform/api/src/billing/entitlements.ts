/**
 * Entitlement resolver — reads `Tenant.tier`, merges `PLANS[tier]` with
 * per-tenant overrides (Enterprise only).
 *
 * Plan: .scratch/plan-billing.md § Entitlement shape, § Implementation outline step 2.
 */

import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { PLANS } from './plans';
import type { Entitlements, InternalPlanId } from './types';

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
  const tenant = await AppDataSource.getRepository(Tenant).findOne({
    where: { id: tenantId },
    select: ['id', 'tier', 'maxSessions', 'dailyLlmCallLimit'],
  });

  if (!tenant) {
    throw new Error(`getEntitlements: tenant ${tenantId} not found`);
  }

  return entitlementsFor(tenant.tier, {
    maxSessions: tenant.maxSessions ?? null,
    dailyLlmCallLimit: tenant.dailyLlmCallLimit ?? null,
  });
}

/**
 * Pure resolver — useful for tests and synchronous code paths that already
 * have the tier in hand.
 */
export function entitlementsFor(
  tier: InternalPlanId,
  overrides: { maxSessions: number | null; dailyLlmCallLimit: number | null } = {
    maxSessions: null,
    dailyLlmCallLimit: null,
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

  return {
    planId: plan.id,
    limits,
    features: plan.features,
    support: plan.support,
  };
}
