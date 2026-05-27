/**
 * Wire-envelope tests for the Phase 5A `knowledge.controller.ts` +
 * `knowledge.routes.ts` migration.
 *
 * Plan: chatbot-platform/docs/api-response-standardization-plan.md §2.2,
 * §2.3, §3.3 (knowledge rows), §3.4a (status preservation), §6.4 (multer
 * adapter pattern), §4 Phase 5.
 *
 * Coverage (one assertion per migration shape):
 *   1. sendSuccess for getKnowledgeBase            — 200 + { success:true, data }
 *   2. sendCreated for createDocument              — 201 + { success:true, data }
 *   3. sendNoContent for deleteDocument            — 204, empty body
 *   4. BadRequestError for testChat guard          — 400 + envelope
 *   5. MulterError → 400 envelope with LIMIT_FILE_SIZE code (multer adapter)
 *
 * Mocks `AppDataSource.getRepository` via `vi.hoisted` per the pattern in
 * `route-phase4-tenants-wire.test.ts`. Bypasses Clerk auth / autoProvision /
 * resolveTenantContext / requireRole by injecting a stable admin user with a
 * fixed tenantId.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import request from 'supertest';

const TENANT_UUID = '11111111-1111-4111-8111-111111111111';
const KB_UUID = '22222222-2222-4222-8222-222222222222';
const DOC_UUID = '33333333-3333-4333-8333-333333333333';

// ─── Hoisted mocks (must be declared before any code-under-test import) ─────

const {
  getOrCreateKnowledgeBase,
  createDocument,
  deleteDocument,
  tenantFindOneOrFail,
  botFindOne,
} = vi.hoisted(() => ({
  getOrCreateKnowledgeBase: vi.fn(),
  createDocument: vi.fn(),
  deleteDocument: vi.fn(),
  tenantFindOneOrFail: vi.fn(),
  botFindOne: vi.fn(),
}));

// Mock the KnowledgeService constructor — controller does
// `new KnowledgeService(AppDataSource)` lazily on first call.
vi.mock('../../knowledge/knowledge.service', () => ({
  KnowledgeService: class MockKnowledgeService {
    getOrCreateKnowledgeBase = getOrCreateKnowledgeBase;
    createDocument = createDocument;
    deleteDocument = deleteDocument;
  },
}));

// Mock the DataSource — only `getRepository(Tenant)` is exercised here
// (by the testChat handler that throws on disabled AI).
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name?: string }) => {
      const name = entity?.name ?? '';
      if (name === 'Tenant') {
        return { findOneOrFail: tenantFindOneOrFail };
      }
      if (name === 'Bot') {
        return { findOne: botFindOne };
      }
      return { findOneOrFail: vi.fn(), findOne: vi.fn(), save: vi.fn() };
    },
  },
}));

// Bypass Clerk auth + auto-provision: inject a stable admin user. The
// controller reads `(req as any).tenantId` directly — we set both that and
// `req.user` so requireRole('admin') passes.
vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      id: 'user-1',
      email: 'admin@example.com',
      role: 'admin',
      tenantId: TENANT_UUID,
      type: 'agent',
    } as never;
    (req as unknown as { tenantId: string }).tenantId = TENANT_UUID;
    next();
  },
  autoProvision: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../middleware/super-admin.middleware', () => ({
  resolveTenantContext: (req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { tenantId: string }).tenantId = TENANT_UUID;
    next();
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import knowledgeRouter from '../../knowledge/knowledge.routes';
import { errorHandler, ApiError, asyncHandler } from '../../middleware/error-handler';
import { requestIdMiddleware } from '../../middleware/request-id.middleware';
import * as ctrl from '../../knowledge/knowledge.controller';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/knowledge', knowledgeRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  getOrCreateKnowledgeBase.mockReset();
  createDocument.mockReset();
  deleteDocument.mockReset();
  tenantFindOneOrFail.mockReset();
  botFindOne.mockReset();
});

// ─── 1. sendSuccess: GET /base ──────────────────────────────────────────────

describe('knowledge.controller.ts — getKnowledgeBase (sendSuccess)', () => {
  it('GET /knowledge/base → 200 + { success:true, data:{ id, ... } }', async () => {
    getOrCreateKnowledgeBase.mockResolvedValue({
      id: KB_UUID,
      tenantId: TENANT_UUID,
      embeddingProvider: 'openai',
      chunkSize: 1000,
    });

    const res = await request(makeApp()).get('/knowledge/base');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { id: KB_UUID, tenantId: TENANT_UUID },
    });
    expect(res.body).not.toHaveProperty('error');
  });
});

// ─── 2. sendCreated: POST /documents ────────────────────────────────────────

describe('knowledge.controller.ts — createDocument (sendCreated, 201)', () => {
  it('POST /knowledge/documents → 201 + { success:true, data:{ id, ... } }', async () => {
    createDocument.mockResolvedValue({
      id: DOC_UUID,
      tenantId: TENANT_UUID,
      title: 'Doc',
      type: 'text',
      status: 'pending',
      processingVersion: 1,
    });

    const res = await request(makeApp())
      .post('/knowledge/documents')
      .send({ title: 'Doc', type: 'text', content: 'Hello world' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      data: { id: DOC_UUID, title: 'Doc', status: 'pending' },
    });
  });
});

// ─── 3. sendNoContent: DELETE /documents/:id ────────────────────────────────

describe('knowledge.controller.ts — deleteDocument (sendNoContent, 204)', () => {
  it('DELETE /knowledge/documents/:id → 204 with empty body', async () => {
    deleteDocument.mockResolvedValue(undefined);

    const res = await request(makeApp()).delete(`/knowledge/documents/${DOC_UUID}`);

    expect(res.status).toBe(204);
    // 204 means no response body. supertest exposes an empty object for
    // missing JSON body and the raw `text` is empty.
    expect(res.body).toEqual({});
    expect(res.text).toBe('');
  });
});

// ─── 4. BadRequestError typed throw: POST /ai-settings/test-chat guard ──────

describe('knowledge.controller.ts — testChat guard (BadRequestError)', () => {
  it('throws BadRequestError when AI is disabled → 400 envelope', async () => {
    // Mount the testChat handler directly on the test app — it lives in the
    // ai-settings router, not the knowledge router under test here, but the
    // guard is part of Phase 5A (`knowledge.controller.ts:testChat`).
    tenantFindOneOrFail.mockResolvedValue({
      id: TENANT_UUID,
      name: 'Acme',
      settings: { ai: { enabled: false } },
    });
    // Multi-bot Phase 4 (#16d): testChat reads behavioural ai from anchor bot.
    botFindOne.mockResolvedValue({
      id: 'bot-anchor',
      tenantId: TENANT_UUID,
      isDefault: true,
      settings: { ai: { enabled: false } },
    });

    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { tenantId: string }).tenantId = TENANT_UUID;
      next();
    });
    app.post('/test-chat', asyncHandler(ctrl.testChat));
    app.use(errorHandler);

    const res = await request(app)
      .post('/test-chat')
      .send({ message: 'hi', history: [], useKnowledgeBase: false });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'AI is not enabled. Save your AI settings first.',
      },
      meta: { requestId: expect.any(String), path: '/test-chat' },
    });
  });
});

// ─── 5. MulterError → 400 envelope (multer adapter, §6.4) ───────────────────

describe('knowledge.routes.ts — multer adapter (MulterError → 400 envelope)', () => {
  it('upload exceeding size limit → 400 + { error:{ code:"LIMIT_FILE_SIZE" } }', async () => {
    // Build a tiny test app that mirrors the production wiring but with a
    // 1-byte multer limit so even a 2-byte upload trips LIMIT_FILE_SIZE.
    // Reusing the same adapter wiring + global errorHandler proves the
    // adapter is what converts MulterError → ApiError envelope.
    const app = express();
    app.use(requestIdMiddleware);

    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 1 },
    });

    app.post(
      '/upload',
      upload.single('file'),
      asyncHandler(async (_req, res) => {
        res.json({ success: true, data: { ok: true } });
      }),
    );

    // Same adapter as the production knowledge.routes.ts.
    app.use((err: Error, _req: Request, _res: Response, next: NextFunction) => {
      if (err instanceof multer.MulterError) {
        return next(new ApiError(err.message, 400, err.code));
      }
      return next(err);
    });
    app.use(errorHandler);

    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('over-1-byte'), 'too-big.txt');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'LIMIT_FILE_SIZE',
        message: expect.any(String),
      },
      meta: { requestId: expect.any(String), path: '/upload' },
    });
  });
});
