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

// Calendar sync now gates on resolved entitlements (D9); resolve via the
// real pure resolver on 'pro' (calendarIntegrations on) so sync stays live.
vi.mock('../../billing/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../billing/entitlements')>();
  return { ...actual, getEntitlements: vi.fn(async () => actual.entitlementsFor('pro')) };
});

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

// InternalProvider now goes through the CalendarProvider port. Mock it to return
// a Google adapter wired to the same mock fns, so the existing assertions hold
// (the mock fns' null returns simulate "no connection" at the method level).
vi.mock('../../scheduler/calendar-provider', () => {
  const googleAdapter = {
    providerType: 'google',
    getBusy: (...a: any[]) => getGoogleBusyForBot(...a),
    createEvent: (...a: any[]) => createCalendarEvent(...a),
    updateEvent: (...a: any[]) => updateCalendarEvent(...a),
    deleteEvent: (...a: any[]) => deleteCalendarEvent(...a),
    resolveIdentity: (...a: any[]) => resolveCalendarIdentity(...a),
  };
  return {
    resolveCalendarProvider: async () => googleAdapter,
    providerFor: () => googleAdapter,
    // D9 additions: sync allowed in these tests; stored identity delegates to
    // the same resolveCalendarIdentity stub so conflict-key assertions hold.
    isCalendarSyncAllowed: async () => true,
    resolveStoredCalendarIdentity: async (...a: any[]) => ({
      identity: await resolveCalendarIdentity(...a),
      providerType: 'google',
    }),
  };
});

