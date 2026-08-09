/**
 * #72 - a reschedule during a booking pause could leave the owner with two appointments.
 *
 * The pause gate is CREATE-SHAPED: it tells the model to capture the customer's preferred time
 * with `request_appointment`. Point that at a customer MOVING an existing appointment and it
 * writes a second row while the original confirmed booking stands. Nothing links or dedups
 * them - `requestAppointment` dedups on the idempotency key or `(session, service, startUtc)`,
 * and a reschedule differs in the time by definition - so accepting it leaves the owner with
 * two confirmed appointments, two calendar events, and a customer holding the old invite.
 *
 * THE PROMPT FIX IS NOT THE FIX. The pause message now names the exception and tells the model
 * `reschedule_booking` still works while paused. Every test here is written as if that
 * instruction were IGNORED, which is the acceptance criterion: prompt-level guards are exactly
 * what this codebase has repeatedly ruled insufficient on their own, and a later prompt edit
 * that erodes the wording must not quietly reopen this.
 *
 * The guard sits at ACCEPT rather than at the write. A captured request is a question, not a
 * commitment; refusing to capture one would throw away the customer's stated preference and
 * tell them nothing. Accept is the last point before a second calendar event exists.
 */
import { randomBytes, randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import request from 'supertest';
import { app } from '../../server';
import { In } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { AvailabilityRule } from '../../database/entities/AvailabilityRule';
import { ServiceType } from '../../database/entities/ServiceType';
import { ChatSession } from '../../database/entities/ChatSession';
import { invalidateEntitlements } from '../../billing/entitlements';
import { createTestTenant, createTestUser, createTestAnchorBot, createTestSession } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

let tenant: Tenant;
let botId: string;
let serviceId: string;
let otherServiceId: string;

async function seedService(name: string): Promise<string> {
  const repo = AppDataSource.getRepository(ServiceType);
  const svc = await repo.save(
    repo.create({
      tenantId: tenant.id,
      botId,
      name,
      slug: `svc-${randomBytes(4).toString('hex')}`,
      durationMin: 60,
      isActive: true,
      onlineBookable: true,
    })
  );
  return svc.id;
}

/** A booking row, written the way the engine writes them. */
async function seedBooking(input: {
  sessionId: string | null;
  serviceId: string | null;
  status: 'confirmed' | 'request_created';
  hoursFromNow: number;
}): Promise<string> {
  const id = randomUUID();
  // Aligned to the top of an hour. Accepting a request RE-VALIDATES the stored slot against the
  // offered grid, so a time at an arbitrary minute is refused as unavailable before the guard
  // under test is ever reached - and the test would pass for entirely the wrong reason.
  const start = new Date(Date.now() + input.hoursFromNow * 3_600_000);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 3_600_000);
  // A Request carries a range like any other row - `requestAppointment` writes
  // `tstzrange($5,$6,'[)')` for it, and the column is NOT NULL. What makes a Request able to sit
  // beside a confirmed booking for the same customer is the exclusion constraint's own predicate,
  // `WHERE status IN ('pending','confirmed')`, which skips it. An earlier version of this fixture
  // wrote NULL and only passed because the test schema was laxer than production's.
  const range = `[${start.toISOString()},${end.toISOString()})`;
  await AppDataSource.query(
    `INSERT INTO chatbot_bookings
       (id, tenant_id, bot_id, provider, status, start_utc, end_utc, calendar_key, blocked_range,
        ics_uid, attendee_name, attendee_email, event_type_id, session_id, created_at, updated_at)
     VALUES ($1, $2, $3, 'internal', $4, $5, $6, $7, $8::tstzrange,
             $9, 'Jan', 'jan@example.com', $10, $11, now(), now())`,
    [
      id,
      tenant.id,
      botId,
      input.status,
      start,
      end,
      `bot:${botId}`,
      range,
      `uid-${id}`,
      input.serviceId,
      input.sessionId,
    ]
  );
  return id;
}

const statusOf = async (id: string): Promise<string> => {
  const rows = await AppDataSource.query(`SELECT status FROM chatbot_bookings WHERE id = $1`, [id]);
  return rows[0].status;
};

beforeEach(async () => {
  vi.clearAllMocks();
  tenant = await createTestTenant({ tier: 'pro' });
  botId = (await createTestAnchorBot(tenant)).id;
  const rules = AppDataSource.getRepository(AvailabilityRule);
  await rules.save(rules.create({ tenantId: tenant.id, botId, timezone: 'Europe/Brussels', availabilityMode: 'always_open' }));
  serviceId = await seedService('Boiler repair');
  otherServiceId = await seedService('Annual service');
  const admin = await createTestUser(tenant.id, { role: 'admin' });
  configureMockAuth(auth, { userId: admin.id, tenantId: tenant.id, role: 'admin' });
  invalidateEntitlements(tenant.id);
});

