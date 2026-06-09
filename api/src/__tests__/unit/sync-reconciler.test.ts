/**
 * Unit tests for the Google-sync reconciliation worker (P0-4). DB + Google service
 * are mocked; asserts the claim → state-matrix → clear/terminal/backoff behavior.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryMock = vi.fn();
const refFind = vi.fn();
const refSave = vi.fn();
const etFindOne = vi.fn();
const ruleFindOne = vi.fn();
const loggerInfo = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    query: (...a: any[]) => queryMock(...a),
    getRepository: (entity: any) => {
      const name = entity?.name ?? entity;
      if (name === 'BookingReference') return { find: refFind, save: refSave, create: (x: any) => x };
      if (name === 'ServiceType') return { findOne: etFindOne };
      if (name === 'AvailabilityRule') return { findOne: ruleFindOne };
      return {};
    },
  },
}));
vi.mock('../../utils/logger', () => ({ logger: { info: (...a: any[]) => loggerInfo(...a), warn: vi.fn(), error: vi.fn() } }));

const createCalendarEvent = vi.fn();
const updateCalendarEvent = vi.fn();
const deleteCalendarEvent = vi.fn();
vi.mock('../../integrations/google/google-calendar.service', () => ({
  createCalendarEvent: (...a: any[]) => createCalendarEvent(...a),
  updateCalendarEvent: (...a: any[]) => updateCalendarEvent(...a),
  deleteCalendarEvent: (...a: any[]) => deleteCalendarEvent(...a),
}));

// The reconciler routes through the CalendarProvider port. Mock it to a Google
// adapter wired to the same google mocks (refs in these tests are google).
vi.mock('../../scheduler/calendar-provider', () => {
  const googleAdapter = {
    providerType: 'google',
    getBusy: vi.fn(),
    createEvent: (...a: any[]) => createCalendarEvent(...a),
    updateEvent: (...a: any[]) => updateCalendarEvent(...a),
    deleteEvent: (...a: any[]) => deleteCalendarEvent(...a),
    resolveIdentity: vi.fn(),
  };
  return {
    resolveCalendarProvider: async () => googleAdapter,
    providerFor: () => googleAdapter,
  };
});

import { reconcilePendingBookingSyncs } from '../../scheduler/sync-reconciler';

const BID = '11111111-2222-3333-4444-555555555555';
const EVID = '111111112222333344445555 55555555'.replace(/\s/g, ''); // hyphens stripped

function claim(row: Record<string, unknown>) {
  // First query() = the claim (FOR UPDATE SKIP LOCKED); rest = post-processing UPDATEs.
  // The optimistic clear (sync_pending=false ... RETURNING id) returns its row to
  // signal the guard matched; everything else returns [].
  queryMock.mockImplementation(async (sql: string) => {
    const q = String(sql);
    if (q.includes('FOR UPDATE SKIP LOCKED')) return [row];
    if (q.includes('sync_pending = false') && q.includes('RETURNING id')) return [{ id: row.id }];
    return [];
  });
}
function postUpdateSqls(): string[] {
  return queryMock.mock.calls.map((c) => String(c[0])).filter((s) => !s.includes('FOR UPDATE SKIP LOCKED'));
}
const cleared = () => postUpdateSqls().some((s) => s.includes('sync_last_error = null'));
const wentTerminal = () => postUpdateSqls().some((s) => s.includes('sync_last_error = $2') && !s.includes('sync_next_attempt_at'));
const scheduledRetry = () => postUpdateSqls().some((s) => s.includes('sync_next_attempt_at = now()'));

beforeEach(() => {
  vi.clearAllMocks();
  refFind.mockResolvedValue([]);
  etFindOne.mockResolvedValue({ name: 'Intro call' });
  ruleFindOne.mockResolvedValue({ timezone: 'UTC' });
});

const baseRow = { id: BID, bot_id: 'b1', start_utc: '2026-07-01T10:00:00Z', end_utc: '2026-07-01T10:30:00Z', event_type_id: null, sync_attempts: 0, updated_at: '2026-06-09 05:00:00+00' };

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
    refFind.mockResolvedValue([{ ...{ externalEventId: 'ev', externalCalendarId: 'team@grp', bookingId: BID }, providerType: 'google' }]);
    updateCalendarEvent.mockResolvedValue('ok');

    await reconcilePendingBookingSyncs();

    expect(updateCalendarEvent).toHaveBeenCalledWith('b1', 'ev', expect.any(Object), 'team@grp');
    expect(cleared()).toBe(true);
  });

  it('recreates the event when the existing one is gone (404)', async () => {
    claim({ ...baseRow, status: 'confirmed' });
    refFind.mockResolvedValue([{ ...{ externalEventId: 'ev', externalCalendarId: 'primary', bookingId: BID }, providerType: 'google' }]);
    updateCalendarEvent.mockResolvedValue('not_found');
    createCalendarEvent.mockResolvedValue({ eventId: EVID, calendarId: 'primary', meetUrl: null });

    await reconcilePendingBookingSyncs();

    expect(createCalendarEvent).toHaveBeenCalledWith('b1', expect.any(Object), { eventId: EVID, calendarId: 'primary' });
    expect(refSave).toHaveBeenCalled();
    expect(cleared()).toBe(true);
  });

  it('goes terminal when the account is inaccessible (403)', async () => {
    claim({ ...baseRow, status: 'confirmed' });
    refFind.mockResolvedValue([{ ...{ externalEventId: 'ev', externalCalendarId: 'primary', bookingId: BID }, providerType: 'google' }]);
    updateCalendarEvent.mockResolvedValue('no_access');

    await reconcilePendingBookingSyncs();

    expect(wentTerminal()).toBe(true);
    expect(cleared()).toBe(false);
  });

  it('deletes the mirrored event for a cancelled booking', async () => {
    claim({ ...baseRow, status: 'cancelled' });
    refFind.mockResolvedValue([{ ...{ externalEventId: 'ev', externalCalendarId: 'primary', bookingId: BID }, providerType: 'google' }]);
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

  it('resets sync_attempts to 0 on a successful sync (fresh budget for a later re-flag)', async () => {
    claim({ ...baseRow, status: 'confirmed', sync_attempts: 4 });
    createCalendarEvent.mockResolvedValue({ eventId: EVID, calendarId: 'primary', meetUrl: 'm' });
    await reconcilePendingBookingSyncs();
    expect(postUpdateSqls().some((s) => s.includes('sync_attempts = 0'))).toBe(true);
  });

  it('re-asserts the claim: does NOT clear sync_pending when the row changed since claim', async () => {
    // Claim a confirmed row, but make the optimistic clear match no row (a concurrent
    // reschedule bumped updated_at). The reconciler must leave sync_pending set.
    queryMock.mockImplementation(async (sql: string) => {
      const q = String(sql);
      if (q.includes('FOR UPDATE SKIP LOCKED')) return [{ ...baseRow, status: 'confirmed' }];
      return []; // clear RETURNING [] = guard didn't match
    });
    createCalendarEvent.mockResolvedValue({ eventId: EVID, calendarId: 'primary', meetUrl: 'm' });

    await reconcilePendingBookingSyncs();

    // clear was issued WITH the optimistic guard, and the skip path fired.
    expect(postUpdateSqls().some((s) => s.includes('updated_at::text = $2'))).toBe(true);
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('skipped clear'), expect.anything());
  });

  it('does nothing when no rows are claimed', async () => {
    queryMock.mockResolvedValue([]);
    await reconcilePendingBookingSyncs();
    expect(createCalendarEvent).not.toHaveBeenCalled();
    expect(updateCalendarEvent).not.toHaveBeenCalled();
  });
});
