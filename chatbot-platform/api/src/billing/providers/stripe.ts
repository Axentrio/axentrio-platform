/**
 * StripeBillingProvider — full v1 adapter for the BillingProvider interface.
 *
 * Plan: .scratch/plan-billing.md § Implementation outline step 6.
 *
 * Key behaviors codex flagged across the planning rounds (refer back if
 * editing — they are easy to regress):
 *
 *   - search-then-create customer (durable across idempotency-key TTL expiry)
 *   - upgrade: retrieve subscription, assert single item, pass real item id
 *   - downgrade: Stripe Subscription Schedules with two phases
 *   - changeSubscription synchronously checks `sub.schedule` for an existing
 *     schedule (authoritative remote check; defeats local-vs-webhook race)
 *   - normalizeWebhookEvent surfaces `subscriptionId` so the lookup chain
 *     in the webhook handler can hit `(provider, subscription_id)` first
 *   - status mapping treats `incomplete` as `none` (row stays non-primary;
 *     tier unchanged) and `incomplete_expired`/`unpaid` as terminal
 *     `cancelled`
 *   - unknown Stripe price IDs are surfaced via `null` on `currentPlanId`'s
 *     resolution — the webhook handler treats that as audit-only
 */

import Stripe from 'stripe';
// Stripe-node v22 ships under `export = StripeConstructor`, and under
// `moduleResolution: "node"` (this project's setting) the default import
// only exposes the constructor — not the resource-type namespace. Pull
// resource types from the CJS core module path so the resolved types
// match the runtime instance returned by the default import (the parallel
// ESM type tree is structurally incompatible under this resolution mode).
// Path stable in v22.x; revisit at major Stripe upgrade.
import type { Stripe as StripeNS } from 'stripe/cjs/stripe.core';
import { config } from '../../config/environment';
import { AppDataSource } from '../../database/data-source';
import { TenantBillingAccount } from '../../database/entities/TenantBillingAccount';
import { PLANS, planIdForStripePriceId, getStripePriceIdFor } from '../plans';
import {
  BillingProvider,
  BillingProviderError,
  CheckoutablePlanId,
  InternalPlanId,
  NormalizedEvent,
  NormalizedStatus,
  NormalizedSubscription,
} from '../types';

const PROVIDER = 'stripe' as const;

let cachedClient: StripeNS | null = null;

export function getStripeClient(): StripeNS {
  if (cachedClient) return cachedClient;
  if (!config.billing.stripe.secretKey) {
    throw new BillingProviderError('stripe_not_configured', PROVIDER);
  }
  cachedClient = new Stripe(config.billing.stripe.secretKey, { typescript: true });
  return cachedClient;
}

// Test-only hook: lets tests inject a mocked Stripe client without going
// through the real constructor. Tests reset between cases via setStripeClient(null).
export function setStripeClient(client: StripeNS | null): void {
  cachedClient = client;
}

function rank(planId: InternalPlanId): number {
  return PLANS[planId].rank;
}

/**
 * Stripe's `2026-04-22.dahlia` API moved `current_period_end` (and
 * `current_period_start`) off the Subscription object and onto each
 * Subscription Item. The legacy field is still emitted for older
 * pinned API versions; this helper reads either shape so the rest of
 * the codebase doesn't have to care which Stripe version the account
 * is pinned to.
 *
 * Returns the Unix seconds timestamp from whichever location populated
 * it, or undefined if neither carries it (defensively — single-item
 * subs should always have one).
 */
function readCurrentPeriodEnd(
  sub: StripeNS.Subscription,
): number | undefined {
  const root = (sub as unknown as { current_period_end?: number })
    .current_period_end;
  if (typeof root === 'number') return root;
  const firstItem = sub.items?.data?.[0] as
    | (StripeNS.SubscriptionItem & { current_period_end?: number })
    | undefined;
  return firstItem?.current_period_end;
}

