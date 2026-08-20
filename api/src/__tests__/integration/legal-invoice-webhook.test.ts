import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { LegalInvoice } from '../../database/entities/LegalInvoice';
import { StripeBillingProvider, setStripeClient } from '../../billing/providers/stripe';
import { registerBillingProvider } from '../../billing/provider-registry';
import { setBillitClient } from '../../billing/legal-invoice/billit-client';
import { createTestTenant, createTestBillingAccount } from '../helpers/factories';

beforeAll(() => {
  registerBillingProvider(new StripeBillingProvider());
});

afterEach(() => {
  setStripeClient(null);
  setBillitClient(null);
  vi.restoreAllMocks();
});

function paidInvoiceEvent(opts: { eventId: string; invoiceId: string; customerId: string; subscriptionId: string }) {
  return {
    id: opts.eventId,
    type: 'invoice.paid',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: opts.invoiceId,
        customer: opts.customerId,
        subscription: opts.subscriptionId,
        amount_paid: 9074,
        total: 9074,
        total_excluding_tax: 7499,
        currency: 'eur',
        hosted_invoice_url: 'https://stripe.example/i',
        status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
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
          has_more: false,
        },
      },
    },
  };
}

describe('POST /api/v1/webhooks/billing/stripe invoice.paid', () => {
  it('returns 200 and then creates a Legal Invoice without charging again', async () => {
    const tenant = await createTestTenant({
      officialBusinessName: 'Example BV',
      vatNumber: 'BE0400378485',
      vatVerified: true,
      invoiceEmail: 'billing@example.com',
      invoiceAddress: {
        street: 'Example Street',
        streetNumber: '1',
        postalCode: '2000',
        city: 'Antwerp',
        country: 'BE',
      },
    });
    await createTestBillingAccount(tenant.id, {
      provider: 'stripe',
      customerId: 'cus_paid_e2e',
      subscriptionId: 'sub_paid_e2e',
      status: 'active',
      currentPlanId: 'pro',
      isPrimary: true,
    });

    const event = paidInvoiceEvent({
      eventId: `evt_paid_${tenant.id.slice(0, 8)}`,
      invoiceId: `in_paid_${tenant.id.slice(0, 8)}`,
      customerId: 'cus_paid_e2e',
      subscriptionId: 'sub_paid_e2e',
    });
    const invoiceObj = event.data.object;

    setStripeClient({
      webhooks: { constructEvent: vi.fn(() => event) },
      invoices: {
        retrieve: vi.fn(async () => invoiceObj),
        listLineItems: vi.fn(),
      },
    } as never);
    setBillitClient({
      isConfigured: () => true,
      consumeNextNumber: vi.fn(async () => '2026-0200'),
      createOrder: vi.fn(async () => ({ orderId: '200', orderNumber: '2026-0200' })),
      sendOrders: vi.fn(async () => undefined),
      getOrder: vi.fn(async (id: string) => ({ orderId: id, orderNumber: '2026-0200', isSent: true })),
      lookupPeppol: vi.fn(async () => ({
        registered: true,
        documentTypes: ['BISv3Invoice', 'BISv3CreditNote'],
      })),
    });

    const res = await request(app)
      .post('/api/v1/webhooks/billing/stripe')
      .set('stripe-signature', 'sig_irrelevant')
      .set('Content-Type', 'application/json')
      .send(Buffer.from(JSON.stringify(event)));

    expect(res.status).toBe(200);

    await vi.waitFor(async () => {
      const row = await AppDataSource.getRepository(LegalInvoice).findOneBy({
        stripeInvoiceId: invoiceObj.id,
      });
      expect(row).toBeTruthy();
      expect(row!.invoiceStatus).toBe('sent');
      expect(row!.peppolStatus).toBe('sent');
      expect(row!.paymentStatus).toBe('paid');
    });
  });

  it('still returns 200 when Billit is down so Stripe does not retry the charge path', async () => {
    const tenant = await createTestTenant({
      officialBusinessName: 'Example BV',
      vatNumber: 'BE0400378485',
      vatVerified: true,
      invoiceEmail: 'billing@example.com',
      invoiceAddress: {
        street: 'Example Street',
        postalCode: '2000',
        city: 'Antwerp',
        country: 'BE',
      },
    });
    await createTestBillingAccount(tenant.id, {
      provider: 'stripe',
      customerId: 'cus_paid_fail',
      subscriptionId: 'sub_paid_fail',
      status: 'active',
      currentPlanId: 'pro',
      isPrimary: true,
    });
    const event = paidInvoiceEvent({
      eventId: `evt_fail_${tenant.id.slice(0, 8)}`,
      invoiceId: `in_fail_${tenant.id.slice(0, 8)}`,
      customerId: 'cus_paid_fail',
      subscriptionId: 'sub_paid_fail',
    });
    setStripeClient({
      webhooks: { constructEvent: vi.fn(() => event) },
      invoices: {
        retrieve: vi.fn(async () => event.data.object),
        listLineItems: vi.fn(),
      },
    } as never);
    setBillitClient({
      isConfigured: () => true,
      consumeNextNumber: vi.fn(async () => {
        throw new Error('billit down');
      }),
      createOrder: vi.fn(),
      sendOrders: vi.fn(),
      getOrder: vi.fn(),
      lookupPeppol: vi.fn(),
    });

    const res = await request(app)
      .post('/api/v1/webhooks/billing/stripe')
      .set('stripe-signature', 'sig_irrelevant')
      .set('Content-Type', 'application/json')
      .send(Buffer.from(JSON.stringify(event)));

    expect(res.status).toBe(200);

    await vi.waitFor(async () => {
      const row = await AppDataSource.getRepository(LegalInvoice).findOneBy({
        stripeInvoiceId: event.data.object.id,
      });
      expect(row).toBeTruthy();
      expect(row!.invoiceStatus).toBe('failed');
    });
  });
});

