/**
 * Trial-expiry service + daily sweep — integration tests.
 *
 * Plan: .scratch/plan-billing.md § Implementation outline step 14 → Integration:
 *   - Trial-expiry job: (i) manual-only → downgrades; (ii) Stripe pending
 *     row within 24h → skips; (iii) Stripe pending row older than 24h,
 *     status='none' → downgrades; (iv) primary already Enterprise →
 *     no-op; (v) recent Stripe `billing_events` row → skips.
 *   - Daily sweep: orphaned trial → selects and downgrades.
 */

import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { TenantBillingAccount } from '../../database/entities/TenantBillingAccount';
import { BillingEvent } from '../../database/entities/BillingEvent';
import {
  expireTrialIfStillManual,
  findExpiredTrialCandidates,
  sweepExpiredTrials,
} from '../../billing/service';
import { createTestTenant, createTestBillingAccount } from '../helpers/factories';

const TWENTY_FIVE_H_MS = 25 * 60 * 60 * 1000;
const TWELVE_H_MS = 12 * 60 * 60 * 1000;

describe('expireTrialIfStillManual', () => {
  it('downgrades a manual+trialing+pro primary row to free', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestBillingAccount(tenant.id, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
      trialEnd: new Date(Date.now() - 60_000), // already expired
    });

    const result = await expireTrialIfStillManual(tenant.id);

    expect(result.downgraded).toBe(true);
    const updated = await AppDataSource.getRepository(Tenant).findOneByOrFail({
      id: tenant.id,
    });
    expect(updated.tier).toBe('free');
    const rows = await AppDataSource.getRepository(TenantBillingAccount).find({
      where: { tenantId: tenant.id },
    });
    expect(rows[0].status).toBe('none');
    expect(rows[0].currentPlanId).toBe('free');
    // Audit row written.
    const events = await AppDataSource.getRepository(BillingEvent).find({
      where: { tenantId: tenant.id, eventType: 'trial.expired' },
    });
    expect(events.length).toBe(1);
  });

  it('skips downgrade when a fresh (<24h) non-manual row exists', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestBillingAccount(tenant.id, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
      trialEnd: new Date(Date.now() - 60_000),
    });
    // Pending Stripe row from a recent abandoned checkout — under 24h old.
    await createTestBillingAccount(tenant.id, {
      provider: 'stripe',
      status: 'none',
      currentPlanId: 'free',
      isPrimary: false,
      customerId: 'cus_recent',
      subscriptionId: null,
    });

    const result = await expireTrialIfStillManual(tenant.id);

    expect(result.downgraded).toBe(false);
    expect(result.reason).toBe('fresh_non_manual_row');
    const tenantRow = await AppDataSource.getRepository(Tenant).findOneByOrFail({
      id: tenant.id,
    });
    expect(tenantRow.tier).toBe('pro'); // untouched
  });

  it('downgrades when the non-manual row is older than 24h AND status=none', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestBillingAccount(tenant.id, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
      trialEnd: new Date(Date.now() - 60_000),
    });
    // Backdate the Stripe row past the 24h freshness window.
    const stripe = await createTestBillingAccount(tenant.id, {
      provider: 'stripe',
      status: 'none',
      currentPlanId: 'free',
      isPrimary: false,
      customerId: 'cus_stale',
      subscriptionId: null,
    });
    await AppDataSource.query(
      `UPDATE tenant_billing_accounts SET created_at = $1 WHERE id = $2`,
      [new Date(Date.now() - TWENTY_FIVE_H_MS), stripe.id],
    );

    const result = await expireTrialIfStillManual(tenant.id);

    expect(result.downgraded).toBe(true);
    const t = await AppDataSource.getRepository(Tenant).findOneByOrFail({ id: tenant.id });
    expect(t.tier).toBe('free');
  });

  it('skips when a non-manual row is active/trialing/past_due (any age)', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestBillingAccount(tenant.id, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
      trialEnd: new Date(Date.now() - 60_000),
    });
    const stripe = await createTestBillingAccount(tenant.id, {
      provider: 'stripe',
      status: 'past_due',
      currentPlanId: 'pro',
      isPrimary: false,
      customerId: 'cus_stale_active',
      subscriptionId: 'sub_active_like',
    });
    // Even with old created_at, an active-like status blocks the downgrade.
    await AppDataSource.query(
      `UPDATE tenant_billing_accounts SET created_at = $1 WHERE id = $2`,
      [new Date(Date.now() - TWENTY_FIVE_H_MS), stripe.id],
    );

    const result = await expireTrialIfStillManual(tenant.id);

    expect(result.downgraded).toBe(false);
    expect(result.reason).toBe('non_manual_active_like');
  });

  it('skips when a recent (<24h) stripe billing_events row exists', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestBillingAccount(tenant.id, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
      trialEnd: new Date(Date.now() - 60_000),
    });
    // No non-manual row at all — but a recent stripe billing_events row
    // signals "checkout in flight"; the expiry job defers.
    const eventRepo = AppDataSource.getRepository(BillingEvent);
    await eventRepo.save(
      eventRepo.create({
        tenantId: tenant.id,
        provider: 'stripe',
        providerEventId: 'evt_recent',
        eventType: 'subscription.created',
        payload: {},
      }),
    );

    const result = await expireTrialIfStillManual(tenant.id);

    expect(result.downgraded).toBe(false);
    expect(result.reason).toBe('recent_stripe_event');
  });

  it('no-ops when the primary is already Enterprise', async () => {
    const tenant = await createTestTenant({ tier: 'enterprise' });
    await createTestBillingAccount(tenant.id, {
      provider: 'manual',
      status: 'active',
      currentPlanId: 'enterprise',
      isPrimary: true,
      trialEnd: null,
    });

    const result = await expireTrialIfStillManual(tenant.id);

    expect(result.downgraded).toBe(false);
    expect(result.reason).toBe('primary_not_eligible');
    const t = await AppDataSource.getRepository(Tenant).findOneByOrFail({ id: tenant.id });
    expect(t.tier).toBe('enterprise');
  });

  it('is idempotent — second call after downgrade no-ops', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestBillingAccount(tenant.id, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
      trialEnd: new Date(Date.now() - 60_000),
    });

    const first = await expireTrialIfStillManual(tenant.id);
    expect(first.downgraded).toBe(true);

    const second = await expireTrialIfStillManual(tenant.id);
    expect(second.downgraded).toBe(false);
    expect(second.reason).toBe('primary_not_eligible');

    // Only one audit row across both calls.
    const events = await AppDataSource.getRepository(BillingEvent).find({
      where: { tenantId: tenant.id, eventType: 'trial.expired' },
    });
    expect(events.length).toBe(1);
  });
});

