/**
 * Portal wire contracts — pins the EXACT key sets of the responses the
 * portal consumes via src/contracts/* (entitlements, insights, outcomes).
 *
 * The shared contract types make renames fail tsc on both sides; these
 * tests close the remaining gap — a provider change that alters the
 * serialized shape (dropped field, renamed key reaching the wire through
 * an `as` cast, envelope drift) fails HERE with a diff that says "you are
 * about to break the portal."
 *
 * Auth-mocking + app-bootstrap pattern mirrors entitlements-routes.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  userId: '',
  tenantId: '',
  agentId: '',
  role: 'admin' as string,
  email: 'test@example.com',
  clerkUserId: '',
  clerkOrgId: '',
}));

vi.mock('../../middleware/clerk.middleware', async () => {
  const { UnauthorizedError } = await import('../../middleware/error-handler');
  return {
    requireClerkAuth: (req: any, _res: any, next: any) => {
      if (!auth.userId) {
        return next(new UnauthorizedError('Clerk: Unauthorized - no userId in auth'));
      }
      req.userId = auth.userId;
      req.tenantId = auth.tenantId;
      req.agentId = auth.agentId;
      req.userRole = auth.role;
      req.user = {
        id: auth.userId,
        email: auth.email,
        role: auth.role,
        tenantId: auth.tenantId,
        clerkUserId: auth.clerkUserId,
        type: 'agent',
      };
      next();
    },
    autoProvision: (_req: any, _res: any, next: any) => next(),
    invalidateProvisionCache: () => {},
    resolveClerkIds: () => ({}),
  };
});

vi.mock('../../middleware/super-admin.middleware', () => ({
  requireSuperAdmin: (_req: any, _res: any, next: any) => next(),
  resolveTenantContext: (_req: any, _res: any, next: any) => next(),
}));

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

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { CanonicalTopic } from '../../database/entities/CanonicalTopic';
import { Gap } from '../../database/entities/Gap';
import { InsightExperiment } from '../../database/entities/InsightExperiment';
import { InsightDigest } from '../../database/entities/InsightDigest';
import { createTestTenant, createTestUser } from '../helpers/factories';

function setAuth(opts: { tenantId: string; userId: string }) {
  auth.userId = opts.userId;
  auth.tenantId = opts.tenantId;
}

const keysOf = (o: Record<string, unknown>) => Object.keys(o).sort();

async function seedProTenant() {
  const tenant = await createTestTenant({ tier: 'pro' });
  const admin = await createTestUser(tenant.id, { role: 'admin' });
  setAuth({ tenantId: tenant.id, userId: admin.id });
  return tenant;
}

async function seedEnterpriseTenant() {
  const tenant = await createTestTenant({ tier: 'enterprise' });
  const admin = await createTestUser(tenant.id, { role: 'admin' });
  setAuth({ tenantId: tenant.id, userId: admin.id });
  return tenant;
}

// ---------------------------------------------------------------------------
// GET /api/v1/entitlements  ↔  contracts/entitlements.ts
// ---------------------------------------------------------------------------

describe('wire contract — /entitlements', () => {
  it('pins the response key sets the portal compiles against', async () => {
    await seedProTenant();
    const res = await request(app).get('/api/v1/entitlements');
    expect(res.status).toBe(200);

    const data = res.body.data;
    expect(keysOf(data)).toEqual(['current', 'plans', 'selfServePlans']);
    expect(keysOf(data.current)).toEqual(
      ['activeModules', 'billable', 'features', 'limits', 'planId', 'support'],
    );
    expect(keysOf(data.current.features)).toEqual([
      'aiBusinessInsights',
      'bookings',
      'calendarSync',
      'channelInstagram',
      'channelMessenger',
      'channelTelegram',
      'channelWhatsapp',
      'crm',
      'customWidgetAppearance',
      'fileUpload',
      'gapEvidence',
      'gapInsights',
      'handoff',
      'hideWidgetAttribution',
      'leadCapture',
      'platformAssistant',
      'unifiedInbox',
    ]);
    expect(keysOf(data.plans[0])).toEqual([
      'displayName',
      'features',
      'id',
      'isSelfServeCheckoutable',
      'limits',
      'priceEurMonthly',
      'rank',
      'support',
    ]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/insights (+ evidence gate)  ↔  contracts/insights.ts
// ---------------------------------------------------------------------------

describe('wire contract — /insights', () => {
  it('pins the gap + meta key sets the portal compiles against', async () => {
    const tenant = await seedProTenant();
    const topic = await AppDataSource.getRepository(CanonicalTopic).save({
      tenantId: tenant.id,
      topic: 'pricing',
    });
    await AppDataSource.getRepository(Gap).save({
      tenantId: tenant.id,
      canonicalTopicId: topic.id,
      status: 'open',
      severity: 'red',
      occurrences: 5,
      distinctVisitors: 5,
      firstDetectedAt: new Date(),
      lastSeenAt: new Date(),
    });

    const res = await request(app).get('/api/v1/insights');
    expect(res.status).toBe(200);

    const data = res.body.data;
    expect(keysOf(data)).toEqual(['gaps', 'meta']);
    expect(keysOf(data.meta)).toEqual([
      'completeness',
      'evidenceEnabled',
      'lastRefreshedAt',
      'retentionDays',
    ]);
    expect(keysOf(data.gaps[0])).toEqual([
      'archivedAt',
      'distinctVisitors',
      'firstDetectedAt',
      'id',
      'lastSeenAt',
      'occurrences',
      'recommendation',
      'resolvedAt',
      'severity',
      'status',
      'topic',
    ]);
    // Pro: evidence is included in the flag set (ADR-0013 ladder).
    expect(data.meta.evidenceEnabled).toBe(true);
    expect(data.meta.retentionDays).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/analytics/outcomes (+ timeseries)  ↔  contracts/analytics.ts
// ---------------------------------------------------------------------------

describe('wire contract — /analytics/outcomes', () => {
  it('pins the aggregate key sets the portal compiles against', async () => {
    await seedProTenant();
    const res = await request(app).get('/api/v1/analytics/outcomes');
    expect(res.status).toBe(200);

    const data = res.body.data;
    expect(keysOf(data)).toEqual(['current', 'previous', 'previousRange', 'range']);
    expect(keysOf(data.range)).toEqual(['from', 'to']);
    expect(keysOf(data.current)).toEqual(['afterHours', 'bookings', 'conversations', 'leads']);
    expect(keysOf(data.current.conversations)).toEqual(['byChannel', 'total']);
    expect(keysOf(data.current.leads)).toEqual(['bySource', 'total']);
    // No scheduler rules seeded → the after-hours metric has no meaning.
    expect(data.current.afterHours).toBeNull();
  });

  it('pins the timeseries point shape', async () => {
    await seedProTenant();
    const res = await request(app).get('/api/v1/analytics/outcomes/timeseries');
    expect(res.status).toBe(200);
    expect(keysOf(res.body.data)).toEqual(['timeseries']);
    // Empty tenant → empty (sparse) series; shape pinned by the contract type
    // + the populated-case unit tests.
    expect(Array.isArray(res.body.data.timeseries)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/insights/experiments  ↔  contracts/insights.ts (P3, Enterprise)
// ---------------------------------------------------------------------------

describe('wire contract — /insights/experiments', () => {
  it('403s a Pro tenant (aiBusinessInsights-gated)', async () => {
    await seedProTenant();
    const res = await request(app).get('/api/v1/insights/experiments');
    expect(res.status).toBe(403);
  });

  it('pins the experiment key set for an Enterprise tenant', async () => {
    const tenant = await seedEnterpriseTenant();
    await AppDataSource.getRepository(InsightExperiment).save({
      tenantId: tenant.id,
      kind: 'sentiment',
      fingerprint: 'theme-1',
      severity: 'orange',
      title: 'Customers frequently mention "slow response" — 4 sessions in 30 days',
      detail: null,
      payload: { theme: 'slow response', sessions: 4 },
      state: 'active',
    });

    const res = await request(app).get('/api/v1/insights/experiments');
    expect(res.status).toBe(200);
    expect(keysOf(res.body.data)).toEqual(['experiments']);
    expect(keysOf(res.body.data.experiments[0])).toEqual([
      'detail',
      'firstSeenAt',
      'id',
      'kind',
      'lastSeenAt',
      'payload',
      'severity',
      'title',
    ]);
    expect(res.body.data.experiments[0].kind).toBe('sentiment');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/insights/digest  ↔  contracts/insights.ts (P3, Enterprise)
// ---------------------------------------------------------------------------

describe('wire contract — /insights/digest', () => {
  it('403s a Pro tenant (aiBusinessInsights-gated)', async () => {
    await seedProTenant();
    const res = await request(app).get('/api/v1/insights/digest');
    expect(res.status).toBe(403);
  });

  it('pins the digest envelope shape for an Enterprise tenant', async () => {
    const tenant = await seedEnterpriseTenant();
    await AppDataSource.getRepository(InsightDigest).save({
      tenantId: tenant.id,
      weekStart: '2026-06-08',
      summaryMd: 'A grounded weekly summary.',
      metrics: {
        conversations: { current: 10, previous: 5 },
        bookings: { current: 3, previous: 1 },
        leads: { current: 2, previous: 0 },
        gapsOpened: 4,
        gapsWon: 2,
      },
      sendState: 'pending',
    });

    const res = await request(app).get('/api/v1/insights/digest');
    expect(res.status).toBe(200);
    expect(keysOf(res.body.data)).toEqual(['digest', 'emailEnabled']);
    expect(keysOf(res.body.data.digest)).toEqual(['metrics', 'summaryMd', 'weekStart']);
    expect(keysOf(res.body.data.digest.metrics)).toEqual([
      'bookings',
      'conversations',
      'gapsOpened',
      'gapsWon',
      'leads',
    ]);
    expect(res.body.data.emailEnabled).toBe(true);
  });
});