function priceIdFor(planId: CheckoutablePlanId): string {
  const id = getStripePriceIdFor(planId);
  if (!id) {
    throw new BillingProviderError('checkout_plan_invalid', PROVIDER, { planId });
  }
  return id;
}

function statusFromStripe(s: StripeNS.Subscription.Status): NormalizedStatus {
  switch (s) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'paused':
      return 'past_due'; // v1: we don't pause subs ourselves; map defensively
    case 'unpaid':
      return 'past_due'; // Stripe's auto-retry budget exhausted; entitlement-wise the same
                         // dunning state as `past_due` (M0 PR9 mapping table).
    case 'incomplete':
      return 'none'; // pending first payment; no access granted yet
    case 'incomplete_expired':
      return 'none'; // initial payment never succeeded → no subscription ever existed
                     // (M0 PR9 mapping table — `none`, not `cancelled`).
    case 'canceled':
      return 'cancelled';
    default:
      return 'none';
  }
}

// Helper: load the tenant's Stripe row. For methods that require an active
// subscription (`changeSubscription`, `cancelSubscription`, etc.) throws
// `no_active_account` when absent. `getSubscription` calls a softer version
// inline because it returns `null` for missing rows.
async function loadStripeRow(tenantId: string): Promise<TenantBillingAccount> {
  const row = await AppDataSource.getRepository(TenantBillingAccount).findOne({
    where: { tenantId, provider: PROVIDER },
  });
  if (!row || !row.subscriptionId) {
    throw new BillingProviderError('no_active_account', PROVIDER, { tenantId });
  }
  return row;
}

export class StripeBillingProvider implements BillingProvider {
  readonly name = PROVIDER;
  readonly supportsWebhooks = true;

  async createCustomer(input: {
    tenantId: string;
    email: string;
    name: string;
  }): Promise<{ customerId: string }> {
    const stripe = getStripeClient();

    // Search-then-create — durable recovery across the Stripe idempotency-key
    // TTL (24h). Returns the first hit on tenantId; concurrent races may
    // produce an orphan customer (accepted v1 scope cut).
    const found = await stripe.customers.search({
      query: `metadata['tenantId']:'${input.tenantId}'`,
      limit: 1,
    });
    if (found.data.length > 0) {
      return { customerId: found.data[0].id };
    }

    // PR5 integration point: when creating the Stripe Customer for the
    // first time, look up any locally-stored VAT ID on the tenant's
    // billing row and pass it through as `tax_id_data`. This is how a
    // pre-set VAT ID (stored via `PUT /billing/vat-id` BEFORE the first
    // checkout) flows into Stripe Tax. If `vatId` is null we omit the
    // field entirely; Stripe Checkout's `tax_id_collection` (set in PR6)
    // will prompt for one during the session.
    const localRow = await AppDataSource.getRepository(TenantBillingAccount).findOne({
      where: { tenantId: input.tenantId },
    });
    const vatId = localRow?.vatId ?? null;

    const customer = await stripe.customers.create({
      email: input.email,
      name: input.name,
      metadata: { tenantId: input.tenantId },
      ...(vatId
        ? { tax_id_data: [{ type: 'eu_vat', value: vatId }] }
        : {}),
    });
    return { customerId: customer.id };
  }

