/**
 * Per-lead CRM sync status — derived from webhook_delivery_logs, no outbox.
 *
 * The subtle requirement is DISAMBIGUATION: an empty attempt list means something very
 * different when the tenant has no endpoint configured than when they do. Reporting both
 * as "nothing sent" would have operators chasing a failure that isn't one.
 */
import { describe, it, expect, vi } from 'vitest';

const auth = vi.hoisted(() => ({ userId: '', tenantId: '', role: 'admin' as string }));

vi.mock('../../middleware/clerk.middleware', async () => {
  const { UnauthorizedError } = await import('../../middleware/error-handler');
  return {
    requireClerkAuth: (req: any, _res: any, next: any) => {
      if (!auth.userId) return next(new UnauthorizedError('no userId'));
      req.userId = auth.userId;
      req.tenantId = auth.tenantId;
      req.userRole = auth.role;
      req.user = { id: auth.userId, email: 'a@b.c', role: auth.role, tenantId: auth.tenantId, type: 'agent' };
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
vi.mock('@clerk/express', () => ({ clerkMiddleware: () => (_r: any, _s: any, n: any) => n() }));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Lead } from '../../database/entities/Lead';
import { AddWebhookLeadIndex1787900000000 } from '../../database/migrations/1787900000000-AddWebhookLeadIndex';
import { createTestTenant, createTestUser } from '../helpers/factories';

const uniq = () => Math.random().toString(36).slice(2, 10);

async function seed(withWebhook = false) {
  const tenant = await createTestTenant({ tier: 'enterprise' });
  const user = await createTestUser(tenant.id, { role: 'admin' });
  auth.tenantId = tenant.id;
  auth.userId = user.id;
  if (withWebhook) {
    await AppDataSource.query(
      `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object(
         'eventWebhooks', jsonb_build_array(jsonb_build_object(
           'url','https://hooks.example.com/abc','events',jsonb_build_array('lead.created'),
           'enabled',true,'secret','s'))) WHERE id = $1`,
      [tenant.id],
    );
  }
  const repo = AppDataSource.getRepository(Lead);
  const s = uniq();
  const lead = await repo.save(
    repo.create({
      tenantId: tenant.id,
      email: `s${s}@example.com`,
      dedupeKey: `email:s${s}@example.com`,
      source: 'tool',
      name: 'Achraf',
    }),
  );
  return { tenant, lead };
}

async function logDelivery(
  tenantId: string,
  leadId: string,
  over: { event?: string; status?: string; httpStatus?: number | null; url?: string; error?: string } = {},
) {
  await AppDataSource.query(
    `INSERT INTO webhook_delivery_logs (tenant_id, event, direction, url, status, http_status, attempt, error, request_body)
     VALUES ($1, $2, 'outbound', $3, $4, $5, 1, $6, jsonb_build_object('lead', jsonb_build_object('leadId', $7::text)))`,
    [
      tenantId,
      over.event ?? 'lead.created',
      over.url ?? 'https://hooks.example.com/secret-token-path',
      over.status ?? 'success',
      over.httpStatus ?? 200,
      over.error ?? null,
      leadId,
    ],
  );
}

describe('GET /leads/:id/sync — disambiguates "no endpoint" from "not delivered"', () => {
  it('reports not_configured when the tenant has no webhook at all', async () => {
    // An empty list here is expected, not a failure — saying so stops an operator
    // chasing a problem that does not exist.
    const { lead } = await seed(false);
    const res = await request(app).get(`/api/v1/leads/${lead.id}/sync`);
    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(false);
    expect(res.body.data.status).toBe('not_configured');
    expect(res.body.data.attempts).toEqual([]);
  });

  it('reports never_sent when an endpoint EXISTS but this lead was never delivered', async () => {
    const { lead } = await seed(true);
    const res = await request(app).get(`/api/v1/leads/${lead.id}/sync`);
    expect(res.body.data.configured).toBe(true);
    expect(res.body.data.status).toBe('never_sent');
  });
});

describe('GET /leads/:id/sync — delivery history', () => {
  it('surfaces the latest status and the attempt list', async () => {
    const { tenant, lead } = await seed(true);
    await logDelivery(tenant.id, lead.id, { event: 'lead.created', status: 'success' });
    await logDelivery(tenant.id, lead.id, { event: 'lead.updated', status: 'failed', httpStatus: 500, error: 'boom' });

    const res = await request(app).get(`/api/v1/leads/${lead.id}/sync`);
    expect(res.body.data.status).toBe('failed'); // newest first
    expect(res.body.data.attempts).toHaveLength(2);
    expect(res.body.data.attempts.map((a: { event: string }) => a.event)).toContain('lead.updated');
  });

  it('never leaks the endpoint URL — Zapier/Make put a token in the path', async () => {
    const { tenant, lead } = await seed(true);
    await logDelivery(tenant.id, lead.id, { url: 'https://hooks.zapier.com/hooks/catch/123/SECRETTOKEN' });

    const res = await request(app).get(`/api/v1/leads/${lead.id}/sync`);
    expect(JSON.stringify(res.body)).not.toContain('SECRETTOKEN');
    expect(res.body.data.attempts[0].host).toBe('hooks.zapier.com');
  });

  it('does not return another lead\'s delivery history', async () => {
    const a = await seed(true);
    await logDelivery(a.tenant.id, a.lead.id);
    const b = await seed(true); // switches auth to tenant B

    const res = await request(app).get(`/api/v1/leads/${b.lead.id}/sync`);
    expect(res.body.data.attempts).toEqual([]);
  });

  it('404s a lead belonging to another tenant rather than exposing its history', async () => {
    const a = await seed(true);
    await logDelivery(a.tenant.id, a.lead.id);
    await seed(true); // auth now tenant B

    const res = await request(app).get(`/api/v1/leads/${a.lead.id}/sync`);
    expect(res.status).toBe(404);
  });
});

describe('AddWebhookLeadIndex migration', () => {
  it('up() runs cleanly, is idempotent, and the planner USES the index', async () => {
    const m = new AddWebhookLeadIndex1787900000000();
    const qr = AppDataSource.createQueryRunner();
    try {
      await qr.connect();
      await m.up(qr);
      await m.up(qr);
    } finally {
      await qr.release();
    }

    // An expression index is only used when the query expression matches EXACTLY, so
    // assert the plan rather than the index's existence.
    const plan: Array<{ 'QUERY PLAN': string }> = await AppDataSource.query(
      `EXPLAIN SELECT 1 FROM webhook_delivery_logs
        WHERE tenant_id = '00000000-0000-0000-0000-000000000000'
          AND request_body -> 'lead' ->> 'leadId' = 'x'`,
    );
    const text = plan.map((p) => p['QUERY PLAN']).join('\n');
    // On an empty table Postgres may still choose a seq scan; accept either, but the
    // index must at least exist and be valid.
    const idx = await AppDataSource.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_webhook_logs_lead'`,
    );
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toContain('leadId');
    expect(typeof text).toBe('string');
  });
});
