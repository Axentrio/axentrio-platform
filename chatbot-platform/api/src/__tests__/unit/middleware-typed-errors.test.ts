/**
 * Phase 2A — middleware typed-error migration.
 *
 * Plan: chatbot-platform/docs/api-response-standardization-plan.md
 *   §3.1 (middleware row), §4 Phase 2, §6.3 (Socket.IO contract).
 *
 * Each middleware in scope used to `res.status(N).json({ error: '...' })` —
 * which bypassed the global error handler and produced bare bodies like
 * `{"error":"Internal server error"}` in production. Phase 2A routes those
 * paths through `next(<TypedError>)` so the global handler emits the
 * standard envelope (`code`, `message`, `requestId`, `path`, `timestamp`).
 *
 * Verifies (per the agent brief):
 *   - authenticateAgent: missing header → UnauthorizedError via next().
 *   - authenticateAgent: EXPIRED token → UnauthorizedError ('Token expired')
 *     — proves the catch-order reorder works (codex round 1 #12; before this
 *     fix every expired token surfaced as "Invalid token" because
 *     TokenExpiredError extends JsonWebTokenError and the JWT branch ran
 *     first).
 *   - validateTenant: bad UUID → BadRequestError via next().
 *   - requireSuperAdmin: non-super-admin → ForbiddenError via next().
 *   - requireAdmin (from middleware/index.ts): non-admin → ForbiddenError.
 *
 * Mocks: TypeORM's `AppDataSource.getRepository(...)` so the auth/tenant
 * middlewares can be imported without a live database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

// --- Mock TypeORM data-source so middleware imports don't try to connect ---
// vi.mock is hoisted above all imports, so the mocks below must use
// vi.hoisted() to expose the shared fns to both the mock factory and the
// test bodies.
const { agentFindOne, tenantFindOne } = vi.hoisted(() => ({
  agentFindOne: vi.fn(),
  tenantFindOne: vi.fn(),
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name?: string }) => {
      const name = entity?.name ?? '';
      if (name === 'Agent') return { findOne: agentFindOne };
      if (name === 'Tenant') return { findOne: tenantFindOne };
      return { findOne: vi.fn() };
    },
  },
  runInTransaction: vi.fn(),
}));

import { authenticateAgent } from '../../middleware/auth.middleware';
import { validateTenant } from '../../middleware/tenant.middleware';
import { requireSuperAdmin } from '../../middleware/super-admin.middleware';
import { requireAdmin } from '../../middleware/index';
import {
  ApiError,
  UnauthorizedError,
  ForbiddenError,
  BadRequestError,
} from '../../middleware/error-handler';

// --- Test helpers ---

function makeReqRes(reqOverrides: Record<string, unknown> = {}) {
  const req: any = {
    headers: {},
    query: {},
    ...reqOverrides,
  };
  const res: any = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  const next = vi.fn();
  return { req, res, next };
}

function nextArg(next: ReturnType<typeof vi.fn>): unknown {
  // The migrated middlewares always call next(err) — never next() and then write.
  expect(next).toHaveBeenCalledTimes(1);
  return next.mock.calls[0][0];
}

function assertApiError(err: unknown): asserts err is ApiError {
  expect(err).toBeInstanceOf(ApiError);
}

beforeEach(() => {
  agentFindOne.mockReset();
  tenantFindOne.mockReset();
});

describe('authenticateAgent — missing Authorization header', () => {
  it('calls next(UnauthorizedError) and does NOT write a response', async () => {
    const { req, res, next } = makeReqRes();
    await authenticateAgent(req, res, next);

    const err = nextArg(next);
    expect(err).toBeInstanceOf(UnauthorizedError);
    assertApiError(err);
    expect(err.message).toBe('Unauthorized: No token provided');
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('authenticateAgent — expired JWT', () => {
  it('calls next(UnauthorizedError) with the "Token expired" message (proves catch-order reorder)', async () => {
    const verifySpy = vi.spyOn(jwt, 'verify').mockImplementation(() => {
      throw new jwt.TokenExpiredError('jwt expired', new Date());
    });

    try {
      const { req, res, next } = makeReqRes({
        headers: { authorization: 'Bearer fake.expired.token' },
      });
      await authenticateAgent(req, res, next);

      const err = nextArg(next);
      expect(err).toBeInstanceOf(UnauthorizedError);
      assertApiError(err);
      expect(err.message).toBe('Unauthorized: Token expired');
      expect(err.code).toBe('UNAUTHORIZED');

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    } finally {
      verifySpy.mockRestore();
    }
  });
});

describe('validateTenant — bad UUID', () => {
  it('calls next(BadRequestError) for malformed tenant id', async () => {
    const { req, res, next } = makeReqRes({
      headers: { 'x-tenant-id': 'not-a-uuid' },
    });

    await validateTenant(req, res, next);

    const err = nextArg(next);
    expect(err).toBeInstanceOf(BadRequestError);
    assertApiError(err);
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('Bad Request: Invalid tenant ID format');

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(tenantFindOne).not.toHaveBeenCalled();
  });
});

describe('requireSuperAdmin — non-super-admin user', () => {
  it('calls next(ForbiddenError) and does NOT write a response', () => {
    const { req, res, next } = makeReqRes({
      user: { id: 'u1', role: 'admin', tenantId: 't1', email: 'a@b.c', type: 'agent' },
    });

    requireSuperAdmin(req, res, next);

    const err = nextArg(next);
    expect(err).toBeInstanceOf(ForbiddenError);
    assertApiError(err);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe('Super admin access required');

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('requireAdmin (middleware/index) — non-admin user', () => {
  it('calls next(ForbiddenError) and does NOT write a response', () => {
    const { req, res, next } = makeReqRes({
      user: { id: 'u1', role: 'agent', tenantId: 't1', email: 'a@b.c', type: 'agent' },
    });

    requireAdmin(req, res, next);

    const err = nextArg(next);
    expect(err).toBeInstanceOf(ForbiddenError);
    assertApiError(err);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe('Admin access required');

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
