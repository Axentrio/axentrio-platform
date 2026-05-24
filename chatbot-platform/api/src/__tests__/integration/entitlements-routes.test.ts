/**
 * Entitlements route — HTTP-level coverage for GET /api/v1/entitlements.
 *
 * Subscription/feature-access epic — M0+M1. Verifies the shape of the
 * `{ current, plans, selfServePlans }` envelope for each tier, plus the
 * Enterprise per-tenant override path (maxSessions / dailyLlmCallLimit).
 *
 * Mirrors the auth-mocking + app-bootstrap pattern used by
 * billing-routes.test.ts / billing-entitlement-gates.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { vi as viHoist } from 'vitest';

// Hoisted auth state — same shape as helpers/auth.ts, but we install our own
// mock so the requireClerkAuth stub can emit 401 when `userId` is blank.
const auth = viHoist.hoisted(() => ({
  userId: '',
  tenantId: '',
  agentId: '',
  role: 'super_admin' as string,
  email: 'test@example.com',
  clerkUserId: '',
  clerkOrgId: '',
}));

vi.mock('../../middleware/clerk.middleware', async () => {
  // Re-export UnauthorizedError-ish behaviour via next(err) so the real
  // errorHandler maps it to a 401 envelope.
  const { UnauthorizedError } = await import('../../middleware/error-handler');
  return {
    requireClerkAuth: (req: any, _res: any, next: any) => {
      if (!auth.userId) {
        return next(new UnauthorizedError('Clerk: Unauthorized - no userId in auth'));
      }
      req.userId = auth.userId;
      req.tenantId = auth.tenantId;
      req.agentId = auth.agentId;
      req.userRole = auth.role;
      req.user = {
        id: auth.userId,
        email: auth.email,
        role: auth.role,
        tenantId: auth.tenantId,
        clerkUserId: auth.clerkUserId,
        type: 'agent',
      };
      next();
    },
    autoProvision: (_req: any, _res: any, next: any) => next(),
    invalidateProvisionCache: () => {},
    resolveClerkIds: () => ({}),
  };
});

vi.mock('../../middleware/super-admin.middleware', () => ({
  requireSuperAdmin: (req: any, res: any, next: any) => {
    if (req.user?.role !== 'super_admin') {
      res.status(403).json({ error: 'Super admin access required' });
      return;
    }
    next();
  },
  resolveTenantContext: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import {
  createTestTenant,
  createTestUser,
} from '../helpers/factories';

function setAuth(opts: { tenantId: string; userId: string; role?: string }) {
  auth.userId = opts.userId;
  auth.tenantId = opts.tenantId;
  auth.role = opts.role ?? 'admin';
}

function clearAuth() {
  auth.userId = '';
  auth.tenantId = '';
  auth.role = 'admin';
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('GET /api/v1/entitlements — auth', () => {
  it('returns 401 when unauthenticated', async () => {
    clearAuth();
    const res = await request(app).get('/api/v1/entitlements');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// current.* — per-tier resolution
// ---------------------------------------------------------------------------

describe('GET /api/v1/entitlements — current per tier', () => {
  it('free tenant: planId=free, all features false, agents=0', async () => {
    const tenant = await createTestTenant({ tier: 'free' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    const res = await request(app).get('/api/v1/entitlements');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const cur = res.body.data.current;
    expect(cur.planId).toBe('free');
    expect(cur.limits.agents).toBe(0);
    for (const [, val] of Object.entries(cur.features)) {
      expect(val).toBe(false);
    }
  });

  it('essential tenant: planId=essential, expected feature flags + limits', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    const res = await request(app).get('/api/v1/entitlements');
    expect(res.status).toBe(200);

    const cur = res.body.data.current;
    expect(cur.planId).toBe('essential');
    expect(cur.features.unifiedInbox).toBe(true);
    expect(cur.features.bookings).toBe(false);
    expect(cur.features.crm).toBe(false);
    expect(cur.features.hideWidgetAttribution).toBe(false);
    expect(cur.features.customWidgetAppearance).toBe(true);
    expect(cur.limits.agents).toBe(1);
  });

  it('pro tenant: planId=pro, expected feature flags + limits', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    const res = await request(app).get('/api/v1/entitlements');
    expect(res.status).toBe(200);

    const cur = res.body.data.current;
    expect(cur.planId).toBe('pro');
    expect(cur.features.bookings).toBe(true);
    expect(cur.features.calendarIntegrations).toBe(true);
    expect(cur.features.platformAssistant).toBe(true);
    expect(cur.features.crm).toBe(false);
    expect(cur.features.hideWidgetAttribution).toBe(true);
    expect(cur.limits.agents).toBe(1);
  });

  it('enterprise tenant: planId=enterprise, crm=true, agents=2', async () => {
    const tenant = await createTestTenant({ tier: 'enterprise' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    const res = await request(app).get('/api/v1/entitlements');
    expect(res.status).toBe(200);

    const cur = res.body.data.current;
    expect(cur.planId).toBe('enterprise');
    expect(cur.features.crm).toBe(true);
    expect(cur.limits.agents).toBe(2);
  });

  it('enterprise + per-tenant overrides: limits.sessions / dailyLlmCalls reflect the override columns', async () => {
    const tenant = await createTestTenant({
      tier: 'enterprise',
      maxSessions: 5000,
      dailyLlmCallLimit: 100000,
    });
    // Sanity: confirm the row really has those values (the factory default for
    // maxSessions is 100 — overrides must win).
    const persisted = await AppDataSource.getRepository(Tenant).findOneByOrFail({
      id: tenant.id,
    });
    expect(persisted.maxSessions).toBe(5000);
    expect(persisted.dailyLlmCallLimit).toBe(100000);

    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    const res = await request(app).get('/api/v1/entitlements');
    expect(res.status).toBe(200);

    const cur = res.body.data.current;
    expect(cur.limits.sessions).toBe(5000);
    expect(cur.limits.dailyLlmCalls).toBe(100000);
  });
});

// ---------------------------------------------------------------------------
// plans[] catalog
// ---------------------------------------------------------------------------

describe('GET /api/v1/entitlements — plans catalog', () => {
  it('plans excludes free and is sorted by rank: essential, pro, enterprise', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    const res = await request(app).get('/api/v1/entitlements');
    expect(res.status).toBe(200);

    const ids = res.body.data.plans.map((p: { id: string }) => p.id);
    expect(ids).toEqual(['essential', 'pro', 'enterprise']);
  });

  it('plans entries expose priceEurMonthly (Essential 49.99, Pro 99.99, Enterprise null)', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    const res = await request(app).get('/api/v1/entitlements');
    expect(res.status).toBe(200);

    const byId = new Map<string, { priceEurMonthly: number | null }>(
      res.body.data.plans.map((p: { id: string; priceEurMonthly: number | null }) => [p.id, p]),
    );
    expect(byId.get('essential')?.priceEurMonthly).toBe(49.99);
    expect(byId.get('pro')?.priceEurMonthly).toBe(99.99);
    expect(byId.get('enterprise')?.priceEurMonthly).toBeNull();
  });

  it('plans entries expose isSelfServeCheckoutable (true for essential/pro, false for enterprise)', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    const res = await request(app).get('/api/v1/entitlements');
    expect(res.status).toBe(200);

    const byId = new Map<string, { isSelfServeCheckoutable: boolean }>(
      res.body.data.plans.map((p: { id: string; isSelfServeCheckoutable: boolean }) => [p.id, p]),
    );
    expect(byId.get('essential')?.isSelfServeCheckoutable).toBe(true);
    expect(byId.get('pro')?.isSelfServeCheckoutable).toBe(true);
    expect(byId.get('enterprise')?.isSelfServeCheckoutable).toBe(false);
  });

  it('selfServePlans is exactly [essential, pro]', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    const res = await request(app).get('/api/v1/entitlements');
    expect(res.status).toBe(200);
    expect(res.body.data.selfServePlans).toEqual(['essential', 'pro']);
  });
});
