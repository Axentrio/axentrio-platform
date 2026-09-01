/**
 * Accepting a request must leave a ledger row for the customer invite.
 *
 * This is the test whose absence let a real production gap stay unproven: accept returned 200,
 * the booking was confirmed, and whether any invite was ever handed to the provider could only
 * be guessed at from an inbox. `sendOrReport` swallows every failure by design, so the ONLY
 * durable evidence that the customer invite happened is an `email_deliveries` row.
 *
 * `booking-email` is deliberately NOT mocked here - it is the code under test. Only the provider
 * is doubled, the same way `email-delivery.test.ts` doubles it.
 */
import { randomBytes, randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../automations', () => ({ getEmailService: () => ({ send }) }));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { AvailabilityRule } from '../../database/entities/AvailabilityRule';
import { ServiceType } from '../../database/entities/ServiceType';
import { EmailDelivery } from '../../database/entities/EmailDelivery';
import { invalidateEntitlements } from '../../billing/entitlements';
import { createTestTenant, createTestUser, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

let tenant: Tenant;
let botId: string;

async function seedService(name: string): Promise<string> {
  const repo = AppDataSource.getRepository(ServiceType);
  const service = await repo.save(
    repo.create({
      tenantId: tenant.id,
      botId,
      name,
      slug: `svc-${randomBytes(4).toString('hex')}`,
      durationMin: 60,
      isActive: true,
      onlineBookable: true,
      bookingMode: 'request',
      customerEmailRequired: true,
    })
  );
  return service.id;
}

/** A captured request, written the way the engine writes one. */
async function seedRequest(serviceId: string, attendeeEmail: string): Promise<string> {
  const id = randomUUID();
  // The accepted time has to be a time the engine still offers, so align it to the
  // 30-minute slot granularity instead of whatever "now + 24h" happens to be.
  const start = new Date(Date.now() + 24 * 3_600_000);
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() < 30 ? 0 : 30);
  const end = new Date(start.getTime() + 3_600_000);
  await AppDataSource.query(
    `INSERT INTO chatbot_bookings
       (id, tenant_id, bot_id, provider, status, start_utc, end_utc, calendar_key,
        blocked_range, ics_uid, attendee_name, attendee_email, event_type_id,
        booked_duration_min, created_at, updated_at)
     VALUES ($1, $2, $3, 'internal', 'request_created', $4, $5, $6,
             tstzrange($4, $5, '[)'), $7, $8, $9, $10, 60, now(), now())`,
    [
      id,
      tenant.id,
      botId,
      start,
      end,
      `bot:${botId}`,
      `${randomUUID()}@axentrio`,
      'Axel Accept',
      attendeeEmail,
      serviceId,
    ]
  );
  return id;
}

async function customerRowFor(bookingId: string): Promise<EmailDelivery | null> {
  return AppDataSource.getRepository(EmailDelivery).findOne({
    where: { relatedId: bookingId, kind: 'booking_email' },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  send.mockResolvedValue({ success: true, messageId: 'accept-invite-1' });
  tenant = await createTestTenant({ tier: 'pro' });
  botId = (await createTestAnchorBot(tenant)).id;
  const rules = AppDataSource.getRepository(AvailabilityRule);
  // always_open keeps this file about the ledger, not about weekly-hours arithmetic.
  await rules.save(
    rules.create({
      tenantId: tenant.id,
      botId,
      timezone: 'Europe/Brussels',
      availabilityMode: 'always_open',
    })
  );
  const admin = await createTestUser(tenant.id, { role: 'admin' });
  configureMockAuth(auth, { userId: admin.id, tenantId: tenant.id, role: 'admin' });
  invalidateEntitlements(tenant.id);
});

describe('accepting a request ledgers the customer invite', () => {
  it('writes a booking_email row keyed to the booking id', async () => {
    const serviceId = await seedService('klantenafspraak');
    const bookingId = await seedRequest(serviceId, 'axel@example.test');

    const res = await request(app).post(`/api/v1/scheduler/bookings/${bookingId}/accept`).send({});
    expect(res.status).toBe(200);

    const row = await customerRowFor(bookingId);
    expect(row).not.toBeNull();
    // related_id is the BOOKING id. The ICS uid is `uuid@axentrio`, which cannot cast to uuid,
    // so using it here used to fail the insert and lose the invite silently.
    expect(row!.relatedId).toBe(bookingId);
    expect(row!.recipientEmail).toBe('axel@example.test');
    expect(row!.subject).toBe('Confirmed: klantenafspraak');
    // The customer invite retains its payload so the sweeper can send it again.
    expect(row!.payload?.body).toBeTruthy();
  });

  it('ledgers a 266-character subject from a service name at its own 255 cap', async () => {
    const longName = 's'.repeat(255);
    const serviceId = await seedService(longName);
    const bookingId = await seedRequest(serviceId, 'wide@example.test');

    const res = await request(app).post(`/api/v1/scheduler/bookings/${bookingId}/accept`).send({});
    expect(res.status).toBe(200);

    const row = await customerRowFor(bookingId);
    expect(row).not.toBeNull();
    expect(row!.subject).toHaveLength(266);
  });
});
