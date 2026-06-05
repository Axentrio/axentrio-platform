import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────────
const eventTypeFindOne = vi.fn();
const ruleFindOne = vi.fn();
const bookingFindOne = vi.fn();
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
      if (name === 'Booking') return { findOne: bookingFindOne, query: bookingQuery };
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

  it('throws BOOKING_NOT_CONFIGURED when the bot has no event type', async () => {
    eventTypeFindOne.mockResolvedValue(null);
    await expect(
      provider.createBooking(ctx, 'idem-4', OFFERED_START, { name: 'Ada', email: 'ada@example.com' })
    ).rejects.toMatchObject({ code: 'BOOKING_NOT_CONFIGURED' });
  });

  it('is a BookingError subclass on failure', async () => {
    eventTypeFindOne.mockResolvedValue(null);
    const err = await provider
      .createBooking(ctx, 'idem-5', OFFERED_START, { name: 'Ada', email: 'ada@example.com' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BookingError);
  });
});
