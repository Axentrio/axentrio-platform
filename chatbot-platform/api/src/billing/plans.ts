/**
 * Plan catalog — the single source of truth for tier entitlements, prices,
 * and provider price-ID mappings. Lives in code (not the DB) so the
 * entitlement contract ships atomically with the feature gates that read it.
 *
 * Plan: .scratch/plan-billing.md § Entitlement shape, § Pricing & currency.
 */

import { config } from '../config/environment';
import type { InternalPlanId, PlanDefinition } from './types';

export const PLANS: Record<InternalPlanId, PlanDefinition> = {
  free: {
    id: 'free',
    displayName: 'Free',
    rank: 0,
    priceUsdMonthly: 0,
    limits: {
      agents: 1,
      sessions: 10,
      dailyLlmCalls: 0,
      channels: 1,
    },
    features: {
      fileUpload: false,
      handoff: false,
      customBranding: false,
      byoLlmKey: true,
    },
    support: 'community',
    providerPriceIds: {
      stripe: { usd: null },
    },
  },
  pro: {
    id: 'pro',
    displayName: 'Pro',
    rank: 1,
    priceUsdMonthly: 49,
    limits: {
      agents: 3,
      sessions: 100,
      dailyLlmCalls: 1000,
      channels: 3,
    },
    features: {
      fileUpload: true,
      handoff: true,
      customBranding: false,
      byoLlmKey: true,
    },
    support: 'email',
    providerPriceIds: {
      stripe: { usd: config.billing.stripe.pricePro || null },
    },
  },
  premium: {
    id: 'premium',
    displayName: 'Premium',
    rank: 2,
    priceUsdMonthly: 199,
    limits: {
      agents: 10,
      sessions: 500,
      dailyLlmCalls: 10000,
      channels: null,
    },
    features: {
      fileUpload: true,
      handoff: true,
      customBranding: true,
      byoLlmKey: true,
    },
    support: 'priority',
    providerPriceIds: {
      stripe: { usd: config.billing.stripe.pricePremium || null },
    },
  },
  enterprise: {
    id: 'enterprise',
    displayName: 'Enterprise',
    rank: 3,
    priceUsdMonthly: null,
    limits: {
      agents: null,
      sessions: null,
      dailyLlmCalls: null,
      channels: null,
    },
    features: {
      fileUpload: true,
      handoff: true,
      customBranding: true,
      byoLlmKey: true,
    },
    support: 'sla',
    providerPriceIds: {
      stripe: { usd: null },
    },
  },
};

/**
 * Reverse lookup: Stripe price ID → internal plan id.
 * Used by `normalizeWebhookEvent` and the `subscription.updated` handler.
 * Returns null for unknown prices (handled per § Lifecycle semantics —
 * unknown price → audit-only, no state mutation).
 */
export function planIdForStripePriceId(priceId: string | null | undefined): InternalPlanId | null {
  if (!priceId) return null;
  for (const plan of Object.values(PLANS)) {
    if (plan.providerPriceIds.stripe.usd === priceId) {
      return plan.id;
    }
  }
  return null;
}
