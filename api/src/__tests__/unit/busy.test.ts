/**
 * `loadAllBusy` is the availability miss: write-time SQL only sees `chatbot_bookings`.
 * Pad each source independently — padding the merged array would give our bookings 2× gap.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const bookingQuery = vi.fn();
const settingsFindOne = vi.fn();
const getBusy = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn((entity: { name?: string }) => {
      if (entity?.name === 'Booking') return { query: (...a: unknown[]) => bookingQuery(...a) };
      return { findOne: (...a: unknown[]) => settingsFindOne(...a) };
    }),
    manager: { getRepository: vi.fn(() => ({ findOne: (...a: unknown[]) => settingsFindOne(...a) })) },
  },
}));

vi.mock('../../scheduler/calendar-provider', () => ({
  resolveCalendarProvider: vi.fn(async () => ({
    getBusy: (...a: unknown[]) => getBusy(...a),
  })),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { loadAllBusy } from '../../booking/booking-providers/busy';
import type { BookingContext } from '../../booking/booking-providers/types';

const ctx = { bot: { id: 'bot-1' } } as BookingContext;
const RANGE = ['2026-09-23T00:00:00.000Z', '2026-09-24T00:00:00.000Z'] as const;

describe('loadAllBusy — minimum gap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bookingQuery.mockResolvedValue([]);
    settingsFindOne.mockResolvedValue({ minGapMin: 30 });
    getBusy.mockResolvedValue([]);
  });

  it('pads a 10:00–10:30 external event so 10:30 is busy', async () => {
    // 10:00–10:30 Brussels = 08:00–08:30 UTC. 30 min gap → busy until 11:00 local.
    getBusy.mockResolvedValue([
      { start: new Date('2026-09-23T08:00:00Z'), end: new Date('2026-09-23T08:30:00Z') },
    ]);
    const busy = await loadAllBusy(ctx, 'cal-1', RANGE[0], RANGE[1], 'Europe/Brussels');
    expect(busy).toEqual([
      { start: new Date('2026-09-23T07:30:00.000Z'), end: new Date('2026-09-23T09:00:00.000Z') },
    ]);
  });

  it('widens the external fetch when rangeStart equals the event end (agent narrow startDate)', async () => {
    // Agent path: LLM passes the named 10:30 as rangeStart (08:30Z). Without widening,
    // Google would not return an event ending exactly at timeMin and 10:30 looks free.
    getBusy.mockResolvedValue([
      { start: new Date('2026-09-23T08:00:00Z'), end: new Date('2026-09-23T08:30:00Z') },
    ]);
    const rangeStart = '2026-09-23T08:30:00.000Z';
    const rangeEnd = '2026-09-23T22:00:00.000Z';
    const busy = await loadAllBusy(ctx, 'cal-1', rangeStart, rangeEnd, 'Europe/Brussels');
    expect(getBusy).toHaveBeenCalledWith(
      'bot-1',
      '2026-09-23T08:00:00.000Z',
      '2026-09-23T22:30:00.000Z',
      'Europe/Brussels',
    );
    expect(busy).toEqual([
      { start: new Date('2026-09-23T07:30:00.000Z'), end: new Date('2026-09-23T09:00:00.000Z') },
    ]);
  });

  it('pads internal and external once each, not the merged array', async () => {
    bookingQuery.mockResolvedValue([{ s: '2026-09-23T07:00:00.000Z', e: '2026-09-23T08:00:00.000Z' }]);
    getBusy.mockResolvedValue([
      { start: new Date('2026-09-23T10:00:00Z'), end: new Date('2026-09-23T10:30:00Z') },
    ]);
    const busy = await loadAllBusy(ctx, 'cal-1', RANGE[0], RANGE[1], 'Europe/Brussels');
    expect(busy).toEqual([
      { start: new Date('2026-09-23T06:30:00.000Z'), end: new Date('2026-09-23T08:30:00.000Z') },
      { start: new Date('2026-09-23T09:30:00.000Z'), end: new Date('2026-09-23T11:00:00.000Z') },
    ]);
  });
});
