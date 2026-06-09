import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const eventTypeFindOne = vi.fn();
const ruleFindOne = vi.fn();
const bookingFindOne = vi.fn();
const bookingFind = vi.fn();
const bookingQuery = vi.fn();
const logCreate = vi.fn((d: any) => d);
const logSave = vi.fn();
const managerQuery = vi.fn();
const bookingRefFind = vi.fn();
const chatSessionFindOne = vi.fn();
const transaction = vi.fn(async (cb: any) => cb({ query: managerQuery }));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn((entity: any) => {
      const name = entity?.name || entity;
      if (name === 'ServiceType') return { findOne: eventTypeFindOne };
      if (name === 'AvailabilityRule') return { findOne: ruleFindOne };
      if (name === 'Booking') return { findOne: bookingFindOne, find: bookingFind, query: bookingQuery };
      if (name === 'BookingLog') return { create: logCreate, save: logSave };
      if (name === 'BookingReference') return { find: bookingRefFind, save: vi.fn(), create: (x: any) => x };
      if (name === 'ChatSession') return { findOne: chatSessionFindOne };
      return {};
    }),
    transaction: (cb: any) => transaction(cb),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sendBookingEmail = vi.fn();
vi.mock('../../n8n/booking-providers/booking-email', () => ({
  sendBookingEmail: (...args: any[]) => sendBookingEmail(...args),
}));

vi.mock('../../integrations/google/google-calendar.service', () => ({
  getGoogleBusyForBot: vi.fn().mockResolvedValue(null),
  createCalendarEvent: vi.fn().mockResolvedValue(null),
  updateCalendarEvent: vi.fn().mockResolvedValue('no_connection'),
  deleteCalendarEvent: vi.fn().mockResolvedValue(undefined),
  resolveCalendarIdentity: vi.fn().mockResolvedValue(null),
}));

// InternalProvider routes calendar work through the port; these tests focus on
// reschedule/cancel LOGIC, so a benign "no connection" adapter suffices.
const providerGetBusy = vi.fn();
vi.mock('../../scheduler/calendar-provider', () => {
  const adapter = {
    providerType: 'google',
    getBusy: (...a: any[]) => providerGetBusy(...a),
    createEvent: vi.fn().mockResolvedValue(null),
    updateEvent: vi.fn().mockResolvedValue('no_connection'),
    deleteEvent: vi.fn().mockResolvedValue('ok'),
    resolveIdentity: vi.fn().mockResolvedValue(null),
  };
  return { resolveCalendarProvider: async () => adapter, providerFor: () => adapter };
});

import { InternalProvider } from '../../n8n/booking-providers/internal.provider';

const ctx: any = {
  session: { id: 'sess-1', visitorId: 'psid-1' },
  tenant: { id: 'ten-1' },
  bot: { id: 'bot-1' },
  botSettings: { ai: { supportEmail: 'owner@axentrio.be' } },
};

const EVENT_TYPE = {
  id: 'et-1',
  name: 'Intro call',
  durationMin: 30,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  minNoticeMin: 0,
  maxHorizonDays: 60,
  locationType: 'custom',
  isActive: true,
};
const RULE = {
  timezone: 'Europe/Brussels',
  weeklyHours: { wed: [{ start: '09:00', end: '11:00' }] },
  dateOverrides: [],
  slotGranularityMin: 30,
};

const confirmedBooking = () => ({
  id: 'bk-1',
  tenantId: 'ten-1',
  botId: 'bot-1',
  sessionId: 'sess-1', // matches ctx.session.id — the customer owns this booking
  provider: 'internal',
  eventTypeId: 'et-1',
  status: 'confirmed',
  icsUid: 'uid-1@axentrio',
  attendeeName: 'Ada',
  attendeeEmail: 'ada@example.com',
  startUtc: new Date('2026-06-10T07:00:00Z'),
  endUtc: new Date('2026-06-10T07:30:00Z'),
  sequence: 0,
});

const NEW_START = '2026-06-10T08:00:00Z'; // 10:00 Brussels CEST — an offered slot