describe('findExpiredTrialCandidates + sweepExpiredTrials', () => {
  it('finds tenants whose trial_end has passed', async () => {
    const expired = await createTestTenant({ tier: 'pro' });
    await createTestBillingAccount(expired.id, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
      trialEnd: new Date(Date.now() - 60_000),
    });

    const stillTrialing = await createTestTenant({ tier: 'pro' });
    await createTestBillingAccount(stillTrialing.id, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
      trialEnd: new Date(Date.now() + TWELVE_H_MS),
    });

    const candidates = await findExpiredTrialCandidates();
    expect(candidates).toContain(expired.id);
    expect(candidates).not.toContain(stillTrialing.id);
  });

  it('sweep downgrades only the expired tenants and reports counts', async () => {
    const expired = await createTestTenant({ tier: 'pro' });
    await createTestBillingAccount(expired.id, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
      trialEnd: new Date(Date.now() - 60_000),
    });
    const fresh = await createTestTenant({ tier: 'pro' });
    await createTestBillingAccount(fresh.id, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
      trialEnd: new Date(Date.now() + TWELVE_H_MS),
    });

    const summary = await sweepExpiredTrials();
    expect(summary.downgraded).toBeGreaterThanOrEqual(1);
    expect(summary.failed).toBe(0);

    const expiredTenant = await AppDataSource.getRepository(Tenant).findOneByOrFail({
      id: expired.id,
    });
    const freshTenant = await AppDataSource.getRepository(Tenant).findOneByOrFail({
      id: fresh.id,
    });
    expect(expiredTenant.tier).toBe('free');
    expect(freshTenant.tier).toBe('pro');
  });
});
