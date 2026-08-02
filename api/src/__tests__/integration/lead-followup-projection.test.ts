/**
 * The follow-up recommendation at the READ boundary.
 *
 * The rules themselves are covered in unit/lead-followup.test.ts. What matters here is
 * everything the route owns and the engine cannot see:
 *
 *   - the `aiBusinessInsights` gate is on the PROJECTION, so a Pro tenant cannot read an
 *     Enterprise feature by calling the API directly — hiding it in the portal would be
 *     no gate at all
 *   - absent (not null) when unentitled, so `'followUp' in lead` distinguishes "not
 *     entitled" from "nothing to suggest"
 *   - the columns the route feeds the engine are the right ones — a booking joined by
 *     LATERAL, not a value copied onto the lead
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
import { Booking } from '../../database/entities/Booking';
import { createTestTenant, createTestUser, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

const uniq = () => Math.random().toString(36).slice(2, 10);

async function tenantWithTier(tier: 'pro' | 'enterprise') {
  const tenant = await createTestTenant({ tier });
  const admin = await createTestUser(tenant.id, { role: 'admin' });
  auth.tenantId = tenant.id;
  auth.userId = admin.id;
  return tenant;
}

async function seedLead(tenantId: string, over: Partial<Lead> = {}) {
  const repo = AppDataSource.getRepository(Lead);
  const suffix = uniq();
  return repo.save(
    repo.create({
      tenantId,
      name: 'Achraf Peeters',
      phone: `3247546${suffix.slice(0, 4)}`,
      dedupeKey: `phone:3247546${suffix}`,
      source: 'channel',
      channel: 'widget',
      ...over,
    }),
  );
}

async function seedBooking(
  tenantId: string,
  botId: string,
  leadId: string,
  over: Partial<Booking> = {},
) {
  const repo = AppDataSource.getRepository(Booking);
  return repo.save(
    repo.create({
      tenantId,
      botId,
      leadId,
      status: 'confirmed',
      startUtc: new Date(Date.now() + 3 * 86_400_000),
      endUtc: new Date(Date.now() + 3 * 86_400_000 + 3_600_000),
      calendarKey: 'cal',
      icsUid: `ics-${uniq()}`,
      ...over,
    }),
  );
}

const findRow = (res: request.Response, id: string) =>
  (res.body.data.leads as Array<Record<string, unknown>>).find((l) => l.id === id)!;

describe('GET /leads — the follow-up recommendation is Enterprise-gated', () => {
  it('omits the key entirely for a tenant without aiBusinessInsights', async () => {
    // Pro has leadEnrichment but not aiBusinessInsights, so this also proves the two
    // gates are independent rather than one flag wearing two names.
    const tenant = await tenantWithTier('pro');
    const lead = await seedLead(tenant.id, { notes: 'Burst pipe in the basement' });

    const res = await request(app).get('/api/v1/leads');
    expect(res.status).toBe(200);
    const row = findRow(res, lead.id);

    expect('followUp' in row).toBe(false);
    // The Pro projection is untouched by this — the enrichment gate still applies.
    expect(row.bookingStatus).toBeNull();
  });

  it('returns a recommendation with its reasons for an Enterprise tenant', async () => {
    const tenant = await tenantWithTier('enterprise');
    const lead = await seedLead(tenant.id, { notes: 'Burst pipe in the basement' });

    const res = await request(app).get('/api/v1/leads');
    const row = findRow(res, lead.id);
    const followUp = row.followUp as {
      action: string;
      via: string;
      reasons: Array<{ key: string }>;
    };

    expect(followUp.action).toBe('offer_a_time');
    expect(followUp.via).toBe('phone');
    // Never a bare verdict: the facts it came from ship with it.
    expect(followUp.reasons.map((r) => r.key)).toEqual(
      expect.arrayContaining(['request_known', 'reach_phone']),
    );
  });
});

describe('GET /leads — the recommendation reads the joined booking, not a copy', () => {
  it('stays silent while a confirmed appointment is still ahead of them', async () => {
    const tenant = await tenantWithTier('enterprise');
    const bot = await createTestAnchorBot(tenant as Tenant);
    const lead = await seedLead(tenant.id, { notes: 'Blocked drain' });
    await seedBooking(tenant.id, bot.id, lead.id);

    const res = await request(app).get('/api/v1/leads');
    const row = findRow(res, lead.id);
    // Entitled, so the key is present; nothing to chase, so its value is null.
    expect('followUp' in row).toBe(true);
    expect(row.followUp).toBeNull();
  });

  it('turns a cancelled booking into a win-back, not a check-in', async () => {
    const tenant = await tenantWithTier('enterprise');
    const bot = await createTestAnchorBot(tenant as Tenant);
    const lead = await seedLead(tenant.id, { notes: 'Blocked drain' });
    // The appointment time has passed AND it was cancelled — the shape that would read
    // as a completed visit if the status were ignored.
    await seedBooking(tenant.id, bot.id, lead.id, {
      status: 'cancelled',
      startUtc: new Date(Date.now() - 86_400_000),
      endUtc: new Date(Date.now() - 86_400_000 + 3_600_000),
    });

    const res = await request(app).get('/api/v1/leads');
    const followUp = findRow(res, lead.id).followUp as { action: string };
    expect(followUp.action).toBe('win_back_cancelled');
  });

  it('recommends nothing for a widget lead nobody can contact', async () => {
    const tenant = await tenantWithTier('enterprise');
    // Identified only by a widget visitor id, which satisfies the identity constraint
    // but is not a contact route: the chat is over and there is nowhere to reply.
    const lead = await seedLead(tenant.id, {
      phone: null,
      email: null,
      externalUserId: `visitor-${uniq()}`,
      dedupeKey: `session:${uniq()}`,
      notes: 'Burst pipe in the basement',
    });

    const res = await request(app).get('/api/v1/leads');
    const row = findRow(res, lead.id);
    // A suggestion nobody can carry out is worse than an empty panel.
    expect(row.followUp).toBeNull();
  });
});
