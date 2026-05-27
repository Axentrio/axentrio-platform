/**
 * Wire-envelope tests for the Phase 2A migrated middlewares.
 *
 * For each middleware in scope, mount it on a tiny Express app and trigger
 * its failure path via supertest. Assert the response body matches the
 * canonical envelope shape, the right `error.code`, and `meta.requestId`.
 *
 * Mocks: TypeORM's `AppDataSource.getRepository(...)` so we can import the
 * middlewares without a live database (matches the unit-test pattern in
 * middleware-typed-errors.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

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

import {
  authenticateAgent,
  requireRole,
  generateAgentToken,
} from '../../middleware/auth.middleware';
import { validateTenant } from '../../middleware/tenant.middleware';
import { requireSuperAdmin } from '../../middleware/super-admin.middleware';
import { requireAdmin } from '../../middleware/index';
import { errorHandler } from '../../middleware/error-handler';
import { requestIdMiddleware } from '../../middleware/request-id.middleware';
import { config } from '../../config/environment';

const TENANT_UUID = '11111111-1111-4111-8111-111111111111';

function makeApp(setup: (app: express.Express) => void): express.Express {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  setup(app);
  app.use(errorHandler);
  return app;
}

function ok(_req: express.Request, res: express.Response) {
  res.json({ ok: true });
}

beforeEach(() => {
  agentFindOne.mockReset();
  tenantFindOne.mockReset();
});

// ─── authenticateAgent ──────────────────────────────────────────────────────

describe('authenticateAgent — wire envelope', () => {
  const app = makeApp((a) => {
    a.get('/protected', authenticateAgent, ok);
  });

  it('emits envelope 401 / UNAUTHORIZED when no Authorization header', async () => {
    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized: No token provided' },
      meta: { path: '/protected', requestId: expect.any(String) },
    });
  });

  it('emits envelope 401 with message "Token expired" for an expired JWT (round 1 #12 fix)', async () => {
    // Sign a token that is already expired.
    const expired = jwt.sign(
      {
        userId: 'agent-1',
        email: 'a@b.c',
        role: 'agent',
        tenantId: TENANT_UUID,
        type: 'agent',
      },
      config.jwt.secret,
      {
        issuer: 'chatbot-platform',
        audience: 'chatbot-api',
        expiresIn: '-1s',
      },
    );

    const res = await request(app)
      .get('/protected')
      .set('authorization', `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    // The catch-order bug previously made this "Invalid token".
    expect(res.body.error.message).toBe('Unauthorized: Token expired');
  });

  it('emits envelope 401 with message "Invalid token" for a malformed JWT', async () => {
    const res = await request(app)
      .get('/protected')
      .set('authorization', 'Bearer notarealjwt');

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Unauthorized: Invalid token');
  });

  it('passes through to the handler with a valid token + live agent', async () => {
    agentFindOne.mockResolvedValueOnce({ id: 'agent-1', isActive: true });
    const valid = generateAgentToken({
      id: 'agent-1',
      tenantId: TENANT_UUID,
      user: { email: 'a@b.c', role: 'agent' },
    } as Parameters<typeof generateAgentToken>[0]);

    const res = await request(app)
      .get('/protected')
      .set('authorization', `Bearer ${valid}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// ─── requireRole ────────────────────────────────────────────────────────────

describe('requireRole — wire envelope', () => {
  function appWith(userRole: string | undefined) {
    return makeApp((a) => {
      a.use((req, _res, next) => {
        if (userRole) {
          req.user = {
            id: 'u',
            email: 'u@x',
            role: userRole as never,
            tenantId: TENANT_UUID,
            type: 'agent',
          };
        }
        next();
      });
      a.get('/admin-only', requireRole('admin'), ok);
    });
  }

  it('401 / UNAUTHORIZED when req.user is missing', async () => {
    const res = await request(appWith(undefined)).get('/admin-only');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Unauthorized: No user found');
  });

  it('403 / FORBIDDEN when role does not match', async () => {
    const res = await request(appWith('agent')).get('/admin-only');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe('Forbidden: Insufficient permissions');
  });

  it('200 when role matches', async () => {
    const res = await request(appWith('admin')).get('/admin-only');

    expect(res.status).toBe(200);
  });

  it('200 when role is super_admin (bypasses all role gates)', async () => {
    const res = await request(appWith('super_admin')).get('/admin-only');

    expect(res.status).toBe(200);
  });
});

// ─── validateTenant ─────────────────────────────────────────────────────────

describe('validateTenant — wire envelope', () => {
  const app = makeApp((a) => {
    a.get('/needs-tenant', validateTenant, ok);
  });

  it('400 / BAD_REQUEST when no tenant id present anywhere', async () => {
    const res = await request(app).get('/needs-tenant');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toBe('Bad Request: Tenant ID required');
  });

  it('400 / BAD_REQUEST when tenant id is not a UUID', async () => {
    const res = await request(app)
      .get('/needs-tenant')
      .set('x-tenant-id', 'not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Bad Request: Invalid tenant ID format');
  });

  it('404 / NOT_FOUND when tenant lookup returns null', async () => {
    tenantFindOne.mockResolvedValueOnce(null);

    const res = await request(app)
      .get('/needs-tenant')
      .set('x-tenant-id', TENANT_UUID);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ─── requireSuperAdmin ──────────────────────────────────────────────────────

describe('requireSuperAdmin — wire envelope', () => {
  function appWith(role: string | undefined) {
    return makeApp((a) => {
      a.use((req, _res, next) => {
        if (role) {
          req.user = {
            id: 'u',
            email: 'u@x',
            role: role as never,
            tenantId: TENANT_UUID,
            type: 'agent',
          };
        }
        next();
      });
      a.get('/super', requireSuperAdmin, ok);
    });
  }

  it('403 / FORBIDDEN when caller is admin (not super_admin)', async () => {
    const res = await request(appWith('admin')).get('/super');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe('Super admin access required');
  });

  it('200 when caller is super_admin', async () => {
    const res = await request(appWith('super_admin')).get('/super');

    expect(res.status).toBe(200);
  });
});

// ─── requireAdmin (middleware/index.ts) ─────────────────────────────────────

describe('requireAdmin — wire envelope (codex round 1 #2)', () => {
  function appWith(role: string | undefined) {
    return makeApp((a) => {
      a.use((req, _res, next) => {
        if (role) {
          req.user = {
            id: 'u',
            email: 'u@x',
            role: role as never,
            tenantId: TENANT_UUID,
            type: 'agent',
          };
        }
        next();
      });
      a.get('/admin', requireAdmin, ok);
    });
  }

  it('403 / FORBIDDEN when caller is agent', async () => {
    const res = await request(appWith('agent')).get('/admin');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe('Admin access required');
    // Envelope shape, not the old bare {error: '...'}.
    expect(res.body).toHaveProperty('meta.requestId');
  });

  it('200 when caller is admin', async () => {
    const res = await request(appWith('admin')).get('/admin');
    expect(res.status).toBe(200);
  });

  it('200 when caller is super_admin', async () => {
    const res = await request(appWith('super_admin')).get('/admin');
    expect(res.status).toBe(200);
  });
});
