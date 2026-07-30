/**
 * Tenant outbound event-webhook config (/tenants/me/event-webhooks).
 *
 * This route is the WRITER that `webhook.emitter.ts` has always needed —
 * `tenant.settings.eventWebhooks` was read but populated by nothing, so the
 * "send your leads to your CRM" promise was unfulfillable. The tests pin the
 * properties that make it safe to expose customer PII egress to tenant admins:
 * SSRF validation at write time, no secret ever echoed back, and the `crm` gate.
 */
import { describe, it, expect, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  userId: '',
  tenantId: '',
  role: 'admin' as string,
  email: 'test@example.com',
}));

vi.mock('../../middleware/clerk.middleware', async () => {
  const { UnauthorizedError } = await import('../../middleware/error-handler');
  return {
    requireClerkAuth: (req: any, _res: any, next: any) => {
      if (!auth.userId) return next(new UnauthorizedError('no userId'));
      req.userId = auth.userId;
      req.tenantId = auth.tenantId;
      req.userRole = auth.role;
      req.user = { id: auth.userId, email: auth.email, role: auth.role, tenantId: auth.tenantId, type: 'agent' };
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
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { createTestTenant, createTestUser } from '../helpers/factories';

const BASE = '/api/v1/tenants/me/event-webhooks';

async function seed(tier: 'pro' | 'enterprise', role = 'admin') {
  const tenant = await createTestTenant({ tier });
  const user = await createTestUser(tenant.id, { role: role as 'admin' });
  auth.tenantId = tenant.id;
  auth.userId = user.id;
  auth.role = role;
  return tenant;
}

async function storedConfigs(tenantId: string) {
  const tenant = await AppDataSource.getRepository(Tenant).findOneOrFail({ where: { id: tenantId } });
  const raw = (tenant.settings as { eventWebhooks?: unknown } | null)?.eventWebhooks;
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
}

describe('event-webhooks — entitlement gate', () => {
  it('402s a Pro tenant (crm is Enterprise-only)', async () => {
    await seed('pro');
    expect((await request(app).get(BASE)).status).toBe(402);
  });

  it('lets an Enterprise tenant read an initially empty config', async () => {
    await seed('enterprise');
    const res = await request(app).get(BASE);
    expect(res.status).toBe(200);
    expect(res.body.data.webhooks).toEqual([]);
    // The lead lifecycle events must be subscribable, or CRM sync is a one-shot
    // that cannot patch or honour erasure.
    expect(res.body.data.subscribableEvents).toContain('lead.created');
    expect(res.body.data.subscribableEvents).toContain('lead.updated');
    expect(res.body.data.subscribableEvents).toContain('lead.deleted');
  });
});

describe('event-webhooks — writing', () => {
  it('persists an endpoint so the emitter can finally find one', async () => {
    const tenant = await seed('enterprise');
    const res = await request(app)
      .put(BASE)
      .send({ webhooks: [{ url: 'https://hooks.zapier.com/abc', events: ['lead.created', 'lead.updated'] }] });

    expect(res.status).toBe(200);
    const stored = await storedConfigs(tenant.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].url).toBe('https://hooks.zapier.com/abc');
    expect(stored[0].events).toEqual(['lead.created', 'lead.updated']);
    expect(stored[0].enabled).toBe(true);
  });

  it('generates a signing secret when none is given, and never returns it', async () => {
    const tenant = await seed('enterprise');
    const res = await request(app)
      .put(BASE)
      .send({ webhooks: [{ url: 'https://hooks.example.com/a', events: ['lead.created'] }] });

    // An endpoint must never end up unsigned merely because the field was omitted.
    const stored = await storedConfigs(tenant.id);
    expect(typeof stored[0].secret).toBe('string');
    expect((stored[0].secret as string).length).toBeGreaterThanOrEqual(32);
    // …but the secret is write-only on the wire.
    expect(JSON.stringify(res.body)).not.toContain(stored[0].secret as string);
    expect(res.body.data.webhooks[0].hasSecret).toBe(true);
    expect(res.body.data.webhooks[0]).not.toHaveProperty('secret');
  });

  it('KEEPS the existing secret when a round-trip omits it', async () => {
    // The GET never returns the secret, so a naive save would blank it and silently
    // break signature verification on the tenant's endpoint.
    const tenant = await seed('enterprise');
    await request(app)
      .put(BASE)
      .send({ webhooks: [{ url: 'https://hooks.example.com/keep', events: ['lead.created'] }] });
    const first = (await storedConfigs(tenant.id))[0].secret;

    await request(app)
      .put(BASE)
      .send({ webhooks: [{ url: 'https://hooks.example.com/keep', events: ['lead.deleted'] }] });
    const after = await storedConfigs(tenant.id);

    expect(after[0].secret).toBe(first); // preserved
    expect(after[0].events).toEqual(['lead.deleted']); // but the events did change
  });

  it('rotates the secret when one IS supplied', async () => {
    const tenant = await seed('enterprise');
    await request(app)
      .put(BASE)
      .send({ webhooks: [{ url: 'https://hooks.example.com/rot', events: ['lead.created'] }] });
    const first = (await storedConfigs(tenant.id))[0].secret;

    await request(app)
      .put(BASE)
      .send({
        webhooks: [{ url: 'https://hooks.example.com/rot', events: ['lead.created'], secret: 'x'.repeat(40) }],
      });
    expect((await storedConfigs(tenant.id))[0].secret).not.toBe(first);
  });

  it('does not clobber unrelated tenant settings (targeted jsonb merge)', async () => {
    const tenant = await seed('enterprise');
    await AppDataSource.query(
      `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || '{"keepMe":"yes"}'::jsonb WHERE id = $1`,
      [tenant.id],
    );

    await request(app)
      .put(BASE)
      .send({ webhooks: [{ url: 'https://hooks.example.com/m', events: ['lead.created'] }] });

    const after = await AppDataSource.getRepository(Tenant).findOneOrFail({ where: { id: tenant.id } });
    expect((after.settings as Record<string, unknown>).keepMe).toBe('yes');
  });
});

// ValidationError maps to 422 in this codebase (BadRequestError is 400) — matching
// feature-toggles.routes.ts, which uses ValidationError for the same kind of input.
describe('event-webhooks — rejects unsafe or malformed input', () => {
  it('rejects a non-https URL', async () => {
    await seed('enterprise');
    const res = await request(app)
      .put(BASE)
      .send({ webhooks: [{ url: 'http://hooks.example.com/a', events: ['lead.created'] }] });
    expect(res.status).toBe(422);
  });

  it('rejects private / loopback targets at WRITE time (SSRF)', async () => {
    // Validating on write means a bad target is refused when it is configured,
    // rather than only failing later inside the dispatcher.
    await seed('enterprise');
    for (const url of ['https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/x']) {
      const res = await request(app).put(BASE).send({ webhooks: [{ url, events: ['lead.created'] }] });
      expect(res.status, `expected 422 for ${url}`).toBe(422);
    }
  });

  it('rejects an unknown event name rather than storing one that can never fire', async () => {
    await seed('enterprise');
    const res = await request(app)
      .put(BASE)
      .send({ webhooks: [{ url: 'https://hooks.example.com/a', events: ['lead.exploded'] }] });
    expect(res.status).toBe(422);
  });

  it('rejects an empty event list and duplicate URLs', async () => {
    await seed('enterprise');
    expect(
      (await request(app).put(BASE).send({ webhooks: [{ url: 'https://a.example.com/x', events: [] }] })).status,
    ).toBe(422);
    expect(
      (
        await request(app)
          .put(BASE)
          .send({
            webhooks: [
              { url: 'https://a.example.com/x', events: ['lead.created'] },
              { url: 'https://a.example.com/x', events: ['lead.updated'] },
            ],
          })
      ).status,
    ).toBe(422);
  });

  it('caps the number of endpoints', async () => {
    await seed('enterprise');
    const webhooks = Array.from({ length: 6 }, (_, i) => ({
      url: `https://hooks.example.com/${i}`,
      events: ['lead.created'],
    }));
    expect((await request(app).put(BASE).send({ webhooks })).status).toBe(422);
  });

  it('403s a non-admin seat — this configures egress of customer personal data', async () => {
    await seed('enterprise', 'supervisor');
    try {
      const res = await request(app)
        .put(BASE)
        .send({ webhooks: [{ url: 'https://hooks.example.com/a', events: ['lead.created'] }] });
      expect(res.status).toBe(403);
    } finally {
      auth.role = 'admin'; // hoisted + shared — must not leak into other tests
    }
  });
});
