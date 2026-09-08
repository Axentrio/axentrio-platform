/**
 * Super-admin impersonation on /tenants/me* (Team invite, members, account).
 *
 * These routers used to skip resolveTenantContext, so X-Tenant-Context was
 * ignored and Team invite / GET /me mutated the JWT home workspace.
 *
 * Deliberately NOT createAuthMocks(): that helper stubs resolveTenantContext.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const auth = vi.hoisted(() => ({ userId: '', tenantId: '', role: 'admin' }));

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (
    req: { userId?: string; tenantId?: string; userRole?: string; user?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = auth.userId;
    req.tenantId = auth.tenantId;
    req.userRole = auth.role;
    req.user = { id: auth.userId, email: 'test@example.com', role: auth.role, tenantId: auth.tenantId };
    next();
  },
  autoProvision: (_req: unknown, _res: unknown, next: () => void) => next(),
  invalidateProvisionCache: () => {},
  resolveClerkIds: () => ({}),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

vi.mock('../../integrations/company-lookup/company-lookup.service', () => ({
  lookupCompanyByVat: vi.fn(async () => ({ status: 'found', cached: false, company: { vatNumber: 'BE0400378485', name: 'Colruyt Group', countryCode: 'BE' } })),
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { createTestTenant, createTestUser } from '../helpers/factories';

let ownTenantId: string;
let targetTenantId: string;
let targetUserEmail: string;

const ACCOUNT_WRITE = {
  officialBusinessName: 'Written On Target',
  vatNumber: 'BE0400378485',
  contactPerson: 'Ian',
  invoiceAddress: { street: 'Nieuwstraat 1', postalCode: '1000', city: 'Brussel', country: 'BE' },
  invoiceEmail: 'invoice-target@example.com',
  phone: '+32 2 000 00 00',
};

beforeEach(async () => {
  const own = await createTestTenant({ name: 'Home Workspace' });
  ownTenantId = own.id;
  const target = await createTestTenant({ name: 'Impersonation Target' });
  targetTenantId = target.id;
  await AppDataSource.getRepository(Tenant).update(targetTenantId, {
    officialBusinessName: 'Target NV',
    vatNumber: 'BE0400378485',
  });
  const targetUser = await createTestUser(targetTenantId, { email: `target-${targetTenantId.slice(0, 8)}@test.com` });
  targetUserEmail = targetUser.email;
});

describe('/tenants/me — X-Tenant-Context', () => {
  it('a SUPER ADMIN reads the impersonated tenant, not home', async () => {
    const user = await createTestUser(ownTenantId, { role: 'super_admin' });
    Object.assign(auth, { userId: user.id, tenantId: ownTenantId, role: 'super_admin' });

    const me = await request(app).get('/api/v1/tenants/me').set('x-tenant-context', targetTenantId);
    expect(me.status).toBe(200);
    expect(me.body.data.id).toBe(targetTenantId);
    expect(me.body.data.name).toBe('Impersonation Target');

    const users = await request(app).get('/api/v1/tenants/me/users').set('x-tenant-context', targetTenantId);
    expect(users.status).toBe(200);
    const emails = (users.body.data as Array<{ email: string }>).map((u) => u.email);
    expect(emails).toContain(targetUserEmail);
    expect(emails).not.toContain(user.email);

    const account = await request(app).get('/api/v1/tenants/me/account').set('x-tenant-context', targetTenantId);
    expect(account.status).toBe(200);
    expect(account.body.data.officialBusinessName).toBe('Target NV');
  });

  it('a NON-super-admin cannot use the header to read another tenant', async () => {
    const user = await createTestUser(ownTenantId, { role: 'admin' });
    Object.assign(auth, { userId: user.id, tenantId: ownTenantId, role: 'admin' });

    const me = await request(app).get('/api/v1/tenants/me').set('x-tenant-context', targetTenantId);
    expect(me.status).toBe(200);
    expect(me.body.data.id).toBe(ownTenantId);
    expect(me.body.data.name).toBe('Home Workspace');
  });

  it('a SUPER ADMIN write lands on the impersonated tenant, not home', async () => {
    const user = await createTestUser(ownTenantId, { role: 'super_admin' });
    Object.assign(auth, { userId: user.id, tenantId: ownTenantId, role: 'super_admin' });

    const put = await request(app)
      .put('/api/v1/tenants/me/account')
      .set('x-tenant-context', targetTenantId)
      .send(ACCOUNT_WRITE);
    expect(put.status).toBe(200);
    expect(put.body.data.officialBusinessName).toBe('Written On Target');

    const target = await AppDataSource.getRepository(Tenant).findOneByOrFail({ id: targetTenantId });
    const home = await AppDataSource.getRepository(Tenant).findOneByOrFail({ id: ownTenantId });
    expect(target.officialBusinessName).toBe('Written On Target');
    expect(target.invoiceEmail).toBe('invoice-target@example.com');
    expect(home.officialBusinessName).not.toBe('Written On Target');
    expect(home.invoiceEmail).not.toBe('invoice-target@example.com');
  });

  it('a NON-super-admin write with the header still hits home', async () => {
    const user = await createTestUser(ownTenantId, { role: 'admin' });
    Object.assign(auth, { userId: user.id, tenantId: ownTenantId, role: 'admin' });

    const put = await request(app)
      .put('/api/v1/tenants/me/account')
      .set('x-tenant-context', targetTenantId)
      .send(ACCOUNT_WRITE);
    expect(put.status).toBe(200);

    const target = await AppDataSource.getRepository(Tenant).findOneByOrFail({ id: targetTenantId });
    const home = await AppDataSource.getRepository(Tenant).findOneByOrFail({ id: ownTenantId });
    expect(home.officialBusinessName).toBe('Written On Target');
    expect(target.officialBusinessName).toBe('Target NV');
  });

  it('rejects a malformed tenant context', async () => {
    const user = await createTestUser(ownTenantId, { role: 'super_admin' });
    Object.assign(auth, { userId: user.id, tenantId: ownTenantId, role: 'super_admin' });

    const res = await request(app).get('/api/v1/tenants/me').set('x-tenant-context', 'not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('404s an unknown tenant id', async () => {
    const user = await createTestUser(ownTenantId, { role: 'super_admin' });
    Object.assign(auth, { userId: user.id, tenantId: ownTenantId, role: 'super_admin' });

    const res = await request(app)
      .get('/api/v1/tenants/me')
      .set('x-tenant-context', '00000000-0000-4000-8000-000000000001');
    expect(res.status).toBe(404);
  });

  it('forbids impersonating a suspended or cancelled tenant', async () => {
    const user = await createTestUser(ownTenantId, { role: 'super_admin' });
    Object.assign(auth, { userId: user.id, tenantId: ownTenantId, role: 'super_admin' });

    const suspended = await createTestTenant({ name: 'Suspended Co', status: 'suspended' });
    const cancelled = await createTestTenant({ name: 'Cancelled Co', status: 'cancelled' });

    const sus = await request(app).get('/api/v1/tenants/me').set('x-tenant-context', suspended.id);
    expect(sus.status).toBe(403);

    const can = await request(app).get('/api/v1/tenants/me').set('x-tenant-context', cancelled.id);
    expect(can.status).toBe(403);
  });

  it('a SUPER ADMIN without the header stays on home', async () => {
    const user = await createTestUser(ownTenantId, { role: 'super_admin' });
    Object.assign(auth, { userId: user.id, tenantId: ownTenantId, role: 'super_admin' });

    const me = await request(app).get('/api/v1/tenants/me');
    expect(me.status).toBe(200);
    expect(me.body.data.id).toBe(ownTenantId);
  });
});
