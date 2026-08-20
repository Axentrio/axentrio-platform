import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { LegalInvoice } from '../../database/entities/LegalInvoice';
import { setStripeClient } from '../../billing/providers/stripe';
import { setBillitClient, type BillitClient } from '../../billing/legal-invoice/billit-client';
import { BillitClientError } from '../../billing/legal-invoice/billit-client';
import {
  isRetryableLegalInvoice,
  processPaidStripeInvoice,
  processStripeRefund,
  retryLegalInvoice,
  retryWaitingLegalInvoices,
} from '../../billing/legal-invoice/service';
import { createTestTenant } from '../helpers/factories';

function billitMock(overrides: Partial<BillitClient> = {}): BillitClient & {
  consumeNextNumber: ReturnType<typeof vi.fn>;
  createOrder: ReturnType<typeof vi.fn>;
  sendOrders: ReturnType<typeof vi.fn>;
  lookupPeppol: ReturnType<typeof vi.fn>;
} {
  const client = {
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
  return client as BillitClient & {
    consumeNextNumber: ReturnType<typeof vi.fn>;
    createOrder: ReturnType<typeof vi.fn>;
    sendOrders: ReturnType<typeof vi.fn>;
    lookupPeppol: ReturnType<typeof vi.fn>;
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

describe('processPaidStripeInvoice', () => {
  afterEach(() => {
    setStripeClient(null);
    setBillitClient(null);
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    setStripeClient({
      invoices: {
        retrieve: vi.fn(async (id: string) => stripeInvoice(id)),
        listLineItems: vi.fn(),
      },
    } as never);
  });

  it('marks missing VAT for manual review and does not call Billit', async () => {
    const tenant = await createTestTenant({
      officialBusinessName: 'Example BV',
      vatNumber: null,
      invoiceEmail: 'billing@example.com',
      invoiceAddress: { street: 'Example Street', postalCode: '2000', city: 'Antwerp', country: 'BE' },
    });
    const billit = billitMock();
    setBillitClient(billit);

    const result = await processPaidStripeInvoice({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_missing_vat',
    });

    expect(result.outcome).toBe('manual_review');
    expect(billit.createOrder).not.toHaveBeenCalled();
    const row = await AppDataSource.getRepository(LegalInvoice).findOneByOrFail({
      stripeInvoiceId: 'in_missing_vat',
    });
    expect(row.invoiceStatus).toBe('manual_review');
    expect(row.reviewReasons).toContain('missing_vat_number');
  });

  it('skips a €0 trial invoice', async () => {
    setStripeClient({
      invoices: {
        retrieve: vi.fn(async (id: string) => ({ ...stripeInvoice(id), amount_paid: 0, total: 0 })),
        listLineItems: vi.fn(),
      },
    } as never);
    const tenant = await createTestTenant({
      officialBusinessName: 'Example BV',
      vatNumber: 'BE0400378485',
      invoiceAddress: { street: 'Example Street', postalCode: '2000', city: 'Antwerp', country: 'BE' },
    });
    const result = await processPaidStripeInvoice({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_trial_zero',
    });
    expect(result.outcome).toBe('skipped_zero_amount');
    const count = await AppDataSource.getRepository(LegalInvoice).count({
      where: { stripeInvoiceId: 'in_trial_zero' },
    });
    expect(count).toBe(0);
  });

  it('creates a Billit invoice and sends Peppol for a complete Belgian Tenant', async () => {
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
    const billit = billitMock();
    setBillitClient(billit);

    const result = await processPaidStripeInvoice({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_paid_be',
    });

    expect(result.outcome).toBe('sent');
    expect(billit.createOrder).toHaveBeenCalledTimes(1);
    expect(billit.sendOrders).toHaveBeenCalledWith(['1684998'], 'Peppol');
    const row = await AppDataSource.getRepository(LegalInvoice).findOneByOrFail({
      stripeInvoiceId: 'in_paid_be',
    });
    expect(row.billitInvoiceNumber).toBe('2026-0001');
    expect(row.paymentStatus).toBe('paid');
    expect(row.invoiceStatus).toBe('sent');
    expect(row.peppolStatus).toBe('sent');
    expect(row.amountExclCents).toBe(7499);
  });

  it('does not create a second Billit invoice on retry after send', async () => {
    const tenant = await createTestTenant({
      officialBusinessName: 'Example BV',
      vatNumber: 'BE0400378485',
      vatVerified: true,
      invoiceEmail: 'billing@example.com',
      invoiceAddress: { street: 'Example Street', postalCode: '2000', city: 'Antwerp', country: 'BE' },
    });
    const billit = billitMock();
    setBillitClient(billit);
    await processPaidStripeInvoice({ tenantId: tenant.id, stripeInvoiceId: 'in_once' });
    const second = await processPaidStripeInvoice({ tenantId: tenant.id, stripeInvoiceId: 'in_once' });
    expect(second.outcome).toBe('already_final');
    expect(billit.createOrder).toHaveBeenCalledTimes(1);
  });

  it('keeps a draft when Billit keys are missing, then sends on retry', async () => {
    const tenant = await createTestTenant({
      officialBusinessName: 'Example BV',
      vatNumber: 'BE0400378485',
      vatVerified: true,
      invoiceEmail: 'billing@example.com',
      invoiceAddress: { street: 'Example Street', postalCode: '2000', city: 'Antwerp', country: 'BE' },
    });
    setBillitClient({
      isConfigured: () => false,
      consumeNextNumber: vi.fn(),
      createOrder: vi.fn(),
      sendOrders: vi.fn(),
      getOrder: vi.fn(),
      lookupPeppol: vi.fn(),
    });

    const waiting = await processPaidStripeInvoice({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_waiting_keys',
    });
    expect(waiting.outcome).toBe('billit_not_configured');
    const draft = await AppDataSource.getRepository(LegalInvoice).findOneByOrFail({
      stripeInvoiceId: 'in_waiting_keys',
    });
    expect(draft.invoiceStatus).toBe('draft');
    expect(draft.lastError).toBe('billit_not_configured');

    const billit = billitMock();
    setBillitClient(billit);
    const replay = await retryWaitingLegalInvoices();
    expect(replay.attempted).toBeGreaterThanOrEqual(1);
    const sent = await AppDataSource.getRepository(LegalInvoice).findOneByOrFail({
      stripeInvoiceId: 'in_waiting_keys',
    });
    expect(sent.invoiceStatus).toBe('sent');
    expect(billit.createOrder).toHaveBeenCalled();
  });

  it('marks peppol_status not_available when the Tenant is not on Peppol', async () => {
    const tenant = await createTestTenant({
      officialBusinessName: 'Example BV',
      vatNumber: 'BE0400378485',
      vatVerified: true,
      invoiceEmail: 'billing@example.com',
      invoiceAddress: { street: 'Example Street', postalCode: '2000', city: 'Antwerp', country: 'BE' },
    });
    const billit = billitMock({
      lookupPeppol: vi.fn(async () => ({ registered: false, documentTypes: [] })),
    });
    setBillitClient(billit);
    const result = await processPaidStripeInvoice({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_no_peppol',
    });
    expect(result.outcome).toBe('peppol_not_available');
    const row = await AppDataSource.getRepository(LegalInvoice).findOneByOrFail({
      stripeInvoiceId: 'in_no_peppol',
    });
    expect(row.billitOrderId).toBe('1684998');
    expect(row.peppolStatus).toBe('not_available');
    expect(row.invoiceStatus).toBe('manual_review');
    expect(billit.sendOrders).not.toHaveBeenCalled();
  });

  it('stores a failed row when Billit create fails, then retries without throwing', async () => {
    const tenant = await createTestTenant({
      officialBusinessName: 'Example BV',
      vatNumber: 'BE0400378485',
      vatVerified: true,
      invoiceEmail: 'billing@example.com',
      invoiceAddress: { street: 'Example Street', postalCode: '2000', city: 'Antwerp', country: 'BE' },
    });
    const billit = billitMock({
      createOrder: vi.fn(async () => {
        throw new BillitClientError('billit_http_error', 500);
      }),
    });
    setBillitClient(billit);

    const failed = await processPaidStripeInvoice({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_billit_down',
    });
    expect(failed.outcome).toBe('failed');
    const row = await AppDataSource.getRepository(LegalInvoice).findOneByOrFail({
      stripeInvoiceId: 'in_billit_down',
    });
    expect(row.invoiceStatus).toBe('failed');
    expect(row.lastError).toBe('billit_http_error');
    expect(row.paymentStatus).toBe('paid');
    expect(isRetryableLegalInvoice(row)).toBe(true);

    billit.createOrder.mockResolvedValue({ orderId: '1684998', orderNumber: '2026-0001' });
    const retried = await retryLegalInvoice(row.id);
    expect(retried.outcome).toBe('sent');
    const sent = await AppDataSource.getRepository(LegalInvoice).findOneByOrFail({
      stripeInvoiceId: 'in_billit_down',
    });
    expect(sent.invoiceStatus).toBe('sent');
    expect(sent.peppolStatus).toBe('sent');
  });

  it('keeps the Billit id when Peppol send fails, then retries send only', async () => {
    const tenant = await createTestTenant({
      officialBusinessName: 'Example BV',
      vatNumber: 'BE0400378485',
      vatVerified: true,
      invoiceEmail: 'billing@example.com',
      invoiceAddress: { street: 'Example Street', postalCode: '2000', city: 'Antwerp', country: 'BE' },
    });
    const billit = billitMock({
      sendOrders: vi.fn(async () => {
        throw new BillitClientError('billit_network_error');
      }),
    });
    setBillitClient(billit);

    const failed = await processPaidStripeInvoice({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_peppol_down',
    });
    expect(failed.outcome).toBe('failed');
    const row = await AppDataSource.getRepository(LegalInvoice).findOneByOrFail({
      stripeInvoiceId: 'in_peppol_down',
    });
    expect(row.invoiceStatus).toBe('created');
    expect(row.peppolStatus).toBe('failed');
    expect(row.billitOrderId).toBe('1684998');
    expect(isRetryableLegalInvoice(row)).toBe(true);

    billit.sendOrders.mockResolvedValue(undefined);
    const retried = await retryLegalInvoice(row.id);
    expect(retried.outcome).toBe('sent');
    expect(billit.createOrder).toHaveBeenCalledTimes(1);
    expect(billit.sendOrders).toHaveBeenCalledTimes(2);
  });
});

describe('processStripeRefund', () => {
  afterEach(() => {
    setStripeClient(null);
    setBillitClient(null);
    vi.restoreAllMocks();
  });

  it('creates a credit note for an existing Legal Invoice', async () => {
    const tenant = await createTestTenant({
      officialBusinessName: 'Example BV',
      vatNumber: 'BE0400378485',
      vatVerified: true,
      invoiceEmail: 'billing@example.com',
      invoiceAddress: { street: 'Example Street', postalCode: '2000', city: 'Antwerp', country: 'BE' },
    });
    const repo = AppDataSource.getRepository(LegalInvoice);
    await repo.save(
      repo.create({
        tenantId: tenant.id,
        documentKind: 'invoice',
        stripeInvoiceId: 'in_refund_src',
        billitOrderId: '1',
        billitInvoiceNumber: '2026-0001',
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
    const billit = billitMock();
    billit.consumeNextNumber.mockResolvedValue('CN-2026-0001');
    setBillitClient(billit);

    const result = await processStripeRefund({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_refund_src',
      stripeRefundId: 're_1',
      amountRefundedCents: 9074,
    });

    expect(result.outcome).toBe('sent');
    expect(billit.createOrder).toHaveBeenCalledTimes(1);
    const credit = await repo.findOneByOrFail({ stripeRefundId: 're_1' });
    expect(credit.documentKind).toBe('credit_note');
    expect(credit.invoiceStatus).toBe('sent');
    const original = await repo.findOneByOrFail({
      stripeInvoiceId: 'in_refund_src',
      documentKind: 'invoice',
    });
    expect(original.invoiceStatus).toBe('credited');
    expect(original.paymentStatus).toBe('refunded');
  });

  it('retries a credit note after Billit send fails without consuming a second number', async () => {
    const tenant = await createTestTenant({
      officialBusinessName: 'Example BV',
      vatNumber: 'BE0400378485',
      vatVerified: true,
      invoiceEmail: 'billing@example.com',
      invoiceAddress: { street: 'Example Street', postalCode: '2000', city: 'Antwerp', country: 'BE' },
    });
    const repo = AppDataSource.getRepository(LegalInvoice);
    await repo.save(
      repo.create({
        tenantId: tenant.id,
        documentKind: 'invoice',
        stripeInvoiceId: 'in_cn_src',
        billitOrderId: '1',
        billitInvoiceNumber: '2026-0001',
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
    const billit = billitMock();
    billit.consumeNextNumber.mockResolvedValue('CN-2026-0001');
    billit.sendOrders.mockRejectedValueOnce(new BillitClientError('billit_http_error', 503));
    setBillitClient(billit);

    const failed = await processStripeRefund({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_cn_src',
      stripeRefundId: 're_retry',
      amountRefundedCents: 9074,
    });
    expect(failed.outcome).toBe('failed');
    const credit = await repo.findOneByOrFail({ stripeRefundId: 're_retry' });
    expect(credit.invoiceStatus).toBe('created');
    expect(credit.peppolStatus).toBe('failed');
    expect(credit.billitInvoiceNumber).toBe('CN-2026-0001');
    expect(isRetryableLegalInvoice(credit)).toBe(true);

    billit.sendOrders.mockResolvedValue(undefined);
    const retried = await retryLegalInvoice(credit.id);
    expect(retried.outcome).toBe('sent');
    expect(billit.consumeNextNumber).toHaveBeenCalledTimes(1);
    expect(billit.createOrder).toHaveBeenCalledTimes(1);
    expect(billit.sendOrders).toHaveBeenCalledTimes(2);
  });

  it('does not create a second Credit Note when the Legal Invoice is already credited', async () => {
    const tenant = await createTestTenant({
      officialBusinessName: 'Example BV',
      vatNumber: 'BE0400378485',
      vatVerified: true,
      invoiceEmail: 'billing@example.com',
      invoiceAddress: { street: 'Example Street', postalCode: '2000', city: 'Antwerp', country: 'BE' },
    });
    const repo = AppDataSource.getRepository(LegalInvoice);
    const original = await repo.save(
      repo.create({
        tenantId: tenant.id,
        documentKind: 'invoice',
        stripeInvoiceId: 'in_already_credited',
        billitOrderId: '1',
        billitInvoiceNumber: '2026-0001',
        paymentStatus: 'refunded',
        invoiceStatus: 'credited',
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
    const billit = billitMock();
    setBillitClient(billit);

    const result = await processStripeRefund({
      tenantId: tenant.id,
      stripeInvoiceId: 'in_already_credited',
      stripeRefundId: 'dp_after_refund',
      amountRefundedCents: 9074,
    });

    expect(result.outcome).toBe('already_credited');
    expect(result.legalInvoiceId).toBe(original.id);
    expect(billit.createOrder).not.toHaveBeenCalled();
    expect(await repo.count({ where: { stripeRefundId: 'dp_after_refund' } })).toBe(0);
  });
});
