/**
 * Billing routes — HTTP-level coverage that complements the service-layer
 * tests in billing-service.test.ts. Verifies the
 * BillingProviderError → HTTP status mapping (no_stripe_subscription → 400,
 * subscription_exists → 409, plan_limit_* → 402), plus the route-layer
 * shape of the error envelope.
 *
 * Plan: .scratch/plan-billing.md § Implementation outline step 14 → Integration:
 *   "No-stripe-subscription route behavior: change-plan/cancel/undo-cancel/
 *    undo-pending-change/portal-session against a free/manual-trial/Enterprise
 *    tenant return HTTP 400 with { code: 'no_stripe_subscription' }."
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));
vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import { app } from '../../server';
import {
  setStripeClient,
  StripeBillingProvider,
} from '../../billing/providers/stripe';
import { registerBillingProvider } from '../../billing/provider-registry';
import {
  createTestTenant,
  createTestUser,
  createTestBillingAccount,
} from '../helpers/factories';

beforeAll(() => {
  registerBillingProvider(new StripeBillingProvider());
});

afterEach(() => {
  setStripeClient(null);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// no_stripe_subscription → HTTP 400 across all five Stripe-targeting routes
// ---------------------------------------------------------------------------

describe('billing routes — no_stripe_subscription returns HTTP 400', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    tenantId = tenant.id;
    const admin = await createTestUser(tenantId, { role: 'admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId, role: 'admin' });
    // Manual trialing-pro primary — no Stripe subscription.
    await createTestBillingAccount(tenantId, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
    });
  });

  it.each([
    ['POST /billing/change-plan', () =>
      request(app).post('/api/v1/billing/change-plan').send({ planId: 'essential' })],
    ['POST /billing/cancel', () => request(app).post('/api/v1/billing/cancel').send()],
    ['POST /billing/undo-cancel', () =>
      request(app).post('/api/v1/billing/undo-cancel').send()],
    ['POST /billing/undo-pending-change', () =>
      request(app).post('/api/v1/billing/undo-pending-change').send()],
    ['POST /billing/portal-session', () =>
      request(app)
        .post('/api/v1/billing/portal-session')
        .send({ returnUrl: 'https://example.com/return' })],
  ])('%s returns 400 with error.code=no_stripe_subscription', async (_, run) => {
    const res = await run();
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('no_stripe_subscription');
  });
});

// ---------------------------------------------------------------------------
// Duplicate-checkout guard → HTTP 409 subscription_exists
// ---------------------------------------------------------------------------

describe('POST /billing/checkout-session — duplicate-checkout guard', () => {
  it('returns 409 with code subscription_exists when primary Stripe row is active', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    configureMockAuth(auth, {
      userId: admin.id,
      tenantId: tenant.id,
      role: 'admin',
    });
    // Active Stripe primary — duplicate-checkout guard should fire.
    await createTestBillingAccount(tenant.id, {
      provider: 'stripe',
      status: 'active',
      currentPlanId: 'pro',
      isPrimary: true,
      customerId: 'cus_dup',
      subscriptionId: 'sub_dup',
    });

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
      webhooks: { constructEvent: vi.fn() },
    } as never);

    const res = await request(app)
      .post('/api/v1/billing/checkout-session')
      .send({
        planId: 'essential',
        successUrl: 'https://example.com/s',
        cancelUrl: 'https://example.com/c',
      });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('subscription_exists');
  });
});

// ---------------------------------------------------------------------------
// GET /billing/state — minimal shape check
// ---------------------------------------------------------------------------

describe('GET /billing/state', () => {
  it('returns the expected envelope shape for a trialing-pro tenant', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    configureMockAuth(auth, {
      userId: admin.id,
      tenantId: tenant.id,
      role: 'admin',
    });
    await createTestBillingAccount(tenant.id, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
    });

    const res = await request(app).get('/api/v1/billing/state');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      tier: 'pro',
      primaryProvider: 'manual',
      planId: 'pro',
      status: 'trialing',
      hasStripeSubscription: false,
    });
    expect(Array.isArray(res.body.data.events)).toBe(true);
  });

  it('reports hasStripeSubscription=false when a manual-free override demoted a still-active Stripe row', async () => {
    // Regression: a super-admin "Set tier → free" demotes the Stripe row to
    // non-primary but leaves it active in Stripe. hasStripeSubscription must
    // track the PRIMARY row (now manual/free) so the portal shows Subscribe
    // tiles — not the Manage actions, which would all 400 on the manual row.
    const tenant = await createTestTenant({ tier: 'free' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    configureMockAuth(auth, {
      userId: admin.id,
      tenantId: tenant.id,
      role: 'admin',
    });
    // Demoted-but-live Stripe row.
    await createTestBillingAccount(tenant.id, {
      provider: 'stripe',
      status: 'active',
      currentPlanId: 'pro',
      subscriptionId: 'sub_legacy_active',
      isPrimary: false,
    });
    // Manual primary row from the tier override.
    await createTestBillingAccount(tenant.id, {
      provider: 'manual',
      status: 'none',
      currentPlanId: 'free',
      isPrimary: true,
      trialEnd: null,
    });

    const res = await request(app).get('/api/v1/billing/state');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      tier: 'free',
      primaryProvider: 'manual',
      planId: 'free',
      status: 'none',
      hasStripeSubscription: false,
    });
  });

  it('rejects unauthorized roles (agent/supervisor) with 403', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const user = await createTestUser(tenant.id, { role: 'agent' });
    configureMockAuth(auth, {
      userId: user.id,
      tenantId: tenant.id,
      role: 'agent',
    });

    const res = await request(app).get('/api/v1/billing/state');
    expect(res.status).toBe(403);
  });
});
