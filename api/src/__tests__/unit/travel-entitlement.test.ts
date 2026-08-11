/**
 * `travelTime` as a COMMERCIAL entitlement (plan §4.6).
 *
 * Three properties are load-bearing and each has cost a real behaviour somewhere else in
 * this codebase when it was got wrong: the key must be grantable per tenant without a
 * deploy, it must die with `bookings` rather than outliving it, and it must NOT be
 * tenant-toggleable — that union is the tenant's own preference, and this is the grant.
 */
import { describe, it, expect } from 'vitest';

import { PLANS } from '../../billing/plans';
import { FEATURE_TAXONOMY } from '../../billing/feature-taxonomy';
import { entitlementsFor } from '../../billing/entitlements';
import { TENANT_TOGGLEABLE_FEATURES } from '../../billing/feature-toggles';
import type { FeatureOverride } from '../../database/entities/Tenant';

/** How a super admin actually grants it — per tenant, audited, without a deploy. */
const grant: FeatureOverride = {
  value: true,
  reason: 'pilot tenant',
  setBy: 'admin@axentrio.com',
  setAt: '2026-08-06T00:00:00Z',
};

describe('travelTime entitlement', () => {
  it('is entitled by exactly the tiers that sell bookings', () => {
    // This used to assert the opposite - off at EVERY tier - because during rollout a tier
    // default would have entitled every Pro tenant the moment it deployed, before the gates
    // were closed. They are closed now (#63, #66, #67, #68, #77, and the Google billing
    // account is off its free trial), so the grant moved from a per-tenant override to the
    // catalog.
    //
    // Asserting the pairing rather than two literals is what makes this survive: `travelTime`
    // declares `requires: 'bookings'`, so a tier that entitles travel without bookings would
    // have the dependency pass silently strip it back off and look entitled in the catalog
    // while being off everywhere that matters.
    for (const plan of Object.values(PLANS)) {
      expect(plan.features.travelTime, `${plan.id}: travelTime must track bookings`).toBe(
        plan.features.bookings,
      );
    }
  });

  it('is granted per tenant by override', () => {
    const ent = entitlementsFor('pro', undefined, {
      status: 'active',
      featureOverrides: { travelTime: grant },
    });
    expect(ent.features.travelTime).toBe(true);
    expect(ent.entitledFeatures.travelTime).toBe(true);
  });

  it('cannot outlive bookings — an override is overruled when the parent is off', () => {
    // Essential does not sell bookings. Granting travel there would gate slots for a
    // scheduler the tenant cannot use.
    const ent = entitlementsFor('essential', undefined, {
      status: 'active',
      featureOverrides: { travelTime: grant },
    });
    expect(ent.features.bookings).toBe(false);
    expect(ent.features.travelTime).toBe(false);
  });

  it('follows the tenant switching bookings off', () => {
    // `bookings` IS tenant-toggleable, so this is reachable without a plan change.
    const ent = entitlementsFor('pro', undefined, {
      status: 'active',
      featureOverrides: { travelTime: grant },
      featureToggles: { bookings: false },
    });
    expect(ent.features.travelTime).toBe(false);
    // The ceiling still shows it granted, so the UI offers a switch rather than an upsell.
    expect(ent.entitledFeatures.travelTime).toBe(true);
  });

  it('is not tenant-toggleable', () => {
    expect(TENANT_TOGGLEABLE_FEATURES).not.toContain('travelTime');
  });

  it('declares `bookings` as its parent in the taxonomy', () => {
    expect(FEATURE_TAXONOMY.travelTime.requires).toBe('bookings');
  });
});
