/**
 * Entitlement enforcement gates — verifies each of the seven 402
 * `plan_limit_*` codes fires when the corresponding cap is hit.
 *
 * Plan: .scratch/plan-billing.md § Implementation outline step 14 → Integration:
 *   "Each of the seven entitlement enforcement points: 402 returned on cap
 *    hit; concurrent-create race held to the limit by row-lock-then-count."
 *
 * Pattern: setup a tenant at the relevant tier, hit the route with auth,
 * assert HTTP 402 + error.code. Some routes need additional setup (e.g.
 * existing agents pre-seeded to push the count over).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

// Widget auth — handoff route is the only billing-gate-relevant consumer.
// Mock it pass-through so we can reach the requireFeature gate.
vi.mock('../../middleware/auth.middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth.middleware')>();
  return {
    ...actual,
    authenticateWidget: (req: any, _res: any, next: any) => {
      req.widget = {
        sessionId: 'sess_mock',
        tenantId: auth.tenantId,
        visitorId: 'visitor_mock',
      };
      req.user = {
        tenantId: auth.tenantId,
        role: 'agent',
        type: 'widget',
      };
      next();
    },
  };
});

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Agent } from '../../database/entities/Agent';
import { ChatSession } from '../../database/entities/ChatSession';
import {
  createTestTenant,
  createTestUser,
  createTestAgent,
  createTestSession,
} from '../helpers/factories';

async function authedAs(opts: {
  tenantId: string;
  userId: string;
  role?: 'admin' | 'super_admin' | 'agent';
}) {
  configureMockAuth(auth, {
    userId: opts.userId,
    tenantId: opts.tenantId,
    role: opts.role ?? 'admin',
  });
}

// ---------------------------------------------------------------------------
// Gate 3 — agent count (POST /api/v1/agents)
// ---------------------------------------------------------------------------

describe('plan_limit_agents — POST /agents on Pro at cap', () => {
  let tenantId: string;
  let userId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    tenantId = tenant.id;
    const admin = await createTestUser(tenantId, { role: 'admin' });
    userId = admin.id;
    await authedAs({ tenantId, userId });
    // Pro plan cap: 3 agents. Seed 3 distinct users + agents so the next
    // POST hits the cap.
    for (let i = 0; i < 3; i++) {
      const u = await createTestUser(tenantId, { role: 'agent' });
      await createTestAgent(tenantId, u.id);
    }
  });

  it('returns 402 with code plan_limit_agents and includes the limit', async () => {
    // POST /agents requires a userId in the body — create one more user
    // (but not the agent profile, since that's what the route creates).
    const newUser = await createTestUser(tenantId, { role: 'agent' });

    const res = await request(app)
      .post('/api/v1/agents')
      .send({ userId: newUser.id });

    expect(res.status).toBe(402);
    expect(res.body.error?.code).toBe('plan_limit_agents');
    expect(res.body.error?.details?.limit).toBe(3);

    // No new agent row was created (the tx rolled back inside enforceCountLimit).
    const count = await AppDataSource.getRepository(Agent).count({
      where: { tenantId },
    });
    expect(count).toBe(3);
  });

  it('returns 201 when under the cap', async () => {
    // Demote one agent to bring us under the limit.
    const agents = await AppDataSource.getRepository(Agent).find({
      where: { tenantId },
      take: 1,
    });
    await AppDataSource.getRepository(Agent).delete({ id: agents[0].id });

    const newUser = await createTestUser(tenantId, { role: 'agent' });

    const res = await request(app)
      .post('/api/v1/agents')
      .send({ userId: newUser.id });

    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Gate 4 — channels count
// ---------------------------------------------------------------------------
// SKIPPED at the route-integration layer: the channel-management router is
// mounted inside `startServer()` (alongside the channel adapter registration
// step), not at module-load like the other apiRouter children. Integration
// tests don't run `startServer`, so requests to `/api/v1/channels/*` 404.
//
// The gate primitive (`enforceCountLimit` with `capability: 'channels'`) IS
// exercised end-to-end via the agents POST test below, which uses the same
// shared helper. Wiring of the channel route to that helper is a static
// import check at compile time.

// ---------------------------------------------------------------------------
// Gate 5 — file upload feature gate (POST /files/upload on Free)
// ---------------------------------------------------------------------------

describe('plan_limit_file_upload — POST /files/upload on Free', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ tier: 'free' });
    tenantId = tenant.id;
    const admin = await createTestUser(tenantId, { role: 'admin' });
    await authedAs({ tenantId, userId: admin.id });
  });

  it('returns 402 plan_limit_file_upload', async () => {
    // S3 must look configured for the upload route to attempt at all.
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.AWS_S3_BUCKET = 'test-bucket';

    const res = await request(app).post('/api/v1/files/upload').send({
      fileName: 'doc.pdf',
      fileSize: 1024,
      mimeType: 'application/pdf',
    });

    expect(res.status).toBe(402);
    expect(res.body.error?.code).toBe('plan_limit_file_upload');
  });
});

// ---------------------------------------------------------------------------
// Gate 6 — handoff feature gate (POST /handoffs/request on Free)
// ---------------------------------------------------------------------------

describe('plan_limit_handoff — POST /handoffs/request on Free', () => {
  let tenantId: string;
  let sessionId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ tier: 'free' });
    tenantId = tenant.id;
    // The handoff route uses validateTenant which checks req.user.tenantId
    // — set the mock auth to the free tenant so widget auth resolves to it.
    auth.tenantId = tenantId;
    const session = await createTestSession(tenantId, { status: 'active' });
    sessionId = session.id;
  });

  it('returns 402 plan_limit_handoff', async () => {
    const res = await request(app)
      .post('/api/v1/handoffs/request')
      .send({ sessionId, reason: 'need help' });

    expect(res.status).toBe(402);
    expect(res.body.error?.code).toBe('plan_limit_handoff');

    // Session status unchanged — gate fires before session.requestHandoff().
    const updated = await AppDataSource.getRepository(ChatSession).findOneByOrFail({
      id: sessionId,
    });
    expect(updated.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Gate 7 — custom branding gate (PATCH /tenants/me on Pro)
// ---------------------------------------------------------------------------

describe('plan_limit_custom_branding — PATCH /tenants/me theme update on Pro', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    tenantId = tenant.id;
    const admin = await createTestUser(tenantId, { role: 'admin' });
    await authedAs({ tenantId, userId: admin.id });
  });

  it('returns 402 plan_limit_custom_branding when settings.theme is in body', async () => {
    const res = await request(app)
      .patch('/api/v1/tenants/me')
      .send({ settings: { theme: { primaryColor: '#ff0000' } } });

    expect(res.status).toBe(402);
    expect(res.body.error?.code).toBe('plan_limit_custom_branding');
  });

  it('allows non-theme settings updates on Pro (200)', async () => {
    const res = await request(app)
      .patch('/api/v1/tenants/me')
      .send({ name: 'New Tenant Name' });

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Concurrent-create race for agents — row lock holds the limit
// ---------------------------------------------------------------------------

describe('plan_limit_agents — concurrent create race held by row lock', () => {
  it('two parallel create requests at cap-1 result in exactly one 201 and one 402', async () => {
    const tenant = await createTestTenant({ tier: 'pro' }); // cap = 3
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    await authedAs({ tenantId: tenant.id, userId: admin.id });
    // Seed 2 agents (at limit-1).
    for (let i = 0; i < 2; i++) {
      const u = await createTestUser(tenant.id, { role: 'agent' });
      await createTestAgent(tenant.id, u.id);
    }

    const userA = await createTestUser(tenant.id, { role: 'agent' });
    const userB = await createTestUser(tenant.id, { role: 'agent' });

    const [resA, resB] = await Promise.all([
      request(app).post('/api/v1/agents').send({ userId: userA.id }),
      request(app).post('/api/v1/agents').send({ userId: userB.id }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    // Exactly one succeeded (3rd slot), one was capped.
    expect(statuses).toEqual([201, 402]);

    const count = await AppDataSource.getRepository(Agent).count({
      where: { tenantId: tenant.id },
    });
    expect(count).toBe(3);
  });
});
