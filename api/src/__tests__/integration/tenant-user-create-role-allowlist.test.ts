/**
 * Privilege-escalation regression test for POST /api/v1/tenants/me/users.
 *
 * A tenant admin must not create a `super_admin` user. `super_admin` unlocks
 * every other tenant through the `X-Tenant-Context` header, so the create
 * route must apply the same role allowlist as `updateTenantUserRole`.
 *
 * The mocking shape follows `route-phase4-tenants-wire.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';

const TENANT_UUID = '11111111-1111-4111-8111-111111111111';
const USER_UUID = '22222222-2222-4222-8222-222222222222';
const NEW_USER_UUID = '33333333-3333-4333-8333-333333333333';

const { tenantFindOne, userFindOne, userSave, userCount, userCreateQB, appQuery } = vi.hoisted(
  () => ({
    tenantFindOne: vi.fn(),
    userFindOne: vi.fn(),
    userSave: vi.fn(),
    userCount: vi.fn(),
    userCreateQB: vi.fn(),
    appQuery: vi.fn(),
  }),
);

vi.mock('@clerk/express', () => ({
  clerkClient: {
    organizations: { getOrganizationMembershipList: vi.fn().mockResolvedValue({ data: [] }) },
    users: { getUser: vi.fn() },
  },
  clerkMiddleware: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../services/clerk-sync.service', () => ({
  inviteToClerkOrganization: vi.fn().mockResolvedValue(true),
  revokeAndResendClerkInvitation: vi.fn().mockResolvedValue(true),
  revokeClerkInvitation: vi.fn().mockResolvedValue(true),
  getAllOrgMemberships: vi.fn().mockResolvedValue([]),
  addMemberToClerkOrganization: vi.fn().mockResolvedValue(true),
  removeFromClerkOrganization: vi.fn().mockResolvedValue(true),
}));

// Bypass Clerk auth: inject a stable tenant admin.
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

vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

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
        return { findOne: tenantFindOne, save: vi.fn() };
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
      return { findOne: vi.fn(), save: vi.fn(), createQueryBuilder: vi.fn() };
    },
    query: appQuery,
    transaction: async (fn: (manager: unknown) => Promise<unknown>) =>
      fn({ save: vi.fn().mockResolvedValue(undefined) }),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

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

beforeEach(() => {
  tenantFindOne.mockReset();
  userFindOne.mockReset();
  userSave.mockReset();
  userCount.mockReset();
  userCreateQB.mockReset();
  appQuery.mockReset();
  userFindOne.mockResolvedValue(null);
  userSave.mockImplementation(async (entity: { id?: string; createdAt?: Date }) => {
    entity.id = NEW_USER_UUID;
    entity.createdAt = new Date('2026-05-20T00:00:00Z');
    return entity;
  });
});

describe('POST /tenants/me/users role allowlist', () => {
  it('rejects role "super_admin" and saves no user', async () => {
    const res = await request(makeApp())
      .post('/tenants/me/users')
      .send({ email: 'escalate@user.com', name: 'Escalate', role: 'super_admin' });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      success: false,
      error: { message: 'Invalid role' },
    });
    expect(userSave).not.toHaveBeenCalled();
  });

  it('still creates a user with the legitimate role "agent"', async () => {
    const res = await request(makeApp())
      .post('/tenants/me/users')
      .send({ email: 'new@user.com', name: 'New', role: 'agent' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      data: { id: NEW_USER_UUID, email: 'new@user.com', role: 'agent' },
    });
    expect(userSave).toHaveBeenCalledWith(expect.objectContaining({ role: 'agent' }));
  });
});
