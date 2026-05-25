/**
 * Webhook handler integration tests — exercises `handleNormalizedEvent`
 * + the wrapping tx against a real Postgres.
 *
 * Plan: .scratch/plan-billing.md § Implementation outline step 14 → Integration.
 *
 * We invoke the handler directly with hand-crafted `NormalizedEvent`s rather
 * than going through `/webhooks/billing/stripe`. The route layer adds
 * signature verification + ON CONFLICT audit insert; those paths are tested
 * separately. Here we focus on the state-mutation semantics:
 *   - primary-switch and tier-cascade rules
 *   - past_due grace (tier preserved)
 *   - non-primary row updates stay row-local
 *   - subscription-mismatch / unknown-price audit-only paths
 *   - subscription_id persistence on out-of-order delivery
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppDataSource, runInTransaction } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { TenantBillingAccount } from '../../database/entities/TenantBillingAccount';
import { handleNormalizedEvent, resolveEventRow } from '../../billing/events';
import { getStripePriceIdFor } from '../../billing/plans';
import { setStripeClient } from '../../billing/providers/stripe';
import { NormalizedEvent, NormalizedStatus } from '../../billing/types';
import {
  createTestTenant,
  createTestBillingAccount,
} from '../helpers/factories';

afterEach(() => {
  setStripeClient(null);
  vi.restoreAllMocks();
});

// -- payload builders -------------------------------------------------------

const PRO_PRICE = getStripePriceIdFor('pro') ?? 'price_test_pro';
const ESSENTIAL_PRICE = getStripePriceIdFor('essential') ?? 'price_test_essential';

function makeSubscriptionEvent(opts: {
  type: 'subscription.created' | 'subscription.updated' | 'subscription.deleted';
  subscriptionId: string;
  customerId: string;
  stripeStatus: string;
  priceId?: string;
  schedule?: unknown;
  trialEnd?: number | null;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: number;
}): NormalizedEvent {
  const normalizedStatusMap: Record<string, NormalizedStatus> = {
    trialing: 'trialing',
    active: 'active',
    past_due: 'past_due',
    paused: 'past_due',
    unpaid: 'cancelled',
    canceled: 'cancelled',
    incomplete: 'none',
    incomplete_expired: 'cancelled',
  };
  const status = normalizedStatusMap[opts.stripeStatus] ?? 'none';
  const priceId = opts.priceId ?? PRO_PRICE;
  const planId =
    priceId === PRO_PRICE
      ? 'pro'
      : priceId === ESSENTIAL_PRICE
        ? 'essential'
        : 'free';
  const periodEnd = opts.currentPeriodEnd ?? 1_900_000_000;
  return {
    providerEventId: `evt_${Math.random().toString(36).slice(2)}`,
    type: opts.type,
    customerId: opts.customerId,
    subscriptionId: opts.subscriptionId,
    subscription: {
      customerId: opts.customerId,
      subscriptionId: opts.subscriptionId,
      status,
      currentPlanId: status === 'cancelled' || status === 'none' ? 'free' : (planId as 'essential' | 'pro'),
      currentPeriodEnd: new Date(periodEnd * 1000),
      cancelAtPeriodEnd: opts.cancelAtPeriodEnd ?? false,
      pendingPlanId: null,
      pendingPlanEffectiveAt: null,
      trialEnd: opts.trialEnd ? new Date(opts.trialEnd * 1000) : null,
    },
    occurredAt: new Date(),
    raw: {
      data: {
        object: {
          id: opts.subscriptionId,
          customer: opts.customerId,
          status: opts.stripeStatus,
          current_period_end: periodEnd,
          cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
          trial_end: opts.trialEnd ?? null,
          items: { data: [{ id: 'si_test', price: { id: priceId } }] },
          schedule: opts.schedule ?? null,
        },
      },
    },
  };
}

// -- helpers ----------------------------------------------------------------

async function loadBilling(tenantId: string): Promise<TenantBillingAccount[]> {
  return AppDataSource.getRepository(TenantBillingAccount).find({
    where: { tenantId },
    order: { createdAt: 'ASC' },
  });
}

async function loadTenantTier(tenantId: string): Promise<string> {
  const t = await AppDataSource.getRepository(Tenant).findOneOrFail({
    where: { id: tenantId },
  });
  return t.tier;
}

// -- tests ------------------------------------------------------------------

describe('handleNormalizedEvent — primary-switch & tier-cascade', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    tenantId = tenant.id;
    // Seed the canonical reverse-trial state: manual + trialing-pro + primary.
    await createTestBillingAccount(tenantId, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
    });
    // Plus a pre-existing pending Stripe row (no subscription yet —
    // checkout was just kicked off but webhook hasn't landed).
    await createTestBillingAccount(tenantId, {
      provider: 'stripe',
      status: 'none',
      currentPlanId: 'free',
      isPrimary: false,
      customerId: 'cus_test_setup',
      subscriptionId: null,
      trialEnd: null,
    });
  });

  it('subscription.created with status=trialing promotes Stripe row to primary; manual row demoted; Tenant.tier set', async () => {
    const event = makeSubscriptionEvent({
      type: 'subscription.created',
      subscriptionId: 'sub_promote_1',
      customerId: 'cus_test_setup',
      stripeStatus: 'trialing',
      priceId: PRO_PRICE,
    });

    await runInTransaction(async (manager) => {
      const matched = await resolveEventRow(manager, event);
      const outcome = await handleNormalizedEvent(manager, event, matched);
      expect(outcome.outcome).toBe('promoted_primary');
    });

    const rows = await loadBilling(tenantId);
    const stripeRow = rows.find((r) => r.provider === 'stripe')!;
    const manualRow = rows.find((r) => r.provider === 'manual')!;
    expect(stripeRow.isPrimary).toBe(true);
    expect(stripeRow.subscriptionId).toBe('sub_promote_1');
    expect(stripeRow.status).toBe('trialing');
    expect(stripeRow.currentPlanId).toBe('pro');
    expect(manualRow.isPrimary).toBe(false);
    expect(await loadTenantTier(tenantId)).toBe('pro');
  });

  it('subscription.created with status=active promotes + cascades tier', async () => {
    const event = makeSubscriptionEvent({
      type: 'subscription.created',
      subscriptionId: 'sub_promote_active',
      customerId: 'cus_test_setup',
      stripeStatus: 'active',
      priceId: ESSENTIAL_PRICE,
    });

    await runInTransaction(async (manager) => {
      const matched = await resolveEventRow(manager, event);
      const outcome = await handleNormalizedEvent(manager, event, matched);
      expect(outcome.outcome).toBe('promoted_primary');
    });

    expect(await loadTenantTier(tenantId)).toBe('essential');
  });

  it('subscription.created with status=incomplete does NOT promote (row stays non-primary)', async () => {
    const event = makeSubscriptionEvent({
      type: 'subscription.created',
      subscriptionId: 'sub_incomplete_1',
      customerId: 'cus_test_setup',
      stripeStatus: 'incomplete',
      priceId: PRO_PRICE,
    });

    await runInTransaction(async (manager) => {
      const matched = await resolveEventRow(manager, event);
      const outcome = await handleNormalizedEvent(manager, event, matched);
      expect(outcome.outcome).toBe('non_primary_row_updated');
    });

    const rows = await loadBilling(tenantId);
    const stripeRow = rows.find((r) => r.provider === 'stripe')!;
    const manualRow = rows.find((r) => r.provider === 'manual')!;
    expect(stripeRow.subscriptionId).toBe('sub_incomplete_1');
    // Plan-id semantics: 'incomplete' keeps price-mapped plan, NOT 'free'.
    expect(stripeRow.currentPlanId).toBe('pro');
    expect(stripeRow.isPrimary).toBe(false);
    expect(manualRow.isPrimary).toBe(true); // manual still primary
    expect(await loadTenantTier(tenantId)).toBe('pro'); // still trialing-pro
  });

  it('subscription.updated with status=incomplete on already-primary row does NOT escalate tier (latent-bug guard)', async () => {
    // Setup: tenant currently on Essential primary, tier='essential'. A
    // misbehaving Stripe transition (or a 3rd-party-fired event) sends
    // subscription.updated with status=incomplete + Pro price. Pre-fix,
    // the cascade would have set tier='pro' because newPlanForStatus
    // returns the price-mapped plan for `none` status — granting full
    // Pro entitlements on a no-payment state. Post-fix the cascade
    // requires status ∈ {trialing, active}, so tier stays 'essential'.
    //
    // Surfaced via synthetic webhook drive on 2026-05-26 lifecycle smoke;
    // codex review verdict: tighten the cascade.
    await AppDataSource.getRepository(TenantBillingAccount).update(
      { tenantId, provider: 'manual' },
      { isPrimary: false },
    );
    await AppDataSource.getRepository(TenantBillingAccount).update(
      { tenantId, provider: 'stripe' },
      {
        subscriptionId: 'sub_incomplete_primary',
        status: 'active',
        currentPlanId: 'essential',
        isPrimary: true,
      },
    );
    await AppDataSource.getRepository(Tenant).update({ id: tenantId }, { tier: 'essential' });

    const event = makeSubscriptionEvent({
      type: 'subscription.updated',
      subscriptionId: 'sub_incomplete_primary',
      customerId: 'cus_test_setup',
      stripeStatus: 'incomplete',
      priceId: PRO_PRICE, // attempted Pro upgrade that hasn't paid
    });

    await runInTransaction(async (manager) => {
      const matched = await resolveEventRow(manager, event);
      const outcome = await handleNormalizedEvent(manager, event, matched);
      expect(outcome.outcome).toBe('primary_non_entitlement_no_tier_cascade');
    });

    const rows = await loadBilling(tenantId);
    const stripeRow = rows.find((r) => r.provider === 'stripe')!;
    // Row-local fields updated to reflect the incoming state...
    expect(stripeRow.status).toBe('none');
    expect(stripeRow.currentPlanId).toBe('pro'); // price-mapped plan recorded
    // ...but Tenant.tier preserved — the no-payment status must not unlock
    // paid Pro entitlements.
    expect(await loadTenantTier(tenantId)).toBe('essential');
  });

  it('past_due preserves Tenant.tier and current_plan_id (grace period)', async () => {
    // Set up: tenant on active Stripe Pro. Demote manual FIRST to avoid
    // tripping the partial unique index on (tenant_id) WHERE is_primary.
    await AppDataSource.getRepository(TenantBillingAccount).update(
      { tenantId, provider: 'manual' },
      { isPrimary: false },
    );
    await AppDataSource.getRepository(TenantBillingAccount).update(
      { tenantId, provider: 'stripe' },
      {
        subscriptionId: 'sub_grace',
        status: 'active',
        currentPlanId: 'pro',
        isPrimary: true,
      },
    );

    const event = makeSubscriptionEvent({
      type: 'subscription.updated',
      subscriptionId: 'sub_grace',
      customerId: 'cus_test_setup',
      stripeStatus: 'past_due',
      priceId: PRO_PRICE,
    });

    await runInTransaction(async (manager) => {
      const matched = await resolveEventRow(manager, event);
      const outcome = await handleNormalizedEvent(manager, event, matched);
      expect(outcome.outcome).toBe('past_due_grace');
    });

    const rows = await loadBilling(tenantId);
    const stripeRow = rows.find((r) => r.provider === 'stripe')!;
    expect(stripeRow.status).toBe('past_due');
    expect(stripeRow.currentPlanId).toBe('pro'); // preserved, not 'free'
    expect(await loadTenantTier(tenantId)).toBe('pro'); // tier preserved
  });

  it('subscription.deleted on non-primary row cancels row-local fields but NOT Tenant.tier (PR9)', async () => {
    // Set up: manual primary (Enterprise), older Stripe row non-primary.
    await AppDataSource.getRepository(Tenant).update({ id: tenantId }, { tier: 'enterprise' });
    // Manual is already isPrimary=true from beforeEach — just adjust plan/status.
    await AppDataSource.getRepository(TenantBillingAccount).update(
      { tenantId, provider: 'manual' },
      { currentPlanId: 'enterprise', status: 'active' },
    );
    // Stripe was non-primary in setup — set its subscription_id.
    await AppDataSource.getRepository(TenantBillingAccount).update(
      { tenantId, provider: 'stripe' },
      {
        subscriptionId: 'sub_demoted',
        status: 'active',
        currentPlanId: 'pro',
      },
    );

    // PR9: subscription.deleted now refetches from Stripe. Mock the client
    // so the refetch resolves (resource_missing path is exercised
    // separately).
    setStripeClient({
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ id: 'sub_demoted', status: 'canceled' }) },
    } as never);

    const event = makeSubscriptionEvent({
      type: 'subscription.deleted',
      subscriptionId: 'sub_demoted',
      customerId: 'cus_test_setup',
      stripeStatus: 'canceled',
      priceId: PRO_PRICE,
    });

    await runInTransaction(async (manager) => {
      const matched = await resolveEventRow(manager, event);
      const outcome = await handleNormalizedEvent(manager, event, matched);
      expect(outcome.outcome).toBe('tenant_cancelled');
    });

    const rows = await loadBilling(tenantId);
    const stripeRow = rows.find((r) => r.provider === 'stripe')!;
    expect(stripeRow.status).toBe('cancelled');
    expect(stripeRow.currentPlanId).toBe('free');
    expect(stripeRow.isPrimary).toBe(false);
    expect(stripeRow.subscriptionId).toBeNull(); // PR9 clears subscriptionId
    expect(await loadTenantTier(tenantId)).toBe('enterprise'); // untouched (non-primary)
  });
});

describe('handleNormalizedEvent — audit-only paths', () => {
  let tenantId: string;
  let stripeRowId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    tenantId = tenant.id;
    await createTestBillingAccount(tenantId, {
      provider: 'manual',
      status: 'none',
      currentPlanId: 'free',
      isPrimary: false,
    });
    const stripe = await createTestBillingAccount(tenantId, {
      provider: 'stripe',
      status: 'active',
      currentPlanId: 'pro',
      isPrimary: true,
      customerId: 'cus_audit_only',
      subscriptionId: 'sub_audit_only',
    });
    stripeRowId = stripe.id;
  });

  it('subscription-mismatch (different sub_id) → audit_only, no state mutation', async () => {
    const event = makeSubscriptionEvent({
      type: 'subscription.updated',
      subscriptionId: 'sub_DIFFERENT', // mismatch — row has sub_audit_only
      customerId: 'cus_audit_only',
      stripeStatus: 'active',
      priceId: ESSENTIAL_PRICE,
    });

    await runInTransaction(async (manager) => {
      // We have to feed the resolved row manually because resolveEventRow
      // would miss (sub_DIFFERENT doesn't exist) and fall back via
      // customer_id — but that fallback path is gated on subscription_id
      // being null on the row. So we simulate the multi-sub race by
      // providing the existing row as `matched`.
      const row = await manager.getRepository(TenantBillingAccount).findOneByOrFail({
        id: stripeRowId,
      });
      const outcome = await handleNormalizedEvent(manager, event, {
        row,
        tenantId,
      });
      expect(outcome.outcome).toBe('subscription_mismatch');
      expect(outcome.meta).toMatchObject({
        existing: 'sub_audit_only',
        incoming: 'sub_DIFFERENT',
      });
    });

    // Row unchanged — still on the original sub + plan.
    const rows = await loadBilling(tenantId);
    const stripeRow = rows.find((r) => r.provider === 'stripe')!;
    expect(stripeRow.subscriptionId).toBe('sub_audit_only');
    expect(stripeRow.currentPlanId).toBe('pro');
  });

  it('unknown Stripe price → unknown_price outcome, no state mutation', async () => {
    const event = makeSubscriptionEvent({
      type: 'subscription.updated',
      subscriptionId: 'sub_audit_only',
      customerId: 'cus_audit_only',
      stripeStatus: 'active',
      priceId: 'price_not_in_catalog',
    });

    await runInTransaction(async (manager) => {
      const matched = await resolveEventRow(manager, event);
      const outcome = await handleNormalizedEvent(manager, event, matched);
      expect(outcome.outcome).toBe('unknown_price');
      expect(outcome.meta).toMatchObject({ priceId: 'price_not_in_catalog' });
    });

    // No plan/tier mutation occurred.
    const rows = await loadBilling(tenantId);
    const stripeRow = rows.find((r) => r.provider === 'stripe')!;
    expect(stripeRow.currentPlanId).toBe('pro');
  });

  it('symmetric unknown-price: subscription.created with unknown price → unknown_price outcome (round-5 #7)', async () => {
    // Set up a separate tenant in the canonical pre-checkout state (manual
    // primary + pending Stripe row without subscription_id) so the lookup
    // resolves via customer_id and would normally promote on a trialing/
    // active event. With an unknown price, the unknown_price guard fires
    // BEFORE the primary-switch — verifying parity with subscription.updated.
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestBillingAccount(tenant.id, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
    });
    await createTestBillingAccount(tenant.id, {
      provider: 'stripe',
      status: 'none',
      currentPlanId: 'free',
      isPrimary: false,
      customerId: 'cus_unknown_price_created',
      subscriptionId: null,
    });

    const event = makeSubscriptionEvent({
      type: 'subscription.created',
      subscriptionId: 'sub_unknown_price',
      customerId: 'cus_unknown_price_created',
      stripeStatus: 'trialing',
      priceId: 'price_completely_unknown',
    });

    await runInTransaction(async (manager) => {
      const matched = await resolveEventRow(manager, event);
      const outcome = await handleNormalizedEvent(manager, event, matched);
      expect(outcome.outcome).toBe('unknown_price');
    });

    // Manual is still primary; Stripe row never got promoted; tier untouched.
    const rows = await loadBilling(tenant.id);
    const manual = rows.find((r) => r.provider === 'manual')!;
    const stripeRow = rows.find((r) => r.provider === 'stripe')!;
    expect(manual.isPrimary).toBe(true);
    expect(stripeRow.isPrimary).toBe(false);
    expect(stripeRow.subscriptionId).toBeNull(); // not even persisted
    expect(await loadTenantTier(tenant.id)).toBe('pro'); // untouched
  });

  it('refund.recorded → audit_only_refund, no state mutation', async () => {
    const event: NormalizedEvent = {
      providerEventId: 'evt_refund_test',
      type: 'refund.recorded',
      customerId: 'cus_audit_only',
      subscriptionId: undefined,
      subscription: null,
      occurredAt: new Date(),
      raw: { data: { object: { customer: 'cus_audit_only' } } },
    };

    await runInTransaction(async (manager) => {
      const matched = await resolveEventRow(manager, event);
      const outcome = await handleNormalizedEvent(manager, event, matched);
      expect(outcome.outcome).toBe('audit_only_refund');
    });

    expect(await loadTenantTier(tenantId)).toBe('pro');
  });

  it('no matching row → no_matching_row outcome (caller writes audit with NULL tenant_id)', async () => {
    const event = makeSubscriptionEvent({
      type: 'subscription.updated',
      subscriptionId: 'sub_ghost',
      customerId: 'cus_ghost_unknown',
      stripeStatus: 'active',
      priceId: PRO_PRICE,
    });

    await runInTransaction(async (manager) => {
      const matched = await resolveEventRow(manager, event);
      expect(matched).toBeNull();
      const outcome = await handleNormalizedEvent(manager, event, matched);
      expect(outcome.outcome).toBe('no_matching_row');
    });
  });
});

describe('handleNormalizedEvent — invoice lifecycle', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    tenantId = tenant.id;
    await createTestBillingAccount(tenantId, {
      provider: 'stripe',
      status: 'past_due',
      currentPlanId: 'pro',
      isPrimary: true,
      customerId: 'cus_invoice',
      subscriptionId: 'sub_invoice',
    });
  });

  it('invoice.paid recovers a past_due row to active', async () => {
    const event: NormalizedEvent = {
      providerEventId: 'evt_invoice_paid',
      type: 'invoice.paid',
      customerId: 'cus_invoice',
      subscriptionId: 'sub_invoice',
      subscription: null,
      occurredAt: new Date(),
      raw: { data: { object: {} } },
    };

    await runInTransaction(async (manager) => {
      const matched = await resolveEventRow(manager, event);
      const outcome = await handleNormalizedEvent(manager, event, matched);
      expect(outcome.outcome).toBe('past_due_recovered');
    });

    const rows = await loadBilling(tenantId);
    expect(rows[0].status).toBe('active');
  });

  it('invoice.payment_failed marks an active row as past_due (tier preserved)', async () => {
    // Reset to active first.
    await AppDataSource.getRepository(TenantBillingAccount).update(
      { tenantId },
      { status: 'active' },
    );
    const event: NormalizedEvent = {
      providerEventId: 'evt_invoice_failed',
      type: 'invoice.payment_failed',
      customerId: 'cus_invoice',
      subscriptionId: 'sub_invoice',
      subscription: null,
      occurredAt: new Date(),
      raw: { data: { object: {} } },
    };

    await runInTransaction(async (manager) => {
      const matched = await resolveEventRow(manager, event);
      const outcome = await handleNormalizedEvent(manager, event, matched);
      expect(outcome.outcome).toBe('marked_past_due');
    });

    const rows = await loadBilling(tenantId);
    expect(rows[0].status).toBe('past_due');
    expect(await loadTenantTier(tenantId)).toBe('pro'); // tier preserved
  });
});

describe('resolveEventRow — lookup fallbacks', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    tenantId = tenant.id;
  });

  it('subscription.created: customer_id fallback when subscription_id miss', async () => {
    await createTestBillingAccount(tenantId, {
      provider: 'stripe',
      customerId: 'cus_fallback',
      subscriptionId: null,
      isPrimary: false,
      status: 'none',
      currentPlanId: 'free',
    });

    const event = makeSubscriptionEvent({
      type: 'subscription.created',
      subscriptionId: 'sub_new_via_customer',
      customerId: 'cus_fallback',
      stripeStatus: 'trialing',
      priceId: PRO_PRICE,
    });

    await runInTransaction(async (manager) => {
      const matched = await resolveEventRow(manager, event);
      expect(matched).not.toBeNull();
      expect(matched!.tenantId).toBe(tenantId);
    });
  });

  it('subscription.updated: customer_id fallback ONLY when subscription_id is null on the row', async () => {
    await createTestBillingAccount(tenantId, {
      provider: 'stripe',
      customerId: 'cus_with_sub',
      subscriptionId: 'sub_existing',
      isPrimary: true,
      status: 'active',
      currentPlanId: 'pro',
    });

    // Out-of-order: `.updated` for sub_existing arrives — direct hit
    const directHitEvent = makeSubscriptionEvent({
      type: 'subscription.updated',
      subscriptionId: 'sub_existing',
      customerId: 'cus_with_sub',
      stripeStatus: 'active',
      priceId: PRO_PRICE,
    });
    await runInTransaction(async (manager) => {
      const matched = await resolveEventRow(manager, directHitEvent);
      expect(matched).not.toBeNull();
    });

    // Different sub_id for same customer → fallback REFUSED (row's
    // subscription_id is set, mismatch goes to subscription_mismatch path)
    const mismatchEvent = makeSubscriptionEvent({
      type: 'subscription.updated',
      subscriptionId: 'sub_mystery',
      customerId: 'cus_with_sub',
      stripeStatus: 'active',
      priceId: PRO_PRICE,
    });
    await runInTransaction(async (manager) => {
      const matched = await resolveEventRow(manager, mismatchEvent);
      expect(matched).toBeNull();
    });
  });
});
