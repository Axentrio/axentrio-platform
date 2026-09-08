import { describe, it, expect, afterEach, vi } from 'vitest';
import Stripe from 'stripe';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { TenantBillingAccount } from '../../database/entities/TenantBillingAccount';
import { cancelPastDueSubscriptionNow, runDunningSweep } from '../../billing/dunning';
import { setStripeClient } from '../../billing/providers/stripe';
import { createTestTenant, createTestBillingAccount } from '../helpers/factories';

afterEach(() => {
  setStripeClient(null);
  vi.restoreAllMocks();
});

describe('cancelPastDueSubscriptionNow', () => {
  it('uses injected now to drop a past-due primary and set Tenant.tier to free', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const now = new Date('2099-01-04T00:00:00.000Z');
    const started = new Date('2099-01-01T00:00:00.000Z');
    await createTestBillingAccount(tenant.id, {
      provider: 'stripe',
      status: 'past_due',
      currentPlanId: 'pro',
      isPrimary: true,
      customerId: 'cus_dunning_drop',
      subscriptionId: 'sub_dunning_drop',
      dunningStartedAt: started,
    });

    const cancel = vi.fn().mockResolvedValue({ id: 'sub_dunning_drop', status: 'canceled' });
    setStripeClient({ subscriptions: { cancel } } as never);

    const result = await cancelPastDueSubscriptionNow(tenant.id, now);

    expect(result).toBe('dropped');
    expect(cancel).toHaveBeenCalledWith('sub_dunning_drop');

    const tba = await AppDataSource.getRepository(TenantBillingAccount).findOneByOrFail({
      tenantId: tenant.id,
      provider: 'stripe',
    });
    expect(tba.status).toBe('cancelled');
    expect(tba.currentPlanId).toBe('free');
    expect(tba.dunningStartedAt).toBeNull();
    expect(tba.subscriptionId).toBeNull();

    const t = await AppDataSource.getRepository(Tenant).findOneByOrFail({ id: tenant.id });
    expect(t.tier).toBe('free');
    expect(t.status).toBe('active');
  });

  it('skips when wall-clock now is before the injected grace end', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const started = new Date('2099-01-01T00:00:00.000Z');
    await createTestBillingAccount(tenant.id, {
      provider: 'stripe',
      status: 'past_due',
      currentPlanId: 'pro',
      isPrimary: true,
      customerId: 'cus_dunning_skip_now',
      subscriptionId: 'sub_dunning_skip_now',
      dunningStartedAt: started,
    });

    const cancel = vi.fn();
    setStripeClient({ subscriptions: { cancel } } as never);

    // No injected now → real Date() is before 2099, so the 72h recheck must skip.
    const result = await cancelPastDueSubscriptionNow(tenant.id);

    expect(result).toBe('skipped');
    expect(cancel).not.toHaveBeenCalled();
    const t = await AppDataSource.getRepository(Tenant).findOneByOrFail({ id: tenant.id });
    expect(t.tier).toBe('pro');
  });

  it('skips and keeps the paid tier when the row recovered before the CTE', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestBillingAccount(tenant.id, {
      provider: 'stripe',
      status: 'active',
      currentPlanId: 'pro',
      isPrimary: true,
      customerId: 'cus_dunning_paid',
      subscriptionId: 'sub_dunning_paid',
      dunningStartedAt: null,
    });

    const cancel = vi.fn();
    setStripeClient({ subscriptions: { cancel } } as never);

    const result = await cancelPastDueSubscriptionNow(
      tenant.id,
      new Date('2099-01-04T00:00:00.000Z'),
    );

    expect(result).toBe('skipped');
    expect(cancel).not.toHaveBeenCalled();
    const t = await AppDataSource.getRepository(Tenant).findOneByOrFail({ id: tenant.id });
    expect(t.tier).toBe('pro');
  });

  it('resource_missing still cancels locally and sets Tenant.tier to free', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const now = new Date('2099-01-04T00:00:00.000Z');
    await createTestBillingAccount(tenant.id, {
      provider: 'stripe',
      status: 'past_due',
      currentPlanId: 'pro',
      isPrimary: true,
      customerId: 'cus_dunning_missing',
      subscriptionId: 'sub_dunning_missing',
      dunningStartedAt: new Date('2099-01-01T00:00:00.000Z'),
    });

    const cancel = vi.fn().mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        message: 'No such subscription',
        type: 'invalid_request_error',
        code: 'resource_missing',
      }),
    );
    setStripeClient({ subscriptions: { cancel } } as never);

    expect(await cancelPastDueSubscriptionNow(tenant.id, now)).toBe('dropped');
    const t = await AppDataSource.getRepository(Tenant).findOneByOrFail({ id: tenant.id });
    expect(t.tier).toBe('free');
    expect(t.status).toBe('active');
  });

  it('does not clobber tier when Stripe cancel races with invoice.paid', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const now = new Date('2099-01-04T00:00:00.000Z');
    await createTestBillingAccount(tenant.id, {
      provider: 'stripe',
      status: 'past_due',
      currentPlanId: 'pro',
      isPrimary: true,
      customerId: 'cus_dunning_race',
      subscriptionId: 'sub_dunning_race',
      dunningStartedAt: new Date('2099-01-01T00:00:00.000Z'),
    });

    const cancel = vi.fn().mockImplementation(async () => {
      await AppDataSource.getRepository(TenantBillingAccount).update(
        { tenantId: tenant.id, provider: 'stripe' },
        { status: 'active', dunningStartedAt: null },
      );
      return { id: 'sub_dunning_race', status: 'canceled' };
    });
    setStripeClient({ subscriptions: { cancel } } as never);

    expect(await cancelPastDueSubscriptionNow(tenant.id, now)).toBe('skipped');
    const tba = await AppDataSource.getRepository(TenantBillingAccount).findOneByOrFail({
      tenantId: tenant.id,
      provider: 'stripe',
    });
    expect(tba.status).toBe('active');
    const t = await AppDataSource.getRepository(Tenant).findOneByOrFail({ id: tenant.id });
    expect(t.tier).toBe('pro');
  });
});

