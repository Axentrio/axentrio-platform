/**
 * Billing types — the load-bearing provider abstraction.
 * Plan: .scratch/plan-billing.md § BillingProvider interface.
 */

export type NormalizedStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'none';
export type InternalPlanId = 'free' | 'pro' | 'premium' | 'enterprise';

/**
 * Plans the user can self-serve into via checkout / change-plan.
 * 'free' is reachable only via cancellation; 'enterprise' is reachable
 * only via the super-admin manual override.
 */
export type CheckoutablePlanId = Extract<InternalPlanId, 'pro' | 'premium'>;

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
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'refund.recorded';

export interface NormalizedEvent {
  providerEventId: string;
  type: NormalizedEventType;
  customerId: string;
  subscriptionId?: string;
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
 */
export interface Entitlements {
  planId: InternalPlanId;
  limits: {
    agents: number | null;
    sessions: number | null;
    dailyLlmCalls: number | null;
    channels: number | null;
  };
  features: {
    fileUpload: boolean;
    handoff: boolean;
    customBranding: boolean;
    byoLlmKey: boolean;
  };
  support: 'community' | 'email' | 'priority' | 'sla';
}

/**
 * Plan catalog entry. `rank` drives upgrade/downgrade direction choice in
 * `StripeBillingProvider.changeSubscription`.
 */
export interface PlanDefinition {
  id: InternalPlanId;
  displayName: string;
  rank: number;
  priceUsdMonthly: number | null; // null = sales-led
  limits: Entitlements['limits'];
  features: Entitlements['features'];
  support: Entitlements['support'];
  /**
   * Provider-side price IDs, keyed by provider name then currency.
   * `null` for plans not available through that provider (free → no Stripe price;
   * enterprise → sales-led, no public price).
   */
  providerPriceIds: {
    stripe: {
      usd: string | null;
    };
  };
}
