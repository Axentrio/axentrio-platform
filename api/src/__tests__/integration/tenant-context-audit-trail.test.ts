/**
 * A super-admin tenant context switch must leave an AUDIT ROW, not only a log
 * line: the audit table is the record that proves who read a customer's data.
 *
 * Driven end to end — the real Express app, the real super-admin middleware and
 * the real audit writer against the test database. Only Clerk authentication is
 * stubbed (as in insights-tenant-context.test.ts); stubbing the middleware under
 * test would make the assertions meaningless.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const auth = vi.hoisted(() => ({ userId: '', tenantId: '', role: 'admin' }));

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (req: any, _res: any, next: any) => {
    req.userId = auth.userId;
    req.tenantId = auth.tenantId; // caller's own tenant; the middleware may override it
    req.userRole = auth.role;
    req.user = { id: auth.userId, email: 'test@example.com', role: auth.role, tenantId: auth.tenantId };
    next();
  },
  // Production autoProvision re-attaches the caller's HOME tenant on every run,
  // which is what makes a second middleware run on one request meaningful.
  autoProvision: (req: any, _res: any, next: any) => {
    req.tenantId = auth.tenantId;
    req.user = { ...req.user, tenantId: auth.tenantId };
    next();
  },
  invalidateProvisionCache: () => {},
  resolveClerkIds: () => ({}),
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { AuditLog } from '../../database/entities/AuditLog';
import { applySocketTenantContext } from '../../websocket/socket.handler';
import type { TenantSocket } from '../../middleware/tenant.middleware';
import { createTestTenant, createTestUser, createTestBillingAccount } from '../helpers/factories';

const SWITCH_ACTION = 'tenant.context_switched';

let ownTenantId: string;
let targetTenantId: string;

async function switchRows(actorId: string): Promise<AuditLog[]> {
  return AppDataSource.getRepository(AuditLog).find({
    where: { actorId, action: SWITCH_ACTION },
  });
}

beforeEach(async () => {
  const own = await createTestTenant({ tier: 'pro' });
  ownTenantId = own.id;
  await createTestBillingAccount(ownTenantId, { status: 'active', currentPlanId: 'pro' });

  const target = await createTestTenant({ tier: 'enterprise', name: 'Target BV' });
  targetTenantId = target.id;
  await createTestBillingAccount(targetTenantId, { status: 'active', currentPlanId: 'enterprise' });
});

describe('super-admin tenant context switch — audit trail', () => {
  it('writes an audit row naming the actor, the target tenant and the home tenant', async () => {
    const user = await createTestUser(ownTenantId, { role: 'super_admin' });
    Object.assign(auth, { userId: user.id, tenantId: ownTenantId, role: 'super_admin' });

    const res = await request(app)
      .get('/api/v1/insights/lead-demand')
      .set('x-tenant-context', targetTenantId);

    expect(res.status).toBe(200);

    const rows = await switchRows(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe('tenant');
    expect(rows[0].entityId).toBe(targetTenantId);
    expect(rows[0].tenantId).toBe(targetTenantId);
    expect(rows[0].metadata).toEqual({ homeTenantId: ownTenantId });
  });

  it('writes exactly one row when two router mounts run the middleware on one request', async () => {
    // GET /api/v1/tenants/me/webhooks/status passes through the /tenants router
    // (which mounts resolveTenantContext) and then the explicit webhook mount
    // (which mounts it again), so the middleware runs twice for one request.
    const user = await createTestUser(ownTenantId, { role: 'super_admin' });
    Object.assign(auth, { userId: user.id, tenantId: ownTenantId, role: 'super_admin' });

    const res = await request(app)
      .get('/api/v1/tenants/me/webhooks/status')
      .set('x-tenant-context', targetTenantId);

    expect(res.status).toBe(200);

    const rows = await switchRows(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toEqual({ homeTenantId: ownTenantId });
  });

  it('writes no row when a normal admin sends the header', async () => {
    const user = await createTestUser(ownTenantId, { role: 'admin' });
    Object.assign(auth, { userId: user.id, tenantId: ownTenantId, role: 'admin' });

    const res = await request(app)
      .get('/api/v1/insights/lead-demand')
      .set('x-tenant-context', targetTenantId);

    // Header inert: the caller stays on their own Pro tenant, which lacks the feature.
    expect(res.status).toBe(403);
    expect(await switchRows(user.id)).toHaveLength(0);
  });

  it('writes a row for the socket switch, marked with the socket transport', async () => {
    const user = await createTestUser(ownTenantId, { role: 'super_admin' });
    const socket = {
      handshake: { auth: { tenantContext: targetTenantId } },
      data: {
        user: {
          id: 'agent-1',
          userId: user.id,
          email: user.email,
          role: 'super_admin',
          tenantId: ownTenantId,
          type: 'agent',
        },
        tenantId: ownTenantId,
      },
    } as unknown as TenantSocket;

    await applySocketTenantContext(socket);

    expect(socket.data.tenantId).toBe(targetTenantId);
    const rows = await switchRows(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toEqual({ homeTenantId: ownTenantId, transport: 'socket' });
  });
});
