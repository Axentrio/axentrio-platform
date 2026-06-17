import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { SpamScamLog } from '../../database/entities/SpamScamLog';
import { GuardrailOutputLog } from '../../database/entities/GuardrailOutputLog';
import { isGuardrailsEnforcing } from '../../guardrails/inbound-guardrails.service';
import { createTestTenant, createTestUser } from '../helpers/factories';

const tenantRepo = () => AppDataSource.getRepository(Tenant);

describe('admin guardrails (super-admin cockpit)', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant();
    tenantId = tenant.id;
    const admin = await createTestUser(tenantId, { role: 'super_admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId, role: 'super_admin' });
  });

  async function seedLogs() {
    const spam = AppDataSource.getRepository(SpamScamLog);
    await spam.save(spam.create({
      tenantId, conversationId: crypto.randomUUID(), sourceChannel: 'widget',
      detectedCategory: 'phishing', reasons: ['fake security alert'], enforced: false,
    }));
    const out = AppDataSource.getRepository(GuardrailOutputLog);
    await out.save(out.create({
      tenantId, conversationId: crypto.randomUUID(), sourceChannel: 'widget',
      generationPath: 'coalescer', families: ['plan_leakage'], reasons: ['plan_leakage: names a plan'], enforced: true,
    }));
  }

  it('GET /guardrails/flagged returns a normalized feed of inbound + output events', async () => {
    await seedLogs();
    const res = await request(app).get('/api/v1/admin/guardrails/flagged?limit=50');
    expect(res.status).toBe(200);
    const events = res.body.data.events;
    const mine = events.filter((e: { tenantId: string }) => e.tenantId === tenantId);
    expect(mine.map((e: { source: string }) => e.source).sort()).toEqual(['inbound', 'output']);

    const out = await request(app).get('/api/v1/admin/guardrails/flagged?source=output');
    expect(out.body.data.events.every((e: { source: string }) => e.source === 'output')).toBe(true);
  });

  it('PUT /tenants/:id/guardrails flips the enforce flag (and rejects non-boolean)', async () => {
    const on = await request(app).put(`/api/v1/admin/tenants/${tenantId}/guardrails`).send({ enforce: true });
    expect(on.status).toBe(200);
    expect((await tenantRepo().findOneOrFail({ where: { id: tenantId } })).settings?.guardrails?.enforce).toBe(true);

    await request(app).put(`/api/v1/admin/tenants/${tenantId}/guardrails`).send({ enforce: false });
    expect((await tenantRepo().findOneOrFail({ where: { id: tenantId } })).settings?.guardrails?.enforce).toBe(false);

    const bad = await request(app).put(`/api/v1/admin/tenants/${tenantId}/guardrails`).send({ enforce: 'yes' });
    expect(bad.status).toBe(422); // ValidationError → 422 in this API
  });

  it('GET /guardrails/summary returns counts', async () => {
    await seedLogs();
    const res = await request(app).get('/api/v1/admin/guardrails/summary?days=7');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('byTenant');
    expect(res.body.data).toHaveProperty('inbound');
    expect(res.body.data).toHaveProperty('output');
  });

  it('requires super-admin (403 for a regular admin)', async () => {
    configureMockAuth(auth, { userId: 'u', tenantId, role: 'admin' });
    const res = await request(app).get('/api/v1/admin/guardrails/flagged');
    expect(res.status).toBe(403);
  });

  it('GUARDRAILS_KILL_SWITCH forces enforcing=false even when the tenant flag is on', async () => {
    await tenantRepo().save({ ...(await tenantRepo().findOneOrFail({ where: { id: tenantId } })), settings: { guardrails: { enforce: true } } } as Tenant);
    const prev = process.env.GUARDRAILS_KILL_SWITCH;
    try {
      process.env.GUARDRAILS_KILL_SWITCH = 'true';
      expect(await isGuardrailsEnforcing(tenantId)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GUARDRAILS_KILL_SWITCH;
      else process.env.GUARDRAILS_KILL_SWITCH = prev;
    }
  });
});
