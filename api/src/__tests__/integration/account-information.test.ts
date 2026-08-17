/**
 * GET/PUT /tenants/me/account — Account Information (#148).
 *
 * Profile is the signed-in user. This surface is the TENANT's invoice identity.
 * Facts already known from onboarding must pre-populate; writes persist per tenant
 * and re-verify VAT when the number changes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const auth = vi.hoisted(() => ({
  userId: '',
  tenantId: '',
  role: 'admin' as string,
}));

const lookupCompanyByVat = vi.hoisted(() => vi.fn());

vi.mock('../../middleware/clerk.middleware', async () => {
  const { UnauthorizedError } = await import('../../middleware/error-handler');
  return {
    requireClerkAuth: (req: any, _res: any, next: any) => {
      if (!auth.userId) return next(new UnauthorizedError('Unauthorized'));
      req.userId = auth.userId;
      req.tenantId = auth.tenantId;
      req.userRole = auth.role;
      req.user = { id: auth.userId, role: auth.role, tenantId: auth.tenantId, type: 'agent' };
      next();
    },
    autoProvision: (_req: any, _res: any, next: any) => next(),
    invalidateProvisionCache: () => {},
    resolveClerkIds: () => ({}),
  };
});

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

vi.mock('../../integrations/company-lookup/company-lookup.service', () => ({
  lookupCompanyByVat,
}));

import request from 'supertest';
import { app } from '../../server';
import { Tenant } from '../../database/entities/Tenant';
import { createTestTenant, createTestUser } from '../helpers/factories';
import type { OnboardingState } from '../../onboarding/onboarding-state';

const FOUND = {
  status: 'found',
  cached: false,
  company: { vatNumber: 'BE0400378485', name: 'Colruyt Group', countryCode: 'BE' },
};

async function signedInTenant(overrides: Partial<Tenant> = {}) {
  const tenant = await createTestTenant({ tier: 'pro', ...overrides });
  const admin = await createTestUser(tenant.id, { role: 'admin' });
  auth.userId = admin.id;
  auth.tenantId = tenant.id;
  auth.role = 'admin';
  return tenant;
}

const PAYLOAD = {
  officialBusinessName: 'NV Colruyt Group',
  vatNumber: 'BE 0400.378.485',
  contactPerson: 'Jan Janssens',
  invoiceAddress: {
    street: 'Edingensesteenweg 196',
    postalCode: '1500',
    city: 'Halle',
    country: 'BE',
  },
  invoiceEmail: 'accounts@colruyt.be',
  phone: '+32 2 363 55 45',
};

beforeEach(() => {
  lookupCompanyByVat.mockReset().mockResolvedValue(FOUND);
});

describe('GET /api/v1/tenants/me/account', () => {
  it('prefills from onboarding company + billing email', async () => {
    const onboarding: OnboardingState = {
      version: 1,
      startedAt: new Date().toISOString(),
      completedAt: null,
      language: 'nl',
      company: {
        vatNumber: 'BE0400378485',
        name: 'NV Colruyt Group',
        legalForm: 'NV',
        street: 'Edingensesteenweg 196',
        postalCode: '1500',
        city: 'Halle',
        verified: true,
      },
      steps: {},
    };
    await signedInTenant({
      settings: { onboarding } as Tenant['settings'],
      billingInfo: { billingEmail: 'accounts@colruyt.be' },
    });

    const res = await request(app).get('/api/v1/tenants/me/account');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      officialBusinessName: 'NV Colruyt Group',
      vatNumber: 'BE0400378485',
      invoiceEmail: 'accounts@colruyt.be',
      vatVerified: true,
      invoiceAddress: {
        street: 'Edingensesteenweg 196',
        postalCode: '1500',
        city: 'Halle',
        country: 'BE',
      },
    });
  });
});

describe('PUT /api/v1/tenants/me/account', () => {
  it('persists the six fields and returns them on GET', async () => {
    await signedInTenant();
    const put = await request(app).put('/api/v1/tenants/me/account').send(PAYLOAD);
    expect(put.status).toBe(200);
    expect(put.body.data.vatNumber).toBe('BE0400378485');
    expect(put.body.data.contactPerson).toBe('Jan Janssens');
    expect(put.body.data.phone).toBe('+32 2 363 55 45');

    const get = await request(app).get('/api/v1/tenants/me/account');
    expect(get.status).toBe(200);
    expect(get.body.data).toMatchObject({
      officialBusinessName: 'NV Colruyt Group',
      vatNumber: 'BE0400378485',
      contactPerson: 'Jan Janssens',
      invoiceEmail: 'accounts@colruyt.be',
      phone: '+32 2 363 55 45',
    });
  });

  it('422s an invalid VAT or email', async () => {
    await signedInTenant();
    const badVat = await request(app)
      .put('/api/v1/tenants/me/account')
      .send({ ...PAYLOAD, vatNumber: '???' });
    expect(badVat.status).toBe(422);

    const badEmail = await request(app)
      .put('/api/v1/tenants/me/account')
      .send({ ...PAYLOAD, invoiceEmail: 'not-an-email' });
    expect(badEmail.status).toBe(422);
  });

  it('re-verifies VAT when the number changes', async () => {
    await signedInTenant();
    await request(app).put('/api/v1/tenants/me/account').send(PAYLOAD);
    lookupCompanyByVat.mockClear();
    lookupCompanyByVat.mockResolvedValue({
      status: 'found',
      cached: false,
      company: { vatNumber: 'BE0123456749', name: 'Other NV', countryCode: 'BE' },
    });

    const res = await request(app)
      .put('/api/v1/tenants/me/account')
      .send({ ...PAYLOAD, vatNumber: 'BE0123456749' });
    expect(res.status).toBe(200);
    expect(lookupCompanyByVat).toHaveBeenCalled();
    expect(res.body.data.vatVerified).toBe(true);
    expect(res.body.data.vatNumber).toBe('BE0123456749');
  });

  it('saves a non-Belgian VAT and leaves verification unset', async () => {
    await signedInTenant();
    lookupCompanyByVat.mockResolvedValue({ status: 'invalid_format', company: null, cached: false });

    const res = await request(app)
      .put('/api/v1/tenants/me/account')
      .send({ ...PAYLOAD, vatNumber: 'NL123456789B01' });
    expect(res.status).toBe(200);
    expect(res.body.data.vatNumber).toBe('NL123456789B01');
    expect(res.body.data.vatVerified).toBe(false);
  });
});
