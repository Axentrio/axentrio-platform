/**
 * Wire-envelope tests for the Phase 4 `routes/tenants.ts` migration.
 *
 * Plan: chatbot-platform/docs/api-response-standardization-plan.md §3.2 (the
 * row for `routes/tenants.ts`), §3.4a (status-code preservation), and §4
 * Phase 4.
 *
 * `tenants.ts` is the biggest single migration in the routes layer
 * (~30 sites). Rather than one test per site, the tests below lock in the
 * unique wire shapes the file emits, grouped by category:
 *
 *   1. Success WITH data (`sendSuccess`)           — GET /me, GET /me/users.
 *   2. Success-with-message (`sendSuccess({message})`) — invite endpoints.
 *   3. Success CREATED (`sendCreated`)             — POST /me/users (201).
 *   4. BadRequestError typed throw                 — guard rejections (400).
 *   5. NotFoundError typed throw                   — invite/user-not-found (404).
 *   6. ApiError(502, CLERK_UPSTREAM_FAILED)        — Clerk wrapper failure.
 *   7. Paginated success shape                     — pagination meta nesting.
 *
 * Each test mounts the real `tenantRouter` behind the request-id +
 * errorHandler stack, mocks `AppDataSource.getRepository(...)` per the
 * pattern in `route-phase3a-wire.test.ts` / `route-phase3b-wire.test.ts`,
 * and asserts the canonical wire envelope.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';

const TENANT_UUID = '11111111-1111-4111-8111-111111111111';
const USER_UUID = '22222222-2222-4222-8222-222222222222';
const OTHER_USER_UUID = '33333333-3333-4333-8333-333333333333';
const INVITE_UUID = '44444444-4444-4444-8444-444444444444';

const {
  tenantFindOne,
  tenantSave,
  userFindOne,
  userSave,
  userCount,
  userCreateQB,
  pendingInviteFind,
  pendingInviteFindOne,
  pendingInviteCreateQB,
  pendingInviteSave,
  pendingInviteRemove,
  chatSessionQB,
  botFindOne,
  botSave,
  appQuery,
  inviteToClerkOrganization,
  revokeAndResendClerkInvitation,
} = vi.hoisted(() => ({
  tenantFindOne: vi.fn(),
  tenantSave: vi.fn(),
  userFindOne: vi.fn(),
  userSave: vi.fn(),
  userCount: vi.fn(),
  userCreateQB: vi.fn(),
  pendingInviteFind: vi.fn(),
  pendingInviteFindOne: vi.fn(),
  pendingInviteCreateQB: vi.fn(),
  pendingInviteSave: vi.fn(),
  pendingInviteRemove: vi.fn(),
  chatSessionQB: vi.fn(),
  // Multi-bot Phase 4 (#16d): GET /me + PATCH /me now hydrate from anchor bot.
  botFindOne: vi.fn(),
  botSave: vi.fn(),
  appQuery: vi.fn(),
  inviteToClerkOrganization: vi.fn(),
  revokeAndResendClerkInvitation: vi.fn(),
}));

vi.mock('@clerk/express', () => ({
  clerkClient: {
    organizations: { getOrganizationMembershipList: vi.fn().mockResolvedValue({ data: [] }) },
    users: { getUser: vi.fn() },
  },
  clerkMiddleware: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../services/clerk-sync.service', () => ({
  inviteToClerkOrganization,
  revokeAndResendClerkInvitation,
  revokeClerkInvitation: vi.fn().mockResolvedValue(true),
  getAllOrgMemberships: vi.fn().mockResolvedValue([]),
  addMemberToClerkOrganization: vi.fn().mockResolvedValue(true),
  removeFromClerkOrganization: vi.fn().mockResolvedValue(true),
}));

// Bypass Clerk auth + auto-provision: inject a stable admin user. The fake
// user.id is `USER_UUID` so the deactivate-yourself guard fires when we
// target that same id (and does NOT fire when we target OTHER_USER_UUID).
vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      id: USER_UUID,
      email: 'admin@example.com',
      role: 'admin',
      tenantId: TENANT_UUID,
      clerkUserId: 'clerk_admin',
      type: 'agent',
    } as never;
    req.userId = USER_UUID;
    next();
  },
  autoProvision: (_req: Request, _res: Response, next: NextFunction) => next(),
  invalidateProvisionCache: vi.fn(),
}));

vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
}));

vi.mock('../../utils/releaseAgentSessions', () => ({
  releaseAgentSessions: vi.fn().mockResolvedValue({
    releasedSessions: 0,
    returnedHandoffs: 0,
    affectedSessionIds: [],
  }),
}));

vi.mock('../../billing/enforce', () => ({
  requireFeature: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name?: string }) => {
      const name = entity?.name ?? '';
      if (name === 'Tenant') {
        return { findOne: tenantFindOne, save: tenantSave };
      }
      if (name === 'User') {
        return {
          findOne: userFindOne,
          save: userSave,
          count: userCount,
          create: (x: unknown) => x,
          createQueryBuilder: userCreateQB,
        };
      }
      if (name === 'PendingInvite') {
        return {
          find: pendingInviteFind,
          findOne: pendingInviteFindOne,
          createQueryBuilder: pendingInviteCreateQB,
          save: pendingInviteSave,
          remove: pendingInviteRemove,
        };
      }
      if (name === 'ChatSession') {
        return { createQueryBuilder: chatSessionQB };
      }
      if (name === 'Agent') {
        return { createQueryBuilder: vi.fn() };
      }
      if (name === 'Bot') {
        return { findOne: botFindOne, save: botSave };
      }
      return { findOne: vi.fn(), save: vi.fn() };
    },
    query: appQuery,
    transaction: async (fn: (manager: unknown) => Promise<unknown>) =>
      fn({ save: vi.fn().mockResolvedValue(undefined) }),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Now import the code under test.
import { tenantRouter } from '../../routes/tenants';
import { errorHandler } from '../../middleware/error-handler';
import { requestIdMiddleware } from '../../middleware/request-id.middleware';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/tenants', tenantRouter);
  app.use(errorHandler);
  return app;
}

const ENVELOPE_META = {
  timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  requestId: expect.any(String),
  path: expect.any(String),
};

beforeEach(() => {
  tenantFindOne.mockReset();
  tenantSave.mockReset();
  userFindOne.mockReset();
  userSave.mockReset();
  userCount.mockReset();
  userCreateQB.mockReset();
  botFindOne.mockReset();
  botSave.mockReset();
  pendingInviteFind.mockReset();
  pendingInviteFindOne.mockReset();
  pendingInviteCreateQB.mockReset();
  pendingInviteSave.mockReset();
  pendingInviteRemove.mockReset();
  chatSessionQB.mockReset();
  appQuery.mockReset();
  inviteToClerkOrganization.mockReset();
  revokeAndResendClerkInvitation.mockReset();
});

// ─── 1. Success-with-data (sendSuccess) ─────────────────────────────────────

describe('tenants.ts — GET /me success envelope (sendSuccess with data)', () => {
  it('emits { success:true, data:{...} } envelope', async () => {
    tenantFindOne.mockResolvedValue({
      id: TENANT_UUID,
      name: 'Acme',
      slug: 'acme',
      apiKey: 'k_abc',
      tier: 'free',
      status: 'active',
      settings: {},
      maxSessions: 10,
      currentSessions: 0,
      webhookUrl: null,
      webhookSecret: null,
      customDomain: null,
      createdAt: new Date('2026-05-20T00:00:00Z'),
    });
    // GET /me probes ChatSession via createQueryBuilder().where().andWhere()...getExists()
    chatSessionQB.mockReturnValue({
      where: () => ({
        andWhere: () => ({
          andWhere: () => ({ getExists: () => Promise.resolve(false) }),
        }),
      }),
    });

    const res = await request(makeApp()).get('/tenants/me');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { id: TENANT_UUID, name: 'Acme', slug: 'acme' },
    });
    // No envelope-level error / meta keys.
    expect(res.body).not.toHaveProperty('error');
  });
});

// ─── 2. Success-with-message (sendSuccess({ message })) ─────────────────────

describe('tenants.ts — POST /me/invite success-with-message envelope', () => {
  it('emits { success:true, data:{ message:"Invitation sent" } }', async () => {
    tenantFindOne.mockResolvedValue({ id: TENANT_UUID, clerkOrgId: 'org_x' });
    inviteToClerkOrganization.mockResolvedValue(true);
    pendingInviteCreateQB.mockReturnValue({
      insert: () => ({
        into: () => ({
          values: () => ({
            orUpdate: () => ({ execute: () => Promise.resolve(undefined) }),
          }),
        }),
      }),
    });
    pendingInviteFindOne.mockResolvedValue({ id: INVITE_UUID });

    const res = await request(makeApp())
      .post('/tenants/me/invite')
      .send({ email: 'new@user.com', role: 'agent' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { message: 'Invitation sent' },
    });
  });
});

// ─── 3. sendCreated (201) ───────────────────────────────────────────────────

describe('tenants.ts — POST /me/users sendCreated envelope (201)', () => {
  it('emits 201 + { success:true, data:{ id, email, ... } }', async () => {
    userFindOne.mockResolvedValueOnce(null); // existing-check returns null
    // The handler then calls userRepository.create(...) and userRepository.save(...)
    // — create is `(x) => x` per the mock; save mutates `id` on the entity.
    userSave.mockImplementation(async (entity: { id?: string; createdAt?: Date }) => {
      entity.id = OTHER_USER_UUID;
      entity.createdAt = new Date('2026-05-20T00:00:00Z');
      return entity;
    });

    const res = await request(makeApp())
      .post('/tenants/me/users')
      .send({ email: 'new@user.com', name: 'New', role: 'agent' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        id: OTHER_USER_UUID,
        email: 'new@user.com',
        name: 'New',
        role: 'agent',
        isActive: true,
      },
    });
  });
});

// ─── 4. BadRequestError typed throw ─────────────────────────────────────────

describe('tenants.ts — guard rejection emits 400 BAD_REQUEST envelope', () => {
  it('PATCH /me with settings.ai → 400 envelope (AI settings guard)', async () => {
    tenantFindOne.mockResolvedValue({
      id: TENANT_UUID,
      name: 'Acme',
      settings: {},
    });

    const res = await request(makeApp())
      .patch('/tenants/me')
      .send({ settings: { ai: { enabled: true } } });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message:
          'AI settings cannot be updated via this endpoint. Use PATCH /tenants/me/ai-settings instead.',
      },
      meta: { ...ENVELOPE_META, path: '/tenants/me' },
    });
  });

  it('POST /me/users/:id/deactivate with self id → 400 "Cannot deactivate yourself"', async () => {
    const res = await request(makeApp()).post(
      `/tenants/me/users/${USER_UUID}/deactivate`,
    );

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'Cannot deactivate yourself' },
    });
  });
});

// ─── 5. NotFoundError typed throw ───────────────────────────────────────────

describe('tenants.ts — NotFoundError emits 404 NOT_FOUND envelope', () => {
  it('DELETE /me/pending-invites/:id → 404 when invite is missing', async () => {
    pendingInviteFindOne.mockResolvedValue(null);

    const res = await request(makeApp()).delete(
      `/tenants/me/pending-invites/${INVITE_UUID}`,
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Invite not found' },
      meta: { ...ENVELOPE_META, path: `/tenants/me/pending-invites/${INVITE_UUID}` },
    });
  });

  it('POST /me/users/:id/reactivate → 404 when user is missing', async () => {
    userFindOne.mockResolvedValue(null);

    const res = await request(makeApp()).post(
      `/tenants/me/users/${OTHER_USER_UUID}/reactivate`,
    );

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND', message: 'User not found in this tenant' },
    });
  });
});

// ─── 6. ApiError(502, CLERK_UPSTREAM_FAILED) ────────────────────────────────

describe('tenants.ts — Clerk upstream failure emits 502 CLERK_UPSTREAM_FAILED', () => {
  it('POST /me/invite → 502 envelope when inviteToClerkOrganization returns false', async () => {
    tenantFindOne.mockResolvedValue({ id: TENANT_UUID, clerkOrgId: 'org_x' });
    inviteToClerkOrganization.mockResolvedValue(false);

    const res = await request(makeApp())
      .post('/tenants/me/invite')
      .send({ email: 'foo@bar.com', role: 'agent' });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'CLERK_UPSTREAM_FAILED',
        message: 'Failed to send invite via Clerk',
      },
      meta: { ...ENVELOPE_META, path: '/tenants/me/invite' },
    });
  });

  it('POST /me/pending-invites/:id/resend → 502 envelope when revokeAndResend returns ok:false', async () => {
    pendingInviteFindOne.mockResolvedValue({
      id: INVITE_UUID,
      tenantId: TENANT_UUID,
      email: 'foo@bar.com',
      role: 'agent',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    tenantFindOne.mockResolvedValue({ id: TENANT_UUID, clerkOrgId: 'org_x' });
    revokeAndResendClerkInvitation.mockResolvedValue({
      ok: false,
      code: 'clerk_500',
      message: 'Clerk service unavailable',
    });

    const res = await request(makeApp()).post(
      `/tenants/me/pending-invites/${INVITE_UUID}/resend`,
    );

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'CLERK_UPSTREAM_FAILED',
        message: 'Clerk service unavailable',
      },
    });
  });
});

// ─── 7. Paginated success shape ─────────────────────────────────────────────

describe('tenants.ts — GET /me/users paginated success envelope', () => {
  it('emits { success:true, data:[...], meta:{ pagination:{...} } }', async () => {
    // applyPagination() uses the qb instance directly — mock it to return
    // shaped results without touching a database.
    const rows = [
      {
        id: USER_UUID,
        email: 'a@b.c',
        name: 'A',
        role: 'admin',
        isActive: true,
        avatarUrl: null,
        lastLoginAt: null,
        createdAt: new Date('2026-05-20T00:00:00Z'),
      },
    ];
    // applyPagination calls `qb.skip(...).take(...)` on the same instance
    // and then `qb.getManyAndCount()`. The qb chain returned from
    // createQueryBuilder().select().where().andWhere() must therefore be the
    // SAME object that exposes skip/take/getManyAndCount. We use a single
    // fluent object whose chain methods return `this`.
    const qb: Record<string, unknown> = {};
    Object.assign(qb, {
      alias: 'user',
      select: () => qb,
      where: () => qb,
      andWhere: () => qb,
      orderBy: () => qb,
      skip: () => qb,
      take: () => qb,
      getManyAndCount: () => Promise.resolve([rows, rows.length]),
      // The SQL-injection guard (#B) reads entity column metadata + existing orderBys
      // off the query builder; provide them so applyPagination's default-sort path works.
      expressionMap: {
        mainAlias: {
          metadata: {
            columns: [
              { propertyName: 'createdAt', databaseName: 'created_at' },
              { propertyName: 'id', databaseName: 'id' },
            ],
          },
        },
        orderBys: {},
      },
    });
    userCreateQB.mockReturnValue(qb);

    const res = await request(makeApp()).get('/tenants/me/users');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: [{ id: USER_UUID, email: 'a@b.c' }],
      meta: {
        pagination: {
          page: 1,
          limit: 20,
          total: 1,
        },
      },
    });
  });
});
