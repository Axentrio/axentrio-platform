/**
 * Wire-envelope tests for the Phase 3A migrated route files.
 *
 * Plan: chatbot-platform/docs/api-response-standardization-plan.md §3.2, §4
 * Phase 3.
 *
 * For each of the five Phase 3A files, mount its router on a tiny Express
 * app + the global errorHandler. Hit the migrated line(s) and assert the
 * wire envelope shape:
 *   - errors: { success:false, error:{code,message}, meta:{requestId,path} }
 *   - successes (sendSuccess): { success:true, data:{...} }
 *   - sendCreated: 201 + { success:true, data:{...} }
 *
 * Mocks the auth/tenant middleware to inject a fake user, and mocks
 * `AppDataSource.getRepository(Tenant)` so we don't need a live database
 * for the success-path tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const TENANT_UUID = '11111111-1111-4111-8111-111111111111';

const { tenantFindOne, tenantSave } = vi.hoisted(() => ({
  tenantFindOne: vi.fn(),
  tenantSave: vi.fn(),
}));

// Database mock — only Tenant repo is used by these routes.
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name?: string }) => {
      const name = entity?.name ?? '';
      if (name === 'Tenant') return { findOne: tenantFindOne, save: tenantSave };
      return { findOne: vi.fn(), save: vi.fn() };
    },
    query: vi.fn(),
  },
  runInTransaction: vi.fn(),
}));

// Bypass Clerk auth + auto-provision: inject a stable admin user.
vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: 'user-1',
      email: 'a@b.c',
      role: 'admin',
      tenantId: TENANT_UUID,
      type: 'agent',
    } as never;
    next();
  },
  autoProvision: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

// resolveTenantContext is a no-op for these tests (req.user already set).
vi.mock('../../middleware/super-admin.middleware', () => ({
  resolveTenantContext: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

// Stub logger to keep test output quiet.
vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

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

beforeEach(() => {
  tenantFindOne.mockReset();
  tenantSave.mockReset();
});

// ─── analytics.routes.ts ────────────────────────────────────────────────────

describe('analytics.routes.ts — POST /export (L219 migration)', () => {
  it('emits envelope 501 / NOT_IMPLEMENTED instead of bare {error}', async () => {
    const router = (await import('../../routes/analytics.routes')).default;
    const app = makeApp((a) => a.use('/analytics', router));

    const res = await request(app).post('/analytics/export');

    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'NOT_IMPLEMENTED', message: 'Analytics export not yet implemented' },
      meta: { path: '/analytics/export', requestId: expect.any(String) },
    });
  });
});

// ─── automations.routes.ts ──────────────────────────────────────────────────

describe('automations.routes.ts — sendSuccess migrations (L69/L114/L143)', () => {
  it('GET /me/automations returns { success:true, data:{ automations } } (L69)', async () => {
    tenantFindOne.mockResolvedValueOnce({
      id: TENANT_UUID,
      settings: { automations: { emailNotifications: { newLeadAlert: { enabled: true } } } },
    });

    const router = (await import('../../routes/automations.routes')).default;
    const app = makeApp((a) => a.use('/', router));

    const res = await request(app).get('/me/automations');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        automations: { emailNotifications: { newLeadAlert: { enabled: true } } },
      },
    });
  });

  it('PATCH /me/automations/email/:type returns { success:true, data:{ type, automation } } (L114)', async () => {
    tenantFindOne.mockResolvedValueOnce({ id: TENANT_UUID, settings: {} });
    tenantSave.mockResolvedValueOnce(undefined);

    const router = (await import('../../routes/automations.routes')).default;
    const app = makeApp((a) => a.use('/', router));

    const res = await request(app)
      .patch('/me/automations/email/followUp')
      .send({ enabled: true, subject: 'hi', body: 'body', delayHours: 24 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        type: 'followUp',
        automation: { enabled: true, subject: 'hi', body: 'body', delayHours: 24 },
      },
    });
  });

  it('POST /me/automations/email/:type/test returns { success:true, data:{ message } } (L143)', async () => {
    tenantFindOne.mockResolvedValueOnce({
      id: TENANT_UUID,
      settings: { automations: { emailNotifications: { followUp: { enabled: true } } } },
    });

    const router = (await import('../../routes/automations.routes')).default;
    const app = makeApp((a) => a.use('/', router));

    const res = await request(app).post('/me/automations/email/followUp/test');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { message: 'Test email sent for "followUp"' },
    });
  });
});

// ─── files.routes.ts ────────────────────────────────────────────────────────

describe('files.routes.ts — 503 FILE_SERVICE_UNAVAILABLE (L32/L84/L115)', () => {
  // Ensure S3 is reported as not configured by clearing env vars in this suite.
  const origEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_S3_BUCKET;
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('POST /upload emits envelope 503 with preserved long copy (L32 deviation per plan)', async () => {
    const router = (await import('../../routes/files.routes')).default;
    const app = makeApp((a) => a.use('/files', router));

    const res = await request(app)
      .post('/files/upload')
      .send({ fileName: 'x.png', fileSize: 1, mimeType: 'image/png' });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'FILE_SERVICE_UNAVAILABLE',
        message: 'File upload service is not configured. S3 credentials are required.',
      },
      meta: { path: '/files/upload', requestId: expect.any(String) },
    });
  });

  it('GET /:id/preview emits envelope 503 / FILE_SERVICE_UNAVAILABLE (L84)', async () => {
    const router = (await import('../../routes/files.routes')).default;
    const app = makeApp((a) => a.use('/files', router));

    const res = await request(app).get('/files/abc/preview');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('FILE_SERVICE_UNAVAILABLE');
    expect(res.body.error.message).toBe('File service is not configured');
  });

  it('GET /:id/download emits envelope 503 / FILE_SERVICE_UNAVAILABLE (L115)', async () => {
    const router = (await import('../../routes/files.routes')).default;
    const app = makeApp((a) => a.use('/files', router));

    const res = await request(app).get('/files/abc/download');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('FILE_SERVICE_UNAVAILABLE');
    expect(res.body.error.message).toBe('File service is not configured');
  });
});

// ─── session-management.routes.ts ───────────────────────────────────────────

describe('session-management.routes.ts — sendSuccess migrations (L39/L79/L96)', () => {
  // The success paths all run AppDataSource.query. We mock it per-test.
  it('POST /bulk-close returns { success:true, data:{ closedCount } } (L39)', async () => {
    const { AppDataSource } = await import('../../database/data-source');
    (AppDataSource.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 's1' },
      { id: 's2' },
    ]);

    const router = (await import('../../routes/session-management.routes')).default;
    const app = makeApp((a) => a.use('/chats', router));

    const res = await request(app)
      .post('/chats/bulk-close')
      .send({ sessionIds: ['s1', 's2'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { closedCount: 2 } });
  });

  it('DELETE /bulk-delete returns { success:true, data:{ sessions, messages, participants } } (L79)', async () => {
    const { AppDataSource } = await import('../../database/data-source');
    const queryMock = AppDataSource.query as ReturnType<typeof vi.fn>;
    queryMock.mockResolvedValueOnce([{ id: 'm1' }]); // messages
    queryMock.mockResolvedValueOnce([{ id: 'p1' }, { id: 'p2' }]); // participants
    queryMock.mockResolvedValueOnce([{ id: 's1' }]); // sessions

    const router = (await import('../../routes/session-management.routes')).default;
    const app = makeApp((a) => a.use('/chats', router));

    const res = await request(app)
      .delete('/chats/bulk-delete')
      .send({ olderThanDays: 7 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { sessions: 1, messages: 1, participants: 2 },
    });
  });

  it('GET /stats returns { success:true, data:{ byStatus, total } } (L96)', async () => {
    const { AppDataSource } = await import('../../database/data-source');
    (AppDataSource.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { status: 'closed', count: 3 },
      { status: 'bot', count: 2 },
    ]);

    const router = (await import('../../routes/session-management.routes')).default;
    const app = makeApp((a) => a.use('/chats', router));

    const res = await request(app).get('/chats/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { byStatus: { closed: 3, bot: 2 }, total: 5 },
    });
  });
});

// ─── skills.routes.ts ───────────────────────────────────────────────────────

describe('skills.routes.ts — sendSuccess/sendCreated migrations (L79/L118/L152/L174)', () => {
  it('GET /me/skills returns { success:true, data:{ skills } } (L79)', async () => {
    tenantFindOne.mockResolvedValueOnce({
      id: TENANT_UUID,
      settings: { skills: [{ name: 'hello', trigger: 't', tools: ['x'], instructions: 'i' }] },
    });

    const router = (await import('../../routes/skills.routes')).default;
    const app = makeApp((a) => a.use('/', router));

    const res = await request(app).get('/me/skills');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { skills: [{ name: 'hello', trigger: 't', tools: ['x'], instructions: 'i' }] },
    });
  });

  it('DELETE /me/skills/:name emits { success:true, data:{ message:"Skill deleted" } } (L174)', async () => {
    tenantFindOne.mockResolvedValueOnce({
      id: TENANT_UUID,
      settings: { skills: [{ name: 'todelete', trigger: 't', tools: ['x'], instructions: 'i' }] },
    });
    tenantSave.mockResolvedValueOnce(undefined);

    const router = (await import('../../routes/skills.routes')).default;
    const app = makeApp((a) => a.use('/', router));

    const res = await request(app).delete('/me/skills/todelete');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { message: 'Skill deleted' },
    });
  });
});

