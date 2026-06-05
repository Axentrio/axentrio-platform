import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const eventTypeFindOne = vi.fn();
const ruleFindOne = vi.fn();
const bookingFindOne = vi.fn();
const bookingFind = vi.fn();
const bookingQuery = vi.fn();
const logCreate = vi.fn((d: any) => d);
const logSave = vi.fn();
const managerQuery = vi.fn();
const transaction = vi.fn(async (cb: any) => cb({ query: managerQuery }));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn((entity: any) => {
      const name = entity?.name || entity;
      if (name === 'EventType') return { findOne: eventTypeFindOne };
      if (name === 'AvailabilityRule') return { findOne: ruleFindOne };
      if (name === 'Booking') return { findOne: bookingFindOne, find: bookingFind, query: bookingQuery };
      if (name === 'BookingLog') return { create: logCreate, save: logSave };
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

import { InternalProvider } from '../../n8n/booking-providers/internal.provider';

const ctx: any = {
  session: { id: 'sess-1' },
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

  it('rejects rescheduling to a non-offered time', async () => {
    await expect(provider.rescheduleBooking(ctx, 'bk-1', '2026-06-10T08:05:00Z')).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
    expect(transaction).not.toHaveBeenCalled();
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

  it('lists upcoming confirmed bookings for an attendee', async () => {
    bookingFind.mockResolvedValue([confirmedBooking()]);
    const res = await provider.listBookings(ctx, 'ada@example.com');
    expect(res.bookings).toHaveLength(1);
    expect(res.bookings[0]).toMatchObject({ id: 'bk-1', status: 'confirmed' });
  });
});
