/**
 * Unit tests for the Google-sync reconciliation worker (P0-4). DB + Google service
 * are mocked; asserts the claim → state-matrix → clear/terminal/backoff behavior.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryMock = vi.fn();
const refFindOne = vi.fn();
const refSave = vi.fn();
const etFindOne = vi.fn();
const ruleFindOne = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    query: (...a: any[]) => queryMock(...a),
    getRepository: (entity: any) => {
      const name = entity?.name ?? entity;
      if (name === 'BookingReference') return { findOne: refFindOne, save: refSave, create: (x: any) => x };
      if (name === 'ServiceType') return { findOne: etFindOne };
      if (name === 'AvailabilityRule') return { findOne: ruleFindOne };
      return {};
    },
  },
}));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const createCalendarEvent = vi.fn();
const updateCalendarEvent = vi.fn();
const deleteCalendarEvent = vi.fn();
vi.mock('../../integrations/google/google-calendar.service', () => ({
  createCalendarEvent: (...a: any[]) => createCalendarEvent(...a),
  updateCalendarEvent: (...a: any[]) => updateCalendarEvent(...a),
  deleteCalendarEvent: (...a: any[]) => deleteCalendarEvent(...a),
}));

import { reconcilePendingBookingSyncs } from '../../scheduler/sync-reconciler';

const BID = '11111111-2222-3333-4444-555555555555';
const EVID = '111111112222333344445555 55555555'.replace(/\s/g, ''); // hyphens stripped

function claim(row: Record<string, unknown>) {
  // First query() = the claim (FOR UPDATE SKIP LOCKED); rest = post-processing UPDATEs.
  queryMock.mockImplementation(async (sql: string) =>
    String(sql).includes('FOR UPDATE SKIP LOCKED') ? [row] : []
  );
}
function postUpdateSqls(): string[] {
  return queryMock.mock.calls.map((c) => String(c[0])).filter((s) => !s.includes('FOR UPDATE SKIP LOCKED'));
}
const cleared = () => postUpdateSqls().some((s) => s.includes('sync_last_error = null'));
const wentTerminal = () => postUpdateSqls().some((s) => s.includes('sync_last_error = $2') && !s.includes('sync_next_attempt_at'));
const scheduledRetry = () => postUpdateSqls().some((s) => s.includes('sync_next_attempt_at = now()'));

beforeEach(() => {
  vi.clearAllMocks();
  refFindOne.mockResolvedValue(null);
  etFindOne.mockResolvedValue({ name: 'Intro call' });
  ruleFindOne.mockResolvedValue({ timezone: 'UTC' });
});

const baseRow = { id: BID, bot_id: 'b1', start_utc: '2026-07-01T10:00:00Z', end_utc: '2026-07-01T10:30:00Z', event_type_id: null, sync_attempts: 0 };

describe('reconcilePendingBookingSyncs', () => {
  it('creates a Google event for a confirmed booking with no reference (deterministic id)', async () => {
    claim({ ...baseRow, status: 'confirmed' });
    createCalendarEvent.mockResolvedValue({ eventId: EVID, calendarId: 'primary', meetUrl: 'm' });

    await reconcilePendingBookingSyncs();

    expect(createCalendarEvent).toHaveBeenCalledWith('b1', expect.objectContaining({ summary: 'Intro call', timezone: 'UTC' }), { eventId: EVID });
    expect(refSave).toHaveBeenCalled();
    expect(cleared()).toBe(true);
  });

  it('updates the event on its real calendar when a reference exists', async () => {
    claim({ ...baseRow, status: 'confirmed' });
    refFindOne.mockResolvedValue({ externalEventId: 'ev', externalCalendarId: 'team@grp', bookingId: BID });
    updateCalendarEvent.mockResolvedValue('ok');

    await reconcilePendingBookingSyncs();

    expect(updateCalendarEvent).toHaveBeenCalledWith('b1', 'ev', expect.any(Object), 'team@grp');
    expect(cleared()).toBe(true);
  });

  it('recreates the event when the existing one is gone (404)', async () => {
    claim({ ...baseRow, status: 'confirmed' });
    refFindOne.mockResolvedValue({ externalEventId: 'ev', externalCalendarId: 'primary', bookingId: BID });
    updateCalendarEvent.mockResolvedValue('not_found');
    createCalendarEvent.mockResolvedValue({ eventId: EVID, calendarId: 'primary', meetUrl: null });

    await reconcilePendingBookingSyncs();

    expect(createCalendarEvent).toHaveBeenCalledWith('b1', expect.any(Object), { eventId: EVID, calendarId: 'primary' });
    expect(refSave).toHaveBeenCalled();
    expect(cleared()).toBe(true);
  });

  it('goes terminal when the account is inaccessible (403)', async () => {
    claim({ ...baseRow, status: 'confirmed' });
    refFindOne.mockResolvedValue({ externalEventId: 'ev', externalCalendarId: 'primary', bookingId: BID });
    updateCalendarEvent.mockResolvedValue('no_access');

    await reconcilePendingBookingSyncs();

    expect(wentTerminal()).toBe(true);
    expect(cleared()).toBe(false);
  });

  it('deletes the mirrored event for a cancelled booking', async () => {
    claim({ ...baseRow, status: 'cancelled' });
    refFindOne.mockResolvedValue({ externalEventId: 'ev', externalCalendarId: 'primary', bookingId: BID });
    deleteCalendarEvent.mockResolvedValue('ok');

    await reconcilePendingBookingSyncs();

    expect(deleteCalendarEvent).toHaveBeenCalledWith('b1', 'ev', 'primary');
    expect(cleared()).toBe(true);
  });

  it('just clears a pending (not-yet-confirmed) row without touching Google', async () => {
    claim({ ...baseRow, status: 'pending' });
    await reconcilePendingBookingSyncs();
    expect(createCalendarEvent).not.toHaveBeenCalled();
    expect(cleared()).toBe(true);
  });

  it('goes terminal when event type / availability rule is missing', async () => {
    claim({ ...baseRow, status: 'confirmed' });
    etFindOne.mockResolvedValue(null);
    await reconcilePendingBookingSyncs();
    expect(wentTerminal()).toBe(true);
    expect(createCalendarEvent).not.toHaveBeenCalled();
  });

  it('schedules a backoff retry when the Google call throws', async () => {
    claim({ ...baseRow, status: 'confirmed' });
    createCalendarEvent.mockRejectedValue(new Error('google 503'));
    await reconcilePendingBookingSyncs();
    expect(scheduledRetry()).toBe(true);
  });

  it('does nothing when no rows are claimed', async () => {
    queryMock.mockResolvedValue([]);
    await reconcilePendingBookingSyncs();
    expect(createCalendarEvent).not.toHaveBeenCalled();
    expect(updateCalendarEvent).not.toHaveBeenCalled();
  });
});
