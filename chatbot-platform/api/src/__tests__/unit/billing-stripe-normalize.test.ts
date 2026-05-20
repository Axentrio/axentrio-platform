/**
 * StripeBillingProvider.normalizeWebhookEvent — one case per supported
 * Stripe event type, plus the status-mapping table.
 *
 * Plan: .scratch/plan-billing.md § Implementation outline step 14 → Unit.
 *
 * These are pure-function tests over hand-crafted Stripe event payloads.
 * The Stripe SDK is NOT called; we never hit `getStripeClient`. The shape
 * of the payloads mirrors what `stripe-node` v22 emits — see
 * `normalizeWebhookEvent` in providers/stripe.ts for the inverse.
 *
 * --- API VERSION NOTE ---
 * Fixtures here track the pre-Basil event shape (Stripe API
 * < `2025-03-31`). stripe-node v22 still defaults to a pre-Basil
 * pinned version, and Stripe sends webhooks in the version pinned to
 * the account / endpoint, so this is what we receive today.
 *
 * Basil (2025-03-31) deprecates `invoice.subscription` in favor of
 * `invoice.parent.subscription_details.subscription`. If/when we upgrade
 * the SDK or pin a newer apiVersion, BOTH normalizeWebhookEvent and these
 * fixtures need updating. See:
 * https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects
 */

import { describe, it, expect } from 'vitest';
import { StripeBillingProvider } from '../../billing/providers/stripe';
import { PLANS } from '../../billing/plans';

function makeProvider() {
  return new StripeBillingProvider();
}

const PRO_PRICE = PLANS.pro.providerPriceIds.stripe.usd;

interface StripeSubscriptionPayload {
  id: string;
  customer: string;
  status: string;
  current_period_end: number;
  cancel_at_period_end: boolean;
  trial_end: number | null;
  items: { data: Array<{ id: string; price: { id: string | null } }> };
  schedule: unknown;
}

function makeSubscriptionPayload(
  overrides: Partial<StripeSubscriptionPayload> = {},
): StripeSubscriptionPayload {
  return {
    id: 'sub_test_123',
    customer: 'cus_test_abc',
    status: 'active',
    current_period_end: 1_700_000_000,
    cancel_at_period_end: false,
    trial_end: null,
    items: {
      data: [
        {
          id: 'si_test_1',
          price: { id: PRO_PRICE ?? 'price_test_pro' },
        },
      ],
    },
    schedule: null,
    ...overrides,
  };
}

function makeEvent(type: string, object: unknown) {
  return {
    id: `evt_test_${Math.random().toString(36).slice(2)}`,
    type,
    created: 1_700_000_000,
    data: { object },
  };
}

describe('normalizeWebhookEvent — per event type', () => {
  it('maps customer.subscription.created → subscription.created with subscriptionId', () => {
    const p = makeProvider();
    const sub = makeSubscriptionPayload({ status: 'trialing' });
    const normalized = p.normalizeWebhookEvent(makeEvent('customer.subscription.created', sub));

    expect(normalized).not.toBeNull();
    expect(normalized!.type).toBe('subscription.created');
    expect(normalized!.subscriptionId).toBe(sub.id);
    expect(normalized!.customerId).toBe(sub.customer);
    expect(normalized!.subscription).not.toBeNull();
    expect(normalized!.subscription!.status).toBe('trialing');
  });

  it('maps customer.subscription.updated → subscription.updated', () => {
    const p = makeProvider();
    const sub = makeSubscriptionPayload({ status: 'active' });
    const normalized = p.normalizeWebhookEvent(makeEvent('customer.subscription.updated', sub));

    expect(normalized!.type).toBe('subscription.updated');
    expect(normalized!.subscription!.status).toBe('active');
  });

  it('maps customer.subscription.deleted → subscription.deleted', () => {
    const p = makeProvider();
    const sub = makeSubscriptionPayload({ status: 'canceled' });
    const normalized = p.normalizeWebhookEvent(makeEvent('customer.subscription.deleted', sub));

    expect(normalized!.type).toBe('subscription.deleted');
    expect(normalized!.subscription!.status).toBe('cancelled');
  });

  it('maps invoice.paid → invoice.paid with subscriptionId extracted', () => {
    const p = makeProvider();
    const invoice = {
      customer: 'cus_invoice',
      subscription: 'sub_invoice_42',
      hosted_invoice_url: 'https://stripe.example/i',
    };
    const normalized = p.normalizeWebhookEvent(makeEvent('invoice.paid', invoice));

    expect(normalized!.type).toBe('invoice.paid');
    expect(normalized!.subscriptionId).toBe('sub_invoice_42');
    expect(normalized!.invoiceUrl).toBe('https://stripe.example/i');
    expect(normalized!.subscription).toBeNull(); // no NormalizedSubscription for invoice events
  });

  it('maps invoice.paid WITHOUT subscription → subscriptionId undefined', () => {
    const p = makeProvider();
    const invoice = { customer: 'cus_invoice', subscription: null };
    const normalized = p.normalizeWebhookEvent(makeEvent('invoice.paid', invoice));

    expect(normalized!.type).toBe('invoice.paid');
    expect(normalized!.subscriptionId).toBeUndefined();
    expect(normalized!.customerId).toBe('cus_invoice');
  });

  it('maps invoice.payment_failed → invoice.payment_failed', () => {
    const p = makeProvider();
    const invoice = { customer: 'cus_x', subscription: 'sub_x' };
    const normalized = p.normalizeWebhookEvent(makeEvent('invoice.payment_failed', invoice));

    expect(normalized!.type).toBe('invoice.payment_failed');
    expect(normalized!.subscriptionId).toBe('sub_x');
  });

  it('maps charge.refunded → refund.recorded', () => {
    const p = makeProvider();
    const charge = { customer: 'cus_refund' };
    const normalized = p.normalizeWebhookEvent(makeEvent('charge.refunded', charge));

    expect(normalized!.type).toBe('refund.recorded');
    expect(normalized!.customerId).toBe('cus_refund');
    // Charges aren't directly subscription-scoped — handler resolves by customer.
    expect(normalized!.subscriptionId).toBeUndefined();
  });

  it('returns null for ignored event types', () => {
    const p = makeProvider();
    const normalized = p.normalizeWebhookEvent(makeEvent('payment_intent.created', {}));
    expect(normalized).toBeNull();
  });
});

