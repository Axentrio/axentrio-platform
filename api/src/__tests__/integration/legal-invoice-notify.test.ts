import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../automations', () => ({ getEmailService: () => ({ send }) }));

import { AppDataSource } from '../../database/data-source';
import { EmailDelivery } from '../../database/entities/EmailDelivery';
import { LegalInvoice } from '../../database/entities/LegalInvoice';
import { setStripeClient } from '../../billing/providers/stripe';
import { setBillitClient, type BillitClient } from '../../billing/legal-invoice/billit-client';
import { BillitClientError } from '../../billing/legal-invoice/billit-client';
import {
  processPaidStripeInvoice,
  processStripeRefund,
} from '../../billing/legal-invoice/service';
import { LEGAL_INVOICE_ALERT_KIND } from '../../billing/legal-invoice/notify-attention';
import { createTestTenant, createTestUser } from '../helpers/factories';

function billitMock(overrides: Partial<BillitClient> = {}): BillitClient {
  return {
    isConfigured: () => true,
    consumeNextNumber: vi.fn(async () => '2026-0001'),
    createOrder: vi.fn(async () => ({ orderId: '1684998', orderNumber: '2026-0001' })),
    sendOrders: vi.fn(async () => undefined),
    getOrder: vi.fn(async (id: string) => ({ orderId: id, orderNumber: '2026-0001', isSent: true })),
    lookupPeppol: vi.fn(async () => ({
      registered: true,
      documentTypes: ['BISv3Invoice', 'BISv3CreditNote'],
    })),
    ...overrides,
  };
}

function stripeInvoice(id: string) {
  return {
    id,
    amount_paid: 9074,
    total: 9074,
    total_excluding_tax: 7499,
    currency: 'eur',
    created: Date.UTC(2026, 4, 1) / 1000,
    period_start: Date.UTC(2026, 4, 1) / 1000,
    period_end: Date.UTC(2026, 4, 31) / 1000,
    status_transitions: { paid_at: Date.UTC(2026, 4, 1) / 1000 },
    customer: 'cus_test',
    subscription: 'sub_test',
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
  };
}

const completeBe = {
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
};

