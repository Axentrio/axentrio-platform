/**
 * Contract tests for the entitlement resolver's feature-override layer
 * (plan .scratch/plan-entitlements-modules.md, Phase 1 — D2/D3/D4/D6).
 *
 * Pure-resolver tests (entitlementsFor): tiers × overrides × status. The
 * DB-backed wrapper (getEntitlements) shares this code path; cache
 * invalidation on override/status writes is exercised by the integration
 * suite (needs the test DB).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { entitlementsFor } from '../../billing/entitlements';
import { PLANS } from '../../billing/plans';
import type { FeatureOverride } from '../../database/entities/Tenant';

const NO_LIMITS = { maxSessions: null, dailyLlmCallLimit: null };

function override(value: boolean): FeatureOverride {
  return { value, reason: 'test', setBy: 'admin@test', setAt: '2026-06-10T00:00:00Z' };
}

describe('entitlementsFor — per-tenant feature overrides', () => {
  it('pro with bookings:false override loses booking (and only booking)', () => {
    const e = entitlementsFor('pro', NO_LIMITS, {
      status: 'active',
      featureOverrides: { bookings: override(false) },
    });
    expect(e.features.bookings).toBe(false);
    expect(e.features.calendarIntegrations).toBe(true); // untouched
    expect(e.features.platformAssistant).toBe(true);
  });

  it('essential with bookings:true override gains booking (comp)', () => {
    const e = entitlementsFor('essential', NO_LIMITS, {
      status: 'active',
      featureOverrides: { bookings: override(true) },
    });
    expect(e.features.bookings).toBe(true);
    expect(e.features.calendarIntegrations).toBe(false); // not implied
  });

  it('no overrides → exact plan defaults per tier', () => {
    for (const tier of ['free', 'essential', 'pro', 'enterprise'] as const) {
      const e = entitlementsFor(tier, NO_LIMITS, { status: 'active', featureOverrides: {} });
      expect(e.features).toEqual(PLANS[tier].features);
    }
  });

  describe('D2 — absolute deny', () => {
    it('free ignores positive overrides entirely', () => {
      const e = entitlementsFor('free', NO_LIMITS, {
        status: 'active',
        featureOverrides: { bookings: override(true), crm: override(true) },
      });
      expect(Object.values(e.features).every((v) => v === false)).toBe(true);
    });

    it('suspended status forces ALL features false regardless of tier and overrides', () => {
      const e = entitlementsFor('enterprise', NO_LIMITS, {
        status: 'suspended',
        featureOverrides: { bookings: override(true) },
      });
      expect(Object.values(e.features).every((v) => v === false)).toBe(true);
    });

    it('cancelled status forces ALL features false', () => {
      const e = entitlementsFor('pro', NO_LIMITS, { status: 'cancelled', featureOverrides: {} });
      expect(Object.values(e.features).every((v) => v === false)).toBe(true);
    });

    it('omitted status defaults to active (pure callers keep plan semantics)', () => {
      expect(entitlementsFor('pro').features.bookings).toBe(true);
    });
  });

  describe('read-side hardening', () => {
    it('ignores unknown feature keys without throwing', () => {
      const e = entitlementsFor('pro', NO_LIMITS, {
        status: 'active',
        featureOverrides: { notAFeature: override(false) } as never,
      });
      expect(e.features).toEqual(PLANS.pro.features);
    });

    it('ignores entries whose value is not a boolean', () => {
      const e = entitlementsFor('pro', NO_LIMITS, {
        status: 'active',
        featureOverrides: { bookings: { value: 'nope' } } as never,
      });
      expect(e.features.bookings).toBe(true); // plan default kept
    });

    it('missing audit metadata does NOT void an override — value alone governs', () => {
      const e = entitlementsFor('pro', NO_LIMITS, {
        status: 'active',
        featureOverrides: { bookings: { value: false } } as never,
      });
      expect(e.features.bookings).toBe(false);
    });
  });

  describe('D3 — limits are never affected by feature overrides', () => {
    it('overrides leave limits exactly at plan/override-column values', () => {
      const e = entitlementsFor(
        'pro',
        NO_LIMITS,
        { status: 'active', featureOverrides: { bookings: override(false) } },
      );
      expect(e.limits).toEqual(PLANS.pro.limits);
    });

    it('enterprise numeric column overrides still apply independently', () => {
      const e = entitlementsFor(
        'enterprise',
        { maxSessions: 999, dailyLlmCallLimit: 5000 },
        { status: 'active', featureOverrides: { crm: override(false) } },
      );
      expect(e.limits.sessions).toBe(999);
      expect(e.limits.dailyLlmCalls).toBe(5000);
      expect(e.features.crm).toBe(false);
    });
  });

  describe('catalog isolation — plan.features is never mutated', () => {
    it('an override never leaks into the shared PLANS catalog or later resolves', () => {
      const before = { ...PLANS.pro.features };
      const overridden = entitlementsFor('pro', NO_LIMITS, {
        status: 'active',
        featureOverrides: { bookings: override(false) },
      });
      expect(overridden.features.bookings).toBe(false);
      // The catalog object is untouched...
      expect(PLANS.pro.features).toEqual(before);
      // ...and a subsequent overrides-free resolve sees pristine defaults.
      expect(entitlementsFor('pro', NO_LIMITS, { status: 'active', featureOverrides: {} }).features.bookings).toBe(true);
    });

    it('mutating a resolved result does not poison the catalog', () => {
      const e = entitlementsFor('pro');
      (e.features as { bookings: boolean }).bookings = false;
      expect(PLANS.pro.features.bookings).toBe(true);
      expect(entitlementsFor('pro').features.bookings).toBe(true);
    });
  });
});