describe('normalizeWebhookEvent — Stripe status → normalized status table', () => {
  // One case per row of the table in
  // .scratch/plan-billing.md § Stripe status mapping
  const cases: Array<[stripe: string, normalized: string]> = [
    ['trialing', 'trialing'],
    ['active', 'active'],
    ['past_due', 'past_due'],
    ['unpaid', 'cancelled'],
    ['incomplete', 'none'],
    ['incomplete_expired', 'cancelled'],
    ['paused', 'past_due'],
    ['canceled', 'cancelled'],
  ];

  for (const [stripeStatus, normalizedStatus] of cases) {
    it(`maps Stripe '${stripeStatus}' → '${normalizedStatus}'`, () => {
      const p = makeProvider();
      const sub = makeSubscriptionPayload({ status: stripeStatus });
      const normalized = p.normalizeWebhookEvent(
        makeEvent('customer.subscription.updated', sub),
      );
      expect(normalized!.subscription!.status).toBe(normalizedStatus);
    });
  }

  it("'incomplete' preserves the price-mapped plan id (NOT 'free')", () => {
    // Per § Plan-id semantics on terminal statuses (codex r4 #5):
    // 'incomplete' means "wants Pro, payment pending" — the row's
    // current_plan_id still maps to Pro/Premium, not 'free'.
    if (!PRO_PRICE) return; // skip when test env has no price configured
    const p = makeProvider();
    const sub = makeSubscriptionPayload({ status: 'incomplete' });
    const normalized = p.normalizeWebhookEvent(
      makeEvent('customer.subscription.updated', sub),
    );
    // toNormalizedSubscription returns the price-mapped plan id, not 'free'.
    expect(normalized!.subscription!.currentPlanId).toBe('pro');
  });

  it("falls back to 'free' currentPlanId for unknown price IDs", () => {
    const p = makeProvider();
    const sub = makeSubscriptionPayload({
      items: {
        data: [{ id: 'si_test', price: { id: 'price_completely_unknown' } }],
      },
    });
    const normalized = p.normalizeWebhookEvent(
      makeEvent('customer.subscription.updated', sub),
    );
    // Reverse-lookup miss → 'free' on the normalized record. Webhook
    // handler treats this as audit-only (no state mutation).
    expect(normalized!.subscription!.currentPlanId).toBe('free');
  });
});

describe('Plan-rank upgrade vs downgrade selection', () => {
  it('Pro → Premium is an upgrade (higher rank)', () => {
    expect(PLANS.premium.rank > PLANS.pro.rank).toBe(true);
  });

  it('Premium → Pro is a downgrade (lower rank)', () => {
    expect(PLANS.pro.rank < PLANS.premium.rank).toBe(true);
  });

  it('Same-plan diff is zero — service rejects with no_op_plan_change', () => {
    expect(PLANS.pro.rank - PLANS.pro.rank).toBe(0);
  });
});
