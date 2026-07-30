/**
 * A3 — booking-derived lead fields, and the conversation link.
 *
 * The point of these tests is that Story 3's Pro column set is a PROJECTION, not an
 * AI feature: address / requested service / preferred date / booking status / list
 * price all already exist as exact customer- or tenant-entered values and are reached
 * by join. Nothing here involves a model.
 *
 * They also pin the two properties that are easy to regress:
 *   - a cancelled booking must not hide a live one (the LATERAL's ordering)
 *   - Pro fields must be absent for a tenant without `leadEnrichment`, at the API
 *     level and not merely hidden in the UI
 */
import { describe, it, expect, vi } from 'vitest';

// Auth + side-effect mocks, mirroring portal-contract-wire.test.ts.
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
vi.mock('../../webhooks/webhook.emitter', () => ({
  emitWebhookEvent: vi.fn(),
  buildEventBase: () => ({ id: 'e', tenantId: 't', timestamp: '', session: {} }),
}));
vi.mock('../../services/notification.service', () => ({
  notificationService: { createForTenant: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Lead } from '../../database/entities/Lead';
import { ServiceType } from '../../database/entities/ServiceType';
import { Booking } from '../../database/entities/Booking';
import { LeadConversation } from '../../database/entities/LeadConversation';
import { upsertLead, associateLeadSession } from '../../leads/lead-capture.service';
import {
  createTestTenant,
  createTestUser,
  createTestAnchorBot,
  createTestSession,
} from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

function setAuth(tenantId: string, userId: string) {
  auth.tenantId = tenantId;
  auth.userId = userId;
}

async function tenantWithTier(tier: 'essential' | 'pro') {
  const tenant = await createTestTenant({ tier });
  const admin = await createTestUser(tenant.id, { role: 'admin' });
  setAuth(tenant.id, admin.id);
  return tenant;
}

async function proTenant() {
  return tenantWithTier('pro');
}

async function seedService(tenantId: string, botId: string, over: Partial<ServiceType> = {}) {
  const repo = AppDataSource.getRepository(ServiceType);
  return repo.save(
    repo.create({
      tenantId,
      botId,
      name: 'Drain unblocking',
      slug: `drain-${Math.random().toString(36).slice(2, 8)}`,
      priceDisplayType: 'fixed',
      fixedPrice: 95,
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
      startUtc: new Date('2026-08-04T09:00:00Z'),
      endUtc: new Date('2026-08-04T10:00:00Z'),
      calendarKey: 'cal',
      icsUid: `ics-${Math.random().toString(36).slice(2, 10)}`,
      customerAddress: 'Kerkstraat 12, 2000 Antwerpen',
      intakeAnswers: { 'q-reason': 'Kitchen sink completely blocked' },
      ...over,
    }),
  );
}

async function seedLead(tenantId: string, over: Partial<Lead> = {}) {
  const repo = AppDataSource.getRepository(Lead);
  const suffix = Math.random().toString(36).slice(2, 8);
  return repo.save(
    repo.create({
      tenantId,
      name: 'Achraf Peeters',
      email: `achraf-${suffix}@example.com`,
      dedupeKey: `email:achraf-${suffix}@example.com`,
      source: 'booking',
      ...over,
    }),
  );
}

describe('A3 — booking-derived Pro fields', () => {
  it('projects address, service, preferred date, status and list price by JOIN', async () => {
    const tenant = await proTenant();
    const bot = await createTestAnchorBot(tenant as Tenant);
    const lead = await seedLead(tenant.id);
    const service = await seedService(tenant.id, bot.id);
    await seedBooking(tenant.id, bot.id, lead.id, { eventTypeId: service.id });

    const res = await request(app).get('/api/v1/leads');
    expect(res.status).toBe(200);
    const row = res.body.data.leads.find((l: { id: string }) => l.id === lead.id);

    expect(row.address).toBe('Kerkstraat 12, 2000 Antwerpen');
    expect(row.serviceRequested).toBe('Drain unblocking');
    expect(row.bookingStatus).toBe('confirmed');
    expect(row.preferredAt).toBe('2026-08-04T09:00:00.000Z');
    // The tenant's OWN list price — not an AI estimate. `priceBasis` lets the UI
    // label it honestly rather than presenting "from €95" as "€95".
    expect(row.servicePrice).toBe(95);
    expect(row.priceBasis).toBe('fixed');
    // Owner-authored intake answers ARE Story 3's "reason for contact".
    expect(row.intakeAnswers).toEqual({ 'q-reason': 'Kitchen sink completely blocked' });
  });

  it('derives a range price as the midpoint, and yields NO number for on_request', async () => {
    const tenant = await proTenant();
    const bot = await createTestAnchorBot(tenant as Tenant);

    const ranged = await seedLead(tenant.id);
    const rangeSvc = await seedService(tenant.id, bot.id, {
      name: 'Boiler service',
      priceDisplayType: 'range',
      fixedPrice: null,
      minPrice: 80,
      maxPrice: 120,
    });
    await seedBooking(tenant.id, bot.id, ranged.id, { eventTypeId: rangeSvc.id });

    const quoted = await seedLead(tenant.id);
    const onRequest = await seedService(tenant.id, bot.id, {
      name: 'Full rewire',
      priceDisplayType: 'on_request',
      fixedPrice: null,
    });
    await seedBooking(tenant.id, bot.id, quoted.id, { eventTypeId: onRequest.id });

    const res = await request(app).get('/api/v1/leads');
    const leads = res.body.data.leads as Array<Record<string, unknown>>;

    const r = leads.find((l) => l.id === ranged.id)!;
    expect(r.servicePrice).toBe(100);
    expect(r.priceBasis).toBe('range_mid');

    const q = leads.find((l) => l.id === quoted.id)!;
    // "on request" must stay blank rather than inventing a figure for a named person.
    expect(q.servicePrice).toBeNull();
    expect(q.priceBasis).toBe('none');
  });

  it('a cancelled booking never hides a live one, and the count reveals there are others', async () => {
    const tenant = await proTenant();
    const bot = await createTestAnchorBot(tenant as Tenant);
    const lead = await seedLead(tenant.id);
    const service = await seedService(tenant.id, bot.id);

    // Cancelled one is LATER in time — naive "most recent" ordering would show it.
    await seedBooking(tenant.id, bot.id, lead.id, {
      eventTypeId: service.id,
      status: 'cancelled',
      startUtc: new Date('2026-09-01T09:00:00Z'),
    });
    await seedBooking(tenant.id, bot.id, lead.id, {
      eventTypeId: service.id,
      status: 'confirmed',
      startUtc: new Date('2026-08-04T09:00:00Z'),
    });

    const res = await request(app).get('/api/v1/leads');
    const row = res.body.data.leads.find((l: { id: string }) => l.id === lead.id);
    expect(row.bookingStatus).toBe('confirmed');
    expect(row.preferredAt).toBe('2026-08-04T09:00:00.000Z');
    expect(row.bookingCount).toBe(2);
  });

  it('shows a cancelled booking rather than blank when it is the ONLY one', async () => {
    const tenant = await proTenant();
    const bot = await createTestAnchorBot(tenant as Tenant);
    const lead = await seedLead(tenant.id);
    const service = await seedService(tenant.id, bot.id);
    await seedBooking(tenant.id, bot.id, lead.id, { eventTypeId: service.id, status: 'cancelled' });

    const res = await request(app).get('/api/v1/leads');
    const row = res.body.data.leads.find((l: { id: string }) => l.id === lead.id);
    expect(row.bookingStatus).toBe('cancelled');
  });

  it('withholds the Pro field set from a tenant without leadEnrichment (API, not just UI)', async () => {
    const tenant = await tenantWithTier('essential');
    await seedLead(tenant.id, { source: 'tool' });

    const res = await request(app).get('/api/v1/leads');
    expect(res.status).toBe(200);
    const row = res.body.data.leads[0];
    // Basic set present…
    expect(row).toHaveProperty('name');
    expect(row).toHaveProperty('status');
    // …structured set absent entirely, so it can't be read by calling the API directly.
    expect(row).not.toHaveProperty('address');
    expect(row).not.toHaveProperty('serviceRequested');
    expect(row).not.toHaveProperty('servicePrice');
  });
});

describe('A3 — conversation association', () => {
  it('links a conversation on capture, and is idempotent across re-touches', async () => {
    const tenant = await proTenant();
    const bot = await createTestAnchorBot(tenant as Tenant);
    const session = await createTestSession(tenant.id, { botId: bot.id });

    for (let i = 0; i < 3; i++) {
      await upsertLead({
        dataSource: AppDataSource,
        tenantId: tenant.id,
        sessionId: session.id,
        botId: bot.id,
        source: 'tool',
        channel: 'widget',
        email: 'repeat@example.com',
        notes: `touch ${i}`,
      });
    }

    const links = await AppDataSource.getRepository(LeadConversation).find({
      where: { tenantId: tenant.id, sessionId: session.id },
    });
    expect(links).toHaveLength(1); // one conversation, one row — not one per capture
  });

  it('gives a returning contact a SECOND conversation row instead of overwriting the first', async () => {
    // This is the whole reason the child table exists: the identity row keeps only
    // the LATEST session_id, so without per-conversation rows the earlier
    // conversation is unrecoverable.
    const tenant = await proTenant();
    const bot = await createTestAnchorBot(tenant as Tenant);
    const first = await createTestSession(tenant.id, { botId: bot.id });
    const second = await createTestSession(tenant.id, { botId: bot.id });

    const a = await upsertLead({
      dataSource: AppDataSource, tenantId: tenant.id, sessionId: first.id, botId: bot.id,
      source: 'channel', channel: 'whatsapp', externalUserId: '32400111222',
    });
    const b = await upsertLead({
      dataSource: AppDataSource, tenantId: tenant.id, sessionId: second.id, botId: bot.id,
      source: 'channel', channel: 'whatsapp', externalUserId: '32400111222',
    });

    expect(a!.leadId).toBe(b!.leadId); // same CONTACT
    expect(b!.inserted).toBe(false); // not a new lead → no duplicate fan-out

    const links = await AppDataSource.getRepository(LeadConversation).find({
      where: { tenantId: tenant.id, leadId: a!.leadId },
    });
    expect(links).toHaveLength(2); // but TWO conversations
  });

  it('refuses to reparent a session already linked to a different lead', async () => {
    const tenant = await proTenant();
    const bot = await createTestAnchorBot(tenant as Tenant);
    const session = await createTestSession(tenant.id, { botId: bot.id });
    const leadA = await seedLead(tenant.id);
    const leadB = await seedLead(tenant.id);

    const first = await associateLeadSession({
      dataSource: AppDataSource, tenantId: tenant.id, leadId: leadA.id, sessionId: session.id,
    });
    expect(first.created).toBe(true);

    const clash = await associateLeadSession({
      dataSource: AppDataSource, tenantId: tenant.id, leadId: leadB.id, sessionId: session.id,
    });
    // Reported, not silently applied — the original association survives.
    expect(clash.created).toBe(false);
    expect(clash.conflictingLeadId).toBe(leadA.id);

    const links = await AppDataSource.getRepository(LeadConversation).find({
      where: { tenantId: tenant.id, sessionId: session.id },
    });
    expect(links).toHaveLength(1);
    expect(links[0].leadId).toBe(leadA.id);
  });
});
