/**
 * The manage page's `request` branch is what EVERY new Service now hits, because
 * `request` became the default. The customer must be told they are ASKING, not
 * moving the appointment, so the button copy is part of the contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getManageBooking = vi.fn();
vi.mock('../../booking/booking.service', () => ({
  getManageBooking: (...a: unknown[]) => getManageBooking(...a),
  adminCancelBooking: vi.fn(),
  adminRescheduleBooking: vi.fn(),
  adminAvailability: vi.fn(),
}));
vi.mock('../../scheduler/booking-token', () => ({
  signBookingToken: () => 'tok',
  verifyBookingToken: () => ({ bookingId: 'bk-1' }),
}));

import { getManagePage } from '../../scheduler/booking-public.controller';

function res() {
  const sent: { code?: number; html?: string } = {};
  return {
    sent,
    status(c: number) { sent.code = c; return this; },
    send(h: string) { sent.html = h; return this; },
    type() { return this; },
    setHeader() { return this; },
  };
}

const START = new Date('2026-06-10T08:00:00.000Z');

function view(over: Record<string, unknown>) {
  return {
    booking: { id: 'bk-1', status: 'confirmed', startUtc: START, endUtc: new Date(START.getTime() + 1800000) },
    timezone: 'Europe/Amsterdam',
    eventName: 'Boiler repair',
    rescheduleUntilMin: null,
    cancelUntilMin: null,
    ...over,
  };
}

describe('edge: manage page copy per customer change mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('request (the new default) asks, it does not promise a move', async () => {
    getManageBooking.mockResolvedValue(view({ rescheduleMode: 'request', cancelMode: 'request' }));
    const r = res();
    await getManagePage({ query: { token: 'tok' } } as never, r as never);
    expect(r.sent.html).toContain('Request reschedule');
    expect(r.sent.html).toContain('Request cancellation');
    expect(r.sent.html).not.toMatch(/>Reschedule</);
  });

  it('auto keeps the plain labels', async () => {
    getManageBooking.mockResolvedValue(view({ rescheduleMode: 'auto', cancelMode: 'auto' }));
    const r = res();
    await getManagePage({ query: { token: 'tok' } } as never, r as never);
    expect(r.sent.html).toContain('>Reschedule<');
    expect(r.sent.html).toContain('Cancel appointment');
  });

  it('not_allowed offers no button and says so once', async () => {
    getManageBooking.mockResolvedValue(view({ rescheduleMode: 'not_allowed', cancelMode: 'not_allowed' }));
    const r = res();
    await getManagePage({ query: { token: 'tok' } } as never, r as never);
    expect(r.sent.html).not.toContain('Reschedule');
    expect(r.sent.html).not.toContain('Cancel');
    expect(r.sent.html).toContain('cannot be changed online');
  });

  it('a passed cutoff demotes request to no button at all', async () => {
    getManageBooking.mockResolvedValue(view({ rescheduleMode: 'request', cancelMode: 'request', rescheduleUntilMin: 10 * 24 * 60, cancelUntilMin: 10 * 24 * 60 }));
    const r = res();
    await getManagePage({ query: { token: 'tok' } } as never, r as never);
    expect(r.sent.html).toContain('cannot be changed online');
  });
});