const getUploadSession = vi.fn();
const getReadyFileIds = vi.fn();
vi.mock('../../file-handling/upload.service', () => ({
  getUploadService: () => ({ getSession: getUploadSession, getReadySessionFileIds: getReadyFileIds }),
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
  name: 'Consultation',
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

  it('rejects INTAKE_REQUIRED when a required intake question is unanswered (M5)', async () => {
    const svc = { ...EVENT_TYPE, intakeQuestions: [{ id: 'q-bed', label: 'Bedrooms', type: 'text', required: true }] };
    eventTypeFindOne.mockResolvedValue(svc);
    serviceTypeFind.mockResolvedValue([svc]);
    await expect(
      provider.createBooking(ctx, 'idem-intake', OFFERED_START, { name: 'Ada', email: 'ada@example.com' })
    ).rejects.toMatchObject({ code: 'INTAKE_REQUIRED' });
  });

  it('books when the required intake question is answered (M5)', async () => {
    const svc = { ...EVENT_TYPE, intakeQuestions: [{ id: 'q-bed', label: 'Bedrooms', type: 'text', required: true }] };
    eventTypeFindOne.mockResolvedValue(svc);
    serviceTypeFind.mockResolvedValue([svc]);
    const res = await provider.createBooking(
      ctx,
      'idem-intake-ok',
      OFFERED_START,
      { name: 'Ada', email: 'ada@example.com' },
      undefined,
      undefined,
      { 'q-bed': '3' }
    );
    expect(res.success).toBe(true);
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

  // ── Capacity (P5b) ─────────────────────────────────────────────────────────

  it('rejects with CAPACITY_REACHED when the service is at its daily cap', async () => {
    serviceTypeFind.mockResolvedValue([{ ...EVENT_TYPE, maxBookingsPerDay: 1 }]); // sole active, cap 1
    managerQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('count(*)')) return [{ n: 1 }]; // already at cap
      if (sql.includes('INSERT INTO chatbot_bookings')) return [{ id: 'bk-1' }];
      return [];
    });
    await expect(
      provider.createBooking(ctx, 'idem-cap', OFFERED_START, { name: 'Ada', email: 'ada@example.com' })
    ).rejects.toMatchObject({ code: 'CAPACITY_REACHED' });
  });

  it('allows the booking when under the daily cap', async () => {
    serviceTypeFind.mockResolvedValue([{ ...EVENT_TYPE, maxBookingsPerDay: 2 }]);
    managerQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('count(*)')) return [{ n: 1 }]; // 1 of 2 used
      if (sql.includes('INSERT INTO chatbot_bookings')) return [{ id: 'bk-1' }];
      return [];
    });
    const res = await provider.createBooking(ctx, 'idem-cap2', OFFERED_START, { name: 'Ada', email: 'ada@example.com' });
    expect(res.success).toBe(true);
  });

  it('treats a null cap as unlimited — never issues the count query', async () => {
    // default EVENT_TYPE has no maxBookingsPerDay
    const res = await provider.createBooking(ctx, 'idem-cap3', OFFERED_START, { name: 'Ada', email: 'ada@example.com' });
    expect(res.success).toBe(true);
    expect(managerQuery.mock.calls.some((c) => String(c[0]).includes('count(*)'))).toBe(false);
  });

  // ── Duration modes (P5c) ───────────────────────────────────────────────────

  const RANGE_SERVICE = { ...EVENT_TYPE, durationMode: 'range', minDurationMin: 30, maxDurationMin: 90 };

  it('persists booked_duration_min = service.durationMin for a fixed service', async () => {
    await provider.createBooking(ctx, 'idem-dur-fixed', OFFERED_START, { name: 'Ada', email: 'ada@example.com' });
    const insert = managerQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO chatbot_bookings'));
    expect((insert![1] as any[]).at(-3)).toBe(30); // booked_duration_min (uploaded_files, source_channel after)
  });

  it('books a range service at the chosen 60-min duration', async () => {
    serviceTypeFind.mockResolvedValue([RANGE_SERVICE]);
    const res = await provider.createBooking(
      ctx, 'idem-dur-60', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, undefined, undefined, undefined,
      { durationMin: 60 }
    );
    expect(res.success).toBe(true);
    expect(res.booking.endTime).toBe('2026-06-10T08:00:00.000Z'); // start + 60min
    const insert = managerQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO chatbot_bookings'));
    expect((insert![1] as any[]).at(-3)).toBe(60); // booked_duration_min (uploaded_files, source_channel after)
  });

  it('defaults a range service to minDurationMin when no duration is given', async () => {
    serviceTypeFind.mockResolvedValue([RANGE_SERVICE]);
    const res = await provider.createBooking(ctx, 'idem-dur-def', OFFERED_START, { name: 'Ada', email: 'ada@example.com' });
    expect(res.booking.endTime).toBe('2026-06-10T07:30:00.000Z'); // start + 30 (min)
  });

  it('rejects DURATION_OUT_OF_RANGE for a range service when the chosen length is outside bounds', async () => {
    serviceTypeFind.mockResolvedValue([RANGE_SERVICE]);
    await expect(
      provider.createBooking(ctx, 'idem-dur-oob', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, undefined, undefined, undefined, { durationMin: 120 })
    ).rejects.toMatchObject({ code: 'DURATION_OUT_OF_RANGE' });
  });

  it('falls back to fixed durationMin for an invalid range config (min>max)', async () => {
    serviceTypeFind.mockResolvedValue([{ ...EVENT_TYPE, durationMode: 'range', minDurationMin: 90, maxDurationMin: 30 }]);
    const res = await provider.createBooking(ctx, 'idem-dur-bad', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, undefined, undefined, undefined, { durationMin: 60 });
    expect(res.success).toBe(true);
    expect(res.booking.endTime).toBe('2026-06-10T07:30:00.000Z'); // fixed 30
  });

  // ── File upload (P5e) ──────────────────────────────────────────────────────

  const readySession = (over: any = {}) => ({
    status: 'ready', tenantId: 'ten-1', chatSessionId: 'sess-1',
    originalName: 'room.jpg', fileKey: 'uploads/ten-1/2026/06/abc.jpg', mimeType: 'image/jpeg', fileSize: 1234,
    ...over,
  });

  it('throws FILE_UPLOAD_NOT_ALLOWED when files are attached to a no-upload service (before any session load)', async () => {
    serviceTypeFind.mockResolvedValue([{ ...EVENT_TYPE, fileUploadAllowed: false }]);
    await expect(
      provider.createBooking(ctx, 'idem-f1', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, undefined, undefined, undefined, { fileSessionIds: ['f-1'] })
    ).rejects.toMatchObject({ code: 'FILE_UPLOAD_NOT_ALLOWED' });
    expect(getUploadSession).not.toHaveBeenCalled(); // no oracle
  });

  it('snapshots a ready, tenant+session-matched file into uploaded_files', async () => {
    serviceTypeFind.mockResolvedValue([{ ...EVENT_TYPE, fileUploadAllowed: true }]);
    getUploadSession.mockResolvedValue(readySession());
    await provider.createBooking(ctx, 'idem-f2', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, undefined, undefined, undefined, { fileSessionIds: ['f-1', 'f-1'] });
    const insert = managerQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO chatbot_bookings'));
    const files = JSON.parse((insert![1] as any[]).at(-2)); // uploaded_files (source_channel last)
    expect(files).toEqual([{ fileSessionId: 'f-1', fileName: 'room.jpg', mimeType: 'image/jpeg', fileSize: 1234, fileKey: 'uploads/ten-1/2026/06/abc.jpg' }]);
  });

  it('throws FILE_NOT_READY for an unscanned / foreign-tenant / wrong-session file', async () => {
    serviceTypeFind.mockResolvedValue([{ ...EVENT_TYPE, fileUploadAllowed: true }]);
    for (const bad of [{ status: 'scanning' }, { tenantId: 'other' }, { chatSessionId: 'other-sess' }]) {
      getUploadSession.mockResolvedValueOnce(readySession(bad));
      await expect(
        provider.createBooking(ctx, `idem-bad-${JSON.stringify(bad)}`, OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, undefined, undefined, undefined, { fileSessionIds: ['f-1'] })
      ).rejects.toMatchObject({ code: 'FILE_NOT_READY' });
    }
  });

  it('throws TOO_MANY_FILES for more than 5 distinct files', async () => {
    serviceTypeFind.mockResolvedValue([{ ...EVENT_TYPE, fileUploadAllowed: true }]);
    await expect(
      provider.createBooking(ctx, 'idem-many', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, undefined, undefined, undefined, { fileSessionIds: ['a','b','c','d','e','f'] })
    ).rejects.toMatchObject({ code: 'TOO_MANY_FILES' });
  });

  it('auto-collects the chat session ready uploads for a file-accepting service when the tool passes none', async () => {
    serviceTypeFind.mockResolvedValue([{ ...EVENT_TYPE, fileUploadAllowed: true }]);
    getReadyFileIds.mockResolvedValue(['auto-1']); // the agent never surfaces upload ids to the LLM
    getUploadSession.mockResolvedValue(readySession());
    await provider.createBooking(ctx, 'idem-auto', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }); // no extras
    expect(getReadyFileIds).toHaveBeenCalledWith('sess-1', 'ten-1');
    const insert = managerQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO chatbot_bookings'));
    const files = JSON.parse((insert![1] as any[]).at(-2)); // uploaded_files (source_channel last)
    expect(files).toEqual([{ fileSessionId: 'auto-1', fileName: 'room.jpg', mimeType: 'image/jpeg', fileSize: 1234, fileKey: 'uploads/ten-1/2026/06/abc.jpg' }]);
  });

  it('does NOT auto-collect (so a stray upload never blocks) for a no-file service', async () => {
    serviceTypeFind.mockResolvedValue([{ ...EVENT_TYPE, fileUploadAllowed: false }]);
    const res = await provider.createBooking(ctx, 'idem-nofile', OFFERED_START, { name: 'Ada', email: 'ada@example.com' });
    expect(res.success).toBe(true);
    expect(getReadyFileIds).not.toHaveBeenCalled();
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

  // ── Intake answers normalization (P3b) ─────────────────────────────────────

  it('normalizes + persists intake answers keyed by current question id', async () => {
    eventTypeFindOne.mockResolvedValue({
      ...EVENT_TYPE, name: 'Consultation',
      intakeQuestions: [
        { id: 'q-1', label: 'Occasion?', type: 'text', required: true },
        { id: 'q-2', label: 'Size?', type: 'choice', required: false, options: ['S', 'L'] },
      ],
    });
    serviceTypeFind.mockResolvedValue([{ ...EVENT_TYPE, intakeQuestions: [] }, { ...EVENT_TYPE, id: 'svc-2' }]); // ≥2 → serviceId required
    await provider.requestAppointment(
      ctx, 'idem-iq', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, undefined, 'svc-1',
      undefined,
      { 'q-1': '  Birthday  ', 'q-2': 7, 'q-unknown': 'dropped', 'q-3-empty': '   ' }
    );
    const insert = bookingQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO chatbot_bookings'));
    const params = insert![1] as any[];
    // createRequest column tail: …, intake_answers, customer_address, customer_phone
    const intakeParam = params[params.length - 5];
    const parsed = JSON.parse(intakeParam);
    expect(parsed).toEqual({ 'q-1': 'Birthday', 'q-2': '7' }); // trimmed, number coerced, unknown + blank dropped
  });

  it('stores null intake_answers when the service has no questions', async () => {
    eventTypeFindOne.mockResolvedValue({ ...EVENT_TYPE, intakeQuestions: [] });
    await provider.requestAppointment(
      ctx, 'idem-iq2', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, undefined, undefined, undefined,
      { 'whatever': 'x' }
    );
    const insert = bookingQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO chatbot_bookings'));
    const params = insert![1] as any[];
    expect(params[params.length - 5]).toBeNull(); // intake_answers (before address, phone)
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

  // ── Address / phone capture (P5a) ──────────────────────────────────────────

  it('throws ADDRESS_REQUIRED when the service requires an address and none is given', async () => {
    serviceTypeFind.mockResolvedValue([{ ...EVENT_TYPE, customerAddressRequired: true }]); // sole-active path
    await expect(
      provider.requestAppointment(ctx, 'idem-addr', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, undefined, undefined, undefined, undefined, {})
    ).rejects.toMatchObject({ code: 'ADDRESS_REQUIRED' });
    expect(bookingQuery).not.toHaveBeenCalled();
  });

  it('throws PHONE_REQUIRED when the service requires a phone (customerLocationRequired) and only whitespace is given', async () => {
    serviceTypeFind.mockResolvedValue([{ ...EVENT_TYPE, customerLocationRequired: true }]);
    await expect(
      provider.requestAppointment(ctx, 'idem-phone', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, undefined, undefined, undefined, undefined, { customerPhone: '   ' })
    ).rejects.toMatchObject({ code: 'PHONE_REQUIRED' });
  });

  it('persists trimmed address/phone into the request row', async () => {
    serviceTypeFind.mockResolvedValue([{ ...EVENT_TYPE, customerAddressRequired: true, customerLocationRequired: true }]);
    await provider.requestAppointment(
      ctx, 'idem-contact', OFFERED_START, { name: 'Ada', email: 'ada@example.com' }, undefined, undefined, undefined, undefined,
      { customerAddress: '  221B Baker Street  ', customerPhone: '+44 20 7946 0000' }
    );
    const insert = bookingQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO chatbot_bookings'));
    const params = insert![1] as any[];
    expect(params[params.length - 4]).toBe('221B Baker Street'); // customer_address
    expect(params[params.length - 3]).toBe('+44 20 7946 0000'); // customer_phone
  });
});
