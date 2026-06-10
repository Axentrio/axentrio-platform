/**
 * Plan catalog — the single source of truth for tier entitlements, prices,
 * and provider price-ID mappings. Lives in code (not the DB) so the
 * entitlement contract ships atomically with the feature gates that read it.
 *
 * Subscription/feature-access epic — M0 PR2. Three marketed tiers
 * (Essential / Pro / Enterprise) plus `free` as the internal-only cancellation
 * sink. See .scratch/plan-m0-foundation-reshape.md § PR2 and
 * docs/subscription-epic-deviations.md for the locked decisions.
 */

import { config } from '../config/environment';
import type { InternalPlanId, PlanDefinition } from './types';

export const PLANS: Record<InternalPlanId, PlanDefinition> = {
  // Internal-only cancellation terminal state. Never offered for signup,
  // never shown in upgrade UIs, never sold. A Tenant lands here only via
  // Stripe `customer.subscription.deleted`. All entitlements off; `dailyLlmCalls: 0`
  // means the agent cannot run.
  free: {
    id: 'free',
    displayName: 'Cancelled', // internal debug label; never rendered to users
    rank: 0,
    priceEurMonthly: null,
    isSelfServeCheckoutable: false,
    limits: { agents: 0, bots: 0, sessions: 0, dailyLlmCalls: 0 },
    features: {
      unifiedInbox: false,
      bookings: false,
      calendarSync: false,
      leadCapture: false,
      platformAssistant: false,
      crm: false,
      hideWidgetAttribution: false,
      customWidgetAppearance: false,
      handoff: false,
      fileUpload: false,
      channelWhatsapp: false,
      channelMessenger: false,
      channelInstagram: false,
      channelTelegram: false,
    },
    support: 'none',
  },
  essential: {
    id: 'essential',
    displayName: 'Essential',
    rank: 1,
    priceEurMonthly: 49.99,
    isSelfServeCheckoutable: true,
    // Epic: Essential includes "1 AI chatbot".
    limits: { agents: 1, bots: 1, sessions: null, dailyLlmCalls: null },
    features: {
      unifiedInbox: true,
      bookings: false,
      calendarSync: false,
      leadCapture: true, // basic — module-level access
      platformAssistant: false,
      crm: false,
      hideWidgetAttribution: false, // "Powered by Axentrio" visible
      customWidgetAppearance: true, // basic color/title/avatar config
      handoff: true,
      fileUpload: true,
      // Channels: Essential is widget-only (external channels are Pro+).
      channelWhatsapp: false,
      channelMessenger: false,
      channelInstagram: false,
      channelTelegram: false,
    },
    support: 'email',
  },
  pro: {
    id: 'pro',
    displayName: 'Pro',
    rank: 2,
    priceEurMonthly: 99.99,
    isSelfServeCheckoutable: true,
    // Epic: Pro includes "1 AI chatbot". Same numeric count as Essential; Pro's
    // bot differentiation lives in feature flags (bookings, platformAssistant, etc.),
    // not in raw bot count.
    limits: { agents: 1, bots: 1, sessions: null, dailyLlmCalls: null },
    features: {
      unifiedInbox: true,
      bookings: true,
      calendarSync: true, // Cal.com only in v1 per D23
      leadCapture: true, // advanced semantics — custom fields, routing, export — gated at PR/M6 layer
      platformAssistant: true,
      crm: false,
      hideWidgetAttribution: true, // watermark removed
      customWidgetAppearance: true,
      handoff: true,
      fileUpload: true,
      channelWhatsapp: true,
      channelMessenger: true,
      channelInstagram: true,
      channelTelegram: true,
    },
    support: 'email',
  },
  enterprise: {
    id: 'enterprise',
    displayName: 'Enterprise',
    rank: 3,
    priceEurMonthly: 149,
    isSelfServeCheckoutable: true,
    // Epic: Enterprise includes "2 AI chatbots".
    limits: { agents: 2, bots: 2, sessions: null, dailyLlmCalls: null },
    features: {
      unifiedInbox: true,
      bookings: true,
      calendarSync: true,
      leadCapture: true,
      platformAssistant: true,
      crm: true, // entitlement gate true; UI shows Coming Soon per D25
      hideWidgetAttribution: true,
      customWidgetAppearance: true,
      handoff: true,
      fileUpload: true,
      channelWhatsapp: true,
      channelMessenger: true,
      channelInstagram: true,
      channelTelegram: true,
    },
    support: 'priority',
  },
};

/**
 * Resolve the Stripe Price ID for a given plan at call time.
 *
 * Resolved here (not on `PlanDefinition`) so the catalog stays decoupled from
 * env config — tests can mock `config` without re-importing `plans.ts`, and
 * a missing env var doesn't cause module-load failures.
 *
 * Returns `null` for non-self-serve plans (`free`) or when the env var is
 * unset. Callers must check for `null` and surface a deterministic
 * configuration error (see PR6 pre-flight guard).
 */
export function getStripePriceIdFor(planId: InternalPlanId): string | null {
  switch (planId) {
    case 'essential':
      return config.billing.stripe.priceEssential || null;
    case 'pro':
      return config.billing.stripe.pricePro || null;
    case 'enterprise':
      return config.billing.stripe.priceEnterprise || null;
    case 'free':
      return null;
  }
}

/**
 * Filter helper: returns only the plans that appear in self-serve upgrade
 * UIs (pricing page, change-plan flow, locked-feature CTA). Skips `free`
 * (cancellation sink).
 */
export function selfServeCheckoutablePlans(): PlanDefinition[] {
  return Object.values(PLANS).filter((p) => p.isSelfServeCheckoutable);
}

/**
 * Reverse lookup: Stripe price ID → internal plan id.
 * Used by `normalizeWebhookEvent` and the `subscription.updated` handler.
 *
 * Returns `null` for unknown/unmapped price IDs. The caller (webhook handler)
 * MUST treat null as "skip mutation with audit log" — never as a silent
 * downgrade to `free`. See PR9 contract.
 */
export function planIdForStripePriceId(priceId: string | null | undefined): InternalPlanId | null {
  if (!priceId) return null;
  if (priceId === config.billing.stripe.priceEssential) return 'essential';
  if (priceId === config.billing.stripe.pricePro) return 'pro';
  if (priceId === config.billing.stripe.priceEnterprise) return 'enterprise';
  return null;
}