describe('runDunningSweep — mixed rows', () => {
  it('drops clocked primaries and leaves grandfather past_due paid', async () => {
    const now = new Date('2099-01-04T00:00:00.000Z');
    const started = new Date('2099-01-01T00:00:00.000Z');

    const due = await createTestTenant({ tier: 'pro' });
    const grandfather = await createTestTenant({ tier: 'pro' });
    await createTestBillingAccount(due.id, {
      provider: 'stripe',
      status: 'past_due',
      currentPlanId: 'pro',
      isPrimary: true,
      customerId: 'cus_dunning_due',
      subscriptionId: 'sub_dunning_due',
      dunningStartedAt: started,
    });
    await createTestBillingAccount(grandfather.id, {
      provider: 'stripe',
      status: 'past_due',
      currentPlanId: 'pro',
      isPrimary: true,
      customerId: 'cus_dunning_gf',
      subscriptionId: 'sub_dunning_gf',
      dunningStartedAt: null,
    });

    const cancel = vi.fn().mockResolvedValue({ status: 'canceled' });
    setStripeClient({ subscriptions: { cancel } } as never);

    const result = await runDunningSweep(now);
    expect(result).toEqual({ reminded: 0, dropped: 1 });
    expect(cancel).toHaveBeenCalledWith('sub_dunning_due');
    expect(cancel).not.toHaveBeenCalledWith('sub_dunning_gf');

    expect(
      (await AppDataSource.getRepository(Tenant).findOneByOrFail({ id: due.id })).tier,
    ).toBe('free');
    expect(
      (await AppDataSource.getRepository(Tenant).findOneByOrFail({ id: due.id })).status,
    ).toBe('active');
    expect(
      (await AppDataSource.getRepository(Tenant).findOneByOrFail({ id: grandfather.id })).tier,
    ).toBe('pro');
    expect(
      (
        await AppDataSource.getRepository(TenantBillingAccount).findOneByOrFail({
          tenantId: grandfather.id,
          provider: 'stripe',
        })
      ).status,
    ).toBe('past_due');
  });
});
