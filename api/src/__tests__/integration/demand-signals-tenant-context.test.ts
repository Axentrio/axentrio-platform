/**
 * Super-admin impersonation on POST /demand-signals/notify-me.
 *
 * demand-signals-routes.test.ts stubs resolveTenantContext to next(), so it
 * cannot prove this. This file uses the real middleware.
 *
 * Deliberately NOT createAuthMocks().
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

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { DemandSignal } from '../../database/entities/DemandSignal';
import { createTestTenant, createTestUser } from '../helpers/factories';

let ownTenantId: string;
let targetTenantId: string;

beforeEach(async () => {
  ownTenantId = (await createTestTenant({ name: 'Home Workspace' })).id;
  targetTenantId = (await createTestTenant({ name: 'Impersonation Target' })).id;
});

describe('POST /demand-signals/notify-me — X-Tenant-Context', () => {
  it('a SUPER ADMIN write pins DemandSignal.tenantId on the target', async () => {
    const user = await createTestUser(ownTenantId, { role: 'super_admin' });
    Object.assign(auth, { userId: user.id, tenantId: ownTenantId, role: 'super_admin' });

    const res = await request(app)
      .post('/api/v1/demand-signals/notify-me')
      .set('x-tenant-context', targetTenantId)
      .send({ feature: 'tiktok', context: { source: 'impersonation_smoke' } });
    expect([200, 201]).toContain(res.status);

    const onTarget = await AppDataSource.getRepository(DemandSignal).find({ where: { tenantId: targetTenantId } });
    const onHome = await AppDataSource.getRepository(DemandSignal).find({ where: { tenantId: ownTenantId } });
    expect(onTarget).toHaveLength(1);
    expect(onTarget[0].tenantId).toBe(targetTenantId);
    expect(onTarget[0].feature).toBe('tiktok');
    expect(onHome).toHaveLength(0);
  });

  it('a NON-super-admin write with the header still hits home', async () => {
    const user = await createTestUser(ownTenantId, { role: 'admin' });
    Object.assign(auth, { userId: user.id, tenantId: ownTenantId, role: 'admin' });

    const res = await request(app)
      .post('/api/v1/demand-signals/notify-me')
      .set('x-tenant-context', targetTenantId)
      .send({ feature: 'linkedin', context: { source: 'impersonation_smoke' } });
    expect([200, 201]).toContain(res.status);

    const onTarget = await AppDataSource.getRepository(DemandSignal).find({ where: { tenantId: targetTenantId } });
    const onHome = await AppDataSource.getRepository(DemandSignal).find({ where: { tenantId: ownTenantId } });
    expect(onHome).toHaveLength(1);
    expect(onHome[0].tenantId).toBe(ownTenantId);
    expect(onHome[0].feature).toBe('linkedin');
    expect(onTarget).toHaveLength(0);
  });
});
