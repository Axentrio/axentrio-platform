import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────────
const eventTypeFindOne = vi.fn();
const serviceTypeFind = vi.fn();
const ruleFindOne = vi.fn();
const bookingFindOne = vi.fn();
const bookingQuery = vi.fn();
const logCreate = vi.fn((d: any) => d);
const logSave = vi.fn();
const refSave = vi.fn((d: any) => d);
const managerQuery = vi.fn();
const transaction = vi.fn(async (cb: any) => cb({ query: managerQuery }));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn((entity: any) => {
      const name = entity?.name || entity;
      if (name === 'ServiceType') return { findOne: eventTypeFindOne, find: serviceTypeFind };
      if (name === 'AvailabilityRule') return { findOne: ruleFindOne };
      if (name === 'Booking') return { findOne: bookingFindOne, query: bookingQuery };
      if (name === 'BookingLog') return { create: logCreate, save: logSave };
      if (name === 'BookingReference') return { create: (d: any) => d, save: refSave, findOne: vi.fn() };
      return {};
    }),
    transaction: (cb: any) => transaction(cb),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sendBookingEmail = vi.fn();
const sendRequestNotificationEmail = vi.fn();
vi.mock('../../n8n/booking-providers/booking-email', () => ({
  sendBookingEmail: (...args: any[]) => sendBookingEmail(...args),
  sendRequestNotificationEmail: (...args: any[]) => sendRequestNotificationEmail(...args),
}));

const getGoogleBusyForBot = vi.fn().mockResolvedValue(null);
const createCalendarEvent = vi.fn().mockResolvedValue(null);
const updateCalendarEvent = vi.fn().mockResolvedValue('no_connection');
const deleteCalendarEvent = vi.fn().mockResolvedValue(undefined);
const resolveCalendarIdentity = vi.fn().mockResolvedValue(null);
vi.mock('../../integrations/google/google-calendar.service', () => ({
  getGoogleBusyForBot: (...args: any[]) => getGoogleBusyForBot(...args),
  createCalendarEvent: (...args: any[]) => createCalendarEvent(...args),
  updateCalendarEvent: (...args: any[]) => updateCalendarEvent(...args),
  deleteCalendarEvent: (...args: any[]) => deleteCalendarEvent(...args),
  resolveCalendarIdentity: (...args: any[]) => resolveCalendarIdentity(...args),
}));

const emitWebhookEvent = vi.fn();
vi.mock('../../webhooks/webhook.emitter', () => ({
  emitWebhookEvent: (...args: any[]) => emitWebhookEvent(...args),
  buildEventBase: (type: string, tenantId: string, session: any) => ({
    id: 'evt-1',
    type,
    tenantId,
    sessionId: session.id,
    timestamp: '2026-06-05T00:00:00.000Z',
    session,
  }),
}));

import { InternalProvider } from '../../n8n/booking-providers/internal.provider';
import { BookingError } from '../../n8n/booking-providers/types';

const ctx: any = {
  session: { id: 'sess-1' },
  tenant: { id: 'ten-1' },
  bot: { id: 'bot-1' },
  botSettings: {},
};

const EVENT_TYPE = {
  id: 'et-1',
  durationMin: 30,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  minNoticeMin: 0,
  maxHorizonDays: 60,
  isActive: true,
};
const RULE = {
  timezone: 'Europe/Brussels',
  weeklyHours: { wed: [{ start: '09:00', end: '11:00' }] },
  dateOverrides: [],
  slotGranularityMin: 30,
};

// 2026-06-10 (Wed) 09:00 Brussels CEST = 07:00 UTC — a genuinely offered slot.
const OFFERED_START = '2026-06-10T07:00:00Z';

