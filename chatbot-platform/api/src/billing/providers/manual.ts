/**
 * ManualBillingProvider — used for Enterprise (sales-managed) tenants and
 * for the reverse-trial period before a Stripe subscription is created.
 *
 * All subscription-mutating methods throw `BillingProviderError`. The
 * provider deliberately implements the full `BillingProvider` interface
 * (rather than being a special-case bypass) to validate the abstraction —
 * if Manual plugs in cleanly, real providers (Paddle, LS, Shopify) will too.
 *
 * Plan: .scratch/plan-billing.md § Enterprise flow.
 */

import {
  BillingProvider,
  BillingProviderError,
  CheckoutablePlanId,
  NormalizedEvent,
  NormalizedSubscription,
} from '../types';

const ERR_CODE = 'manual_provider_sales_managed';

export class ManualBillingProvider implements BillingProvider {
  readonly name = 'manual';
  readonly supportsWebhooks = false;

  async createCustomer(_input: {
    tenantId: string;
    email: string;
    name: string;
  }): Promise<{ customerId: string }> {
    throw new BillingProviderError(ERR_CODE, this.name);
  }

  async createCheckoutSession(_input: {
    tenantId: string;
    planId: CheckoutablePlanId;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string }> {
    throw new BillingProviderError(ERR_CODE, this.name);
  }

  async createPortalSession(_input: {
    tenantId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    throw new BillingProviderError(ERR_CODE, this.name);
  }

  async changeSubscription(_input: {
    tenantId: string;
    newPlanId: CheckoutablePlanId;
  }): Promise<void> {
    throw new BillingProviderError(ERR_CODE, this.name);
  }

  async cancelSubscription(_input: {
    tenantId: string;
    atPeriodEnd: true;
  }): Promise<void> {
    throw new BillingProviderError(ERR_CODE, this.name);
  }

  async undoCancel(_input: { tenantId: string }): Promise<void> {
    throw new BillingProviderError(ERR_CODE, this.name);
  }

  async undoPendingChange(_input: { tenantId: string }): Promise<void> {
    throw new BillingProviderError(ERR_CODE, this.name);
  }

  async getSubscription(_input: { tenantId: string }): Promise<NormalizedSubscription | null> {
    return null;
  }

  async verifyWebhook(_input: {
    rawBody: Buffer;
    headers: Record<string, string>;
  }): Promise<unknown> {
    throw new BillingProviderError('webhooks_not_supported', this.name);
  }

  normalizeWebhookEvent(_providerEvent: unknown): NormalizedEvent | null {
    throw new BillingProviderError('webhooks_not_supported', this.name);
  }
}
