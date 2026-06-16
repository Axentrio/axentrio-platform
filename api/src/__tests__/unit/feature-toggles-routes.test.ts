import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (before imports) ──────────────────────────────────────────────────

const { state } = vi.hoisted(() => ({
  state: {
    tenantId: 'tenant-1' as string | undefined,
    role: 'admin' as string,
    // ceiling: pro-like — bookings/leadCapture/channels entitled, others not.
    entitledFeatures: {
      bookings: true,
      leadCapture: true,
      channelWhatsapp: true,
      gapInsights: true,
    } as Record<string, boolean>,
    effectiveFeatures: {} as Record<string, boolean>,
    storedToggles: {} as Record<string, boolean>,
    lastWriteSql: null as string | null,
    lastWriteParams: null as unknown[] | null,
    invalidated: [] as string[],
    modulesInvalidated: [] as string[],
    audits: [] as Array<{ action: string; metadata: unknown }>,
  },
}));

vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (req: any, _res: any, next: any) => {
    req.user = state.tenantId ? { tenantId: state.tenantId, role: state.role } : {};
    req.userId = 'user-1';
    req.tenantId = state.tenantId;
    next();
  },
  autoProvision: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/super-admin.middleware', () => ({
  resolveTenantContext: (req: any, _res: any, next: any) => {
    req.tenantId = state.tenantId;
    next();
  },
}));

// Real requireRole semantics: super_admin always passes; else role must match.
vi.mock('../../middleware/auth.middleware', () => ({
  requireRole:
    (...roles: string[]) =>
    (req: any, res: any, next: any) => {
      if (req.user?.role === 'super_admin' || roles.includes(req.user?.role)) return next();
      res.status(403).json({ error: 'forbidden' });
    },
}));

vi.mock('../../billing/entitlements', () => ({
  getEntitlements: async () => ({
    entitledFeatures: state.entitledFeatures,
    featureToggles: state.storedToggles,
    features: state.effectiveFeatures,
  }),
  invalidateEntitlements: async (id: string) => {
    state.invalidated.push(id);
  },
}));

vi.mock('../../modules', () => ({
  invalidateModules: async (id: string) => {
    state.modulesInvalidated.push(id);
  },
}));

vi.mock('../../utils/audit', () => ({
  logAudit: async (_actor: string, action: string, _t: string, _id: string, _tid: string, metadata: unknown) => {
    state.audits.push({ action, metadata });
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    query: async (sql: string, params: unknown[]) => {
      state.lastWriteSql = sql;
      state.lastWriteParams = params;
      return [];
    },
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import express from 'express';
import request from 'supertest';
import featureTogglesRoutes from '../../routes/feature-toggles.routes';
import { errorHandler } from '../../middleware/error-handler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/tenants/me', featureTogglesRoutes);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  state.tenantId = 'tenant-1';
  state.role = 'admin';
  state.entitledFeatures = { bookings: true, leadCapture: true, channelWhatsapp: true, gapInsights: true };
  state.effectiveFeatures = {};
  state.storedToggles = {};
  state.lastWriteSql = null;
  state.lastWriteParams = null;
  state.invalidated = [];
  state.modulesInvalidated = [];
  state.audits = [];
});

describe('PUT /tenants/me/feature-toggles', () => {
  it('persists a valid toggle-off, invalidates cache, and audits', async () => {
    const res = await request(createApp())
      .put('/tenants/me/feature-toggles')
      .send({ bookings: false });

    expect(res.status).toBe(200);
    // atomic jsonb_set write touching only settings.featureToggles
    expect(state.lastWriteSql).toContain("jsonb_set");
    expect(state.lastWriteSql).toContain("'{featureToggles}'");
    expect(state.lastWriteParams).toEqual(['tenant-1', JSON.stringify({ bookings: false })]);
    expect(state.invalidated).toEqual(['tenant-1']);
    // Feature-gated modules (e.g. booking) must re-resolve immediately, so the
    // module cache is invalidated too — otherwise a toggled-off feature keeps
    // its agent tools for up to the resolver's 60s TTL.
    expect(state.modulesInvalidated).toEqual(['tenant-1']);
    expect(state.audits).toEqual([
      { action: 'tenant.feature_toggles_updated', metadata: { featureToggles: { bookings: false } } },
    ]);
  });

  it('allows enabling a feature within the entitlement ceiling', async () => {
    const res = await request(createApp())
      .put('/tenants/me/feature-toggles')
      .send({ bookings: true });
    expect(res.status).toBe(200);
    expect(state.lastWriteParams?.[1]).toBe(JSON.stringify({ bookings: true }));
  });

  it('rejects enabling a feature the plan does NOT grant (422), no write', async () => {
    state.entitledFeatures = { bookings: false, leadCapture: true, channelWhatsapp: true, gapInsights: true };
    const res = await request(createApp())
      .put('/tenants/me/feature-toggles')
      .send({ bookings: true });
    expect(res.status).toBe(422);
    expect(state.lastWriteSql).toBeNull();
    expect(state.invalidated).toEqual([]);
  });

  it('allows turning OFF a non-entitled feature (no-op, but not rejected)', async () => {
    state.entitledFeatures = { bookings: false, leadCapture: true, channelWhatsapp: true, gapInsights: true };
    const res = await request(createApp())
      .put('/tenants/me/feature-toggles')
      .send({ bookings: false });
    expect(res.status).toBe(200);
  });

  it('rejects a non-toggleable feature key (422)', async () => {
    const res = await request(createApp())
      .put('/tenants/me/feature-toggles')
      .send({ calendarSync: false }); // entitled child, but not tenant-toggleable
    expect(res.status).toBe(422);
    expect(state.lastWriteSql).toBeNull();
  });

  it('rejects a non-boolean toggle value (422)', async () => {
    const res = await request(createApp())
      .put('/tenants/me/feature-toggles')
      .send({ bookings: 'yes' });
    expect(res.status).toBe(422);
  });

  it('rejects a non-object body (422)', async () => {
    const res = await request(createApp())
      .put('/tenants/me/feature-toggles')
      .send([{ bookings: false }]);
    expect(res.status).toBe(422);
  });

  it('forbids a non-admin tenant member (403), no write', async () => {
    state.role = 'agent';
    const res = await request(createApp())
      .put('/tenants/me/feature-toggles')
      .send({ bookings: false });
    expect(res.status).toBe(403);
    expect(state.lastWriteSql).toBeNull();
  });

  it('accepts a multi-key full map and writes it verbatim', async () => {
    const res = await request(createApp())
      .put('/tenants/me/feature-toggles')
      .send({ bookings: false, leadCapture: true, channelWhatsapp: false });
    expect(res.status).toBe(200);
    expect(state.lastWriteParams?.[1]).toBe(
      JSON.stringify({ bookings: false, leadCapture: true, channelWhatsapp: false }),
    );
  });
});
