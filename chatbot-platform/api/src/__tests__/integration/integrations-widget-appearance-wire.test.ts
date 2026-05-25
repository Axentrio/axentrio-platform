/**
 * Wire-envelope tests for Phase 5B controller migrations:
 *   - chatbot-platform/api/src/knowledge/integrations.controller.ts
 *   - chatbot-platform/api/src/widget/widget-appearance.controller.ts
 *
 * Plan: chatbot-platform/docs/api-response-standardization-plan.md §2.2, §2.3,
 * §3.3 (rows for `integrations.controller.ts` + `widget-appearance.controller.ts`),
 * §4 Phase 5.
 *
 * Coverage:
 *   (a) integrations.getIntegrations success envelope.
 *   (b) integrations.connectCalcom upstream 401 → 400 BAD_REQUEST envelope.
 *   (c) integrations.connectCalcom upstream 429 → 429 RATE_LIMIT_EXCEEDED envelope.
 *   (d) integrations.connectCalcom upstream unreachable → 502 UPSTREAM_FAILED envelope.
 *   (e) widget-appearance.getWidgetAppearance success envelope.
 *   (f) widget-appearance.updateWidgetAppearance success envelope (round-trip).
 *
 * Both controllers sit behind `requireClerkAuth`, `autoProvision`,
 * `resolveTenantContext`, and `requireRole(...)`. Each is mocked out here so
 * the request reaches the handler with a stable `req.user` / `req.tenantId`.
 * `AppDataSource.getRepository(...)` is mocked via `vi.hoisted` per the
 * existing route-phase wire-test pattern. `axios` is mocked for the Cal.com
 * upstream sites.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';

const TENANT_UUID = '11111111-1111-4111-8111-111111111111';
const USER_UUID = '22222222-2222-4222-8222-222222222222';

const { tenantFindOneOrFail, tenantSave, botFindOne, botSave, axiosGet } = vi.hoisted(() => ({
  tenantFindOneOrFail: vi.fn(),
  tenantSave: vi.fn(),
  botFindOne: vi.fn(),
  botSave: vi.fn(),
  axiosGet: vi.fn(),
}));

// Stub Clerk SDK so importing the routes (which import clerk middleware via
// their `requireClerkAuth` import) doesn't blow up.
vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Bypass Clerk auth + auto-provision: stamp a super_admin user so
// requireRole('admin') / requireRole('admin', 'supervisor') passes.
vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      id: USER_UUID,
      email: 'admin@example.com',
      role: 'super_admin',
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

vi.mock('../../middleware/super-admin.middleware', () => ({
  requireSuperAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  resolveTenantContext: (req: Request, _res: Response, next: NextFunction) => {
    req.tenantId = TENANT_UUID;
    next();
  },
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name?: string }) => {
      const name = entity?.name ?? '';
      if (name === 'Tenant') {
        return {
          findOneOrFail: tenantFindOneOrFail,
          findOne: tenantFindOneOrFail,
          save: tenantSave,
        };
      }
      if (name === 'Bot') {
        return { findOne: botFindOne, save: botSave };
      }
      return { findOneOrFail: vi.fn(), findOne: vi.fn(), save: vi.fn() };
    },
  },
}));

vi.mock('axios', () => ({
  default: { get: axiosGet },
}));

vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// `encrypt` / `decrypt` are not exercised by these tests, but `connectCalcom`
// calls `encrypt(apiKey)` on the success path. We stub it to avoid needing
// the real encryption key in the test environment.
vi.mock('../../utils/encryption', () => ({
  encrypt: (value: string) => `enc:${value}`,
  decrypt: (value: string) => value.replace(/^enc:/, ''),
}));

// Now import the code under test.
import integrationsRoutes from '../../knowledge/integrations.routes';
import widgetAppearanceRoutes from '../../widget/widget-appearance.routes';
import { errorHandler } from '../../middleware/error-handler';
import { requestIdMiddleware } from '../../middleware/request-id.middleware';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/tenants/me', integrationsRoutes);
  app.use('/tenants/me', widgetAppearanceRoutes);
  app.use(errorHandler);
  return app;
}

const ENVELOPE_META = {
  timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  requestId: expect.any(String),
  path: expect.any(String),
};

beforeEach(() => {
  tenantFindOneOrFail.mockReset();
  tenantSave.mockReset();
  botFindOne.mockReset();
  botSave.mockReset();
  axiosGet.mockReset();
});

// ─── (a) integrations.getIntegrations success ──────────────────────────────

describe('integrations.controller — GET /integrations success envelope', () => {
  it('emits { success:true, data:{ calcom:{ hasApiKey, ... } } }', async () => {
    // Multi-bot Phase 4 (#16d): GET /integrations now hydrates from anchor bot.
    botFindOne.mockResolvedValue({
      id: 'bot-anchor',
      tenantId: TENANT_UUID,
      isDefault: true,
      settings: {
        integrations: {
          calcom: {
            apiKey: 'enc:abc',
            eventTypeId: 42,
            language: 'en',
          },
        },
      },
    });

    const res = await request(makeApp()).get('/tenants/me/integrations');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        calcom: {
          eventTypeId: 42,
          language: 'en',
          hasApiKey: true,
        },
      },
    });
    expect(res.body).not.toHaveProperty('error');
  });
});

// ─── (b) connectCalcom 401 → BadRequestError envelope ───────────────────────

describe('integrations.controller — connectCalcom Cal.com 401 → BAD_REQUEST envelope', () => {
  it('emits 400 { success:false, error:{ code:"BAD_REQUEST", message:"Invalid or expired API key" } }', async () => {
    axiosGet.mockRejectedValue({ response: { status: 401 }, message: 'Unauthorized' });

    const res = await request(makeApp())
      .post('/tenants/me/integrations/calcom/connect')
      .send({ apiKey: 'cal_test_key' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'Invalid or expired API key' },
      meta: { ...ENVELOPE_META, path: '/tenants/me/integrations/calcom/connect' },
    });
  });
});

// ─── (c) connectCalcom 429 → RateLimitError envelope ────────────────────────

describe('integrations.controller — connectCalcom Cal.com 429 → RATE_LIMIT_EXCEEDED envelope', () => {
  it('emits 429 { success:false, error:{ code:"RATE_LIMIT_EXCEEDED", message } }', async () => {
    axiosGet.mockRejectedValue({ response: { status: 429 }, message: 'Too many requests' });

    const res = await request(makeApp())
      .post('/tenants/me/integrations/calcom/connect')
      .send({ apiKey: 'cal_test_key' });

    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Cal.com rate limit exceeded. Please try again later.',
      },
      meta: { ...ENVELOPE_META, path: '/tenants/me/integrations/calcom/connect' },
    });
  });
});

// ─── (d) connectCalcom unreachable → ApiError(502, UPSTREAM_FAILED) ─────────

describe('integrations.controller — connectCalcom Cal.com unreachable → UPSTREAM_FAILED envelope', () => {
  it('emits 502 { success:false, error:{ code:"UPSTREAM_FAILED", message } }', async () => {
    // No `.response` → drops through to the generic-upstream branch.
    axiosGet.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(makeApp())
      .post('/tenants/me/integrations/calcom/connect')
      .send({ apiKey: 'cal_test_key' });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'UPSTREAM_FAILED',
        message: 'Could not reach Cal.com. Please try again later.',
      },
      meta: { ...ENVELOPE_META, path: '/tenants/me/integrations/calcom/connect' },
    });
  });
});

// ─── (e) widget-appearance.getWidgetAppearance success ──────────────────────

describe('widget-appearance.controller — GET /widget-appearance success envelope', () => {
  it('emits { success:true, data:{ primaryColor, avatarUrl, launcherPosition, launcherLabel } }', async () => {
    // Multi-bot Phase 4 (#16d): widget appearance hydrates from anchor bot.
    botFindOne.mockResolvedValue({
      id: 'bot-anchor',
      tenantId: TENANT_UUID,
      isDefault: true,
      settings: {
        theme: { primaryColor: '#abcdef' },
        widget: {
          avatarUrl: 'https://example.com/a.png',
          launcherPosition: 'bottom-left',
          launcherLabel: 'Chat',
        },
      },
    });

    const res = await request(makeApp()).get('/tenants/me/widget-appearance');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        primaryColor: '#abcdef',
        avatarUrl: 'https://example.com/a.png',
        launcherPosition: 'bottom-left',
        launcherLabel: 'Chat',
      },
    });
    expect(res.body).not.toHaveProperty('error');
  });
});

// ─── (f) widget-appearance.updateWidgetAppearance success (round-trip) ──────

describe('widget-appearance.controller — PATCH /widget-appearance round-trip envelope', () => {
  it('emits { success:true, data:{...} } reflecting the patched fields', async () => {
    // Multi-bot Phase 4 (#16d): writes target anchor bot, not tenant.
    botFindOne.mockResolvedValue({
      id: 'bot-anchor',
      tenantId: TENANT_UUID,
      isDefault: true,
      settings: {},
    });
    botSave.mockImplementation(async (b: { settings?: unknown }) => b);

    const res = await request(makeApp())
      .patch('/tenants/me/widget-appearance')
      .send({
        primaryColor: '#112233',
        avatarUrl: 'https://example.com/avatar.png',
        launcherPosition: 'bottom-right',
        launcherLabel: 'Hi',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        primaryColor: '#112233',
        avatarUrl: 'https://example.com/avatar.png',
        launcherPosition: 'bottom-right',
        launcherLabel: 'Hi',
      },
    });
    expect(botSave).toHaveBeenCalledTimes(1);
  });
});
