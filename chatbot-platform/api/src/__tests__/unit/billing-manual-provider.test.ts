/**
 * ManualBillingProvider + BillingProviderError — pure unit tests.
 *
 * Plan: .scratch/plan-billing.md § Implementation outline step 14 → Unit.
 */

import { describe, it, expect } from 'vitest';
import { ManualBillingProvider } from '../../billing/providers/manual';
import { BillingProviderError } from '../../billing/types';

function makeProvider() {
  return new ManualBillingProvider();
}

describe('ManualBillingProvider — no-op semantics', () => {
  it('declares its identity correctly', () => {
    const p = makeProvider();
    expect(p.name).toBe('manual');
    expect(p.supportsWebhooks).toBe(false);
  });

  it('throws manual_provider_sales_managed for every mutation method', async () => {
    const p = makeProvider();
    const args = { tenantId: 't-1' };

    await expect(
      p.createCustomer({ tenantId: 't-1', email: 'a@b.com', name: 'A' }),
    ).rejects.toMatchObject({
      code: 'manual_provider_sales_managed',
      providerName: 'manual',
    });

    await expect(
      p.createCheckoutSession({
        tenantId: 't-1',
        planId: 'pro',
        successUrl: 'https://example.com/s',
        cancelUrl: 'https://example.com/c',
      }),
    ).rejects.toMatchObject({ code: 'manual_provider_sales_managed' });

    await expect(
      p.createPortalSession({ tenantId: 't-1', returnUrl: 'https://example.com' }),
    ).rejects.toMatchObject({ code: 'manual_provider_sales_managed' });

    await expect(
      p.changeSubscription({ tenantId: 't-1', newPlanId: 'pro' }),
    ).rejects.toMatchObject({ code: 'manual_provider_sales_managed' });

    await expect(
      p.cancelSubscription({ tenantId: 't-1', atPeriodEnd: true }),
    ).rejects.toMatchObject({ code: 'manual_provider_sales_managed' });

    await expect(p.undoCancel(args)).rejects.toMatchObject({
      code: 'manual_provider_sales_managed',
    });
    await expect(p.undoPendingChange(args)).rejects.toMatchObject({
      code: 'manual_provider_sales_managed',
    });
  });

  it('getSubscription returns null instead of throwing — read-only is safe', async () => {
    const p = makeProvider();
    await expect(p.getSubscription({ tenantId: 't-1' })).resolves.toBeNull();
  });

  it('verifyWebhook and normalizeWebhookEvent throw webhooks_not_supported', async () => {
    const p = makeProvider();
    await expect(
      p.verifyWebhook({ rawBody: Buffer.from(''), headers: {} }),
    ).rejects.toMatchObject({ code: 'webhooks_not_supported' });
    expect(() => p.normalizeWebhookEvent({})).toThrow(BillingProviderError);
  });
});

describe('BillingProviderError', () => {
  it('captures (code, providerName, meta) and sets name', () => {
    const err = new BillingProviderError('past_due_block', 'stripe', { tenantId: 't-1' });
    expect(err.code).toBe('past_due_block');
    expect(err.providerName).toBe('stripe');
    expect(err.meta).toEqual({ tenantId: 't-1' });
    expect(err.name).toBe('BillingProviderError');
    expect(err.message).toContain('stripe');
    expect(err.message).toContain('past_due_block');
  });

  it('meta is optional', () => {
    const err = new BillingProviderError('no_op_plan_change', 'stripe');
    expect(err.meta).toBeUndefined();
  });

  it('subclasses Error so instanceof + stack traces work', () => {
    const err = new BillingProviderError('webhooks_not_supported', 'manual');
    expect(err).toBeInstanceOf(Error);
    expect(err.stack).toBeTruthy();
  });
});
