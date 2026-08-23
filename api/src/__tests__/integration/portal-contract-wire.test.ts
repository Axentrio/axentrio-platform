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
import { Lead } from '../../database/entities/Lead';
import { logAudit } from '../../utils/audit';
import { getConfiguredOrigins } from '../../security/cors';
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
      ['activeModules', 'billable', 'entitledFeatures', 'featureToggles', 'features', 'limits', 'planId', 'support'],
    );
    // entitledFeatures mirrors the features shape (it's the ceiling pre-toggle);
    // featureToggles is the tenant's raw on/off prefs ({} when none set).
    expect(keysOf(data.current.entitledFeatures)).toEqual(keysOf(data.current.features));
    expect(Array.isArray(data.current.featureToggles)).toBe(false);
    expect(keysOf(data.current.features)).toEqual([
      'aiBusinessInsights',
      'bookings',
      'calendarSync',
      'channelInstagram',
      'channelLinkedin',
      'channelMessenger',
      'channelTelegram',
      'channelTiktok',
      'channelWhatsapp',
      'channelX',
      'cloudImport',
      'crm',
      'customWidgetAppearance',
      'fileUpload',
      'gapEvidence',
      'gapInsights',
      'handoff',
      'hideWidgetAttribution',
      'leadCapture',
      'leadEnrichment',
      'platformAssistant',
      'proactiveLeadCapture',
      'travelTime',
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
      recommendation: 'Publish clear pricing in the knowledge base.',
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
      'priorityScore',
      'recommendation',
      'resolvedAt',
      'severity',
      'status',
      'topic',
    ]);
    // Pro: evidence is included in the flag set (ADR-0013 ladder).
    expect(data.meta.evidenceEnabled).toBe(true);
    expect(data.meta.retentionDays).toBe(90);
    expect(data.gaps[0].recommendation).toBe('Publish clear pricing in the knowledge base.');
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
      'priorityScore',
      'severity',
      'title',
    ]);
    expect(res.body.data.experiments[0].kind).toBe('sentiment');
  });
});

