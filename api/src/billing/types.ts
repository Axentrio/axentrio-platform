/**
 * Billing types — the load-bearing provider abstraction.
 * Plan: .scratch/plan-billing.md § BillingProvider interface.
 */

export type NormalizedStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'none';
export type InternalPlanId = 'free' | 'essential' | 'pro' | 'enterprise';

/**
 * Plans the user can self-serve into via checkout / change-plan.
 * 'free' is reachable only via cancellation (internal-only terminal state).
 * Enterprise is also reachable sales-led via super-admin manual override
 * (POST /admin/tenants/:id/set-enterprise) for negotiated deals.
 */
export type CheckoutablePlanId = Extract<InternalPlanId, 'essential' | 'pro' | 'enterprise'>;

export interface NormalizedSubscription {
  customerId: string;
  subscriptionId: string | null;
  status: NormalizedStatus;
  currentPlanId: InternalPlanId;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  pendingPlanId: InternalPlanId | null;
  pendingPlanEffectiveAt: Date | null;
  trialEnd: Date | null;
}

export type NormalizedEventType =
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.deleted'
  | 'subscription.trial_will_end'
  | 'checkout.session.completed'
  | 'checkout.session.expired'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'refund.recorded';

export interface NormalizedEvent {
  providerEventId: string;
  type: NormalizedEventType;
  customerId: string;
  subscriptionId?: string;
  /**
   * Stripe Checkout session id. Populated only for `checkout.session.*`
   * events. Used by the trial-reservation expired-cleanup handler to scope
   * the DELETE so a stale expired event doesn't nuke a newer row.
   */
  sessionId?: string;
  subscription: NormalizedSubscription | null;
  invoiceUrl?: string;
  occurredAt: Date;
  raw: unknown;
}

/**
 * Provider interface. All mutating/query methods take only `tenantId`; the
 * provider is responsible for reading its own `tenant_billing_accounts` row
 * via (provider=this.name, tenant_id). Exception: `createCustomer` is a
 * creation method and does not read a pre-existing row.
 */
export interface BillingProvider {
  name: string;
  supportsWebhooks: boolean;

  createCustomer(input: {
    tenantId: string;
    email: string;
    name: string;
  }): Promise<{ customerId: string }>;

  createCheckoutSession(input: {
    tenantId: string;
    planId: CheckoutablePlanId;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string }>;

  createPortalSession(input: {
    tenantId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;

  changeSubscription(input: {
    tenantId: string;
    newPlanId: CheckoutablePlanId;
  }): Promise<void>;

  cancelSubscription(input: {
    tenantId: string;
    atPeriodEnd: true;
  }): Promise<void>;

  undoCancel(input: { tenantId: string }): Promise<void>;
  undoPendingChange(input: { tenantId: string }): Promise<void>;
  getSubscription(input: { tenantId: string }): Promise<NormalizedSubscription | null>;

  verifyWebhook(input: {
    rawBody: Buffer;
    headers: Record<string, string>;
  }): Promise<unknown>;
  normalizeWebhookEvent(providerEvent: unknown): NormalizedEvent | null;
}

export class BillingProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly providerName: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(`[${providerName}] ${code}`);
    this.name = 'BillingProviderError';
  }
}

/**
 * Entitlement shape resolved per tenant. Numeric limits use `null` for
 * "unlimited" so call sites can distinguish "no cap" from "zero allowed."
 *
 * Feature flags reshaped per M0 PR2 (subscription epic):
 *   - `customBranding` → split into `hideWidgetAttribution` (Pro+ removes
 *     "Powered by Axentrio" watermark) and `customWidgetAppearance` (color/
 *     title/avatar config — all paid tiers).
 *   - New flags: `unifiedInbox`, `bookings`, `calendarSync`,
 *     `leadCapture`, `platformAssistant`, `crm`. `handoff` retained.
 *   - Dropped: `fileUpload` (implicit in all paid tiers), `byoLlmKey` (unused),
 *     `limits.channels` (channels are per-tier-by-feature, not numeric).
 *
 * Support tier `'community'` removed because `free` is now the internal-only
 * cancellation sink, never a marketed plan. `'sla'` removed because
 * Enterprise support is sold per-deal alongside the sales-led contract.
 */
/**
 * Canonical key set for boolean feature flags — the only keys a per-tenant
 * feature override may target. Derived from the entitlement shape so the
 * catalog, overrides, and gates can never disagree on what a "feature" is.
 */
export type FeatureKey = keyof Entitlements['features'];

export interface Entitlements {
  planId: InternalPlanId;
  /**
   * D2 signal: false when `tier === 'free'` OR `Tenant.status !== 'active'`.
   * When false, every boolean feature below is also forced false, and the
   * module resolver activates nothing (feature- or enablement-gated alike).
   */
  billable: boolean;
  limits: {
    /** Human support-agent seats (rows in `support_agents`). NOT the AI chatbot count. */
    agents: number | null;
    /**
     * AI chatbots (rows in `chatbot_bots`, anchor + extras combined). Per the
     * epic verbatim: Essential 1, Pro 1, Enterprise 2. Paused bots still count
     * toward the cap; only soft-delete frees a slot. (Multi-bot integration —
     * docs/multi-bot-handoff.md § Action items.)
     */
    bots: number | null;
    sessions: number | null;
    dailyLlmCalls: number | null;
  };
  features: {
    unifiedInbox: boolean;
    bookings: boolean;
    calendarSync: boolean;
    leadCapture: boolean;
    platformAssistant: boolean;
    crm: boolean;
    hideWidgetAttribution: boolean;
    customWidgetAppearance: boolean;
    handoff: boolean;
    /** File upload to KnowledgeBase. False on `free` cancellation sink; true on all paid tiers. */
    fileUpload: boolean;
  };
  support: 'none' | 'email' | 'priority';
}

/**
 * Plan catalog entry. `rank` drives upgrade/downgrade direction choice in
 * `StripeBillingProvider.changeSubscription`.
 *
 * `isSelfServeCheckoutable` is the canonical predicate for "show this plan on
 * upgrade UIs." Replaces ambiguous rank/price filtering — `free` (cancellation
 * sink) and `enterprise` (sales-led) both have rank > 0 and one has a price,
 * but neither should appear in a self-serve upgrade list.
 *
 * Price IDs are NOT stored on the plan definition — they are resolved at call
 * time via `getStripePriceIdFor(planId)` so the catalog stays decoupled from
 * env config (cleaner tests, no module-load ordering issues).
 */
export interface PlanDefinition {
  id: InternalPlanId;
  displayName: string;
  rank: number;
  priceEurMonthly: number | null; // null = no chargeable price (cancellation sink or sales-led)
  isSelfServeCheckoutable: boolean;
  limits: Entitlements['limits'];
  features: Entitlements['features'];
  support: Entitlements['support'];
}
