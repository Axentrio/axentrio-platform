/**
 * Wire-envelope tests for the 4 Phase 3B route-migration sites.
 *
 * Plan: chatbot-platform/docs/api-response-standardization-plan.md §3.2, §3.3,
 * §4 Phase 3.
 *
 * Sites covered:
 *   1. admin.routes.ts L115 — resend invite, Clerk-upstream-failure path.
 *   2. admin.routes.ts L333 — create-tenant, Clerk-upstream-failure path.
 *      (Skipped at the wire-test layer — the create-tenant handler runs a
 *      compensating DB transaction after the Clerk failure that requires a
 *      deep mock cascade. The synchronous typed-throw is verified via the
 *      unit reading; documented in the phase report.)
 *   3. admin.routes.ts L705 — invite member, Clerk-upstream-failure path.
 *   4. billing.routes.ts requireBillingAdmin — non-admin role 403 gate.
 *   5. webhook-admin.routes.ts /test — target-webhook-failure contract change.
 *   6. widget.ts /config — simpleRateLimit 429 gate.
 *
 * Each test mounts the real router on a minimal Express app, stubs the
 * upstream dependencies that would otherwise need a database / Clerk, and
 * asserts the global error handler emits the canonical envelope shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';

// ─── Hoisted mocks (must be declared before any `import` of code-under-test) ──
const {
  inviteToClerkOrganization,
  createClerkOrganization,
  pendingInviteFindOne,
  tenantFindOne,
  axiosPost,
} = vi.hoisted(() => ({
  inviteToClerkOrganization: vi.fn(),
  createClerkOrganization: vi.fn(),
  pendingInviteFindOne: vi.fn(),
  tenantFindOne: vi.fn(),
  axiosPost: vi.fn(),
}));

// Stub Clerk SDK so importing clerk middleware doesn't blow up.
vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Stub the Clerk wrappers used by admin.routes.ts. Default: success; override
// per-test to return null/false to hit the upstream-failure branches.
vi.mock('../../services/clerk-sync.service', () => ({
  createClerkOrganization,
  inviteToClerkOrganization,
  getAllOrgMemberships: vi.fn().mockResolvedValue([]),
  addMemberToClerkOrganization: vi.fn(),
  removeFromClerkOrganization: vi.fn(),
  deleteClerkOrganization: vi.fn(),
  updateClerkOrganization: vi.fn(),
}));

// Bypass the Clerk + super-admin guards on the admin router so we can reach
// the handler logic. Each guard is a no-op next() in this test harness.
vi.mock('../../middleware/clerk.middleware', () => ({
  // Idempotent: only fills `req.user`/`req.userId` if the test harness hasn't
  // already set them. Lets per-test pre-middleware override role for the
  // billing-admin-gate test.
  requireClerkAuth: (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      req.user = {
        id: 'test-user',
        role: 'super_admin',
        clerkUserId: 'clerk_test',
      } as Request['user'];
    }
    if (!req.userId) req.userId = 'test-user';
    next();
  },
  autoProvision: (_req: Request, _res: Response, next: NextFunction) => next(),
  invalidateProvisionCache: vi.fn(),
}));

vi.mock('../../middleware/super-admin.middleware', () => ({
  requireSuperAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  resolveTenantContext: (req: Request, _res: Response, next: NextFunction) => {
    req.tenantId = 'tenant-test';
    next();
  },
}));

// Audit logging is fire-and-forget side-effect; no-op for tests.
vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

// AppDataSource.getRepository(entity) returns a stub repository keyed by
// entity.name. Per-test, callers override findOne/save behavior on the
// shared spy objects.
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name?: string }) => {
      const name = entity?.name ?? '';
      if (name === 'PendingInvite') return { findOne: pendingInviteFindOne, save: vi.fn() };
      if (name === 'Tenant') return { findOne: tenantFindOne, save: vi.fn() };
      if (name === 'WebhookDeliveryLog') {
        return {
          create: (x: unknown) => x,
          save: vi.fn().mockResolvedValue(undefined),
          findOne: vi.fn().mockResolvedValue(null),
          createQueryBuilder: () => ({
            where: () => ({ orderBy: () => ({}) }),
          }),
        };
      }
      return { findOne: vi.fn(), save: vi.fn() };
    },
  },
  runInTransaction: async (fn: (manager: unknown) => Promise<unknown>) => fn({}),
}));

// Stub axios so the webhook-test handler hits our controlled failure path.
vi.mock('axios', () => ({
  default: { post: axiosPost, request: axiosPost },
}));

// The SSRF guard (#A) now routes the webhook test through `safeOutboundRequest`
// (which asserts the URL then calls axios.request). Mock just that seam so the
// existing axiosPost setups drive the outbound result without real DNS/SSRF checks.
vi.mock('../../security/ssrf-guard', async (orig) => ({
  ...(await orig<typeof import('../../security/ssrf-guard')>()),
  safeOutboundRequest: (...args: unknown[]) => axiosPost(...args),
}));

// Stub logger / Sentry so noise doesn't reach the console.
vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Now import the code under test.
import adminRoutes from '../../routes/admin.routes';
import billingRoutes from '../../routes/billing.routes';
import webhookAdminRoutes from '../../routes/webhook-admin.routes';
import { widgetRouter } from '../../routes/widget';
import { errorHandler } from '../../middleware/error-handler';
import { requestIdMiddleware } from '../../middleware/request-id.middleware';

function makeApp(mount: (app: express.Express) => void): express.Express {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  mount(app);
  app.use(errorHandler);
  return app;
}

const ENVELOPE_META = {
  timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  requestId: expect.any(String),
  path: expect.any(String),
};

beforeEach(() => {
  inviteToClerkOrganization.mockReset();
  createClerkOrganization.mockReset();
  pendingInviteFindOne.mockReset();
  tenantFindOne.mockReset();
  axiosPost.mockReset();
});

// ─── 1. admin.routes.ts L115 — resend invite, Clerk upstream failure ─────────

describe('admin.routes — resend invite Clerk upstream failure (L115)', () => {
  const app = makeApp((a) => a.use('/admin', adminRoutes));

  it('emits 502 CLERK_UPSTREAM_FAILED envelope when inviteToClerkOrganization returns false', async () => {
    pendingInviteFindOne.mockResolvedValue({
      id: 'invite-1',
      tenantId: 'tenant-1',
      email: 'foo@bar.com',
      role: 'agent',
    });
    tenantFindOne.mockResolvedValue({ id: 'tenant-1', clerkOrgId: 'org_x' });
    inviteToClerkOrganization.mockResolvedValue(false);

    const res = await request(app)
      .post('/admin/tenants/tenant-1/pending-invites/invite-1/resend')
      .send();

    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'CLERK_UPSTREAM_FAILED', message: 'Failed to resend Clerk invitation' },
      meta: {
        ...ENVELOPE_META,
        path: '/admin/tenants/tenant-1/pending-invites/invite-1/resend',
      },
    });
  });
});

// ─── 3. admin.routes.ts L705 — invite member, Clerk upstream failure ─────────

describe('admin.routes — invite member Clerk upstream failure (L705)', () => {
  const app = makeApp((a) => a.use('/admin', adminRoutes));

  it('emits 502 CLERK_UPSTREAM_FAILED envelope when inviteToClerkOrganization returns false', async () => {
    tenantFindOne.mockResolvedValue({ id: 'tenant-1', clerkOrgId: 'org_x' });
    inviteToClerkOrganization.mockResolvedValue(false);

    const res = await request(app)
      .post('/admin/tenants/tenant-1/invite')
      .send({ email: 'new@user.com', name: 'New User', role: 'agent' });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'CLERK_UPSTREAM_FAILED', message: 'Failed to send invite via Clerk' },
      meta: { ...ENVELOPE_META, path: '/admin/tenants/tenant-1/invite' },
    });
  });
});

// ─── 4. billing.routes.ts — requireBillingAdmin gate ─────────────────────────

describe('billing.routes — requireBillingAdmin (L66-75)', () => {
  // Override the clerk auth stub for this suite so we control `req.user.role`.
  function makeBillingApp(role: string): express.Express {
    return makeApp((a) => {
      a.use((req, _res, next) => {
        req.user = { id: 'u1', role, clerkUserId: 'c1' } as Request['user'];
        req.userId = 'u1';
        next();
      });
      a.use('/billing', billingRoutes);
    });
  }

  it('emits 403 FORBIDDEN envelope when role is not admin/super_admin', async () => {
    const app = makeBillingApp('agent');

    const res = await request(app).get('/billing/state');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Admin access required' },
      meta: { ...ENVELOPE_META, path: '/billing/state' },
    });
  });
});

// ─── 5. webhook-admin.routes.ts /test — testFailed contract change ───────────

describe('webhook-admin.routes — POST /test target-webhook-failed contract (L132)', () => {
  const app = makeApp((a) => {
    // The router relies on req.tenantId being set by upstream middleware.
    a.use((req, _res, next) => {
      req.tenantId = 'tenant-1';
      next();
    });
    a.use('/webhooks', webhookAdminRoutes);
  });

  it('emits success envelope with testFailed:true on the wire when the target webhook errors', async () => {
    tenantFindOne.mockResolvedValue({
      id: 'tenant-1',
      webhookUrl: 'https://example.com/hook',
      webhookSecret: null,
    });
    // Simulate the target webhook responding with an HTTP error.
    const err = Object.assign(new Error('Boom from target'), {
      response: { status: 500 },
    });
    axiosPost.mockRejectedValue(err);

    const res = await request(app).post('/webhooks/test').send();

    expect(res.status).toBe(200);
    // Wire shape: { success: true, data: { ..., testFailed: true } }
    expect(res.body).toMatchObject({
      success: true,
      data: {
        status: 500,
        testFailed: true,
        error: 'Boom from target',
        durationMs: expect.any(Number),
      },
    });
  });

  it('still emits success envelope WITHOUT testFailed when the target webhook succeeds', async () => {
    tenantFindOne.mockResolvedValue({
      id: 'tenant-1',
      webhookUrl: 'https://example.com/hook',
      webhookSecret: null,
    });
    axiosPost.mockResolvedValue({ status: 200 });

    const res = await request(app).post('/webhooks/test').send();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { status: 200, durationMs: expect.any(Number) },
    });
    expect((res.body as { data: { testFailed?: boolean } }).data.testFailed).toBeUndefined();
  });
});

// ─── 6. widget.ts /config — simpleRateLimit 429 envelope (L46) ───────────────

describe('widget.ts — simpleRateLimit envelope (L45-47)', () => {
  // simpleRateLimit on /config = 30/min per IP. Exhaust by sending 30 requests
  // (any response — the rate-limit fires before any DB lookup as long as the
  // bucket is full) and assert the 31st emits the envelope 429.
  const app = makeApp((a) => a.use('/widget', widgetRouter));

  it('emits 429 RATE_LIMIT_EXCEEDED envelope when the per-IP burst is exhausted', async () => {
    // Drain the bucket. The handler itself will 400 (no apiKey) but that's
    // irrelevant — we only care about the 31st response, which is the
    // rate-limit denial.
    for (let i = 0; i < 30; i++) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).get('/widget/config');
    }

    const res = await request(app).get('/widget/config');

    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests, please try again later',
      },
      meta: { ...ENVELOPE_META, path: '/widget/config' },
    });
  });
});