describe('POST /api/v1/webhooks/billing/stripe charge.dispute.closed', () => {
  it('returns 200 and then creates a Credit Note for a lost chargeback', async () => {
    const tenant = await createTestTenant({
      officialBusinessName: 'Example BV',
      vatNumber: 'BE0400378485',
      vatVerified: true,
      invoiceEmail: 'billing@example.com',
      invoiceAddress: {
        street: 'Example Street',
        streetNumber: '1',
        postalCode: '2000',
        city: 'Antwerp',
        country: 'BE',
      },
    });
    await createTestBillingAccount(tenant.id, {
      provider: 'stripe',
      customerId: 'cus_dispute',
      subscriptionId: 'sub_dispute',
      status: 'active',
      currentPlanId: 'pro',
      isPrimary: true,
    });
    const repo = AppDataSource.getRepository(LegalInvoice);
    await repo.save(
      repo.create({
        tenantId: tenant.id,
        documentKind: 'invoice',
        stripeInvoiceId: 'in_disputed',
        billitOrderId: '1',
        billitInvoiceNumber: '2026-0300',
        paymentStatus: 'paid',
        invoiceStatus: 'sent',
        peppolStatus: 'sent',
        peppolRequired: true,
        currency: 'EUR',
        amountExclCents: 7499,
        vatAmountCents: 1575,
        amountInclCents: 9074,
        reviewReasons: [],
        retryCount: 0,
      }),
    );

    const event = {
      id: `evt_dp_${tenant.id.slice(0, 8)}`,
      type: 'charge.dispute.closed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'dp_e2e',
          amount: 9074,
          charge: 'ch_e2e',
          status: 'lost',
        },
      },
    };

    setStripeClient({
      webhooks: { constructEvent: vi.fn(() => event) },
      charges: {
        retrieve: vi.fn(async () => ({
          id: 'ch_e2e',
          customer: 'cus_dispute',
          invoice: 'in_disputed',
        })),
      },
    } as never);
    setBillitClient({
      isConfigured: () => true,
      consumeNextNumber: vi.fn(async () => 'CN-2026-0300'),
      createOrder: vi.fn(async () => ({ orderId: '300', orderNumber: 'CN-2026-0300' })),
      sendOrders: vi.fn(async () => undefined),
      getOrder: vi.fn(async (id: string) => ({ orderId: id, orderNumber: 'CN-2026-0300', isSent: true })),
      lookupPeppol: vi.fn(async () => ({
        registered: true,
        documentTypes: ['BISv3Invoice', 'BISv3CreditNote'],
      })),
    });

    const res = await request(app)
      .post('/api/v1/webhooks/billing/stripe')
      .set('stripe-signature', 'sig_irrelevant')
      .set('Content-Type', 'application/json')
      .send(Buffer.from(JSON.stringify(event)));

    expect(res.status).toBe(200);

    await vi.waitFor(async () => {
      const credit = await repo.findOneBy({ stripeRefundId: 'dp_e2e' });
      expect(credit).toBeTruthy();
      expect(credit!.documentKind).toBe('credit_note');
      expect(credit!.invoiceStatus).toBe('sent');
      expect(credit!.peppolStatus).toBe('sent');
    });
    const original = await repo.findOneByOrFail({
      stripeInvoiceId: 'in_disputed',
      documentKind: 'invoice',
    });
    expect(original.invoiceStatus).toBe('credited');
  });
});
