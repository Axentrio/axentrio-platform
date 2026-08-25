/**
 * DELETE /scheduler/services/:id — the delete that turned booking off in silence.
 *
 * A portal user deleted the last bookable service and nothing said so: the runtime
 * gate went unconfigured, and the assistant stopped being able to book. The route
 * now recomputes the runtime gate (active + online-bookable services, plus
 * availability-rule existence), reports `bookingConfigured`, and writes an audit row.
 *
 * The audit helper is REAL here (never mocked): the row is the deliverable, so a
 * mocked `logAudit` would make every assertion below pass on a route that writes
 * nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { ServiceType, type BookingMode } from '../../database/entities/ServiceType';
import { AvailabilityRule } from '../../database/entities/AvailabilityRule';
import { AuditLog } from '../../database/entities/AuditLog';
import { invalidateEntitlements } from '../../billing/entitlements';
import { createTestTenant, createTestUser, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

const SERVICES_URL = '/api/v1/scheduler/services';

let tenant: Tenant;
let botId: string;

interface SeedService {
  name: string;
  bookingMode?: BookingMode;
  isActive?: boolean;
  onlineBookable?: boolean;
}

/** A service row seeded directly: only tenantId/botId/name/slug lack a column default. */
async function seedService(over: SeedService): Promise<ServiceType> {
  const repo = AppDataSource.getRepository(ServiceType);
  return repo.save(
    repo.create({
      tenantId: tenant.id,
      botId,
      name: over.name,
      slug: over.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      durationMin: 30,
      bookingMode: over.bookingMode ?? 'auto',
      isActive: over.isActive ?? true,
      onlineBookable: over.onlineBookable ?? true,
    }),
  );
}

/** The one availability rule per bot the auto-mode gate needs. */
async function seedRule(): Promise<void> {
  const repo = AppDataSource.getRepository(AvailabilityRule);
  await repo.save(
    repo.create({
      tenantId: tenant.id,
      botId,
      timezone: 'Europe/Brussels',
      availabilityMode: 'business_hours',
      weeklyHours: { mon: [{ start: '09:00', end: '17:00' }] },
    }),
  );
}

const auditRowFor = (serviceId: string) =>
  AppDataSource.getRepository(AuditLog).findOne({
    where: { action: 'scheduler.service_deleted', entityId: serviceId },
  });

beforeEach(async () => {
  vi.clearAllMocks();
  tenant = await createTestTenant({ tier: 'pro' });
  botId = (await createTestAnchorBot(tenant)).id;
  const admin = await createTestUser(tenant.id, { role: 'admin' });
  configureMockAuth(auth, { userId: admin.id, tenantId: tenant.id, role: 'admin' });
  invalidateEntitlements(tenant.id);
});

describe('DELETE /scheduler/services/:id — booking impact', () => {
  it('reports booking still configured when another bookable service survives', async () => {
    const kept = await seedService({ name: 'Cut' });
    const doomed = await seedService({ name: 'Beard' });
    await seedRule();

    const res = await request(app).delete(`${SERVICES_URL}/${doomed.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ deleted: true, bookingConfigured: true });

    // The row is gone, the survivor is not.
    const rows = await AppDataSource.getRepository(ServiceType).find({ where: { botId } });
    expect(rows.map((s) => s.id)).toEqual([kept.id]);

    const audit = await auditRowFor(doomed.id);
    expect(audit?.metadata).toMatchObject({ botId, name: 'Beard', bookingConfiguredAfter: true });
  });

  it('reports booking OFF when the last bookable service is deleted', async () => {
    const only = await seedService({ name: 'Cut' });
    await seedRule();

    const res = await request(app).delete(`${SERVICES_URL}/${only.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ deleted: true, bookingConfigured: false });

    const audit = await auditRowFor(only.id);
    expect(audit?.metadata).toMatchObject({ name: 'Cut', bookingConfiguredAfter: false });
  });

  it('reports booking configured when a request-mode service survives without a rule', async () => {
    // Request mode collects a lead instead of confirming a slot, so it needs no
    // availability rule — mirrors isBookingConfigured.
    await seedService({ name: 'Quote', bookingMode: 'request' });
    const doomed = await seedService({ name: 'Cut', bookingMode: 'auto' });

    const res = await request(app).delete(`${SERVICES_URL}/${doomed.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.bookingConfigured).toBe(true);
  });

  it('reports booking OFF when the only survivor is inactive or phone-only', async () => {
    // Neither survivor is bookable through the chat, so the gate set is empty.
    await seedService({ name: 'Retired', isActive: false });
    await seedService({ name: 'Phone only', onlineBookable: false });
    const doomed = await seedService({ name: 'Cut' });
    await seedRule();

    const res = await request(app).delete(`${SERVICES_URL}/${doomed.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.bookingConfigured).toBe(false);
  });

  it('404s on an unknown id and writes no audit row', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const res = await request(app).delete(`${SERVICES_URL}/${missing}`);
    expect(res.status).toBe(404);
    expect(res.body?.error?.code ?? res.body?.code).toBe('SERVICE_NOT_FOUND');
    expect(await auditRowFor(missing)).toBeNull();
  });
});
