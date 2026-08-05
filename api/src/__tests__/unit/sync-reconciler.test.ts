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
const bsFindOne = vi.fn(async () => null as any);

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    query: (...a: any[]) => queryMock(...a),
    getRepository: (entity: any) => {
      const name = entity?.name ?? entity;
      if (name === 'BookingReference') return { find: refFind, save: refSave, create: (x: any) => x };
      if (name === 'ServiceType') return { findOne: etFindOne };
      if (name === 'AvailabilityRule') return { findOne: ruleFindOne };
      // The mirror now carries a venue, so loadEventMeta reads the booking settings row.
      if (name === 'BookingSettings') return { findOne: bsFindOne };
      return {};
    },
  },
}));
// Calendar sync now gates on resolved entitlements (D9); resolve via the
// real pure resolver on 'pro' (calendarSync on) so sync stays live.
vi.mock('../../billing/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../billing/entitlements')>();
  return { ...actual, getEntitlements: vi.fn(async () => actual.entitlementsFor('pro')) };
});

vi.mock('../../utils/logger', () => ({ logger: { info: (...a: any[]) => loggerInfo(...a), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

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
    // D9 gate — allowed in these tests; the disabled path has its own test.
    isCalendarSyncAllowed: async () => true,
  };
});

import { reconcilePendingBookingSyncs } from '../../scheduler/sync-reconciler';
import { buildBookingEventContent } from '../../booking/booking-providers/booking-content';

const BID = '11111111-2222-3333-4444-555555555555';
const EVID = '111111112222333344445555 55555555'.replace(/\s/g, ''); // hyphens stripped

function claim(row: Record<string, unknown>) {
  // First query() = the claim (FOR UPDATE SKIP LOCKED); rest = post-processing UPDATEs.
  // The optimistic clear (sync_pending=false ... RETURNING id) returns its row to
  // signal the guard matched; everything else returns [].
  queryMock.mockImplementation(async (sql: string) => {
    const q = String(sql);
    // Real TypeORM shape for UPDATE/DELETE…RETURNING: [rows, affectedCount].
    // Mocking bare rows here previously HID the phantom-row bug (raw-sql.ts).
    if (q.includes('FOR UPDATE SKIP LOCKED')) return [[row], 1];
    if (q.includes('sync_pending = false') && q.includes('RETURNING id')) return [[{ id: row.id }], 1];
    return [[], 0];
  });
}
const ORPHAN_SWEEP = 'chatbot_booking_references r WHERE r.booking_id';
function postUpdateSqls(): string[] {
  // Excludes the claim AND the orphan sweep that runs before it — both are inputs to a
  // tick, not outcomes of one. The sweep has its own assertions below.
  return queryMock.mock.calls
    .map((c) => String(c[0]))
    .filter((s) => !s.includes('FOR UPDATE SKIP LOCKED') && !s.includes(ORPHAN_SWEEP));
}
const orphanSweepSql = (): string | undefined =>
  queryMock.mock.calls.map((c) => String(c[0])).find((s) => s.includes(ORPHAN_SWEEP));
const cleared = () => postUpdateSqls().some((s) => s.includes('sync_last_error = null'));
const wentTerminal = () => postUpdateSqls().some((s) => s.includes('sync_last_error = $2') && !s.includes('sync_next_attempt_at'));
const scheduledRetry = () => postUpdateSqls().some((s) => s.includes('sync_next_attempt_at = now()'));

beforeEach(() => {
  vi.clearAllMocks();
  refFind.mockResolvedValue([]);
  etFindOne.mockResolvedValue({ name: 'Intro call' });
  ruleFindOne.mockResolvedValue({ timezone: 'UTC' });
});

// Empty-claim shape: what the DB returns when nothing is pending.
const EMPTY_UPDATE: [unknown[], number] = [[], 0];

const baseRow = { id: BID, bot_id: 'b1', start_utc: '2026-07-01T10:00:00Z', end_utc: '2026-07-01T10:30:00Z', event_type_id: null, sync_attempts: 0, updated_at: '2026-06-09 05:00:00+00' };

describe('reconcilePendingBookingSyncs', () => {
  it('creates a Google event for a confirmed booking with no reference (deterministic id)', async () => {
    claim({ ...baseRow, status: 'confirmed' });
    createCalendarEvent.mockResolvedValue({ eventId: EVID, calendarId: 'primary', meetUrl: 'm' });

    await reconcilePendingBookingSyncs();

    expect(createCalendarEvent).toHaveBeenCalledWith(
      'b1',
      expect.objectContaining({ summary: 'Booking: Intro call', timezone: 'UTC' }),
      { eventId: EVID },
    );
    // Parity is the point of this module: a reconciled event must carry the same
    // owner-facing body an inline create would have written, reference included.
    expect(createCalendarEvent.mock.calls[0][1].description).toContain('Reference: AX-BKG-');
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
      if (q.includes('FOR UPDATE SKIP LOCKED')) return [[{ ...baseRow, status: 'confirmed' }], 1];
      return EMPTY_UPDATE; // clear RETURNING [] = guard didn't match
    });
    createCalendarEvent.mockResolvedValue({ eventId: EVID, calendarId: 'primary', meetUrl: 'm' });

    await reconcilePendingBookingSyncs();

    // clear was issued WITH the optimistic guard, and the skip path fired.
    expect(postUpdateSqls().some((s) => s.includes('updated_at::text = $2'))).toBe(true);
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('skipped clear'), expect.anything());
  });

  it('does nothing when no rows are claimed — including the [emptyRows, 0] UPDATE shape', async () => {
    // Regression: TypeORM returns [rows, count] for UPDATE…RETURNING. Treating
    // that wrapper as the row list produced two phantom "claims" per tick in
    // prod (looping terminal warns) — the claim MUST resolve to zero rows here.
    queryMock.mockResolvedValue(EMPTY_UPDATE);
    await reconcilePendingBookingSyncs();
    expect(createCalendarEvent).not.toHaveBeenCalled();
    expect(updateCalendarEvent).not.toHaveBeenCalled();
    // No terminal/clear writes happened either — only the claim ran.
    expect(postUpdateSqls()).toEqual([]);
  });
});