describe('InternalProvider.createBooking', () => {
  let provider: InternalProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-05T00:00:00Z'));
    provider = new InternalProvider();
    eventTypeFindOne.mockResolvedValue(EVENT_TYPE);
    serviceTypeFind.mockResolvedValue([EVENT_TYPE]); // sole active service
    ruleFindOne.mockResolvedValue(RULE);
    bookingFindOne.mockResolvedValue(null);
    bookingQuery.mockResolvedValue([]); // no busy intervals
    managerQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('INSERT INTO chatbot_bookings')) return [{ id: 'bk-1' }];
      return [];
    });
  });

  afterEach(() => vi.useRealTimers());

  it('creates a booking for an offered slot and writes an audit log', async () => {
    const res = await provider.createBooking(ctx, 'idem-1', OFFERED_START, {
      name: 'Ada',
      email: 'ada@example.com',
    });
    expect(res.success).toBe(true);
    expect(res.booking.id).toBe('bk-1');
    expect(res.booking.startTime).toBe('2026-06-10T07:00:00.000Z');
    expect(res.booking.endTime).toBe('2026-06-10T07:30:00.000Z');
    expect(logSave).toHaveBeenCalledOnce();
    // advisory lock + insert both ran inside the transaction
    expect(managerQuery).toHaveBeenCalledTimes(2);
    // a confirmation invite was sent
    expect(sendBookingEmail).toHaveBeenCalledOnce();
    expect(sendBookingEmail.mock.calls[0][0]).toMatchObject({ method: 'REQUEST', sequence: 0 });
  });

  it('returns the existing booking on idempotent retry without inserting', async () => {
    bookingFindOne.mockResolvedValue({
      id: 'bk-existing',
      status: 'confirmed',
      startUtc: new Date('2026-06-10T07:00:00Z'),
      endUtc: new Date('2026-06-10T07:30:00Z'),
      attendeeName: 'Ada',
      attendeeEmail: 'ada@example.com',
    });
    const res = await provider.createBooking(ctx, 'idem-1', OFFERED_START, {
      name: 'Ada',
      email: 'ada@example.com',
    });
    expect(res.idempotent).toBe(true);
    expect(res.booking.id).toBe('bk-existing');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects a time that is not an offered slot', async () => {
    await expect(
      provider.createBooking(ctx, 'idem-2', '2026-06-10T07:05:00Z', { name: 'Ada', email: 'ada@example.com' })
    ).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('maps a concurrent exclusion violation (23P01) to SLOT_UNAVAILABLE', async () => {
    managerQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('INSERT INTO chatbot_bookings')) {
        throw Object.assign(new Error('conflicting key value violates exclusion constraint'), { code: '23P01' });
      }
      return [];
    });
    await expect(
      provider.createBooking(ctx, 'idem-3', OFFERED_START, { name: 'Ada', email: 'ada@example.com' })
    ).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
  });

  it('mirrors the booking to Google and puts the Meet link in the invite when connected', async () => {
    createCalendarEvent.mockResolvedValueOnce({
      eventId: 'gcal-evt-1',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
      calendarId: 'primary',
    });
    await provider.createBooking(ctx, 'idem-gc', OFFERED_START, { name: 'Ada', email: 'ada@example.com' });
    // a booking_reference was stored for the Google event
    expect(refSave).toHaveBeenCalledOnce();
    expect(refSave.mock.calls[0][0]).toMatchObject({ externalEventId: 'gcal-evt-1', providerType: 'google' });
    // the Meet link rode along in the invite
    expect(sendBookingEmail.mock.calls[0][0]).toMatchObject({ location: 'https://meet.google.com/abc-defg-hij' });
  });

  it('rejects a slot that conflicts with a Google calendar busy interval', async () => {
    // Google reports the owner busy over the 07:00 slot → not offered.
    getGoogleBusyForBot.mockResolvedValueOnce([
      { start: new Date('2026-06-10T07:00:00Z'), end: new Date('2026-06-10T07:30:00Z') },
    ]);
    await expect(
      provider.createBooking(ctx, 'idem-g1', OFFERED_START, { name: 'Ada', email: 'ada@example.com' })
    ).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
  });

  it('fails closed (BOOKING_TEMPORARILY_UNAVAILABLE) when Google free/busy errors', async () => {
    getGoogleBusyForBot.mockRejectedValueOnce(new Error('google down'));
    await expect(
      provider.createBooking(ctx, 'idem-g2', OFFERED_START, { name: 'Ada', email: 'ada@example.com' })
    ).rejects.toMatchObject({ code: 'BOOKING_TEMPORARILY_UNAVAILABLE' });
  });

  it('throws BOOKING_NOT_CONFIGURED when the bot has no active service', async () => {
    serviceTypeFind.mockResolvedValue([]);
    await expect(
      provider.createBooking(ctx, 'idem-4', OFFERED_START, { name: 'Ada', email: 'ada@example.com' })
    ).rejects.toMatchObject({ code: 'BOOKING_NOT_CONFIGURED' });
  });

  it('is a BookingError subclass on failure', async () => {
    serviceTypeFind.mockResolvedValue([]);
    const err = await provider
      .createBooking(ctx, 'idem-5', OFFERED_START, { name: 'Ada', email: 'ada@example.com' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BookingError);
  });

  // ── Multi-service (K1b) ────────────────────────────────────────────────────

  it('books a specific service when serviceId is given', async () => {
    eventTypeFindOne.mockResolvedValue({ ...EVENT_TYPE, id: 'svc-hair', name: 'Haircut' });
    const res = await provider.createBooking(
      ctx, 'idem-svc', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, undefined, 'svc-hair'
    );
    expect(res.success).toBe(true);
    expect(eventTypeFindOne).toHaveBeenCalledWith({ where: { id: 'svc-hair', botId: 'bot-1', isActive: true } });
  });

  it('throws SERVICE_REQUIRED when ≥2 active services and no serviceId', async () => {
    serviceTypeFind.mockResolvedValue([EVENT_TYPE, { ...EVENT_TYPE, id: 'et-2' }]);
    await expect(
      provider.createBooking(ctx, 'idem-amb', OFFERED_START, { name: 'Ada', email: 'ada@example.com' })
    ).rejects.toMatchObject({ code: 'SERVICE_REQUIRED' });
  });

  it('throws SERVICE_NOT_FOUND for an unknown serviceId', async () => {
    eventTypeFindOne.mockResolvedValue(null);
    await expect(
      provider.createBooking(ctx, 'idem-nf', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, undefined, 'nope')
    ).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' });
  });

  it('captures a request (no calendar event / email / lock) for a request-only service', async () => {
    eventTypeFindOne.mockResolvedValue({ ...EVENT_TYPE, id: 'svc-req', name: 'Sleeve tattoo', bookingMode: 'request' });
    bookingQuery.mockImplementation(async (sql: string) =>
      sql.includes('INSERT INTO chatbot_bookings') ? [{ id: 'req-1' }] : []
    );
    const res = await provider.createBooking(
      ctx, 'idem-req', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, undefined, 'svc-req'
    );
    expect(res.success).toBe(true);
    expect(res.requested).toBe(true);
    expect(res.booking.id).toBe('req-1');
    expect(sendBookingEmail).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(createCalendarEvent).not.toHaveBeenCalled();
  });
});