describe('wire contract — /insights/sentiment/trend', () => {
  it('exposes the Pro sentiment trend shape', async () => {
    await seedProTenant();
    const res = await request(app).get('/api/v1/insights/sentiment/trend?days=7');
    expect(res.status).toBe(200);
    expect(keysOf(res.body.data)).toEqual(['timeseries', 'windowDays']);
    expect(res.body.data.windowDays).toBe(7);
    expect(keysOf(res.body.data.timeseries[0])).toEqual([
      'date',
      'negative',
      'neutral',
      'positive',
    ]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/insights/digest  ↔  contracts/insights.ts (Pro+)
// ---------------------------------------------------------------------------

describe('wire contract — /insights/digest', () => {
  it('serves a weekly improvement snapshot to Pro', async () => {
    const tenant = await seedProTenant();
    await AppDataSource.getRepository(InsightDigest).save({
      tenantId: tenant.id,
      weekStart: '2026-06-08',
      summaryMd: 'A grounded Pro weekly summary.',
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
    expect(res.body.data.digest.summaryMd).toBe('A grounded Pro weekly summary.');
  });

  it('keeps the snapshot unavailable to Essential', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });

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

// ---------------------------------------------------------------------------
// GET /api/v1/analytics/export  ↔  exporter registry (P3, Enterprise, D7)
// ---------------------------------------------------------------------------

describe('analytics export — /analytics/export', () => {
  it('403s a Pro tenant (aiBusinessInsights-gated)', async () => {
    await seedProTenant();
    const res = await request(app).get('/api/v1/analytics/export?dataset=leads');
    expect(res.status).toBe(403);
  });

  it('streams a text/csv attachment for an Enterprise tenant', async () => {
    await seedEnterpriseTenant();
    const res = await request(app).get('/api/v1/analytics/export?dataset=leads');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="leads_.*\.csv"/);
    // Header row is always present even with no leads in range.
    expect(res.text.split('\r\n')[0]).toBe('created_at_utc,name,email,phone,channel,source,status,notes');
  });

  it('400s an unknown dataset', async () => {
    await seedEnterpriseTenant();
    const res = await request(app).get('/api/v1/analytics/export?dataset=bogus');
    expect(res.status).toBe(400);
  });

  it('405s the retired POST with an Allow: GET header', async () => {
    await seedEnterpriseTenant();
    const res = await request(app).post('/api/v1/analytics/export');
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('GET');
  });
});

// ---------------------------------------------------------------------------
// Leads worklist routes — GET /leads/export (leadCapture-gated) + PATCH /leads/:id
// ---------------------------------------------------------------------------

describe('leads routes — export + status', () => {
  it('lets a Pro tenant export leads CSV (leadCapture-gated, NOT aiBusinessInsights) with the notes column', async () => {
    await seedProTenant();
    const res = await request(app).get('/api/v1/leads/export');
    expect(res.status).toBe(200); // Pro is 403 on /analytics/export?dataset=leads but 200 here
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    // Interchange framing, NOT Excel framing. `format=csv` is comma-delimited RFC 4180
    // with a UTF-8 BOM (so é/ë/ç in NL/FR names survive) and NO `sep=` hint line — a
    // strict parser reads that hint as a stray first data row. The semicolon+`sep=`
    // variant was correct only while CSV was the sole export format; `?format=xlsx`
    // is now the Excel path, so a file offered as "CSV" is allowed to be one.
    expect(res.text.startsWith('﻿')).toBe(true);
    expect(res.text).not.toContain('sep=');
    const lines = res.text.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('created_at_utc,name,email,phone,channel,source,status,notes');
  });

  it('403s the leads export for an `agent` seat but allows a supervisor (bulk PII egress)', async () => {
    const tenant = await seedProTenant(); // leaves auth.role = 'admin'
    try {
      const agent = await createTestUser(tenant.id, { role: 'agent' });
      setAuth({ tenantId: tenant.id, userId: agent.id });
      auth.role = 'agent'; // `agent` is the DEFAULT auto-provision role
      expect((await request(app).get('/api/v1/leads/export')).status).toBe(403);

      const supervisor = await createTestUser(tenant.id, { role: 'supervisor' });
      setAuth({ tenantId: tenant.id, userId: supervisor.id });
      auth.role = 'supervisor';
      expect((await request(app).get('/api/v1/leads/export')).status).toBe(200);
    } finally {
      auth.role = 'admin'; // hoisted + shared across tests — must not leak
    }
  });

  it('exposes the export headers to the portal via CORS (portal is a different origin)', async () => {
    await seedProTenant();
    // Use an origin this deployment actually allows, so the test asserts the
    // expose-headers POLICY rather than whether one hardcoded hostname is in the
    // allowlist (an unmatched origin gets no CORS headers at all, which would
    // make this pass/fail for the wrong reason).
    const allowedOrigin = getConfiguredOrigins().find((o) => o !== '*');
    const req0 = request(app).get('/api/v1/leads/export');
    const res = await (allowedOrigin ? req0.set('Origin', allowedOrigin) : req0);
    expect(res.status).toBe(200);

    // Without Access-Control-Expose-Headers the browser hides everything except
    // the 7 CORS-safelisted headers, so the download filename silently falls back
    // and a truncated export is never surfaced — while same-process supertest
    // assertions on res.headers still pass. Assert the EXPOSURE, not the header.
    const exposed = String(res.headers['access-control-expose-headers'] ?? '').toLowerCase();
    expect(exposed).toContain('content-disposition');
    expect(exposed).toContain('x-export-truncated');
  });

  it('audits the leads export with the row count that actually left', async () => {
    await seedProTenant();
    vi.mocked(logAudit).mockClear();

    const res = await request(app).get('/api/v1/leads/export');
    expect(res.status).toBe(200);

    // logAudit is module-mocked in this suite, so assert the call, not a DB row.
    expect(logAudit).toHaveBeenCalledWith(
      expect.any(String),
      'leads.exported',
      'lead',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ format: 'csv', truncated: false, rowCount: expect.any(Number) }),
    );
  });

  it('marks a lead handled (PATCH status=archived); validates value + scopes to tenant', async () => {
    const tenant = await seedProTenant();
    const repo = AppDataSource.getRepository(Lead);
    const lead = await repo.save(
      repo.create({ tenantId: tenant.id, email: 'arch@x.io', dedupeKey: 'email:arch@x.io', source: 'tool' }),
    );

    const ok = await request(app).patch(`/api/v1/leads/${lead.id}`).send({ status: 'archived' });
    expect(ok.status).toBe(200);
    expect((await repo.findOneByOrFail({ id: lead.id })).status).toBe('archived');

    const bad = await request(app).patch(`/api/v1/leads/${lead.id}`).send({ status: 'nope' });
    expect(bad.status).toBe(400);

    const missing = await request(app)
      .patch('/api/v1/leads/00000000-0000-0000-0000-000000000000')
      .send({ status: 'new' });
    expect(missing.status).toBe(404);
  });

  it('402s a tenant without leadCapture (free) on both export and status (requireFeature plan-limit)', async () => {
    const tenant = await createTestTenant({ tier: 'free' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });
    expect((await request(app).get('/api/v1/leads/export')).status).toBe(402);
    expect(
      (await request(app).patch('/api/v1/leads/00000000-0000-0000-0000-000000000000').send({ status: 'new' })).status,
    ).toBe(402);
  });
});
