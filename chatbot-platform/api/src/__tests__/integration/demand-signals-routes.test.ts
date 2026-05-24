/**
 * Demand-signals route — HTTP-level coverage for POST /api/v1/demand-signals/notify-me.
 *
 * Subscription/feature-access epic — M0 PR11. Verifies:
 *   - auth (401 when no userId)
 *   - happy-path insert with tenant-snapshotted `currentTier`
 *   - zod validation (unknown feature / empty body / oversized context)
 *   - locale resolution (Accept-Language → first lang, default 'en')
 *   - default context = {}
 *   - rate limit (10/24h per (tenant, feature)), per-feature isolation, and
 *     per-tenant isolation
 *   - returned row shape (asserted against actual response, see notes)
 */

import { describe, it, expect, vi } from 'vitest';
import { vi as viHoist } from 'vitest';

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
import { DemandSignal } from '../../database/entities/DemandSignal';
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
}

const ENDPOINT = '/api/v1/demand-signals/notify-me';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('POST /api/v1/demand-signals/notify-me — auth', () => {
  it('returns 401 when unauthenticated', async () => {
    clearAuth();
    const res = await request(app).post(ENDPOINT).send({ feature: 'tiktok' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// Happy path + tier snapshot + default context
// ---------------------------------------------------------------------------

describe('POST /api/v1/demand-signals/notify-me — happy path', () => {
  it('inserts a row with tenantId/feature/currentTier/context.source', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    const res = await request(app)
      .post(ENDPOINT)
      .send({ feature: 'tiktok', context: { source: 'social_hub_card' } });

    expect([200, 201]).toContain(res.status);
    expect(res.body.success).toBe(true);

    const rows = await AppDataSource.getRepository(DemandSignal).find({
      where: { tenantId: tenant.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(tenant.id);
    expect(rows[0].feature).toBe('tiktok');
    expect(rows[0].currentTier).toBe('essential');
    expect(rows[0].context).toMatchObject({ source: 'social_hub_card' });
  });

  it('snapshots Tenant.tier at click time (pro tenant → currentTier="pro")', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    const res = await request(app).post(ENDPOINT).send({ feature: 'tiktok' });
    expect([200, 201]).toContain(res.status);

    const row = await AppDataSource.getRepository(DemandSignal).findOneByOrFail({
      tenantId: tenant.id,
    });
    expect(row.currentTier).toBe('pro');
  });

  it('persists context = {} when none provided', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    const res = await request(app).post(ENDPOINT).send({ feature: 'tiktok' });
    expect([200, 201]).toContain(res.status);

    const row = await AppDataSource.getRepository(DemandSignal).findOneByOrFail({
      tenantId: tenant.id,
    });
    expect(row.context).toEqual({});
  });

  it('returned row shape includes tenantId / feature / currentTier / locale / createdAt', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    const res = await request(app).post(ENDPOINT).send({ feature: 'tiktok' });
    expect([200, 201]).toContain(res.status);

    const data = res.body.data;
    expect(data).toBeTruthy();
    expect(data.tenantId).toBe(tenant.id);
    expect(data.feature).toBe('tiktok');
    expect(data.currentTier).toBe('essential');
    expect(typeof data.locale).toBe('string');
    expect(data.createdAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
//
// Note: the shared validate() middleware throws ValidationError (HTTP 422),
// not 400. The task spec said "HTTP 400 (zod rejection)", but the actual
// production behavior is 422 per src/middleware/error-handler.ts. We assert
// against the actual behavior — see report notes.

describe('POST /api/v1/demand-signals/notify-me — validation', () => {
  it('rejects an unknown feature (zod allow-list) → 422', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    const res = await request(app)
      .post(ENDPOINT)
      .send({ feature: 'totally_made_up' });
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an empty body → 422', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    const res = await request(app).post(ENDPOINT).send({});
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an oversized context (> 2 KiB JSON) → 422', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    const res = await request(app)
      .post(ENDPOINT)
      .send({ feature: 'tiktok', context: { huge: 'x'.repeat(3000) } });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Locale resolution
// ---------------------------------------------------------------------------

describe('POST /api/v1/demand-signals/notify-me — locale resolution', () => {
  it('Accept-Language: nl-BE,fr;q=0.8 → persisted locale="nl"', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    const res = await request(app)
      .post(ENDPOINT)
      .set('Accept-Language', 'nl-BE,fr;q=0.8')
      .send({ feature: 'tiktok' });
    expect([200, 201]).toContain(res.status);

    const row = await AppDataSource.getRepository(DemandSignal).findOneByOrFail({
      tenantId: tenant.id,
    });
    expect(row.locale).toBe('nl');
  });

  it('no locale info → persisted locale="en"', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    // supertest may set a default Accept-Language; clear it explicitly.
    const res = await request(app)
      .post(ENDPOINT)
      .set('Accept-Language', '')
      .send({ feature: 'tiktok' });
    expect([200, 201]).toContain(res.status);

    const row = await AppDataSource.getRepository(DemandSignal).findOneByOrFail({
      tenantId: tenant.id,
    });
    expect(row.locale).toBe('en');
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('POST /api/v1/demand-signals/notify-me — rate limiting', () => {
  it('11th request for same (tenant, feature) within 24h returns 429 + Retry-After', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    for (let i = 0; i < 10; i++) {
      const res = await request(app).post(ENDPOINT).send({ feature: 'tiktok' });
      expect([200, 201]).toContain(res.status);
    }

    const limited = await request(app).post(ENDPOINT).send({ feature: 'tiktok' });
    expect(limited.status).toBe(429);
    const retryAfter = limited.headers['retry-after'];
    expect(retryAfter).toBeTruthy();
    expect(Number.isInteger(Number(retryAfter))).toBe(true);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it('rate limit is per (tenant, feature) — different feature in the same tenant succeeds', async () => {
    const tenant = await createTestTenant({ tier: 'enterprise' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

    for (let i = 0; i < 10; i++) {
      const res = await request(app).post(ENDPOINT).send({ feature: 'tiktok' });
      expect([200, 201]).toContain(res.status);
    }

    const other = await request(app).post(ENDPOINT).send({ feature: 'crm_native' });
    expect([200, 201]).toContain(other.status);
  });

  it('rate limit is per tenant — second tenant is unaffected', async () => {
    const tenantA = await createTestTenant({ tier: 'essential' });
    const adminA = await createTestUser(tenantA.id, { role: 'admin' });
    setAuth({ tenantId: tenantA.id, userId: adminA.id });

    for (let i = 0; i < 10; i++) {
      const res = await request(app).post(ENDPOINT).send({ feature: 'tiktok' });
      expect([200, 201]).toContain(res.status);
    }

    const tenantB = await createTestTenant({ tier: 'essential' });
    const adminB = await createTestUser(tenantB.id, { role: 'admin' });
    setAuth({ tenantId: tenantB.id, userId: adminB.id });

    const res = await request(app).post(ENDPOINT).send({ feature: 'tiktok' });
    expect([200, 201]).toContain(res.status);
  });
});
