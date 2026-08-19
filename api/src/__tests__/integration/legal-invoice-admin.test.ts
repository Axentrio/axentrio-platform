import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { LegalInvoice } from '../../database/entities/LegalInvoice';
import { setStripeClient } from '../../billing/providers/stripe';
import { setBillitClient } from '../../billing/legal-invoice/billit-client';
import { createTestTenant, createTestUser } from '../helpers/factories';

const COMPLETE_TENANT = {
  name: 'Example BV',
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

describe('admin legal invoice HTTP', () => {
  afterEach(() => {
    setStripeClient(null);
    setBillitClient(null);
    vi.restoreAllMocks();
  });

  it('lists legal invoices with Tenant name and retryable flag', async () => {
    const tenant = await createTestTenant({ name: 'Example BV' });
    const admin = await createTestUser(tenant.id, { role: 'super_admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId: tenant.id, role: 'super_admin' });
    const repo = AppDataSource.getRepository(LegalInvoice);
    await repo.save(
      repo.create({
        tenantId: tenant.id,
        documentKind: 'invoice',
        stripeInvoiceId: 'in_admin_list',
        paymentStatus: 'paid',
        invoiceStatus: 'failed',
        peppolStatus: 'pending',
        peppolRequired: true,
        currency: 'EUR',
        amountExclCents: 7499,
        vatAmountCents: 1575,
        amountInclCents: 9074,
        reviewReasons: [],
        lastError: 'billit_http_error',
        retryCount: 0,
      }),
    );

    const res = await request(app).get('/api/v1/admin/legal-invoices');
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.attentionCount).toBeGreaterThanOrEqual(1);
    const row = body.invoices.find((item: { stripeInvoiceId: string }) => item.stripeInvoiceId === 'in_admin_list');
    expect(row).toBeTruthy();
    expect(row.tenantName).toBe('Example BV');
    expect(row.retryable).toBe(true);
    expect(row.lastError).toBe('billit_http_error');
  });

  it('retries one failed Legal Invoice through POST and marks it sent', async () => {
    const tenant = await createTestTenant(COMPLETE_TENANT);
    const admin = await createTestUser(tenant.id, { role: 'super_admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId: tenant.id, role: 'super_admin' });
    const repo = AppDataSource.getRepository(LegalInvoice);
    const row = await repo.save(
      repo.create({
        tenantId: tenant.id,
        documentKind: 'invoice',
        stripeInvoiceId: 'in_admin_retry',
        paymentStatus: 'paid',
        invoiceStatus: 'failed',
        peppolStatus: 'pending',
        peppolRequired: true,
        currency: 'EUR',
        amountExclCents: 7499,
        vatAmountCents: 1575,
        amountInclCents: 9074,
        reviewReasons: [],
        lastError: 'billit_http_error',
        retryCount: 0,
      }),
    );
    setStripeClient({
      invoices: {
        retrieve: vi.fn(async (id: string) => stripeInvoice(id)),
        listLineItems: vi.fn(),
      },
    } as never);
    setBillitClient({
      isConfigured: () => true,
      consumeNextNumber: vi.fn(async () => '2026-0099'),
      createOrder: vi.fn(async () => ({ orderId: '99', orderNumber: '2026-0099' })),
      sendOrders: vi.fn(async () => undefined),
      getOrder: vi.fn(async (id: string) => ({ orderId: id, orderNumber: '2026-0099', isSent: true })),
      lookupPeppol: vi.fn(async () => ({
        registered: true,
        documentTypes: ['BISv3Invoice', 'BISv3CreditNote'],
      })),
    });

    const res = await request(app).post(
      `/api/v1/admin/tenants/${tenant.id}/legal-invoices/${row.id}/retry`,
    );
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.outcome).toBe('sent');
    expect(body.invoiceStatus).toBe('sent');
    expect(body.peppolStatus).toBe('sent');
    const stored = await repo.findOneByOrFail({ id: row.id });
    expect(stored.invoiceStatus).toBe('sent');
    expect(stored.lastError).toBeNull();
  });

  it('retries all waiting Legal Invoices through POST /legal-invoices/retry-waiting', async () => {
    const tenant = await createTestTenant(COMPLETE_TENANT);
    const admin = await createTestUser(tenant.id, { role: 'super_admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId: tenant.id, role: 'super_admin' });
    const repo = AppDataSource.getRepository(LegalInvoice);
    await repo.save(
      repo.create({
        tenantId: tenant.id,
        documentKind: 'invoice',
        stripeInvoiceId: 'in_wait_1',
        paymentStatus: 'paid',
        invoiceStatus: 'draft',
        peppolStatus: 'pending',
        peppolRequired: true,
        currency: 'EUR',
        amountExclCents: 7499,
        vatAmountCents: 1575,
        amountInclCents: 9074,
        reviewReasons: [],
        lastError: 'billit_not_configured',
        retryCount: 0,
      }),
    );
    setStripeClient({
      invoices: {
        retrieve: vi.fn(async (id: string) => stripeInvoice(id)),
        listLineItems: vi.fn(),
      },
    } as never);
    setBillitClient({
      isConfigured: () => true,
      consumeNextNumber: vi.fn(async () => '2026-0100'),
      createOrder: vi.fn(async () => ({ orderId: '100', orderNumber: '2026-0100' })),
      sendOrders: vi.fn(async () => undefined),
      getOrder: vi.fn(async (id: string) => ({ orderId: id, orderNumber: '2026-0100', isSent: true })),
      lookupPeppol: vi.fn(async () => ({
        registered: true,
        documentTypes: ['BISv3Invoice', 'BISv3CreditNote'],
      })),
    });

    const res = await request(app).post('/api/v1/admin/legal-invoices/retry-waiting');
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.attempted).toBeGreaterThanOrEqual(1);
    const stored = await repo.findOneByOrFail({ stripeInvoiceId: 'in_wait_1' });
    expect(stored.invoiceStatus).toBe('sent');
  });
});
