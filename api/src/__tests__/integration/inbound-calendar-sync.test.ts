/**
 * Inbound calendar sync against a real database. Google is stubbed; bookings are not.
 */
import { randomBytes, randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getCalendarEvent = vi.fn();
const listChangedGoogleEvents = vi.fn();
const sendBookingEmail = vi.fn();

vi.mock('../../integrations/google/google-calendar.service', () => ({
  getGoogleBusyForBot: vi.fn(async () => []),
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(async () => 'ok'),
  deleteCalendarEvent: vi.fn(async () => 'ok'),
  resolveCalendarIdentity: vi.fn(async () => null),
  getCalendarEvent: (...a: unknown[]) => getCalendarEvent(...a),
  listChangedGoogleEvents: (...a: unknown[]) => listChangedGoogleEvents(...a),
}));

vi.mock('../../booking/booking-providers/booking-email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../booking/booking-providers/booking-email')>();
  return { ...actual, sendBookingEmail: (...a: unknown[]) => sendBookingEmail(...a) };
});


vi.mock('../../booking/booking-providers/reminders', () => ({
  cancelReminders: vi.fn(async () => undefined),
  scheduleAndPersistReminders: vi.fn(async () => undefined),
}));

import { AppDataSource } from '../../database/data-source';
import { AvailabilityRule } from '../../database/entities/AvailabilityRule';
import { BookingReference } from '../../database/entities/BookingReference';
import { CalendarCredential } from '../../database/entities/CalendarCredential';
import { ServiceType } from '../../database/entities/ServiceType';
import { invalidateEntitlements } from '../../billing/entitlements';
import { createTestAnchorBot, createTestTenant } from '../helpers/factories';
import { syncExternalCalendarChanges } from '../../scheduler/inbound-calendar-sync';
import type { Tenant } from '../../database/entities/Tenant';

let tenant: Tenant;
let botId: string;
let serviceId: string;

async function seedService(): Promise<string> {
  const repo = AppDataSource.getRepository(ServiceType);
  const svc = await repo.save(
    repo.create({
      tenantId: tenant.id,
      botId,
      name: 'Intro call',
      slug: `svc-${randomBytes(4).toString('hex')}`,
      durationMin: 60,
      isActive: true,
      onlineBookable: true,
    })
  );
  return svc.id;
}

async function seedCredential(): Promise<void> {
  const repo = AppDataSource.getRepository(CalendarCredential);
  await repo.save(
    repo.create({
      tenantId: tenant.id,
      botId,
      provider: 'google',
      status: 'active',
      accountEmail: 'owner@example.com',
      accessTokenEnc: 'enc:test',
      refreshTokenEnc: 'enc:test',
      calendarId: 'primary',
      inboundSyncCursor: 'tok-1',
      inboundAttempts: 0,
      tokenExpiry: new Date(Date.now() + 3_600_000),
    })
  );
}

async function seedBooking(hoursFromNow: number): Promise<{ id: string; start: Date }> {
  const id = randomUUID();
  const start = new Date(Date.now() + hoursFromNow * 3_600_000);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 3_600_000);
  const range = `[${start.toISOString()},${end.toISOString()})`;
  await AppDataSource.query(
    `INSERT INTO chatbot_bookings
       (id, tenant_id, bot_id, provider, status, start_utc, end_utc, calendar_key, blocked_range,
        ics_uid, attendee_name, attendee_email, event_type_id, booked_duration_min, sequence,
        created_at, updated_at)
     VALUES ($1, $2, $3, 'internal', 'confirmed', $4, $5, $6, $7::tstzrange,
             $8, 'Ada', 'ada@example.com', $9, 60, 0, now(), now())`,
    [id, tenant.id, botId, start, end, `bot:${botId}`, range, `uid-${id}@axentrio`, serviceId]
  );
  const refs = AppDataSource.getRepository(BookingReference);
  await refs.save(
    refs.create({
      bookingId: id,
      providerType: 'google',
      externalEventId: `ev-${id}`,
      externalCalendarId: 'primary',
    })
  );
  return { id, start };
}

beforeEach(async () => {
  vi.clearAllMocks();
  tenant = await createTestTenant({ tier: 'pro' });
  botId = (await createTestAnchorBot(tenant, { businessTimezone: 'UTC' })).id;
  const rules = AppDataSource.getRepository(AvailabilityRule);
  await rules.save(
    rules.create({ tenantId: tenant.id, botId, timezone: 'UTC', availabilityMode: 'always_open' })
  );
  serviceId = await seedService();
  await seedCredential();
  invalidateEntitlements(tenant.id);
});

describe('syncExternalCalendarChanges (db)', () => {
  it('moves the booking in place when the owner drags the event', async () => {
    const { id, start } = await seedBooking(48);
    const newStart = new Date(start.getTime() + 2 * 3_600_000);
    const newEnd = new Date(newStart.getTime() + 3_600_000);
    listChangedGoogleEvents.mockResolvedValue({
      eventIds: [`ev-${id}`],
      cursor: 'tok-2',
      bootstrapped: false,
    });
    getCalendarEvent.mockResolvedValue({
      kind: 'found',
      startISO: newStart.toISOString(),
      endISO: newEnd.toISOString(),
      cancelled: false,
    });

    await syncExternalCalendarChanges();

    const rows = await AppDataSource.query(
      `SELECT start_utc, sequence FROM chatbot_bookings WHERE id = $1`,
      [id]
    );
    expect(new Date(rows[0].start_utc).getTime()).toBe(newStart.getTime());
    expect(rows[0].sequence).toBe(1);
    const count = await AppDataSource.query(
      `SELECT count(*)::int AS n FROM chatbot_bookings WHERE id = $1`,
      [id]
    );
    expect(count[0].n).toBe(1);
    expect(sendBookingEmail).toHaveBeenCalledWith(expect.objectContaining({ method: 'REQUEST' }));
  });

  it('cancels the booking when the owner deletes the event', async () => {
    const { id } = await seedBooking(48);
    listChangedGoogleEvents.mockResolvedValue({
      eventIds: [`ev-${id}`],
      cursor: 'tok-2',
      bootstrapped: false,
    });
    getCalendarEvent.mockResolvedValue({ kind: 'not_found' });

    await syncExternalCalendarChanges();

    const rows = await AppDataSource.query(
      `SELECT status, sequence FROM chatbot_bookings WHERE id = $1`,
      [id]
    );
    expect(rows[0].status).toBe('cancelled');
    expect(sendBookingEmail).toHaveBeenCalledWith(expect.objectContaining({ method: 'CANCEL' }));
  });
});
