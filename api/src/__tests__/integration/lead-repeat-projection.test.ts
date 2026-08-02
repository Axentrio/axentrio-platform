/**
 * The repeat-customer READ boundary.
 *
 * The sweep's own behaviour is covered in lead-repeat-detection.test.ts; what matters
 * here is that there is exactly ONE notion of "repeat" leaving the server. Before this
 * change the leads list shipped a per-row `conversationCount` that the portal rendered
 * as "returning" — a number that structurally cannot see a returning customer, because
 * their second visit creates a second lead row rather than a second conversation on the
 * first one. That number still ships, and still means what its name says, but it is no
 * longer the repeat signal for either the portal or the readiness score.
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
import { LeadConversation } from '../../database/entities/LeadConversation';
import { sweepTenant } from '../../leads/repeat-detection.service';
import { createTestTenant, createTestUser, createTestSession } from '../helpers/factories';

const uniq = () => Math.random().toString(36).slice(2, 10);

async function seedTenant() {
  const tenant = await createTestTenant({ tier: 'enterprise' });
  const user = await createTestUser(tenant.id, { role: 'admin' });
  auth.tenantId = tenant.id;
  auth.userId = user.id;
  return tenant;
}

async function seedLead(tenantId: string, over: Partial<Lead>): Promise<Lead> {
  const repo = AppDataSource.getRepository(Lead);
  const lead = await repo.save(
    repo.create({ tenantId, name: 'Achraf', source: 'channel', dedupeKey: `seed:${uniq()}`, ...over }),
  );
  const session = await createTestSession(tenantId);
  const convRepo = AppDataSource.getRepository(LeadConversation);
  await convRepo.save(
    convRepo.create({ tenantId, leadId: lead.id, sessionId: session.id, source: 'link' }),
  );
  return lead;
}

describe('GET /leads — repeat-customer projection', () => {
  it('reports the PERSON across their identity rows, not the row', async () => {
    const tenant = await seedTenant();
    await seedLead(tenant.id, {
      channel: 'whatsapp',
      externalUserId: '32475464421',
      phone: '32475464421',
    });
    await seedLead(tenant.id, { channel: 'widget', phone: '+32 475 46 44 21', source: 'tool' });
    await sweepTenant(tenant.id);

    const res = await request(app).get('/api/v1/leads');
    expect(res.status).toBe(200);
    const rows = res.body.data.leads as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      // The row's own count is 1 — which is exactly why it cannot be the repeat signal.
      expect(row.conversationCount).toBe(1);
      expect(row.personConversationCount).toBe(2);
      expect(row.personLeadCount).toBe(2);
      expect(row.isRepeatCustomer).toBe(true);
      expect(typeof row.personFirstSeenAt).toBe('string');
      expect(typeof row.personLastSeenAt).toBe('string');
      // The grouping key is a plaintext phone number; it stays server-side.
      expect(row.personKey).toBeUndefined();
      // The score follows the same one definition.
      const readiness = row.readiness as { components: Array<{ key: string }> };
      expect(readiness.components.map((c) => c.key)).toContain('returning');
    }
  });

  it('falls back to the row before the sweep has run, and never invents a repeat', async () => {
    const tenant = await seedTenant();
    await seedLead(tenant.id, { channel: 'widget', phone: '32475464421', source: 'tool' });

    const res = await request(app).get('/api/v1/leads');
    const row = res.body.data.leads[0];
    // No sweep yet: the person columns are NULL, so the projection degrades to this
    // record alone — a strict floor, so it can under-report but never over-report.
    expect(row.personConversationCount).toBe(1);
    expect(row.personLeadCount).toBe(1);
    expect(row.isRepeatCustomer).toBe(false);
    expect(row.personFirstSeenAt).toBeNull();
    const readiness = row.readiness as { components: Array<{ key: string }> };
    expect(readiness.components.map((c) => c.key)).not.toContain('returning');
  });

  it('does not leak the person block to a tenant without the enrichment entitlement', async () => {
    // Essential gets the basic lead set only; the whole derived block is Pro+.
    const tenant = await createTestTenant({ tier: 'essential' });
    const user = await createTestUser(tenant.id, { role: 'admin' });
    auth.tenantId = tenant.id;
    auth.userId = user.id;
    await seedLead(tenant.id, { channel: 'widget', phone: '32475464421', source: 'tool' });

    const res = await request(app).get('/api/v1/leads');
    const row = res.body.data.leads[0];
    expect(row.personConversationCount).toBeUndefined();
    expect(row.isRepeatCustomer).toBeUndefined();
    expect(row.conversationCount).toBeUndefined();
  });
});
