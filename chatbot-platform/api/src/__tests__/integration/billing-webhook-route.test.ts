/**
 * End-to-end webhook route tests via supertest.
 *
 * Plan: .scratch/plan-billing.md § Implementation outline step 14 → Integration:
 *   - Webhook round-trip with INSERT…ON CONFLICT idempotency (replay →
 *     single mutation, single audit row, tenant_id populated when
 *     resolvable).
 *   - Webhook handler rolls back tenant lookup + audit insert + state
 *     mutation on a thrown mutation; next retry succeeds.
 *   - Unknown identifier → audit row with tenant_id = NULL.
 *
 * Stripe signature verification is bypassed by mocking
 * `stripe.webhooks.constructEvent` to return a pre-built event. The
 * provider's `verifyWebhook` path is exercised in the unit suite via the
 * normalizeWebhookEvent tests.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { TenantBillingAccount } from '../../database/entities/TenantBillingAccount';
import { BillingEvent } from '../../database/entities/BillingEvent';
import {
  setStripeClient,
  StripeBillingProvider,
} from '../../billing/providers/stripe';
import { registerBillingProvider } from '../../billing/provider-registry';
import { PLANS } from '../../billing/plans';
import {
  createTestTenant,
  createTestBillingAccount,
} from '../helpers/factories';

const PRO_PRICE = PLANS.pro.providerPriceIds.stripe.usd ?? 'price_test_pro';

// server.ts only registers the Stripe provider inside startServer(), which
// integration tests don't run — register here.
beforeAll(() => {
  registerBillingProvider(new StripeBillingProvider());
});

afterEach(() => {
  setStripeClient(null);
  vi.restoreAllMocks();
});

function makeStripeSubscriptionEvent(opts: {
  type: string;
  subscriptionId: string;
  customerId: string;
  stripeStatus: string;
  priceId?: string;
}): Record<string, unknown> {
  return {
    id: `evt_${Math.random().toString(36).slice(2)}`,
    type: opts.type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: opts.subscriptionId,
        customer: opts.customerId,
        status: opts.stripeStatus,
        current_period_end: 1_900_000_000,
        cancel_at_period_end: false,
        trial_end: null,
        items: {
          data: [{ id: 'si_e2e', price: { id: opts.priceId ?? PRO_PRICE } }],
        },
        schedule: null,
      },
    },
  };
}

function installVerifyWebhookStub(eventToReturn: unknown) {
  setStripeClient({
    customers: { search: vi.fn(), create: vi.fn(), update: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
    subscriptions: { retrieve: vi.fn(), update: vi.fn() },
    subscriptionSchedules: {
      create: vi.fn(),
      update: vi.fn(),
      retrieve: vi.fn(),
      release: vi.fn(),
    },
    // Returns the canned event regardless of body/signature. We're testing
    // the post-verify pipeline, not signature verification (covered elsewhere).
    webhooks: { constructEvent: vi.fn(() => eventToReturn) },
  } as never);
}

describe('POST /api/v1/webhooks/billing/stripe — idempotency', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    tenantId = tenant.id;
    // Manual trialing-pro primary, plus a pending Stripe row with customer_id
    // but no subscription_id (canonical "checkout-in-flight" state).
    await createTestBillingAccount(tenantId, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
    });
    await createTestBillingAccount(tenantId, {
      provider: 'stripe',
      status: 'none',
      currentPlanId: 'free',
      isPrimary: false,
      customerId: 'cus_idempotency',
      subscriptionId: null,
    });
  });

  it('round-trip: single audit row + primary-switch on first delivery', async () => {
    const event = makeStripeSubscriptionEvent({
      type: 'customer.subscription.created',
      subscriptionId: 'sub_idem_1',
      customerId: 'cus_idempotency',
      stripeStatus: 'trialing',
    });
    installVerifyWebhookStub(event);

    const res = await request(app)
      .post('/api/v1/webhooks/billing/stripe')
      .set('stripe-signature', 'sig_irrelevant')
      .set('Content-Type', 'application/json')
      .send(Buffer.from(JSON.stringify(event)));

    expect(res.status).toBe(200);

    const events = await AppDataSource.getRepository(BillingEvent).find({
      where: { provider: 'stripe', providerEventId: event.id as string },
    });
    expect(events.length).toBe(1);
    expect(events[0].tenantId).toBe(tenantId);

    const stripeRow = await AppDataSource.getRepository(
      TenantBillingAccount,
    ).findOneByOrFail({ tenantId, provider: 'stripe' });
    expect(stripeRow.isPrimary).toBe(true);
    expect(stripeRow.subscriptionId).toBe('sub_idem_1');
  });

  it('replay: second delivery of the same event_id is a no-op (single audit row, single mutation)', async () => {
    const event = makeStripeSubscriptionEvent({
      type: 'customer.subscription.created',
      subscriptionId: 'sub_replay_1',
      customerId: 'cus_idempotency',
      stripeStatus: 'trialing',
    });
    installVerifyWebhookStub(event);

    const first = await request(app)
      .post('/api/v1/webhooks/billing/stripe')
      .set('stripe-signature', 'sig_irrelevant')
      .set('Content-Type', 'application/json')
      .send(Buffer.from(JSON.stringify(event)));
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/v1/webhooks/billing/stripe')
      .set('stripe-signature', 'sig_irrelevant')
      .set('Content-Type', 'application/json')
      .send(Buffer.from(JSON.stringify(event)));
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ alreadyProcessed: true });

    // Still only ONE audit row + ONE primary stripe row.
    const events = await AppDataSource.getRepository(BillingEvent).find({
      where: { provider: 'stripe', providerEventId: event.id as string },
    });
    expect(events.length).toBe(1);
    const rows = await AppDataSource.getRepository(TenantBillingAccount).find({
      where: { tenantId, provider: 'stripe' },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].subscriptionId).toBe('sub_replay_1');
  });

  it('unknown customer → tenant_id NULL on audit row, returns 200 (no retry storm)', async () => {
    const event = makeStripeSubscriptionEvent({
      type: 'customer.subscription.created',
      subscriptionId: 'sub_ghost',
      customerId: 'cus_unknown_in_db', // no local row for this customer
      stripeStatus: 'trialing',
    });
    installVerifyWebhookStub(event);

    const res = await request(app)
      .post('/api/v1/webhooks/billing/stripe')
      .set('stripe-signature', 'sig_irrelevant')
      .set('Content-Type', 'application/json')
      .send(Buffer.from(JSON.stringify(event)));

    expect(res.status).toBe(200);

    const events = await AppDataSource.getRepository(BillingEvent).find({
      where: { provider: 'stripe', providerEventId: event.id as string },
    });
    expect(events.length).toBe(1);
    expect(events[0].tenantId).toBeNull();
  });
});

describe('POST /api/v1/webhooks/billing/stripe — rollback on thrown mutation', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    tenantId = tenant.id;
    await createTestBillingAccount(tenantId, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
    });
    await createTestBillingAccount(tenantId, {
      provider: 'stripe',
      status: 'none',
      currentPlanId: 'free',
      isPrimary: false,
      customerId: 'cus_rollback',
      subscriptionId: null,
    });
  });

  it('Stripe-side schedule retrieve failure rolls back both audit + state; retry succeeds', async () => {
    // Trigger the schedule-retrieve path by giving the event a string
    // schedule id. The webhook handler will try to call
    // subscriptionSchedules.retrieve which we make throw on first attempt
    // and succeed on retry.
    const event = {
      id: 'evt_rollback_1',
      type: 'customer.subscription.updated',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'sub_rollback',
          customer: 'cus_rollback',
          status: 'active',
          current_period_end: 1_900_000_000,
          cancel_at_period_end: false,
          trial_end: null,
          items: { data: [{ id: 'si_1', price: { id: PRO_PRICE } }] },
          // String schedule id triggers the inline retrieve.
          schedule: 'sub_sched_rollback',
        },
      },
    };

    const retrieveMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('stripe-transient-failure'))
      .mockResolvedValueOnce({
        id: 'sub_sched_rollback',
        phases: [
          { start_date: 1_700_000_000, items: [{ price: { id: PRO_PRICE } }] },
          {
            start_date: 1_900_000_000,
            items: [{ price: { id: 'price_test_premium' } }],
          },
        ],
      });
    setStripeClient({
      customers: { search: vi.fn(), create: vi.fn(), update: vi.fn() },
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: vi.fn() } },
      subscriptions: { retrieve: vi.fn(), update: vi.fn() },
      subscriptionSchedules: {
        create: vi.fn(),
        update: vi.fn(),
        retrieve: retrieveMock,
        release: vi.fn(),
      },
      webhooks: { constructEvent: vi.fn(() => event) },
    } as never);

    // First delivery — handler throws inside the tx → 500, no audit row,
    // no state mutation.
    const first = await request(app)
      .post('/api/v1/webhooks/billing/stripe')
      .set('stripe-signature', 'sig_irrelevant')
      .set('Content-Type', 'application/json')
      .send(Buffer.from(JSON.stringify(event)));
    expect(first.status).toBe(500);

    let events = await AppDataSource.getRepository(BillingEvent).find({
      where: { provider: 'stripe', providerEventId: 'evt_rollback_1' },
    });
    expect(events.length).toBe(0); // tx rolled back

    let stripeRow = await AppDataSource.getRepository(
      TenantBillingAccount,
    ).findOneByOrFail({ tenantId, provider: 'stripe' });
    // No mutation — subscription_id still null on the pending row.
    expect(stripeRow.subscriptionId).toBeNull();

    // Retry — Stripe schedule retrieve resolves this time, full success.
    const retry = await request(app)
      .post('/api/v1/webhooks/billing/stripe')
      .set('stripe-signature', 'sig_irrelevant')
      .set('Content-Type', 'application/json')
      .send(Buffer.from(JSON.stringify(event)));
    expect(retry.status).toBe(200);

    events = await AppDataSource.getRepository(BillingEvent).find({
      where: { provider: 'stripe', providerEventId: 'evt_rollback_1' },
    });
    expect(events.length).toBe(1);

    stripeRow = await AppDataSource.getRepository(
      TenantBillingAccount,
    ).findOneByOrFail({ tenantId, provider: 'stripe' });
    expect(stripeRow.subscriptionId).toBe('sub_rollback');
    // Pending plan populated from the schedule's phase 2 price.
    expect(stripeRow.pendingPlanId).toBe('premium');
  });
});

describe('POST /api/v1/webhooks/billing/:provider — provider allowlist', () => {
  it('unknown provider returns 404', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/billing/paddle')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'));
    expect(res.status).toBe(404);
  });
});