describe('InternalProvider reschedule / cancel / list', () => {
  let provider: InternalProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-05T00:00:00Z'));
    provider = new InternalProvider();
    eventTypeFindOne.mockResolvedValue(EVENT_TYPE);
    ruleFindOne.mockResolvedValue(RULE);
    bookingFindOne.mockResolvedValue(confirmedBooking());
    bookingRefFind.mockResolvedValue([]); // no calendar ref by default
    chatSessionFindOne.mockResolvedValue(null); // owning session not found by default
    providerGetBusy.mockResolvedValue(null); // no external busy by default
    bookingQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('lower(blocked_range)')) return []; // busy
      if (sql.includes("status='cancelled'")) return [{ sequence: 1 }]; // cancel update
      return [];
    });
    managerQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('UPDATE chatbot_bookings')) return [{ sequence: 1 }];
      return [];
    });
  });

  afterEach(() => vi.useRealTimers());

  it('reschedules to an offered slot, bumps sequence, sends an updated invite', async () => {
    const res = await provider.rescheduleBooking(ctx, 'bk-1', NEW_START);
    expect(res.success).toBe(true);
    expect(res.booking.startTime).toBe('2026-06-10T08:00:00.000Z');
    expect(res.booking.endTime).toBe('2026-06-10T08:30:00.000Z');
    expect(sendBookingEmail).toHaveBeenCalledOnce();
    expect(sendBookingEmail.mock.calls[0][0]).toMatchObject({ method: 'REQUEST', sequence: 1, uid: 'uid-1@axentrio' });
    expect(logSave).toHaveBeenCalledOnce();
  });

  it('reschedule invite keeps the meeting join link (location + description)', async () => {
    bookingRefFind.mockResolvedValue([
      { bookingId: 'bk-1', providerType: 'google', meetingUrl: 'https://meet.google.com/abc-defg-hij', createdAt: new Date('2026-06-01T00:00:00Z') },
    ]);
    await provider.rescheduleBooking(ctx, 'bk-1', NEW_START);
    expect(sendBookingEmail.mock.calls[0][0]).toMatchObject({
      method: 'REQUEST',
      location: 'https://meet.google.com/abc-defg-hij',
      description: 'Join the meeting: https://meet.google.com/abc-defg-hij',
    });
  });

  it('rejects rescheduling to a non-offered time', async () => {
    await expect(provider.rescheduleBooking(ctx, 'bk-1', '2026-06-10T08:05:00Z')).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('reschedule to a nearby slot is not blocked by the booking\'s OWN external event (M3)', async () => {
    // Finer granularity so 07:15Z (09:15 Brussels) is a candidate that overlaps the
    // old event [07:00,07:30). The booking's mirror sits at its old time; getBusy
    // returns it as foreign busy. Without the self-exclusion this move is rejected.
    ruleFindOne.mockResolvedValue({ ...RULE, slotGranularityMin: 15 });
    providerGetBusy.mockResolvedValue([
      { start: new Date('2026-06-10T07:00:00Z'), end: new Date('2026-06-10T07:30:00Z') },
    ]);
    const res = await provider.rescheduleBooking(ctx, 'bk-1', '2026-06-10T07:15:00Z');
    expect(res.success).toBe(true);
    expect(res.booking.startTime).toBe('2026-06-10T07:15:00.000Z');
  });

  it('maps a reschedule exclusion violation to SLOT_UNAVAILABLE', async () => {
    managerQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('UPDATE chatbot_bookings')) {
        throw Object.assign(new Error('exclusion'), { code: '23P01' });
      }
      return [];
    });
    await expect(provider.rescheduleBooking(ctx, 'bk-1', NEW_START)).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
  });

  it('rejects reschedule/cancel for a booking owned by another tenant (404)', async () => {
    bookingFindOne.mockResolvedValue({ ...confirmedBooking(), tenantId: 'other-tenant' });
    await expect(provider.rescheduleBooking(ctx, 'bk-1', NEW_START)).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND' });
    await expect(provider.cancelBooking(ctx, 'bk-1')).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND' });
  });

  // ── H1: cross-customer IDOR within the same tenant ────────────────────────
  it("rejects reschedule/cancel of another customer's booking in the same tenant (different session → 404)", async () => {
    bookingFindOne.mockResolvedValue({ ...confirmedBooking(), sessionId: 'other-customer-session' });
    chatSessionFindOne.mockResolvedValue({ id: 'other-customer-session', visitorId: 'psid-OTHER' });
    await expect(provider.rescheduleBooking(ctx, 'bk-1', NEW_START)).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND' });
    await expect(provider.cancelBooking(ctx, 'bk-1')).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('a returning customer (new session, SAME visitor identity) can manage their booking', async () => {
    // e.g. a Messenger/IG user back the next day: new session, same PSID. The booking
    // was made in an earlier session but shares the caller's stable visitor identity.
    bookingFindOne.mockResolvedValue({ ...confirmedBooking(), sessionId: 'earlier-session' });
    chatSessionFindOne.mockResolvedValue({ id: 'earlier-session', visitorId: 'psid-1' });
    const res = await provider.rescheduleBooking(ctx, 'bk-1', NEW_START);
    expect(res.success).toBe(true);
  });

  it('an admin context (portal / signed manage-link) may manage a booking from any session', async () => {
    bookingFindOne.mockResolvedValue({ ...confirmedBooking(), sessionId: 'other-customer-session' });
    const res = await provider.rescheduleBooking({ ...ctx, isAdmin: true }, 'bk-1', NEW_START);
    expect(res.success).toBe(true);
  });

  it('listBookings falls back to the current session when there is no visitor id', async () => {
    const ctxNoVisitor = { ...ctx, session: { id: 'sess-1' } };
    bookingQuery.mockResolvedValueOnce([]);
    await provider.listBookings(ctxNoVisitor as any, 'ada@example.com');
    const call = bookingQuery.mock.calls.at(-1)!;
    expect(String(call[0])).not.toMatch(/JOIN chat_sessions/);
    expect(call[1]).toContain('sess-1');
  });

  it('cancels a confirmed booking and sends a CANCEL invite', async () => {
    const res = await provider.cancelBooking(ctx, 'bk-1', 'changed plans');
    expect(res).toEqual({ success: true, cancelled: true });
    expect(sendBookingEmail).toHaveBeenCalledOnce();
    expect(sendBookingEmail.mock.calls[0][0]).toMatchObject({ method: 'CANCEL', sequence: 1 });
  });

  it('is idempotent when cancelling an already-cancelled booking', async () => {
    bookingFindOne.mockResolvedValue({ ...confirmedBooking(), status: 'cancelled' });
    const res = await provider.cancelBooking(ctx, 'bk-1');
    expect(res).toEqual({ success: true, cancelled: true });
    expect(sendBookingEmail).not.toHaveBeenCalled();
    expect(logSave).not.toHaveBeenCalled();
  });

  it('lists confirmed bookings scoped to the caller\'s visitor identity (across sessions)', async () => {
    bookingQuery.mockResolvedValueOnce([
      { id: 'bk-1', start_utc: new Date('2026-06-10T07:00:00Z'), end_utc: new Date('2026-06-10T07:30:00Z'), attendee_name: 'Ada', attendee_email: 'ada@example.com', status: 'confirmed' },
    ]);
    const res = await provider.listBookings(ctx, 'ada@example.com');
    expect(res.bookings).toHaveLength(1);
    expect(res.bookings[0]).toMatchObject({ id: 'bk-1', status: 'confirmed' });
    const call = bookingQuery.mock.calls.at(-1)!;
    expect(String(call[0])).toMatch(/JOIN chat_sessions/);
    expect(call[1]).toContain('psid-1'); // scoped by the stable visitor id, not the session
  });

  // ── accept / decline request ──────────────────────────────────────────────
  // requestBooking start 07:00Z = 09:00 Brussels (an offered Wed slot), future.
  const requestBooking = (over: Record<string, unknown> = {}) => ({
    ...confirmedBooking(),
    status: 'request_created',
    bookedDurationMin: 30,
    ...over,
  });

  it('acceptRequest confirms a request → calendar + email + log, returns success', async () => {
    bookingFindOne.mockResolvedValue(requestBooking());
    const res = await provider.acceptRequest(ctx, 'bk-1');
    expect(res.success).toBe(true);
    expect(res.booking.startTime).toBe('2026-06-10T07:00:00.000Z');
    expect(sendBookingEmail).toHaveBeenCalledOnce();
    expect(sendBookingEmail.mock.calls[0][0]).toMatchObject({ method: 'REQUEST' });
    expect(logSave).toHaveBeenCalled(); // created log
    // the confirm UPDATE flipped status under the lock
    expect(managerQuery.mock.calls.some((c) => String(c[0]).includes("status='confirmed'"))).toBe(true);
  });

  it('acceptRequest rejects a non-request (confirmed) booking', async () => {
    bookingFindOne.mockResolvedValue(confirmedBooking());
    await expect(provider.acceptRequest(ctx, 'bk-1')).rejects.toMatchObject({ code: 'NOT_A_REQUEST' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('acceptRequest rejects a request whose time is in the past', async () => {
    bookingFindOne.mockResolvedValue(requestBooking({ startUtc: new Date('2026-06-04T07:00:00Z'), endUtc: new Date('2026-06-04T07:30:00Z') }));
    await expect(provider.acceptRequest(ctx, 'bk-1')).rejects.toMatchObject({ code: 'REQUEST_EXPIRED' });
  });

  it('acceptRequest rejects when the requested time is no longer offered', async () => {
    bookingFindOne.mockResolvedValue(requestBooking({ startUtc: new Date('2026-06-10T08:05:00Z'), endUtc: new Date('2026-06-10T08:35:00Z') }));
    await expect(provider.acceptRequest(ctx, 'bk-1')).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('acceptRequest → REQUEST_ALREADY_HANDLED when the conditional update matches no row', async () => {
    bookingFindOne.mockResolvedValue(requestBooking());
    managerQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('UPDATE chatbot_bookings')) return []; // already handled / raced
      return [];
    });
    await expect(provider.acceptRequest(ctx, 'bk-1')).rejects.toMatchObject({ code: 'REQUEST_ALREADY_HANDLED' });
    expect(sendBookingEmail).not.toHaveBeenCalled();
  });

  it('acceptRequest maps an exclusion violation (23P01) to SLOT_UNAVAILABLE', async () => {
    bookingFindOne.mockResolvedValue(requestBooking());
    managerQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('UPDATE chatbot_bookings')) throw Object.assign(new Error('excl'), { code: '23P01' });
      return [];
    });
    await expect(provider.acceptRequest(ctx, 'bk-1')).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
  });

  it('declineRequest closes a request (cancelled + log, no email/calendar)', async () => {
    bookingFindOne.mockResolvedValue(requestBooking());
    const res = await provider.declineRequest(ctx, 'bk-1', 'cannot accommodate');
    expect(res).toEqual({ success: true, cancelled: true });
    expect(sendBookingEmail).not.toHaveBeenCalled();
    expect(logSave).toHaveBeenCalledOnce();
  });

  it('declineRequest rejects a non-request booking', async () => {
    bookingFindOne.mockResolvedValue(confirmedBooking());
    await expect(provider.declineRequest(ctx, 'bk-1')).rejects.toMatchObject({ code: 'NOT_A_REQUEST' });
  });

  it('declineRequest is idempotent for an already-cancelled row', async () => {
    bookingFindOne.mockResolvedValue(requestBooking({ status: 'cancelled' }));
    const res = await provider.declineRequest(ctx, 'bk-1');
    expect(res).toEqual({ success: true, cancelled: true });
    expect(logSave).not.toHaveBeenCalled();
  });
});
