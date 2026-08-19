import { describe, expect, it } from 'vitest';
import { mapStripeInvoiceToBillitOrder, shouldSkipZeroAmountInvoice } from '../../billing/legal-invoice/map-stripe-to-billit';
import type { BillingValidationResult, StripeInvoiceLike } from '../../billing/legal-invoice/types';

const VALID: BillingValidationResult = {
  ok: true,
  reasons: [],
  peppolRequired: true,
  country: 'BE',
  vatNumber: 'BE0400378485',
  companyName: 'Example BV',
  email: 'billing@example.com',
  address: {
    street: 'Example Street',
    streetNumber: '1',
    postalCode: '2000',
    city: 'Antwerp',
    country: 'BE',
  },
};

function invoice(overrides: Partial<StripeInvoiceLike> = {}): StripeInvoiceLike {
  return {
    id: 'in_test_1',
    amount_paid: 9074,
    total: 9074,
    total_excluding_tax: 7499,
    currency: 'eur',
    created: Date.UTC(2026, 4, 1) / 1000,
    period_start: Date.UTC(2026, 4, 1) / 1000,
    period_end: Date.UTC(2026, 4, 31) / 1000,
    status_transitions: { paid_at: Date.UTC(2026, 4, 1) / 1000 },
    customer: 'cus_test',
    lines: {
      data: [
        {
          description: 'Axentrio Pro Subscription',
          quantity: 1,
          amount: 9074,
          amount_excluding_tax: 7499,
          taxes: [{ amount: 1575, tax_rate_details: { percentage_decimal: '21.0' } }],
        },
      ],
    },
    ...overrides,
  };
}

describe('shouldSkipZeroAmountInvoice', () => {
  it('skips a €0 trial invoice', () => {
    expect(shouldSkipZeroAmountInvoice(invoice({ amount_paid: 0, total: 0 }))).toBe(true);
  });

  it('does not skip a paid invoice', () => {
    expect(shouldSkipZeroAmountInvoice(invoice())).toBe(false);
  });
});

describe('mapStripeInvoiceToBillitOrder', () => {
  it('maps Stripe exclusive amounts and marks the Billit invoice paid', () => {
    const order = mapStripeInvoiceToBillitOrder({
      invoice: invoice(),
      validation: VALID,
      orderNumber: '2026-0001',
      tenantId: 'ten_1',
    });
    expect(order.OrderType).toBe('Invoice');
    expect(order.Paid).toBe(true);
    expect(order.Currency).toBe('EUR');
    expect(order.ExternalProviderID).toBe('in_test_1');
    expect(order.Customer.VATNumber).toBe('BE0400378485');
    expect(order.OrderLines).toHaveLength(1);
    expect(order.OrderLines[0].UnitPriceExcl).toBe(74.99);
    expect(order.OrderLines[0].VATPercentage).toBe(21);
    expect(order.OrderTitle).toBe('May 2026');
  });

  it('maps a negative proration as a negative unit price', () => {
    const order = mapStripeInvoiceToBillitOrder({
      invoice: invoice({
        lines: {
          data: [
            {
              description: 'Unused time on Pro',
              quantity: 1,
              amount: -1210,
              amount_excluding_tax: -1000,
              taxes: [{ amount: -210, tax_rate_details: { percentage_decimal: '21.0' } }],
            },
            {
              description: 'Remaining time on Enterprise',
              quantity: 1,
              amount: 18150,
              amount_excluding_tax: 15000,
              taxes: [{ amount: 3150, tax_rate_details: { percentage_decimal: '21.0' } }],
            },
          ],
        },
      }),
      validation: VALID,
      orderNumber: '2026-0002',
      tenantId: 'ten_1',
    });
    expect(order.OrderLines[0].Quantity).toBe(1);
    expect(order.OrderLines[0].UnitPriceExcl).toBe(-10);
    expect(order.OrderLines[1].UnitPriceExcl).toBe(150);
  });
});