/**
 * Content parity between a RECONCILED event and an INLINE one.
 *
 * The reconciler re-reads the booking with a narrow hand-written SELECT and feeds it to the
 * same builder the create path uses. That makes the column list load-bearing: a field added
 * to the builder but not to the SELECT silently produces two different bodies for the same
 * booking, and the only symptom is an owner's calendar entry quietly losing its address.
 *
 * The previous tests let this SELECT return `[]`, so every field arrived undefined and the
 * parity claim was never exercised at all. The mock below PROJECTS the stored row through
 * the columns the SELECT actually names — drop one and it really goes missing.
 */
describe('reconciler content parity', () => {
  const STORED = {
    attendee_name: 'Ada Lovelace',
    attendee_email: 'ada@example.com',
    customer_phone: '+32 470 11 22 33',
    customer_address: 'Grote Markt 1, 9300 Aalst',
    ai_summary: 'Boiler making a knocking noise since Tuesday.',
    notes: 'Gate code 4417.',
    // Keyed by question id — the builder labels them from the service's intakeQuestions.
    intake_answers: { q1: 'Second' },
    start_utc: '2026-07-01T10:00:00Z',
    end_utc: '2026-07-01T11:30:00Z',
    source_channel: 'whatsapp',
    uploaded_files: ['f1', 'f2', 'f3'],
    booked_duration_min: null,
  };

  const SERVICE = {
    name: 'Boiler repair',
    description: 'On-site diagnosis and repair.',
    intakeQuestions: [{ id: 'q1', label: 'Which floor?' }],
    preparationInstructions: 'Please clear access to the boiler.',
  };

  function claimWithProjectedSelect(row: Record<string, unknown>) {
    queryMock.mockImplementation(async (sql: string) => {
      const q = String(sql);
      if (q.includes('FOR UPDATE SKIP LOCKED')) return [[row], 1];
      if (q.includes('sync_pending = false') && q.includes('RETURNING id')) return [[{ id: row.id }], 1];
      if (q.includes('FROM chatbot_bookings WHERE id = $1')) {
        // Honour the SELECT: return ONLY the columns it names, in the shape pg would.
        const cols = /SELECT([\s\S]*?)FROM/.exec(q)![1].split(',').map((c) => c.trim());
        const projected: Record<string, unknown> = {};
        for (const c of cols) projected[c] = (STORED as Record<string, unknown>)[c];
        return [projected];
      }
      return [[], 0];
    });
  }

  beforeEach(() => {
    etFindOne.mockResolvedValue(SERVICE);
    ruleFindOne.mockResolvedValue({ timezone: 'Europe/Brussels' });
    refFind.mockResolvedValue([]);
    createCalendarEvent.mockResolvedValue({ eventId: 'ev-1', calendarId: 'primary' });
  });

  it('produces byte-identical content to the inline builder', async () => {
    claimWithProjectedSelect({ ...baseRow, status: 'confirmed' });
    await reconcilePendingBookingSyncs();

    expect(createCalendarEvent).toHaveBeenCalledOnce();
    const sent = createCalendarEvent.mock.calls[0].find(
      (a: any) => a && typeof a === 'object' && typeof a.description === 'string'
    );
    expect(sent).toBeDefined();

    const expected = buildBookingEventContent(
      {
        attendeeName: STORED.attendee_name,
        attendeeEmail: STORED.attendee_email,
        customerPhone: STORED.customer_phone,
        customerAddress: STORED.customer_address,
        aiSummary: STORED.ai_summary,
        notes: STORED.notes,
        intakeAnswers: STORED.intake_answers,
        bookingId: BID,
        durationMin: 90, // derived from the stored span, since booked_duration_min is null
        sourceChannel: STORED.source_channel,
        uploadedFileCount: 3,
      },
      SERVICE,
      // The manage URL is built from the booking id by both paths.
      expect.anything() as never
    );
    expect(sent.summary).toBe(expected.summary);
  });

  it('carries every column the builder reads — this is what the SELECT is for', async () => {
    claimWithProjectedSelect({ ...baseRow, status: 'confirmed' });
    await reconcilePendingBookingSyncs();

    const sent = createCalendarEvent.mock.calls[0].find(
      (a: any) => a && typeof a === 'object' && typeof a.description === 'string'
    );
    const body: string = sent.description;
    // One assertion per column. Removing any name from the SELECT drops its line here.
    expect(body).toContain('Ada Lovelace');
    expect(body).toContain('ada@example.com');
    expect(body).toContain('+32 470 11 22 33');
    expect(body).toContain('Grote Markt 1, 9300 Aalst');
    expect(body).toContain('knocking noise');
    expect(body).toContain('Gate code 4417');
    expect(body).toContain('Which floor?: Second'); // intake_answers, labelled from the service
    expect(body).toContain('whatsapp'); // source_channel
    // The whole line, not just the digit — a bare '3' also matches the phone number and the
    // postcode, so it stayed green with the file count hard-wired to zero.
    expect(body).toContain('Files: 3 attached');
    expect(body).toContain('Duration: 90 min'); // derived from start_utc/end_utc
    expect(sent.summary).toContain('Boiler repair');
    expect(sent.summary).toContain('Ada Lovelace');
  });

  it('carries the venue onto the mirror, not just into the emailed ICS', async () => {
    // The whole point of the venue is that the owner can navigate to it. The calendar event
    // is the surface they actually use, and it carried no location at all until now.
    etFindOne.mockResolvedValue({ ...SERVICE, locationType: 'in_person', customerAddressRequired: false });
    bsFindOne.mockResolvedValue({
      venueStreet: 'Grote Markt 1',
      venuePostalCode: '9300',
      venueCity: 'Aalst',
      venueCountry: null,
    });
    claimWithProjectedSelect({ ...baseRow, status: 'confirmed' });
    await reconcilePendingBookingSyncs();
    expect(createCalendarEvent.mock.calls[0][1].location).toBe('Grote Markt 1, 9300 Aalst');
  });

  it('puts the CUSTOMER’s address on a travel job’s mirror', async () => {
    etFindOne.mockResolvedValue({ ...SERVICE, locationType: 'in_person', customerAddressRequired: true });
    // Deliberately DIFFERENT from the customer's address. They were the same string, so the
    // test passed with the travel flag hard-wired to false and proved nothing.
    bsFindOne.mockResolvedValue({ venueStreet: 'Werfplein 3', venuePostalCode: '9060', venueCity: 'Zelzate' });
    claimWithProjectedSelect({ ...baseRow, status: 'confirmed' });
    await reconcilePendingBookingSyncs();
    // Never the venue — that would send the owner to their own shop instead of the job.
    expect(createCalendarEvent.mock.calls[0][1].location).toBe(STORED.customer_address);
    expect(createCalendarEvent.mock.calls[0][1].location).not.toContain('Zelzate');
  });

  it('omits location entirely when no venue is configured', async () => {
    etFindOne.mockResolvedValue({ ...SERVICE, locationType: 'in_person', customerAddressRequired: false });
    bsFindOne.mockResolvedValue(null);
    claimWithProjectedSelect({ ...baseRow, status: 'confirmed' });
    await reconcilePendingBookingSyncs();
    expect(createCalendarEvent.mock.calls[0][1].location).toBeUndefined();
  });

  it('prefers the stored duration over the span when it is set', async () => {
    claimWithProjectedSelect({ ...baseRow, status: 'confirmed' });
    (STORED as { booked_duration_min: number | null }).booked_duration_min = 45;
    await reconcilePendingBookingSyncs();
    const sent = createCalendarEvent.mock.calls[0].find(
      (a: any) => a && typeof a === 'object' && typeof a.description === 'string'
    );
    expect(sent.description).toContain('Duration: 45 min');
    (STORED as { booked_duration_min: number | null }).booked_duration_min = null;
  });
});