describe('InternalProvider.requestAppointment (P2a)', () => {
  let provider: InternalProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-05T00:00:00Z'));
    provider = new InternalProvider();
    eventTypeFindOne.mockResolvedValue({ ...EVENT_TYPE, name: 'Consultation' });
    serviceTypeFind.mockResolvedValue([{ ...EVENT_TYPE, name: 'Consultation' }]); // sole active service
    ruleFindOne.mockResolvedValue(RULE);
    bookingFindOne.mockResolvedValue(null);
    bookingQuery.mockImplementation(async (sql: string) =>
      sql.includes('INSERT INTO chatbot_bookings') ? [{ id: 'req-1' }] : []
    );
  });

  afterEach(() => vi.useRealTimers());

  it('captures a request without touching the calendar, lock, or email; fires the webhook once', async () => {
    const res = await provider.requestAppointment(
      ctx, 'idem-r1', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, 'flexible on timing', undefined, 'New client wants a consult'
    );
    expect(res.success).toBe(true);
    expect(res.requested).toBe(true);
    expect(res.booking.id).toBe('req-1');
    // request side effects: webhook, but no calendar/email/lock
    expect(emitWebhookEvent).toHaveBeenCalledOnce();
    expect(emitWebhookEvent.mock.calls[0][0]).toMatchObject({
      type: 'booking.request_created',
      booking: { bookingId: 'req-1', attendeeName: 'Ada' },
      service: { name: 'Consultation' },
    });
    expect(sendBookingEmail).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(createCalendarEvent).not.toHaveBeenCalled();
    expect(logSave).toHaveBeenCalledOnce();
  });

  it('persists source_channel + ai_summary on the request row', async () => {
    await provider.requestAppointment(
      { ...ctx, session: { id: 'sess-1', channel: 'messenger' } },
      'idem-r2', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, undefined, undefined, 'summary text'
    );
    const insert = bookingQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO chatbot_bookings'));
    expect(insert).toBeDefined();
    const params = insert![1] as any[];
    expect(params).toContain('messenger'); // source_channel
    expect(params).toContain('summary text'); // ai_summary
  });

  it('returns the existing request on idempotent retry without re-notifying', async () => {
    bookingFindOne.mockResolvedValue({
      id: 'req-existing',
      status: 'request_created',
      startUtc: new Date(OFFERED_START),
      endUtc: new Date('2026-06-10T07:30:00Z'),
      attendeeName: 'Ada',
      attendeeEmail: 'ada@example.com',
    });
    const res = await provider.requestAppointment(
      ctx, 'idem-r1', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }
    );
    expect(res.idempotent).toBe(true);
    expect(res.requested).toBe(true);
    expect(res.booking.id).toBe('req-existing');
    expect(emitWebhookEvent).not.toHaveBeenCalled();
    expect(bookingQuery).not.toHaveBeenCalled(); // no INSERT
  });

  it('throws SERVICE_REQUIRED when ≥2 active services and no serviceId', async () => {
    serviceTypeFind.mockResolvedValue([EVENT_TYPE, { ...EVENT_TYPE, id: 'et-2' }]);
    await expect(
      provider.requestAppointment(ctx, 'idem-r3', OFFERED_START, { name: 'Ada', email: 'ada@example.com' })
    ).rejects.toMatchObject({ code: 'SERVICE_REQUIRED' });
    expect(emitWebhookEvent).not.toHaveBeenCalled();
  });

  it('rejects an invalid preferred time', async () => {
    await expect(
      provider.requestAppointment(ctx, 'idem-r4', 'not-a-date', { name: 'Ada', email: 'ada@example.com' })
    ).rejects.toMatchObject({ code: 'INVALID_START_TIME' });
  });

  // ── Owner notification email (P2b) ─────────────────────────────────────────

  it('emails the owner (no ICS) when supportEmail is configured', async () => {
    ruleFindOne.mockResolvedValue(RULE);
    const ctxWithEmail = { ...ctx, botSettings: { ai: { supportEmail: 'owner@example.com' } } };
    await provider.requestAppointment(
      ctxWithEmail, 'idem-r5', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, 'note', undefined, 'summary'
    );
    // fire-and-forget — let the queued microtask run
    await new Promise((r) => setTimeout(r, 0));
    expect(sendRequestNotificationEmail).toHaveBeenCalledOnce();
    expect(sendRequestNotificationEmail.mock.calls[0][0]).toMatchObject({
      ownerEmail: 'owner@example.com',
      serviceName: 'Consultation',
      attendeeName: 'Ada',
      notes: 'note',
      aiSummary: 'summary',
    });
  });

  it('skips the owner email (degraded state) when no supportEmail is set', async () => {
    await provider.requestAppointment(
      ctx, 'idem-r6', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(sendRequestNotificationEmail).not.toHaveBeenCalled();
    // the request + webhook still happened
    expect(emitWebhookEvent).toHaveBeenCalledOnce();
  });
});