describe('accepting a request that would duplicate a live appointment', () => {
  it('refuses, and names the appointment it would duplicate', async () => {
    // The exact shape of the bug: one customer, one service, an appointment they already hold,
    // and a request captured for a different time because the model was told to capture rather
    // than reschedule.
    const session = await createTestSession(tenant.id);
    const existing = await seedBooking({ sessionId: session.id, serviceId, status: 'confirmed', hoursFromNow: 48 });
    const req = await seedBooking({ sessionId: session.id, serviceId, status: 'request_created', hoursFromNow: 72 });

    const res = await request(app).post(`/api/v1/scheduler/bookings/${req}/accept`).send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REQUEST_WOULD_DUPLICATE');
    // Naming it is the point. "You cannot do that" leaves the owner to go and find which
    // appointment is in the way; this lets the portal offer to move that one instead.
    expect(res.body.error.details.existingBookingId).toBe(existing);
    expect(res.body.error.details.suggestion).toBe('reschedule');
    // Enough to open the picker against the EXISTING appointment. The owner is on the Requests
    // tab and that appointment is on Upcoming, so without these the portal has nothing to hand
    // the picker and the "reschedule instead" offer would be a button that does nothing.
    expect(res.body.error.details.existingServiceId).toBe(serviceId);
    expect(res.body.error.details.existingDurationMin).toBe(60);

    // And nothing changed - no second confirmed appointment, no second calendar event.
    expect(await statusOf(req)).toBe('request_created');
    expect(await statusOf(existing)).toBe('confirmed');
  });

  it('recognises the same customer across SESSIONS, which is how channels work', async () => {
    // A Messenger or WhatsApp customer comes back days later on a new session carrying the same
    // stable visitor identity. Keying on the session alone would miss exactly the returning
    // customer most likely to be moving an appointment.
    const visitorId = `visitor-${randomBytes(4).toString('hex')}`;
    const first = await createTestSession(tenant.id);
    const second = await createTestSession(tenant.id);
    await AppDataSource.getRepository(ChatSession).update(
      { id: In([first.id, second.id]) },
      { visitorId, botId }
    );

    const existing = await seedBooking({ sessionId: first.id, serviceId, status: 'confirmed', hoursFromNow: 48 });
    const req = await seedBooking({ sessionId: second.id, serviceId, status: 'request_created', hoursFromNow: 72 });

    const res = await request(app).post(`/api/v1/scheduler/bookings/${req}/accept`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.details.existingBookingId).toBe(existing);
  });

  it('allows it when the owner says so, because repeat business is real', async () => {
    // The guard refuses; it does not forbid. A customer booking a second appointment of the
    // same service is an ordinary thing, and blocking it outright would be the opposite error.
    const session = await createTestSession(tenant.id);
    await seedBooking({ sessionId: session.id, serviceId, status: 'confirmed', hoursFromNow: 48 });
    const req = await seedBooking({ sessionId: session.id, serviceId, status: 'request_created', hoursFromNow: 72 });

    const res = await request(app).post(`/api/v1/scheduler/bookings/${req}/accept`).send({ allowDuplicate: true });

    expect(res.status).toBe(200);
    expect(await statusOf(req)).toBe('confirmed');
  });
});

describe('what the guard must NOT catch', () => {
  it('a different service is a different appointment', async () => {
    const session = await createTestSession(tenant.id);
    await seedBooking({ sessionId: session.id, serviceId, status: 'confirmed', hoursFromNow: 48 });
    const req = await seedBooking({
      sessionId: session.id,
      serviceId: otherServiceId,
      status: 'request_created',
      hoursFromNow: 72,
    });

    const res = await request(app).post(`/api/v1/scheduler/bookings/${req}/accept`).send({});
    expect(res.status).toBe(200);
  });

  it('an appointment already in the PAST cannot be the one being moved', async () => {
    // A customer who came last month and is booking again is repeat business, not a reschedule.
    const session = await createTestSession(tenant.id);
    await seedBooking({ sessionId: session.id, serviceId, status: 'confirmed', hoursFromNow: -72 });
    const req = await seedBooking({ sessionId: session.id, serviceId, status: 'request_created', hoursFromNow: 72 });

    const res = await request(app).post(`/api/v1/scheduler/bookings/${req}/accept`).send({});
    expect(res.status).toBe(200);
  });

  it('a cancelled appointment holds nothing to duplicate', async () => {
    const session = await createTestSession(tenant.id);
    const existing = await seedBooking({ sessionId: session.id, serviceId, status: 'confirmed', hoursFromNow: 48 });
    await AppDataSource.query(`UPDATE chatbot_bookings SET status = 'cancelled' WHERE id = $1`, [existing]);
    const req = await seedBooking({ sessionId: session.id, serviceId, status: 'request_created', hoursFromNow: 72 });

    const res = await request(app).post(`/api/v1/scheduler/bookings/${req}/accept`).send({});
    expect(res.status).toBe(200);
  });

  it('another customer\'s appointment for the same service is not a duplicate', async () => {
    const mine = await createTestSession(tenant.id);
    const theirs = await createTestSession(tenant.id);
    await seedBooking({ sessionId: theirs.id, serviceId, status: 'confirmed', hoursFromNow: 48 });
    const req = await seedBooking({ sessionId: mine.id, serviceId, status: 'request_created', hoursFromNow: 72 });

    const res = await request(app).post(`/api/v1/scheduler/bookings/${req}/accept`).send({});
    expect(res.status).toBe(200);
  });
});