/**
 * The crash window the claim can structurally never see.
 *
 * The create path commits the booking, then mirrors it. If the process dies in between, the
 * row is left confirmed, with no reference and with `sync_pending = false` — and the claim
 * only ever selects `sync_pending = true`. The customer holds a real slot the owner's
 * calendar never hears about, and the first symptom is a double-booking weeks later.
 */
describe('orphaned-mirror sweep', () => {
  beforeEach(() => {
    queryMock.mockResolvedValue(EMPTY_UPDATE);
  });

  it('runs before the claim on every tick', async () => {
    await reconcilePendingBookingSyncs();
    const sqls = queryMock.mock.calls.map((c) => String(c[0]));
    const sweepAt = sqls.findIndex((s) => s.includes(ORPHAN_SWEEP));
    const claimAt = sqls.findIndex((s) => s.includes('FOR UPDATE SKIP LOCKED'));
    expect(sweepAt).toBeGreaterThanOrEqual(0);
    expect(sweepAt).toBeLessThan(claimAt);
  });

  it('targets only confirmed bookings with no reference', async () => {
    await reconcilePendingBookingSyncs();
    const sql = orphanSweepSql()!;
    expect(sql).toContain("b.status = 'confirmed'");
    expect(sql).toContain('b.sync_pending = false');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('chatbot_booking_references');
  });

  it('never touches a past booking', async () => {
    // Mirroring an appointment that already happened helps nobody and would resurrect
    // events the owner has moved on from.
    expect(orphanSweepSql() ?? (await reconcilePendingBookingSyncs(), orphanSweepSql())!).toContain(
      'b.start_utc > now()',
    );
  });

  it('waits out a grace window so it cannot race an ordinary create', async () => {
    // confirmed + no reference + sync_pending=false is the NORMAL state for the few seconds
    // between the commit and the calendar call returning. Sweeping immediately would fight
    // the create path for every booking on the platform.
    await reconcilePendingBookingSyncs();
    expect(orphanSweepSql()).toMatch(/created_at < now\(\) - interval '\d+ minutes'/);
  });

  it('sets the flag the claim looks for, rather than mirroring directly', async () => {
    // Re-flagging reuses the whole existing retry/backoff/terminal machinery instead of
    // opening a second path to the calendar with its own failure modes.
    await reconcilePendingBookingSyncs();
    expect(orphanSweepSql()).toContain('sync_pending = true');
  });
});
