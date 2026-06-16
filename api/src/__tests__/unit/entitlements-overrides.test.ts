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
  it('pro with bookings:false override loses booking + its dependent calendar sync', () => {
    const e = entitlementsFor('pro', NO_LIMITS, {
      status: 'active',
      featureOverrides: { bookings: override(false) },
    });
    expect(e.features.bookings).toBe(false);
    expect(e.features.calendarSync).toBe(false); // taxonomy: requires bookings
    expect(e.features.platformAssistant).toBe(true); // unrelated features untouched
  });

  it('essential with bookings:true override gains booking (comp)', () => {
    const e = entitlementsFor('essential', NO_LIMITS, {
      status: 'active',
      featureOverrides: { bookings: override(true) },
    });
    expect(e.features.bookings).toBe(true);
    expect(e.features.calendarSync).toBe(false); // not implied
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

  describe('taxonomy dependencies — a child feature never outlives its parent', () => {
    it('calendarSync override cannot turn on without bookings (essential)', () => {
      const e = entitlementsFor('essential', NO_LIMITS, {
        status: 'active',
        featureOverrides: { calendarSync: override(true) }, // bookings stays false
      });
      expect(e.features.calendarSync).toBe(false); // forced off — nothing to sync
    });

    it('forcing bookings off also forces calendarSync off (pro)', () => {
      const e = entitlementsFor('pro', NO_LIMITS, {
        status: 'active',
        featureOverrides: { bookings: override(false) }, // calendarSync default true
      });
      expect(e.features.bookings).toBe(false);
      expect(e.features.calendarSync).toBe(false);
    });

    it('comping bookings + calendarSync together works (essential)', () => {
      const e = entitlementsFor('essential', NO_LIMITS, {
        status: 'active',
        featureOverrides: { bookings: override(true), calendarSync: override(true) },
      });
      expect(e.features.bookings).toBe(true);
      expect(e.features.calendarSync).toBe(true);
    });

    it('crm requires leadCapture', () => {
      const e = entitlementsFor('enterprise', NO_LIMITS, {
        status: 'active',
        featureOverrides: { leadCapture: override(false) }, // crm default true on enterprise
      });
      expect(e.features.leadCapture).toBe(false);
      expect(e.features.crm).toBe(false);
    });
  });

  describe('tenant feature toggles — preference layer (plan-tenant-feature-toggles)', () => {
    it('entitled feature toggled off → effective off, but ceiling stays on', () => {
      const e = entitlementsFor('pro', NO_LIMITS, {
        status: 'active',
        featureOverrides: {},
        featureToggles: { bookings: false },
      });
      expect(e.features.bookings).toBe(false); // effective
      expect(e.entitledFeatures.bookings).toBe(true); // ceiling — drives upsell vs off-switch
      expect(e.featureToggles).toEqual({ bookings: false }); // echoed back for the UI
    });

    it('toggling a NON-entitled feature on can never exceed the ceiling', () => {
      // essential doesn't include bookings; a stray `true` preference must not enable it.
      const e = entitlementsFor('essential', NO_LIMITS, {
        status: 'active',
        featureOverrides: {},
        featureToggles: { bookings: true },
      });
      expect(e.features.bookings).toBe(false);
      expect(e.entitledFeatures.bookings).toBe(false);
    });

    it('toggling a parent off cascades to its dependent child', () => {
      const e = entitlementsFor('pro', NO_LIMITS, {
        status: 'active',
        featureOverrides: {},
        featureToggles: { bookings: false },
      });
      expect(e.features.bookings).toBe(false);
      expect(e.features.calendarSync).toBe(false); // cascaded
      expect(e.entitledFeatures.calendarSync).toBe(true); // ceiling untouched
    });

    it('leadCapture toggled off cascades crm off too', () => {
      const e = entitlementsFor('enterprise', NO_LIMITS, {
        status: 'active',
        featureOverrides: {},
        featureToggles: { leadCapture: false },
      });
      expect(e.features.leadCapture).toBe(false);
      expect(e.features.crm).toBe(false);
      expect(e.entitledFeatures.crm).toBe(true);
    });

    it('admin override ⊕ tenant preference compose (override on, tenant off)', () => {
      // essential is comped bookings by an admin override, then the tenant
      // turns it back off for themselves.
      const e = entitlementsFor('essential', NO_LIMITS, {
        status: 'active',
        featureOverrides: { bookings: override(true) },
        featureToggles: { bookings: false },
      });
      expect(e.entitledFeatures.bookings).toBe(true); // override raised the ceiling
      expect(e.features.bookings).toBe(false); // tenant opted out under it
    });

    it('free/suspended tenants ignore toggles entirely (D2 absolute deny wins)', () => {
      const free = entitlementsFor('free', NO_LIMITS, {
        status: 'active',
        featureToggles: { bookings: false, leadCapture: false },
      });
      expect(Object.values(free.features).every((v) => v === false)).toBe(true);
      expect(Object.values(free.entitledFeatures).every((v) => v === false)).toBe(true);

      const suspended = entitlementsFor('pro', NO_LIMITS, {
        status: 'suspended',
        featureToggles: { bookings: false },
      });
      expect(Object.values(suspended.features).every((v) => v === false)).toBe(true);
    });

    it('ignores non-toggleable keys and non-boolean values without throwing', () => {
      const e = entitlementsFor('pro', NO_LIMITS, {
        status: 'active',
        featureToggles: {
          calendarSync: false, // entitled on pro, but NOT in the toggleable allowlist
          notAFeature: false, // unknown
          bookings: 'nope', // malformed
        } as never,
      });
      expect(e.features.calendarSync).toBe(true); // untouched — not tenant-toggleable
      expect(e.features.bookings).toBe(true); // malformed value dropped
      expect(e.featureToggles).toEqual({}); // all rejected
    });

    it('no toggles → effective equals ceiling', () => {
      const e = entitlementsFor('pro', NO_LIMITS, { status: 'active', featureOverrides: {} });
      expect(e.features).toEqual(e.entitledFeatures);
      expect(e.featureToggles).toEqual({});
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