  async createCheckoutSession(input: {
    tenantId: string;
    planId: CheckoutablePlanId;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string }> {
    const stripe = getStripeClient();

    // Wrap the read-then-create critical section in a transaction with a
    // per-tenant Postgres advisory lock. Without this, two concurrent
    // re-subscribe attempts after a cancel can both pass the dup-check
    // (the existing Stripe TBA row is in `cancelled` state) and each
    // produce a live Stripe Checkout — completing both would create two
    // paid subscriptions for the same tenant. `pg_try_advisory_xact_lock`
    // auto-releases at tx commit/rollback, and the tx wrapper also
    // unwinds the reservation INSERT cleanly if Stripe throws.
    //
    // Codex review caveat (concurrent-checkout race, audit follow-up):
    // tx-held DB connection across the Stripe network call (typical
    // ~500ms). Acceptable because the lock guarantees at most one such
    // hold per tenant at a time, so pool exhaustion is bounded by
    // distinct concurrent tenants, not concurrent attempts.
    return AppDataSource.transaction(async (manager) => {
      const [lockRow] = (await manager.query(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)::int) AS locked`,
        [`checkout:${input.tenantId}`],
      )) as Array<{ locked: boolean }>;
      if (!lockRow?.locked) {
        throw new BillingProviderError('checkout_in_progress', PROVIDER, {
          tenantId: input.tenantId,
        });
      }

      const row = await manager.findOne(TenantBillingAccount, {
        where: { tenantId: input.tenantId, provider: PROVIDER },
      });
      if (!row || !row.customerId) {
        throw new BillingProviderError('no_active_account', PROVIDER, {
          tenantId: input.tenantId,
        });
      }

      // Trial-reservation guard (codex round 7 item 1 + audit gap #2 fix).
      // Only Pro is trial-eligible. The primary-key unique constraint on
      // `chatbot_tenant_trial_reservations.tenant_id` would also serialise
      // concurrent Pro checkouts on its own, but with the advisory lock
      // in place this INSERT now runs against a quiescent table — the
      // reservation guard's purpose narrows to "has this tenant *ever*
      // consumed a trial," and serialisation falls to the lock.
      //
      // Why this and not `stripe.subscriptions.list`: the Stripe API does
      // not see in-flight Checkout sessions, so the old guard couldn't
      // tell whether a trial was about to be granted via a parallel
      // checkout. The reservation row is the canonical record.
      //
      // Audit-gap-#2 wrinkle: an unclaimed reservation must be releasable
      // on checkout abandonment (M0 spec line 532). The
      // `checkout.session.expired` webhook handler unwinds the
      // reservation; until that fires the row counts as "in flight" and
      // blocks a re-attempt. Stripe expires sessions after 24h, and the
      // customer should not be able to spin up a fresh trial within that
      // window by hammering the button.
      let allowTrial = false;
      if (input.planId === 'pro') {
        const reserved: Array<{ tenant_id: string }> = await manager.query(
          `INSERT INTO chatbot_tenant_trial_reservations (tenant_id)
           VALUES ($1)
           ON CONFLICT (tenant_id) DO NOTHING
           RETURNING tenant_id`,
          [input.tenantId],
        );
        allowTrial = reserved.length > 0;
      }

      const session: StripeNS.Checkout.Session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: row.customerId,
        // Session-level metadata: the `checkout.session.completed` and
        // `checkout.session.expired` webhook handlers read `tenantId` to
        // resolve the owner without trusting Customer metadata (which can
        // drift if edited in the dashboard).
        metadata: { tenantId: input.tenantId },
        line_items: [{ price: priceIdFor(input.planId), quantity: 1 }],
        payment_method_types: ['card', 'bancontact', 'ideal', 'sepa_debit'],
        // Force payment-method capture during trial — Stripe will cancel
        // the subscription if the customer never provides a payment method
        // by trial-end.
        payment_method_collection: 'always',
        subscription_data: {
          // Subscription-level metadata: read by `customer.subscription.*`
          // webhook handlers as the authoritative tenant resolution channel.
          metadata: { tenantId: input.tenantId },
          // `trial_period_days` is OMITTED entirely (not set to 0) for
          // non-trial plans — Stripe rejects `0` as invalid.
          ...(allowTrial
            ? {
                trial_period_days: 14,
                trial_settings: {
                  end_behavior: {
                    missing_payment_method: 'cancel',
                  },
                },
              }
            : {}),
        },
        automatic_tax: { enabled: true },
        tax_id_collection: { enabled: true },
        // `customer_update` is required in subscription mode when `customer`
        // is pre-set on the session and we want Stripe Tax to derive
        // address from the customer at checkout.
        customer_update: { address: 'auto', name: 'auto' },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      });

      // If Stripe threw above, the tx rolls back and the (unclaimed)
      // reservation INSERT unwinds automatically — no manual DELETE
      // needed any more.

      if (!session.url) {
        // Same recovery — throwing aborts the tx, which also undoes the
        // reservation INSERT.
        throw new BillingProviderError('checkout_session_no_url', PROVIDER);
      }

      // Stamp the reservation with the session id so the `checkout.session.
      // expired` handler can scope its deletion (a stale expired event must
      // not nuke a newer pending row for the same tenant).
      if (allowTrial) {
        await manager.query(
          `UPDATE chatbot_tenant_trial_reservations
           SET checkout_session_id = $1
           WHERE tenant_id = $2 AND subscription_id IS NULL`,
          [session.id, input.tenantId],
        );
      }

      return { url: session.url };
    });
  }

  async createPortalSession(input: {
    tenantId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const stripe = getStripeClient();

    const row = await AppDataSource.getRepository(TenantBillingAccount).findOne({
      where: { tenantId: input.tenantId, provider: PROVIDER },
    });
    if (!row || !row.customerId) {
      throw new BillingProviderError('no_stripe_subscription', PROVIDER, {
        tenantId: input.tenantId,
      });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: row.customerId,
      return_url: input.returnUrl,
    });
    return { url: session.url };
  }

  async changeSubscription(input: {
    tenantId: string;
    newPlanId: CheckoutablePlanId;
  }): Promise<void> {
    const stripe = getStripeClient();
    const row = await loadStripeRow(input.tenantId);

    const currentRank = rank(row.currentPlanId);
    const newRank = rank(input.newPlanId);
    if (currentRank === newRank) {
      throw new BillingProviderError('no_op_plan_change', PROVIDER);
    }

    // Authoritative remote check — defeats local-vs-webhook race (two
    // downgrade clicks before the first webhook lands). Stripe's
    // `sub.schedule` is the source of truth for "is there a pending change."
    const sub = await stripe.subscriptions.retrieve(row.subscriptionId!, {
      expand: ['schedule'],
    });
    if (sub.schedule) {
      throw new BillingProviderError('pending_change_exists', PROVIDER);
    }

    if (sub.items.data.length !== 1) {
      throw new BillingProviderError('subscription_shape_unexpected', PROVIDER, {
        itemCount: sub.items.data.length,
      });
    }

    if (newRank > currentRank) {
      // Upgrade — immediate, prorated.
      const itemId = sub.items.data[0].id;
      await stripe.subscriptions.update(row.subscriptionId!, {
        items: [{ id: itemId, price: priceIdFor(input.newPlanId) }],
        proration_behavior: 'always_invoice',
      });
      return;
    }

    // Downgrade — Subscription Schedule with two phases.
    const currentPriceId = sub.items.data[0].price.id;
    // `current_period_end` lives on the subscription root pre-dahlia, on
    // each Subscription Item from `2026-04-22.dahlia` onward. The helper
    // hides the shift so we keep working regardless of the account's
    // pinned Stripe API version.
    const currentPeriodEnd = readCurrentPeriodEnd(sub);
    if (!currentPeriodEnd) {
      throw new BillingProviderError('subscription_shape_unexpected', PROVIDER, {
        reason: 'missing_current_period_end',
      });
    }

    const schedule = await stripe.subscriptionSchedules.create({
      from_subscription: row.subscriptionId!,
    });
    await stripe.subscriptionSchedules.update(schedule.id, {
      phases: [
        {
          items: [{ price: currentPriceId, quantity: 1 }],
          start_date: schedule.phases[0].start_date,
          end_date: currentPeriodEnd,
          proration_behavior: 'none',
        },
        {
          items: [{ price: priceIdFor(input.newPlanId), quantity: 1 }],
          start_date: currentPeriodEnd,
          proration_behavior: 'none',
        },
      ],
      end_behavior: 'release',
    });
  }

  async cancelSubscription(input: {
    tenantId: string;
    atPeriodEnd: true;
  }): Promise<void> {
    const stripe = getStripeClient();
    const row = await loadStripeRow(input.tenantId);
    await stripe.subscriptions.update(row.subscriptionId!, {
      cancel_at_period_end: true,
    });
  }

  async undoCancel(input: { tenantId: string }): Promise<void> {
    const stripe = getStripeClient();
    const row = await loadStripeRow(input.tenantId);
    await stripe.subscriptions.update(row.subscriptionId!, {
      cancel_at_period_end: false,
    });
  }

  async undoPendingChange(input: { tenantId: string }): Promise<void> {
    const stripe = getStripeClient();
    const row = await loadStripeRow(input.tenantId);
    const stripeMeta = (row.rawProviderData ?? {}) as { stripe?: { scheduleId?: string } };
    const scheduleId = stripeMeta.stripe?.scheduleId;
    if (!scheduleId) {
      throw new BillingProviderError('no_pending_change', PROVIDER);
    }
    await stripe.subscriptionSchedules.release(scheduleId);
  }

  async getSubscription(input: { tenantId: string }): Promise<NormalizedSubscription | null> {
    const stripe = getStripeClient();
    const row = await AppDataSource.getRepository(TenantBillingAccount).findOne({
      where: { tenantId: input.tenantId, provider: PROVIDER },
    });
    if (!row || !row.subscriptionId || !row.customerId) return null;
    const sub = await stripe.subscriptions.retrieve(row.subscriptionId, {
      expand: ['schedule'],
    });
    return this.toNormalizedSubscription(sub, row.customerId);
  }

  toNormalizedSubscription(
    sub: StripeNS.Subscription,
    customerId: string,
  ): NormalizedSubscription {
    const priceId = sub.items.data[0]?.price.id ?? null;
    // PR9 contract: `toNormalizedSubscription` is a pure normalizer used by
    // both `getSubscription` (read API) and `normalizeWebhookEvent`. For
    // unknown price IDs we fall back to 'free' HERE for type-shape reasons,
    // but the WEBHOOK HANDLER in `events.ts` explicitly detects unknown
    // raw price IDs (via `planIdForStripePriceId(rawPriceId) === null`)
    // and refuses to mutate local state. So the fallback below NEVER
    // causes a silent downgrade in the webhook path — the handler returns
    // outcome='unknown_price' before reaching any plan-id-driven write.
    const planId = planIdForStripePriceId(priceId) ?? 'free';
    const status = statusFromStripe(sub.status);

    const schedule =
      sub.schedule && typeof sub.schedule !== 'string' ? sub.schedule : null;
    const phase2 = schedule?.phases[1];
    let pendingPlanId: InternalPlanId | null = null;
    let pendingPlanEffectiveAt: Date | null = null;
    if (phase2) {
      const phase2PriceItem = phase2.items[0];
      // phase items' `price` may be a string id or an expanded object.
      const phase2PriceId =
        typeof phase2PriceItem?.price === 'string'
          ? phase2PriceItem.price
          : (phase2PriceItem?.price as StripeNS.Price | undefined)?.id ?? null;
      pendingPlanId = planIdForStripePriceId(phase2PriceId);
      pendingPlanEffectiveAt = phase2.start_date
        ? new Date(phase2.start_date * 1000)
        : null;
    }

    // dahlia API moves current_period_end to the Subscription Item.
    // The helper covers both shapes so normalized events fire correctly
    // on both API versions.
    const currentPeriodEnd = readCurrentPeriodEnd(sub);

    return {
      customerId,
      subscriptionId: sub.id,
      status,
      currentPlanId: planId,
      currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : null,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      pendingPlanId,
      pendingPlanEffectiveAt,
      trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    };
  }

  async verifyWebhook(input: {
    rawBody: Buffer;
    headers: Record<string, string>;
  }): Promise<StripeNS.Event> {
    const stripe = getStripeClient();
    // Express normalizes header names to lowercase.
    const sig = input.headers['stripe-signature'];
    if (!sig) {
      throw new BillingProviderError('webhook_signature_missing', PROVIDER);
    }
    if (!config.billing.stripe.webhookSecret) {
      throw new BillingProviderError('webhook_secret_not_configured', PROVIDER);
    }
    return stripe.webhooks.constructEvent(
      input.rawBody,
      sig,
      config.billing.stripe.webhookSecret,
    );
  }

  normalizeWebhookEvent(providerEvent: unknown): NormalizedEvent | null {
    const event = providerEvent as StripeNS.Event;
    const occurredAt = new Date(event.created * 1000);

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as StripeNS.Subscription;
        const customerId =
          typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
        const normalized = this.toNormalizedSubscription(sub, customerId);
        const typeMap = {
          'customer.subscription.created': 'subscription.created',
          'customer.subscription.updated': 'subscription.updated',
          'customer.subscription.deleted': 'subscription.deleted',
        } as const;
        return {
          providerEventId: event.id,
          type: typeMap[event.type],
          customerId,
          subscriptionId: sub.id,
          subscription: normalized,
          occurredAt,
          raw: event,
        };
      }
      case 'customer.subscription.trial_will_end': {
        // PR9: logging-only handler. No state mutation. Normalize without
        // re-fetching schedule/price info (it's not consulted downstream).
        const sub = event.data.object as StripeNS.Subscription;
        const customerId =
          typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
        return {
          providerEventId: event.id,
          type: 'subscription.trial_will_end',
          customerId,
          subscriptionId: sub.id,
          subscription: null,
          occurredAt,
          raw: event,
        };
      }
      case 'checkout.session.completed': {
        // PR9: bookkeeping only — persists customer_id / subscription_id
        // on the TBA row. Tier change is driven by the subsequent
        // customer.subscription.created event.
        const session = event.data.object as StripeNS.Checkout.Session;
        const customerId =
          typeof session.customer === 'string'
            ? session.customer
            : session.customer?.id ?? '';
        const subscriptionId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id;
        return {
          providerEventId: event.id,
          type: 'checkout.session.completed',
          customerId,
          subscriptionId: subscriptionId ?? undefined,
          sessionId: session.id,
          subscription: null,
          occurredAt,
          raw: event,
        };
      }
      case 'checkout.session.expired': {
        // Audit gap #2 fix: Stripe fires this 24h after an abandoned
        // checkout. We release the (unclaimed) trial reservation so the
        // tenant can retry with a fresh trial — M0 spec line 532.
        const session = event.data.object as StripeNS.Checkout.Session;
        const customerId =
          typeof session.customer === 'string'
            ? session.customer
            : session.customer?.id ?? '';
        return {
          providerEventId: event.id,
          type: 'checkout.session.expired',
          customerId,
          sessionId: session.id,
          subscription: null,
          occurredAt,
          raw: event,
        };
      }
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const invoice = event.data.object as StripeNS.Invoice;
        const customerId =
          typeof invoice.customer === 'string'
            ? invoice.customer
            : invoice.customer?.id ?? '';
        const subId =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          typeof (invoice as any).subscription === 'string'
            ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ((invoice as any).subscription as string)
            : // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ((invoice as any).subscription as { id?: string } | null | undefined)?.id;
        return {
          providerEventId: event.id,
          type: event.type === 'invoice.paid' ? 'invoice.paid' : 'invoice.payment_failed',
          customerId,
          subscriptionId: subId ?? undefined,
          subscription: null,
          invoiceUrl: invoice.hosted_invoice_url ?? undefined,
          occurredAt,
          raw: event,
        };
      }
      case 'charge.refunded': {
        const charge = event.data.object as StripeNS.Charge;
        const customerId =
          typeof charge.customer === 'string'
            ? charge.customer
            : charge.customer?.id ?? '';
        return {
          providerEventId: event.id,
          type: 'refund.recorded',
          customerId,
          subscriptionId: undefined,
          subscription: null,
          occurredAt,
          raw: event,
        };
      }
      default:
        return null;
    }
  }
}
