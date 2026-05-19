/**
 * Plan catalog + entitlement resolver — pure unit tests.
 *
 * Plan: .scratch/plan-billing.md § Implementation outline step 14 → Unit.
 */

import { describe, it, expect } from 'vitest';
import { PLANS, planIdForStripePriceId } from '../../billing/plans';
import { entitlementsFor } from '../../billing/entitlements';

describe('PLANS catalog', () => {
  it('exposes all four tiers with the documented ranks', () => {
    expect(PLANS.free.rank).toBe(0);
    expect(PLANS.pro.rank).toBe(1);
    expect(PLANS.premium.rank).toBe(2);
    expect(PLANS.enterprise.rank).toBe(3);
  });

  it('orders ranks correctly so upgrade vs downgrade is unambiguous', () => {
    expect(PLANS.pro.rank).toBeLessThan(PLANS.premium.rank);
    expect(PLANS.premium.rank).toBeLessThan(PLANS.enterprise.rank);
    expect(PLANS.free.rank).toBeLessThan(PLANS.pro.rank);
  });

  it('matches the documented entitlement shape per tier', () => {
    // These are the values the Billing UI displays — locking them in so a
    // catalog edit breaks the test rather than silently changing limits.
    expect(PLANS.free.limits.agents).toBe(1);
    expect(PLANS.free.limits.dailyLlmCalls).toBe(0);
    expect(PLANS.pro.limits.agents).toBe(3);
    expect(PLANS.pro.limits.dailyLlmCalls).toBe(1000);
    expect(PLANS.premium.limits.agents).toBe(10);
    expect(PLANS.premium.limits.dailyLlmCalls).toBe(10000);
    expect(PLANS.enterprise.limits.agents).toBeNull();
    expect(PLANS.enterprise.limits.dailyLlmCalls).toBeNull();
  });

  it('gates features per tier', () => {
    expect(PLANS.free.features.fileUpload).toBe(false);
    expect(PLANS.free.features.handoff).toBe(false);
    expect(PLANS.free.features.customBranding).toBe(false);

    expect(PLANS.pro.features.fileUpload).toBe(true);
    expect(PLANS.pro.features.handoff).toBe(true);
    expect(PLANS.pro.features.customBranding).toBe(false);

    expect(PLANS.premium.features.customBranding).toBe(true);
    expect(PLANS.enterprise.features.customBranding).toBe(true);
  });
});

describe('planIdForStripePriceId', () => {
  it('returns null on null / undefined input', () => {
    expect(planIdForStripePriceId(null)).toBeNull();
    expect(planIdForStripePriceId(undefined)).toBeNull();
  });

  it('returns null when the price ID is not in any plan', () => {
    expect(planIdForStripePriceId('price_completely_unknown')).toBeNull();
  });

  it('reverse-maps a registered price ID to its plan', () => {
    // The env-loaded test config sets pro/premium price IDs; if the test
    // env strips them, the catalog has null and this still returns null.
    const pro = PLANS.pro.providerPriceIds.stripe.usd;
    const premium = PLANS.premium.providerPriceIds.stripe.usd;
    if (pro) expect(planIdForStripePriceId(pro)).toBe('pro');
    if (premium) expect(planIdForStripePriceId(premium)).toBe('premium');
  });
});

describe('entitlementsFor', () => {
  it('resolves free / pro / premium entitlements straight from the catalog', () => {
    const free = entitlementsFor('free');
    expect(free.planId).toBe('free');
    expect(free.limits.agents).toBe(1);
    expect(free.limits.dailyLlmCalls).toBe(0);
    expect(free.features.fileUpload).toBe(false);

    const pro = entitlementsFor('pro');
    expect(pro.planId).toBe('pro');
    expect(pro.limits.agents).toBe(3);
    expect(pro.features.handoff).toBe(true);

    const premium = entitlementsFor('premium');
    expect(premium.planId).toBe('premium');
    expect(premium.limits.channels).toBeNull(); // unlimited
    expect(premium.features.customBranding).toBe(true);
  });

  it('ignores Enterprise override columns for non-Enterprise tiers', () => {
    const pro = entitlementsFor('pro', {
      maxSessions: 9999,
      dailyLlmCallLimit: 99999,
    });
    // Pro plan defaults stand regardless of override columns.
    expect(pro.limits.sessions).toBe(PLANS.pro.limits.sessions);
    expect(pro.limits.dailyLlmCalls).toBe(PLANS.pro.limits.dailyLlmCalls);
  });

  it('merges Enterprise override columns on top of plan defaults', () => {
    const ent = entitlementsFor('enterprise', {
      maxSessions: 2500,
      dailyLlmCallLimit: 50000,
    });
    expect(ent.planId).toBe('enterprise');
    expect(ent.limits.sessions).toBe(2500);
    expect(ent.limits.dailyLlmCalls).toBe(50000);
    // Unbounded fields stay null when the override doesn't set them.
    expect(ent.limits.agents).toBeNull();
    expect(ent.limits.channels).toBeNull();
  });

  it('falls back to plan defaults for Enterprise when override is null', () => {
    const ent = entitlementsFor('enterprise', {
      maxSessions: null,
      dailyLlmCallLimit: null,
    });
    expect(ent.limits.sessions).toBeNull();
    expect(ent.limits.dailyLlmCalls).toBeNull();
  });

  it('throws on an unknown tier', () => {
    expect(() => entitlementsFor('mystery_tier' as never)).toThrow(/unknown tier/);
  });
});
