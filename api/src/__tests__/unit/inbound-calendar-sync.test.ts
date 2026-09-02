/**
 * Inbound calendar sync: owner edits in the connected calendar update the booking.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BookingError } from '../../booking/booking-providers/types';

const queryMock = vi.fn();
const bookingFindOne = vi.fn();
const serviceFindOne = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    query: (...a: unknown[]) => queryMock(...a),
    getRepository: (entity: { name?: string }) => {
      const name = entity?.name ?? entity;
      if (name === 'Booking') return { findOne: bookingFindOne };
      if (name === 'ServiceType') return { findOne: serviceFindOne };
      return {};
    },
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const listChanges = vi.fn();
const getEvent = vi.fn();
const updateEvent = vi.fn();
vi.mock('../../scheduler/calendar-provider', () => {
  const adapter = {
    providerType: 'google',
    getBusy: vi.fn(),
    createEvent: vi.fn(),
    updateEvent: (...a: unknown[]) => updateEvent(...a),
    deleteEvent: vi.fn(),
    resolveIdentity: vi.fn(),
    getEvent: (...a: unknown[]) => getEvent(...a),
    listChanges: (...a: unknown[]) => listChanges(...a),
  };
  return {
    providerFor: () => adapter,
    resolveCalendarProvider: async () => adapter,
    isCalendarSyncAllowed: async () => true,
  };
});

const externalRescheduleBooking = vi.fn();
const externalCancelBooking = vi.fn();
vi.mock('../../booking/booking.service', () => ({
  externalRescheduleBooking: (...a: unknown[]) => externalRescheduleBooking(...a),
  externalCancelBooking: (...a: unknown[]) => externalCancelBooking(...a),
}));

const sendCalendarChangeRejectedEmail = vi.fn();
vi.mock('../../booking/booking-providers/booking-email', () => ({
  sendCalendarChangeRejectedEmail: (...a: unknown[]) => sendCalendarChangeRejectedEmail(...a),
}));

vi.mock('../../booking/business-timezone', () => ({
  getBotBusinessTimezone: vi.fn(async () => 'UTC'),
}));

vi.mock('../../services/bot-config.service', () => ({
  getBotConfigForBotId: vi.fn(async () => ({
    settings: { ai: { supportEmail: 'owner@example.com' } },
  })),
}));

import { syncExternalCalendarChanges } from '../../scheduler/inbound-calendar-sync';

const BOOKING_ID = 'bk-1';
const START = new Date('2026-06-15T08:00:00Z');
const END = new Date('2026-06-15T09:00:00Z');

const cred = {
  id: 'cred-1',
  tenant_id: 't1',
  bot_id: 'b1',
  provider: 'google',
  calendar_id: 'primary',
  inbound_sync_cursor: 'tok-1',
  inbound_attempts: 0,
  lease_token: 'lease-1',
};

const booking = {
  id: BOOKING_ID,
  status: 'confirmed',
  startUtc: START,
  endUtc: END,
  attendeeName: 'Ada',
  eventTypeId: 'svc-1',
};

const match = {
  external_event_id: 'ev-1',
  external_calendar_id: 'primary',
  booking_id: BOOKING_ID,
};

function claim(row: Record<string, unknown>, matches: unknown[] = [match]) {
  let claimed = false;
  queryMock.mockImplementation(async (sql: string) => {
    const q = String(sql);
    if (q.includes('FOR UPDATE SKIP LOCKED')) {
      if (claimed) return [[], 0];
      claimed = true;
      return [[row], 1];
    }
    if (q.includes('$2::timestamptz')) {
      return [[{ lease_token: 'lease-2' }], 1];
    }
    if (q.includes('FROM chatbot_booking_references')) return matches;
    return [[], 0];
  });
}

function found(startISO: string | null, endISO: string | null, cancelled = false) {
  return { kind: 'found' as const, startISO, endISO, cancelled };
}

const cursorAdvanced = () =>
  queryMock.mock.calls.some((c) => String(c[0]).includes('inbound_sync_cursor = $3'));
const attemptsIncremented = () =>
  queryMock.mock.calls.some((c) => String(c[0]).includes('inbound_attempts = inbound_attempts + 1'));
const cursorParam = () => {
  const call = queryMock.mock.calls.find((c) => String(c[0]).includes('inbound_sync_cursor = $3'));
  return call?.[1] as unknown[] | undefined;
};

beforeEach(() => {
  vi.clearAllMocks();
  bookingFindOne.mockResolvedValue(booking);
  serviceFindOne.mockResolvedValue({ name: 'Intro call' });
  listChanges.mockResolvedValue({ eventIds: ['ev-1'], cursor: 'tok-2', bootstrapped: false });
  updateEvent.mockResolvedValue({ status: 'ok', meetUrl: null });
  externalRescheduleBooking.mockResolvedValue({ success: true });
  externalCancelBooking.mockResolvedValue({ success: true });
});

describe('syncExternalCalendarChanges', () => {
  it('reschedules when the owner moves the event', async () => {
    claim(cred);
    getEvent.mockResolvedValue(found('2026-06-15T12:00:00Z', '2026-06-15T13:00:00Z'));

    await syncExternalCalendarChanges();

    expect(externalRescheduleBooking).toHaveBeenCalledOnce();
    expect(externalRescheduleBooking).toHaveBeenCalledWith(
      't1',
      BOOKING_ID,
      '2026-06-15T12:00:00Z',
      60
    );
    expect(externalCancelBooking).not.toHaveBeenCalled();
  });

  it('reschedules with the new duration when the owner stretches the event', async () => {
    claim(cred);
    getEvent.mockResolvedValue(found('2026-06-15T08:00:00Z', '2026-06-15T10:00:00Z'));

    await syncExternalCalendarChanges();

    expect(externalRescheduleBooking).toHaveBeenCalledWith('t1', BOOKING_ID, '2026-06-15T08:00:00Z', 120);
  });

  it('cancels when the event is gone', async () => {
    claim(cred);
    getEvent.mockResolvedValue({ kind: 'not_found' });

    await syncExternalCalendarChanges();

    expect(externalCancelBooking).toHaveBeenCalledOnce();
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('cancels when the event is marked cancelled', async () => {
    claim(cred);
    getEvent.mockResolvedValue(found('2026-06-15T08:00:00Z', '2026-06-15T09:00:00Z', true));

    await syncExternalCalendarChanges();

    expect(externalCancelBooking).toHaveBeenCalledOnce();
  });

  it('does nothing when the times already match', async () => {
    claim(cred);
    getEvent.mockResolvedValue(found('2026-06-15T08:00:00Z', '2026-06-15T09:00:00Z'));

    await syncExternalCalendarChanges();

    expect(externalRescheduleBooking).not.toHaveBeenCalled();
    expect(externalCancelBooking).not.toHaveBeenCalled();
  });

  it('treats sub-second time drift as the same appointment', async () => {
    claim(cred);
    getEvent.mockResolvedValue(found('2026-06-15T08:00:00.500Z', '2026-06-15T09:00:00.123Z'));

    await syncExternalCalendarChanges();

    expect(externalRescheduleBooking).not.toHaveBeenCalled();
    expect(externalCancelBooking).not.toHaveBeenCalled();
  });

  it('claims one credential at a time', async () => {
    claim(cred);
    getEvent.mockResolvedValue(found('2026-06-15T08:00:00Z', '2026-06-15T09:00:00Z'));

    await syncExternalCalendarChanges();

    const claimSql = queryMock.mock.calls.map((c) => String(c[0])).find((s) => s.includes('FOR UPDATE SKIP LOCKED'));
    expect(claimSql).toContain('LIMIT 1');
    expect(claimSql).not.toContain('LIMIT 25');
  });

  it('aborts when the lease is no longer owned', async () => {
    let claimed = false;
    queryMock.mockImplementation(async (sql: string) => {
      const q = String(sql);
      if (q.includes('FOR UPDATE SKIP LOCKED')) {
        if (claimed) return [[], 0];
        claimed = true;
        return [[{ ...cred }], 1];
      }
      if (q.includes('$2::timestamptz')) return [[], 0];
      return [[], 0];
    });

    await syncExternalCalendarChanges();

    expect(listChanges).not.toHaveBeenCalled();
    expect(externalRescheduleBooking).not.toHaveBeenCalled();
    expect(cursorAdvanced()).toBe(false);
    expect(attemptsIncremented()).toBe(false);
  });

  it('restores an all-day event and mails the owner', async () => {
    claim(cred);
    getEvent.mockResolvedValue(found(null, null));

    await syncExternalCalendarChanges();

    expect(updateEvent).toHaveBeenCalledWith(
      'b1',
      'ev-1',
      {
        startISO: START.toISOString(),
        endISO: END.toISOString(),
        timezone: 'UTC',
      },
      'primary'
    );
    expect(sendCalendarChangeRejectedEmail).toHaveBeenCalledOnce();
    expect(externalRescheduleBooking).not.toHaveBeenCalled();
    expect(externalCancelBooking).not.toHaveBeenCalled();
  });

  it('restores when reschedule is refused as SLOT_UNAVAILABLE', async () => {
    claim(cred);
    getEvent.mockResolvedValue(found('2026-06-15T12:00:00Z', '2026-06-15T13:00:00Z'));
    externalRescheduleBooking.mockRejectedValue(
      new BookingError('Do not offer specific times', 'SLOT_UNAVAILABLE', 409)
    );

    await syncExternalCalendarChanges();

    expect(updateEvent).toHaveBeenCalledWith(
      'b1',
      'ev-1',
      {
        startISO: START.toISOString(),
        endISO: END.toISOString(),
        timezone: 'UTC',
      },
      'primary'
    );
    expect(sendCalendarChangeRejectedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'owner.reason_slot_unavailable',
      })
    );
  });

  it('holds the cursor when a candidate getEvent fails', async () => {
    claim(cred, [
      match,
      { external_event_id: 'ev-2', external_calendar_id: 'primary', booking_id: 'bk-2' },
    ]);
    listChanges.mockResolvedValue({ eventIds: ['ev-1', 'ev-2'], cursor: 'tok-2', bootstrapped: false });
    getEvent.mockRejectedValue(new Error('google 503'));

    await syncExternalCalendarChanges();

    expect(cursorAdvanced()).toBe(false);
    expect(attemptsIncremented()).toBe(true);
  });

  it('advances the cursor after MAX_ROUND_ATTEMPTS of a poisoned change', async () => {
    claim({ ...cred, inbound_attempts: 5 });
    getEvent.mockRejectedValue(new Error('google 503'));

    await syncExternalCalendarChanges();

    expect(cursorAdvanced()).toBe(true);
    expect(cursorParam()?.[2]).toBe('tok-2');
    expect(attemptsIncremented()).toBe(false);
  });

  it('persists a bootstrap cursor and applies nothing', async () => {
    claim(cred);
    listChanges.mockResolvedValue({ eventIds: ['ev-1'], cursor: 'tok-boot', bootstrapped: true });

    await syncExternalCalendarChanges();

    expect(cursorAdvanced()).toBe(true);
    expect(cursorParam()?.[2]).toBe('tok-boot');
    expect(getEvent).not.toHaveBeenCalled();
    expect(externalRescheduleBooking).not.toHaveBeenCalled();
    expect(externalCancelBooking).not.toHaveBeenCalled();
  });
});
