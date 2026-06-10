/**
 * Plan catalog + entitlement resolver — pure unit tests.
 *
 * Updated for M0 plan-catalog reshape (subscription epic):
 *   - Tiers: free | essential | pro | enterprise
 *   - `free` is the internal-only cancellation sink
 *   - Enterprise is self-serve at €149/mo (still reachable sales-led via
 *     super-admin manual override for negotiated deals)
 *   - Entitlement shape uses the new feature flag names
 */

import { describe, it, expect } from 'vitest';
import {
  PLANS,
  planIdForStripePriceId,
  getStripePriceIdFor,
  selfServeCheckoutablePlans,
} from '../../billing/plans';
import { entitlementsFor } from '../../billing/entitlements';

describe('PLANS catalog', () => {
  it('exposes all four tiers with the documented ranks', () => {
    expect(PLANS.free.rank).toBe(0);
    expect(PLANS.essential.rank).toBe(1);
    expect(PLANS.pro.rank).toBe(2);
    expect(PLANS.enterprise.rank).toBe(3);
  });

  it('orders ranks correctly so upgrade vs downgrade is unambiguous', () => {
    expect(PLANS.free.rank).toBeLessThan(PLANS.essential.rank);
    expect(PLANS.essential.rank).toBeLessThan(PLANS.pro.rank);
    expect(PLANS.pro.rank).toBeLessThan(PLANS.enterprise.rank);
  });

  it('marks self-serve plans correctly (Essential + Pro + Enterprise)', () => {
    expect(PLANS.free.isSelfServeCheckoutable).toBe(false);
    expect(PLANS.essential.isSelfServeCheckoutable).toBe(true);
    expect(PLANS.pro.isSelfServeCheckoutable).toBe(true);
    expect(PLANS.enterprise.isSelfServeCheckoutable).toBe(true);
  });

  it('locks the documented per-tier prices (EUR)', () => {
    expect(PLANS.free.priceEurMonthly).toBeNull();
    expect(PLANS.essential.priceEurMonthly).toBe(49.99);
    expect(PLANS.pro.priceEurMonthly).toBe(99.99);
    expect(PLANS.enterprise.priceEurMonthly).toBe(149);
  });

  it('locks limits per tier', () => {
    // free is the cancellation sink — zero everything so the agent can't run.
    expect(PLANS.free.limits.agents).toBe(0);
    expect(PLANS.free.limits.bots).toBe(0);
    expect(PLANS.free.limits.dailyLlmCalls).toBe(0);
    // Essential and Pro: one human support agent + one AI bot per the epic.
    expect(PLANS.essential.limits.agents).toBe(1);
    expect(PLANS.essential.limits.bots).toBe(1);
    expect(PLANS.pro.limits.agents).toBe(1);
    expect(PLANS.pro.limits.bots).toBe(1);
    // Enterprise: two of each per the epic.
    expect(PLANS.enterprise.limits.agents).toBe(2);
    expect(PLANS.enterprise.limits.bots).toBe(2);
  });

  it('gates features per tier', () => {
    // Cancellation sink: everything off.
    expect(PLANS.free.features.unifiedInbox).toBe(false);
    expect(PLANS.free.features.handoff).toBe(false);
    expect(PLANS.free.features.fileUpload).toBe(false);

    // Essential: basic feature set, watermark visible, no bookings/CRM/assistant.
    expect(PLANS.essential.features.unifiedInbox).toBe(true);
    expect(PLANS.essential.features.bookings).toBe(false);
    expect(PLANS.essential.features.calendarSync).toBe(false);
    expect(PLANS.essential.features.platformAssistant).toBe(false);
    expect(PLANS.essential.features.crm).toBe(false);
    expect(PLANS.essential.features.hideWidgetAttribution).toBe(false);
    expect(PLANS.essential.features.customWidgetAppearance).toBe(true);
    expect(PLANS.essential.features.fileUpload).toBe(true);

    // Pro: bookings + assistant on; watermark off; CRM still off.
    expect(PLANS.pro.features.bookings).toBe(true);
    expect(PLANS.pro.features.calendarSync).toBe(true);
    expect(PLANS.pro.features.platformAssistant).toBe(true);
    expect(PLANS.pro.features.crm).toBe(false);
    expect(PLANS.pro.features.hideWidgetAttribution).toBe(true);

    // Enterprise: everything on, including CRM (entitlement gate true; the
    // UI shows Coming Soon at the surface layer per D25).
    expect(PLANS.enterprise.features.crm).toBe(true);
    expect(PLANS.enterprise.features.hideWidgetAttribution).toBe(true);
  });
});

describe('selfServeCheckoutablePlans', () => {
  it('returns Essential, Pro, and Enterprise', () => {
    const plans = selfServeCheckoutablePlans();
    expect(plans.map((p) => p.id).sort()).toEqual(['enterprise', 'essential', 'pro']);
  });
});

describe('getStripePriceIdFor', () => {
  it('returns null for free regardless of env', () => {
    expect(getStripePriceIdFor('free')).toBeNull();
  });

  it('returns the configured price ID for self-serve plans when set', () => {
    // The test env may or may not have these set; the function just reads
    // config. Whatever the value is, it should be consistent.
    const essentialId = getStripePriceIdFor('essential');
    const proId = getStripePriceIdFor('pro');
    const enterpriseId = getStripePriceIdFor('enterprise');
    // Either configured strings or null — never undefined.
    expect(typeof essentialId === 'string' || essentialId === null).toBe(true);
    expect(typeof proId === 'string' || proId === null).toBe(true);
    expect(typeof enterpriseId === 'string' || enterpriseId === null).toBe(true);
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

  it('round-trips: getStripePriceIdFor → planIdForStripePriceId', () => {
    const essentialId = getStripePriceIdFor('essential');
    const proId = getStripePriceIdFor('pro');
    const enterpriseId = getStripePriceIdFor('enterprise');
    if (essentialId) expect(planIdForStripePriceId(essentialId)).toBe('essential');
    if (proId) expect(planIdForStripePriceId(proId)).toBe('pro');
    if (enterpriseId) expect(planIdForStripePriceId(enterpriseId)).toBe('enterprise');
  });
});

describe('entitlementsFor', () => {
  it('resolves Essential entitlements straight from the catalog', () => {
    const ess = entitlementsFor('essential');
    expect(ess.planId).toBe('essential');
    expect(ess.limits.agents).toBe(1);
    expect(ess.features.unifiedInbox).toBe(true);
    expect(ess.features.bookings).toBe(false);
    expect(ess.features.hideWidgetAttribution).toBe(false);
  });

  it('resolves Pro entitlements straight from the catalog', () => {
    const pro = entitlementsFor('pro');
    expect(pro.planId).toBe('pro');
    expect(pro.limits.agents).toBe(1);
    expect(pro.features.bookings).toBe(true);
    expect(pro.features.platformAssistant).toBe(true);
    expect(pro.features.hideWidgetAttribution).toBe(true);
  });

  it('resolves Free (cancellation sink) entitlements as all-zero/all-false', () => {
    const free = entitlementsFor('free');
    expect(free.planId).toBe('free');
    expect(free.limits.agents).toBe(0);
    expect(free.limits.dailyLlmCalls).toBe(0);
    expect(free.features.unifiedInbox).toBe(false);
    expect(free.features.handoff).toBe(false);
    expect(free.features.fileUpload).toBe(false);
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
    // agents + bots have no override path; use the plan defaults.
    expect(ent.limits.agents).toBe(2);
    expect(ent.limits.bots).toBe(2);
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