describe('legal invoice Super Admin attention email', () => {
  afterEach(() => {
    setStripeClient(null);
    setBillitClient(null);
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({ success: true, messageId: 'legal-alert-1' });
    setStripeClient({
      invoices: {
        retrieve: vi.fn(async (id: string) => stripeInvoice(id)),
        listLineItems: vi.fn(),
      },
    } as never);
  });

  it('mails each Super Admin when a Legal Invoice lands in manual_review', async () => {
    const tenant = await createTestTenant({
      name: 'Example BV',
      officialBusinessName: 'Example BV',
      vatNumber: null,
      invoiceEmail: 'billing@example.com',
      invoiceAddress: { street: 'Example Street', postalCode: '2000', city: 'Antwerp', country: 'BE' },
    });
    const superAdmin = await createTestUser(tenant.id, {
      role: 'super_admin',
      email: 'ops@axentrio.test',
    });
    await createTestUser(tenant.id, { role: 'admin', email: 'tenant-admin@example.com' });
    setBillitClient(billitMock());

    const result = await processPaidStripeInvoice({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_missing_vat_mail',
    });

    expect(result.outcome).toBe('manual_review');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      to: 'ops@axentrio.test',
      subject: 'Legal Invoice needs attention',
    });
    expect(send.mock.calls[0][0].body).toContain('Example BV');
    expect(send.mock.calls[0][0].body).toContain('Status: manual_review');
    expect(send.mock.calls[0][0].body).toContain(
      `/admin/legal-invoices?invoice=${result.legalInvoiceId}`,
    );

    const row = await AppDataSource.getRepository(EmailDelivery).findOneByOrFail({
      kind: LEGAL_INVOICE_ALERT_KIND,
      recipientUserId: superAdmin.id,
    });
    expect(row).toMatchObject({
      status: 'sent',
      recipientEmail: 'ops@axentrio.test',
      relatedId: result.legalInvoiceId,
      tenantId: tenant.id,
      providerMessageId: 'legal-alert-1',
    });
  });

  it('does not mail again on a second process of the same status', async () => {
    const tenant = await createTestTenant({
      officialBusinessName: 'Example BV',
      vatNumber: null,
      invoiceEmail: 'billing@example.com',
      invoiceAddress: { street: 'Example Street', postalCode: '2000', city: 'Antwerp', country: 'BE' },
    });
    await createTestUser(tenant.id, { role: 'super_admin', email: 'ops@axentrio.test' });
    setBillitClient(billitMock());

    await processPaidStripeInvoice({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_review_once',
    });
    await processPaidStripeInvoice({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_review_once',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const count = await AppDataSource.getRepository(EmailDelivery).count({
      where: { kind: LEGAL_INVOICE_ALERT_KIND },
    });
    expect(count).toBe(1);
  });

  it('mails Super Admin when Billit create fails, and keeps the Legal Invoice failed if mail fails', async () => {
    const tenant = await createTestTenant(completeBe);
    await createTestUser(tenant.id, { role: 'super_admin', email: 'ops@axentrio.test' });
    send.mockRejectedValue(new Error('resend down'));
    setBillitClient(
      billitMock({
        createOrder: vi.fn(async () => {
          throw new BillitClientError('billit_http_error', 500);
        }),
      }),
    );

    const result = await processPaidStripeInvoice({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_billit_mail',
    });

    expect(result.outcome).toBe('failed');
    const invoice = await AppDataSource.getRepository(LegalInvoice).findOneByOrFail({
      stripeInvoiceId: 'in_billit_mail',
    });
    expect(invoice.invoiceStatus).toBe('failed');
    expect(invoice.lastError).toBe('billit_http_error');
    const delivery = await AppDataSource.getRepository(EmailDelivery).findOneByOrFail({
      kind: LEGAL_INVOICE_ALERT_KIND,
    });
    expect(delivery.status).toBe('failed');
    expect(delivery.error).toBe('resend down');
  });

  it('mails one Super Admin once when they have two user rows', async () => {
    const tenant = await createTestTenant({
      officialBusinessName: 'Example BV',
      vatNumber: null,
      invoiceEmail: 'billing@example.com',
      invoiceAddress: { street: 'Example Street', postalCode: '2000', city: 'Antwerp', country: 'BE' },
    });
    const otherTenant = await createTestTenant();
    await createTestUser(tenant.id, { role: 'super_admin', email: 'ops@axentrio.test' });
    await createTestUser(otherTenant.id, { role: 'super_admin', email: 'ops@axentrio.test' });
    setBillitClient(billitMock());

    await processPaidStripeInvoice({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_dup_admin',
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe('ops@axentrio.test');
  });

  it('does not mail on a successful Peppol send', async () => {
    const tenant = await createTestTenant(completeBe);
    await createTestUser(tenant.id, { role: 'super_admin', email: 'ops@axentrio.test' });
    setBillitClient(billitMock());

    const result = await processPaidStripeInvoice({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_ok_no_mail',
    });

    expect(result.outcome).toBe('sent');
    expect(send).not.toHaveBeenCalled();
    const count = await AppDataSource.getRepository(EmailDelivery).count({
      where: { kind: LEGAL_INVOICE_ALERT_KIND },
    });
    expect(count).toBe(0);
  });

  it('does not mail while Billit keys are missing', async () => {
    const tenant = await createTestTenant(completeBe);
    await createTestUser(tenant.id, { role: 'super_admin', email: 'ops@axentrio.test' });
    setBillitClient({
      isConfigured: () => false,
      consumeNextNumber: vi.fn(),
      createOrder: vi.fn(),
      sendOrders: vi.fn(),
      getOrder: vi.fn(),
      lookupPeppol: vi.fn(),
    });

    const result = await processPaidStripeInvoice({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_waiting_keys_mail',
    });

    expect(result.outcome).toBe('billit_not_configured');
    expect(send).not.toHaveBeenCalled();
  });

  it('mails Super Admin when a Credit Note lands in manual_review', async () => {
    const tenant = await createTestTenant(completeBe);
    await createTestUser(tenant.id, { role: 'super_admin', email: 'ops@axentrio.test' });
    setBillitClient(billitMock());

    const result = await processStripeRefund({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_missing_original',
      stripeRefundId: 're_mail',
      amountRefundedCents: 9074,
    });

    expect(result.outcome).toBe('manual_review');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].subject).toBe('Credit Note needs attention');
    expect(send.mock.calls[0][0].body).toContain('re_mail');
  });
});
