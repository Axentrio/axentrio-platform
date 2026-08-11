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
/** No settings row = no business rules, which is every pre-existing test's world. */
const bookingSettingsFindOne = vi.fn(async () => null as any);
// The transaction manager is a real EntityManager in production — the provider reads
// booking settings through it so the read shares the transaction's connection.
const transaction = vi.fn(async (cb: any) => cb({ query: managerQuery, getRepository: (e: any) => repoFor(e) }));

/** One resolver, shared by AppDataSource, its .manager and the transaction manager. */
function repoFor(entity: any) {
  const name = entity?.name || entity;
  if (name === 'ServiceType') return { findOne: eventTypeFindOne };
  if (name === 'AvailabilityRule') return { findOne: ruleFindOne };
  if (name === 'Booking') return { findOne: bookingFindOne, find: bookingFind, query: bookingQuery };
  if (name === 'BookingLog') return { create: logCreate, save: logSave };
  if (name === 'BookingReference') return { find: bookingRefFind, save: vi.fn(), create: (x: any) => x };
  if (name === 'ChatSession') return { findOne: chatSessionFindOne };
  if (name === 'BookingSettings') return { findOne: bookingSettingsFindOne };
  return {};
}

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn((entity: any) => repoFor(entity)),
    manager: { getRepository: (entity: any) => repoFor(entity) },
    transaction: (cb: any) => transaction(cb),
  },
}));

// Calendar sync now gates on resolved entitlements (D9); resolve via the
// real pure resolver on 'pro' (calendarSync on) so sync stays live.
vi.mock('../../billing/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../billing/entitlements')>();
  return { ...actual, getEntitlements: vi.fn(async () => actual.entitlementsFor('pro')) };
});

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sendBookingEmail = vi.fn();
vi.mock('../../booking/booking-providers/booking-email', () => ({
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
// Exposed (rather than inlined in the factory) so a test can drive the not_found RECREATE
// branch and read the event payload it builds — the branch that silently rebuilt the mirror
// without its location or conferencing.
const providerCreateEvent = vi.fn();
const providerUpdateEvent = vi.fn();
vi.mock('../../scheduler/calendar-provider', () => {
  const adapter = {
    providerType: 'google',
    getBusy: (...a: any[]) => providerGetBusy(...a),
    createEvent: (...a: any[]) => providerCreateEvent(...a),
    updateEvent: (...a: any[]) => providerUpdateEvent(...a),
    deleteEvent: vi.fn().mockResolvedValue('ok'),
    resolveIdentity: vi.fn().mockResolvedValue(null),
  };
  return {
    resolveCalendarProvider: async () => adapter,
    providerFor: () => adapter,
    // D9 additions: sync allowed; stored identity null (bot-scoped keys).
    isCalendarSyncAllowed: async () => true,
    resolveStoredCalendarIdentity: async () => ({ identity: null, providerType: 'google' }),
  };
});

// Travel time: the gates and the arithmetic are settled elsewhere. What matters here is what
// the RESCHEDULE path does with a verdict, so only the verdict and the diary are injected.
// A reschedule places an EXISTING row, by its durable identity — never by re-reading the
// address the customer typed, which can resolve somewhere else once the coordinates have
// aged out (ADR-0014). `placeAddressFor` is left REAL so that a regression to it would have
// to reach a geocoder that is not mocked here, and fail loudly.
const placeExistingBooking = vi.fn(async (..._a: unknown[]) => ({ applies: false }) as any);
vi.mock('../../booking/travel/booking-place', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../booking/travel/booking-place')>();
  return { ...actual, placeExistingBooking: (...a: unknown[]) => placeExistingBooking(...a) };
});
const resolveTravelEligibility = vi.fn(async (..._a: unknown[]) => ({ active: false as const, reason: 'no_api_key' as const }));
vi.mock('../../booking/travel/travel-eligibility', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../booking/travel/travel-eligibility')>();
  return { ...actual, resolveTravelEligibility: (...a: unknown[]) => resolveTravelEligibility(...a) };
});
const loadTravelNeighbours = vi.fn(async (..._a: unknown[]) => ({ neighbours: [] as unknown[], venue: null as unknown }));
const loadStoredNeighbours = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
vi.mock('../../booking/travel/travel-neighbours', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../booking/travel/travel-neighbours')>();
  return {
    ...actual,
    loadTravelNeighbours: (...a: unknown[]) => loadTravelNeighbours(...a),
    loadStoredNeighbours: (...a: unknown[]) => loadStoredNeighbours(...a),
  };
});

// Routing. The client itself is settled in travel-routes.test.ts; here only its ANSWER
// matters. Unavailable by default, which is both the state of a platform with no Maps key and
// ADR-0015's degraded branch — so every test that does not opt in is exercising the fallback.
const driveAnswer = vi.fn(
  async (..._a: unknown[]): Promise<{ minutes: number | null; cause?: string }> => ({ minutes: null })
);
vi.mock('../../booking/travel/routes.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../booking/travel/routes.service')>();
  return { ...actual, driveLookupFor: () => (leg: unknown) => driveAnswer(leg) };
});

import { InternalProvider } from '../../booking/booking-providers/internal.provider';

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

/**
 * A reschedule is a booking being made again — same job, different neighbours — so it earns the
 * same travel check. Without it the gate is a front door with the side door left open.
 */
describe('InternalProvider.rescheduleBooking — travel', () => {
  let provider: InternalProvider;
  const MOBILE = { ...EVENT_TYPE, customerAddressRequired: true };
  const PLACE = { placeId: 'ChIJ_p', lat: 51.05, lng: 3.72, precision: 'rooftop' as const, formattedAddress: 'Kerkstraat 12, 9000 Gent, Belgium' };
  const ACTIVE = { active: true as const, tenantId: 'ten-1', itineraryKey: 'bot:bot-1', slackMin: 0, startFromBase: false, maxDetourMin: null, baseDepartOffsetMin: 0, groupingPeriod: 'none' as const };
  const neighbour = (start: string, end: string, point: { lat: number; lng: number }) => ({
    blockedStart: new Date(start), blockedEnd: new Date(end), location: { kind: 'known', point },
  });
  const updateSql = () =>
    (managerQuery.mock.calls.find((c: any) => String(c[0]).includes('UPDATE chatbot_bookings')) ?? []) as [string, unknown[]];

  beforeEach(() => {
    vi.clearAllMocks();
    bookingSettingsFindOne.mockResolvedValue(null as any);
    resolveTravelEligibility.mockResolvedValue(ACTIVE as any);
    placeExistingBooking.mockResolvedValue({ applies: true, outcome: 'placed', place: PLACE });
    loadTravelNeighbours.mockResolvedValue({ neighbours: [], venue: null });
    loadStoredNeighbours.mockResolvedValue([]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-05T00:00:00Z'));
    provider = new InternalProvider();
    eventTypeFindOne.mockResolvedValue(MOBILE);
    ruleFindOne.mockResolvedValue(RULE);
    bookingFindOne.mockResolvedValue({ ...confirmedBooking(), customerAddress: 'Kerkstraat 12, 9000 Gent' });
    bookingRefFind.mockResolvedValue([]);
    chatSessionFindOne.mockResolvedValue(null);
    providerGetBusy.mockResolvedValue(null);
    providerUpdateEvent.mockResolvedValue('no_connection');
    bookingQuery.mockImplementation(async (sql: string) => (sql.includes('lower(blocked_range)') ? [] : []));
    managerQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('UPDATE chatbot_bookings')) return [{ sequence: 1 }];
      return [];
    });
  });
  afterEach(() => vi.useRealTimers());

  it('refuses a move the owner provably cannot reach', async () => {
    // Liège, ten minutes before the new 08:00 start.
    loadTravelNeighbours.mockResolvedValue({
      venue: null,
      neighbours: [neighbour('2026-06-10T07:00:00Z', '2026-06-10T07:50:00Z', { lat: 50.6326, lng: 5.5797 })],
    });
    await expect(provider.rescheduleBooking(ctx, 'bk-1', NEW_START)).rejects.toMatchObject({
      code: 'TRAVEL_TIME_CONFLICT',
    });
    expect(managerQuery).not.toHaveBeenCalled();
  });

  it('places the ROW, by identity — the customer is not asked again for a job that has not moved', async () => {
    // And not by the typed address either. A booking rescheduled more than thirty days after
    // it was made has had its coordinates swept, so this is the ordinary path at a 60-day
    // horizon — and re-geocoding the same words months later can silently move the job.
    await provider.rescheduleBooking(ctx, 'bk-1', NEW_START);
    expect(placeExistingBooking).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bk-1', customerAddress: 'Kerkstraat 12, 9000 Gent' }),
      ACTIVE
    );
  });

  it('re-asserts under the lock, so a neighbour that lands mid-confirm still refuses', async () => {
    loadStoredNeighbours.mockResolvedValue([
      neighbour('2026-06-10T07:00:00Z', '2026-06-10T07:50:00Z', { lat: 50.6326, lng: 5.5797 }),
    ]);
    await expect(provider.rescheduleBooking(ctx, 'bk-1', NEW_START)).rejects.toMatchObject({
      code: 'TRAVEL_TIME_CONFLICT',
    });
  });

  it('stamps `ok` when routing answered every constraining leg of the new time', async () => {
    // A real neighbour far enough away that the floor cannot settle it, so the leg genuinely
    // goes to routing. Five minutes fits — clear AND routed, the only combination earning `ok`.
    const far = [neighbour('2026-06-10T06:00:00Z', '2026-06-10T06:30:00Z', { lat: 50.8503, lng: 4.3517 })];
    loadTravelNeighbours.mockResolvedValue({ neighbours: far, venue: null });
    loadStoredNeighbours.mockResolvedValue(far);
    driveAnswer.mockResolvedValue({ minutes: 5 });
    await provider.rescheduleBooking(ctx, 'bk-1', NEW_START);
    const [sql, params] = updateSql();
    expect(sql).toContain('travel_check=');
    expect(params).toContain('ok');
  });

  it('stamps `degraded` when the proofs cleared a leg routing never answered', async () => {
    // The mixed-leg rule from the other side: a neighbour close enough that the floor settles
    // it on its own. Nothing was unavailable, but nothing was VERIFIED AGAINST ROUTING either,
    // and `CONTEXT.md` reserves `ok` for the second. Routing is never even called.
    const near = [neighbour('2026-06-10T06:00:00Z', '2026-06-10T06:30:00Z', { lat: 51.0505, lng: 3.7205 })];
    loadTravelNeighbours.mockResolvedValue({ neighbours: near, venue: null });
    loadStoredNeighbours.mockResolvedValue(near);
    await provider.rescheduleBooking(ctx, 'bk-1', NEW_START);
    const [sql, params] = updateSql();
    expect(sql).toContain('travel_check=');
    expect(params).toContain('degraded');
    expect(driveAnswer).not.toHaveBeenCalled();
  });

  it('REWRITES travel_check, because the move invalidates whatever the old time was checked against', async () => {
    // An empty diary writes NULL, not `ok` and not `degraded`. Nothing was measured and
    // nothing was unavailable, which is exactly what NULL already means on this column —
    // `ok` would claim a routing answer nobody sought, and `degraded` would put a permanent
    // stream of rows into the signal #68 has to watch for outages. What must never happen is
    // the column being left describing the journey to the OLD time.
    await provider.rescheduleBooking(ctx, 'bk-1', NEW_START);
    const [sql, params] = updateSql();
    expect(sql).toContain('travel_check=');
    expect(params).toContain(null);
    expect(params).not.toContain('ok');
  });

  it('warns the OWNER rather than blocking them — their diary, their judgement', async () => {
    // ADR-0015: feasibility is a hard constraint against the bot, never against the person who
    // owns the diary. The portal picker already marks the risky rows.
    loadTravelNeighbours.mockResolvedValue({
      venue: null,
      neighbours: [neighbour('2026-06-10T07:00:00Z', '2026-06-10T07:50:00Z', { lat: 50.6326, lng: 5.5797 })],
    });
    await expect(
      provider.rescheduleBooking({ ...ctx, isAdmin: true, travelPolicy: 'annotate' } as never, 'bk-1', NEW_START)
    ).resolves.toMatchObject({ success: true });
    expect(updateSql()[1]).toContain('overridden');
  });

  it('leaves a service nobody drives to completely alone', async () => {
    // "Alone" means NOTHING IS SPENT and NOTHING IS STAMPED: no address is placed, so no Google
    // element is bought, and `travel_check` stays null.
    //
    // It does NOT mean the eligibility row goes unread. Since #76 that cheap read also answers
    // "is start-from-base on for this diary", because moving an at-premises job can expose a
    // first job just as surely as moving a mobile one — see the exposure test below. Asserting
    // the read never happens would lock in the bug that made a workshop move assert nothing.
    eventTypeFindOne.mockResolvedValue(EVENT_TYPE);
    await expect(provider.rescheduleBooking(ctx, 'bk-1', NEW_START)).resolves.toMatchObject({ success: true });
    expect(placeExistingBooking).not.toHaveBeenCalled();
    expect(updateSql()[1]).toContain(null);
  });
});

describe('InternalProvider reschedule / cancel / list', () => {
  let provider: InternalProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps implementations; re-pin "no business rules" so one test's
    // mockResolvedValue cannot silently gate the next.
    bookingSettingsFindOne.mockResolvedValue(null as any);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-05T00:00:00Z'));
    provider = new InternalProvider();
    eventTypeFindOne.mockResolvedValue(EVENT_TYPE);
    ruleFindOne.mockResolvedValue(RULE);
    bookingFindOne.mockResolvedValue(confirmedBooking());
    bookingRefFind.mockResolvedValue([]); // no calendar ref by default
    chatSessionFindOne.mockResolvedValue(null); // owning session not found by default
    providerGetBusy.mockResolvedValue(null); // no external busy by default
    providerCreateEvent.mockResolvedValue(null);
    providerUpdateEvent.mockResolvedValue('no_connection');
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
    // #6: reschedule result carries the business-local pre-formatted time. 08:00 UTC
    // = 10:00 in Europe/Brussels — the AI quotes displayTime, never the UTC drift.
    expect(res.timezone).toBe('Europe/Brussels');
    expect(res.booking.displayTime).toContain('10:00');
    expect(res.booking.displayTime).not.toContain('8:00');
    expect(sendBookingEmail).toHaveBeenCalledOnce();
    expect(sendBookingEmail.mock.calls[0][0]).toMatchObject({ method: 'REQUEST', sequence: 1, uid: 'uid-1@axentrio' });
    expect(logSave).toHaveBeenCalledOnce();
  });

  it('moves calendar_key with the booking, so the row lands on the diary it was validated against', async () => {
    // The gap #60 recorded and left. Everything above the UPDATE resolves the itinerary key
    // FRESHLY — the advisory lock takes it, loadAllBusy filters on it, the capacity gap scopes
    // to it — because the owner may have connected or switched a calendar since the booking was
    // made. The UPDATE then left the row on its OLD key, so a reschedule after a calendar change
    // validated against one diary and wrote into another, and the row went invisible to every
    // later query scoped by the key: its own next reschedule, the Minimum Gap check, and the
    // travel gate's neighbour scan. It still blocked its range through the exclusion constraint,
    // which is why this never looked like a double-booking — it looked like a gap that was not
    // enforced, against a job nobody could see.
    await provider.rescheduleBooking(ctx, 'bk-1', NEW_START);
    const update = managerQuery.mock.calls.find((c: any) =>
      String(c[0]).includes('UPDATE chatbot_bookings')
    ) as [string, unknown[]];
    expect(update[0]).toContain('calendar_key=');
    // The value written is the same key the lock was taken on, not whatever the row carried.
    const lock = managerQuery.mock.calls.find((c: any) =>
      String(c[0]).includes('pg_advisory_xact_lock')
    ) as [string, unknown[]];
    expect(update[1]).toContain(lock[1][0]);
  });

  it('reschedule invite keeps the meeting join link (location + description)', async () => {
    bookingRefFind.mockResolvedValue([
      { bookingId: 'bk-1', providerType: 'google', meetingUrl: 'https://meet.google.com/abc-defg-hij', createdAt: new Date('2026-06-01T00:00:00Z') },
    ]);
    await provider.rescheduleBooking(ctx, 'bk-1', NEW_START);
    expect(sendBookingEmail.mock.calls[0][0]).toMatchObject({
      method: 'REQUEST',
      location: 'https://meet.google.com/abc-defg-hij',
    });
    // The join link now rides inside a fuller customer-facing body rather than BEING the
    // whole body — it used to be the only thing a customer's calendar entry ever said, and
    // an in-person booking therefore said nothing at all.
    expect(sendBookingEmail.mock.calls[0][0].description)
      .toContain('Join the meeting: https://meet.google.com/abc-defg-hij');
    expect(sendBookingEmail.mock.calls[0][0].description).toContain('Reschedule or cancel:');
  });

  describe('the mirror was deleted in the calendar (not_found → recreate)', () => {
    // A recreate builds the event from nothing, and it SUCCEEDS — so markSyncPending never
    // fires and the reconciler, which claims sync_pending rows only, never revisits it.
    // Anything left out here is gone permanently, and the stored meetingUrl is overwritten
    // with whatever comes back. That is what made the loss compound: the nulled URL then
    // blanked the join link on every later reschedule and in the portal's booking list.
    beforeEach(() => {
      bookingRefFind.mockResolvedValue([
        {
          bookingId: 'bk-1',
          providerType: 'google',
          externalEventId: 'ev-old',
          externalCalendarId: 'cal-1',
          meetingUrl: 'https://meet.google.com/abc-defg-hij',
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
      ]);
      providerUpdateEvent.mockResolvedValue('not_found');
      providerCreateEvent.mockResolvedValue({
        eventId: 'ev-new',
        calendarId: 'cal-1',
        meetUrl: 'https://meet.google.com/new-link',
      });
    });

    it('rebuilds a video booking WITH conferencing, so a fresh join link is minted', async () => {
      eventTypeFindOne.mockResolvedValue({ ...EVENT_TYPE, locationType: 'google_meet' });

      await provider.rescheduleBooking(ctx, 'bk-1', NEW_START);

      expect(providerCreateEvent).toHaveBeenCalledOnce();
      expect(providerCreateEvent.mock.calls[0][1]).toMatchObject({ conferencing: true });
    });

    it('rebuilds an in-person booking WITH the venue on it', async () => {
      eventTypeFindOne.mockResolvedValue({ ...EVENT_TYPE, locationType: 'in_person' });
      bookingSettingsFindOne.mockResolvedValue({
        venueStreet: 'Grote Markt 1',
        venuePostalCode: '9300',
        venueCity: 'Aalst',
        venueCountry: 'BE',
      } as any);

      await provider.rescheduleBooking(ctx, 'bk-1', NEW_START);

      expect(providerCreateEvent.mock.calls[0][1]).toMatchObject({
        location: 'Grote Markt 1, 9300 Aalst, BE',
      });
      // Not a video service — minting a conference would also steal the LOCATION field.
      expect(providerCreateEvent.mock.calls[0][1].conferencing).toBeUndefined();
    });

    it('still carries the full body, not just a bare title', async () => {
      eventTypeFindOne.mockResolvedValue({ ...EVENT_TYPE, locationType: 'in_person' });
      await provider.rescheduleBooking(ctx, 'bk-1', NEW_START);
      const input = providerCreateEvent.mock.calls[0][1];
      expect(input.summary).toBeTruthy();
      expect(input.description).toContain('Ada');
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

  /**
   * `acceptRequest` makes TWO differently-shaped reads now: the request itself, and a probe for
   * a live appointment the same customer already holds for the same service (#72). This file's
   * repository double answers every `findOne` identically, so without telling them apart the
   * probe finds the request itself and every accept below refuses as a duplicate.
   *
   * The probe is the one asking for a CONFIRMED booking ending in the future.
   */
  const answerAccept = (row: unknown, duplicate: unknown = null) =>
    bookingFindOne.mockImplementation(async (opts: any) =>
      opts?.where?.status === 'confirmed' && opts?.where?.endUtc ? duplicate : row
    );

  it('acceptRequest confirms a request → calendar + email + log, returns success', async () => {
    answerAccept(requestBooking());
    const res = await provider.acceptRequest(ctx, 'bk-1');
    expect(res.success).toBe(true);
    expect(res.booking.startTime).toBe('2026-06-10T07:00:00.000Z');
    expect(sendBookingEmail).toHaveBeenCalledOnce();
    expect(sendBookingEmail.mock.calls[0][0]).toMatchObject({ method: 'REQUEST' });
    expect(logSave).toHaveBeenCalled(); // created log
    // the confirm UPDATE flipped status under the lock
    expect(managerQuery.mock.calls.some((c) => String(c[0]).includes("status='confirmed'"))).toBe(true);
  });

  it('acceptRequest refuses when the customer already holds this appointment (#72)', async () => {
    // The unit-level half of the duplicate guard. The integration file drives it through the
    // route; this one proves the provider itself refuses, and that the refusal carries what the
    // owner needs to move the existing appointment instead of hunting for it.
    answerAccept(requestBooking(), { ...confirmedBooking(), id: 'bk-existing', bookedDurationMin: 45 });
    await expect(provider.acceptRequest(ctx, 'bk-1')).rejects.toMatchObject({
      code: 'REQUEST_WOULD_DUPLICATE',
      details: { existingBookingId: 'bk-existing', existingDurationMin: 45, suggestion: 'reschedule' },
    });
    // Nothing was written: the guard runs before the confirm UPDATE, not after it.
    expect(managerQuery.mock.calls.some((c) => String(c[0]).includes("status='confirmed'"))).toBe(false);
  });

  it('acceptRequest confirms it anyway when the owner allows the duplicate', async () => {
    answerAccept(requestBooking(), { ...confirmedBooking(), id: 'bk-existing' });
    const res = await provider.acceptRequest(ctx, 'bk-1', { allowDuplicate: true });
    expect(res.success).toBe(true);
  });

  it('acceptRequest SKIPS the travel gate — the owner is not blocked by it', async () => {
    // ADR-0015: a Request the travel gate captured would otherwise be refused by the same gate
    // that captured it, and the owner could never clear it. The feature would have built a
    // queue with no exit. Feasibility is a hard constraint against the BOT, never against the
    // person who owns the diary.
    answerAccept(requestBooking());
    await provider.acceptRequest(ctx, 'bk-1');
    expect(loadStoredNeighbours).not.toHaveBeenCalled();
  });

  it('acceptRequest records the override FROM THE ROW, not from today s settings', async () => {
    // The condition is the row's own travel_check = 'captured', evaluated by Postgres in the
    // same statement that confirms. Between capture and acceptance a tenant can lose the
    // entitlement or an owner can flip the toggle, and in every one of those the owner is still
    // overriding a job travel captured — so live eligibility must not decide it.
    answerAccept(requestBooking());
    resolveTravelEligibility.mockResolvedValue({ active: false, reason: 'not_entitled' } as any);
    await provider.acceptRequest(ctx, 'bk-1');
    const update = managerQuery.mock.calls.find((c: any) =>
      String(c[0]).includes('UPDATE chatbot_bookings')
    ) as [string, unknown[]];
    expect(update[0]).toContain("travel_check = CASE WHEN travel_check = 'captured' THEN 'overridden'");
    // And it leaves anything else alone rather than stamping every accepted request.
    expect(update[0]).toContain('ELSE travel_check END');
  });

  it('acceptRequest SUCCEEDS on a job travel captured, with travel fully active', async () => {
    // THE INVARIANT, stated as behaviour rather than as the absence of a call.
    //
    // Travel feasibility is a hard constraint against the ASSISTANT and never against the person
    // who owns the diary. A Request the gate captured as unreachable would otherwise be refused by
    // the same gate that captured it, and the owner could never clear it - the feature would have
    // built a queue with no exit.
    //
    // Deliberately NOT written as "no travel assert is called at line N". That version fails the
    // first honest refactor while permitting a rewrite that reintroduces the refusal somewhere
    // else. What must stay true is that the owner can accept; how that is achieved is free to
    // change.
    resolveTravelEligibility.mockResolvedValue({
      active: true,
      tenantId: 'ten-1',
      itineraryKey: 'bot:1',
      slackMin: 0,
      startFromBase: false,
      baseDepartOffsetMin: 0,
      maxDetourMin: null,
      groupingPeriod: 'none',
    } as any);
    answerAccept(requestBooking());

    await expect(provider.acceptRequest(ctx, 'bk-1')).resolves.toBeDefined();

    // And it really confirmed, rather than resolving to some softer outcome.
    const update = managerQuery.mock.calls.find((c: any) =>
      String(c[0]).includes('UPDATE chatbot_bookings')
    ) as [string, unknown[]];
    expect(update[0]).toContain("status='confirmed'");
  });

  it('acceptRequest rejects a non-request (confirmed) booking', async () => {
    bookingFindOne.mockResolvedValue(confirmedBooking());
    await expect(provider.acceptRequest(ctx, 'bk-1')).rejects.toMatchObject({ code: 'NOT_A_REQUEST' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('acceptRequest rejects a request whose time is in the past', async () => {
    answerAccept(requestBooking({ startUtc: new Date('2026-06-04T07:00:00Z'), endUtc: new Date('2026-06-04T07:30:00Z') }));
    await expect(provider.acceptRequest(ctx, 'bk-1')).rejects.toMatchObject({ code: 'REQUEST_EXPIRED' });
  });

  it('acceptRequest rejects when the requested time is no longer offered', async () => {
    answerAccept(requestBooking({ startUtc: new Date('2026-06-10T08:05:00Z'), endUtc: new Date('2026-06-10T08:35:00Z') }));
    await expect(provider.acceptRequest(ctx, 'bk-1')).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('acceptRequest → REQUEST_ALREADY_HANDLED when the conditional update matches no row', async () => {
    answerAccept(requestBooking());
    managerQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('UPDATE chatbot_bookings')) return []; // already handled / raced
      return [];
    });
    await expect(provider.acceptRequest(ctx, 'bk-1')).rejects.toMatchObject({ code: 'REQUEST_ALREADY_HANDLED' });
    expect(sendBookingEmail).not.toHaveBeenCalled();
  });

  it('acceptRequest maps an exclusion violation (23P01) to SLOT_UNAVAILABLE', async () => {
    answerAccept(requestBooking());
    managerQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('UPDATE chatbot_bookings')) throw Object.assign(new Error('excl'), { code: '23P01' });
      return [];
    });
    await expect(provider.acceptRequest(ctx, 'bk-1')).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
  });

  it('declineRequest closes a request (cancelled + log, no email/calendar)', async () => {
    answerAccept(requestBooking());
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
    answerAccept(requestBooking({ status: 'cancelled' }));
    const res = await provider.declineRequest(ctx, 'bk-1');
    expect(res).toEqual({ success: true, cancelled: true });
    expect(logSave).not.toHaveBeenCalled();
  });
});

/**
 * Start from base (#76): a move is a REMOVAL too.
 *
 * Rescheduling the day's first job does not merely place it somewhere new — it EXPOSES the next
 * booking as that day's new first, carrying a premises leg nobody has ever checked. Asserting
 * only the moved booking at its new position would let a customer move themselves out of a
 * morning and strand a confirmed appointment, with every check having passed.
 */
describe('InternalProvider.rescheduleBooking — what the move exposed', () => {
  let provider: InternalProvider;
  const MOBILE = { ...EVENT_TYPE, customerAddressRequired: true };
  const PLACE = { placeId: 'ChIJ_p', lat: 51.05, lng: 3.72, precision: 'rooftop' as const, formattedAddress: 'Kerkstraat 12, 9000 Gent, Belgium' };
  const BASED = { active: true as const, tenantId: 'ten-1', itineraryKey: 'bot:bot-1', slackMin: 0, startFromBase: true, maxDetourMin: null, baseDepartOffsetMin: 0, groupingPeriod: 'none' as const };
  const GENT = { lat: 51.05, lng: 3.72 };
  const LIEGE = { lat: 50.6326, lng: 5.5797 };
  const VENUE = { kind: 'known' as const, point: GENT };

  const held = (id: string, start: string, end: string, point: { lat: number; lng: number }) => ({
    bookingId: id,
    blockedStart: new Date(start),
    blockedEnd: new Date(end),
    location: { kind: 'known' as const, point },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    bookingSettingsFindOne.mockResolvedValue(null as any);
    resolveTravelEligibility.mockResolvedValue(BASED as any);
    placeExistingBooking.mockResolvedValue({ applies: true, outcome: 'placed', place: PLACE });
    loadTravelNeighbours.mockResolvedValue({ neighbours: [], venue: VENUE });
    loadStoredNeighbours.mockResolvedValue([]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-05T00:00:00Z'));
    provider = new InternalProvider();
    eventTypeFindOne.mockResolvedValue(MOBILE);
    ruleFindOne.mockResolvedValue(RULE);
    bookingFindOne.mockResolvedValue({ ...confirmedBooking(), customerAddress: 'Kerkstraat 12, 9000 Gent' });
    bookingRefFind.mockResolvedValue([]);
    chatSessionFindOne.mockResolvedValue(null);
  });
  afterEach(() => vi.useRealTimers());

  it('refuses a move that strands the booking left behind it', async () => {
    // The exposed job is in Liège; the premises are in Gent, ~87 km away, and the day opens at
    // 09:00 Brussels with that job starting 09:30. Nobody makes that drive in thirty minutes.
    // The moved booking (bk-1) is projected OUT, which is what makes the Liège job first.
    loadStoredNeighbours.mockResolvedValue([held('bk-2', '2026-06-10T07:30:00Z', '2026-06-10T08:00:00Z', LIEGE)]);
    loadTravelNeighbours.mockResolvedValue({
      neighbours: [held('bk-2', '2026-06-10T07:30:00Z', '2026-06-10T08:00:00Z', LIEGE)],
      venue: VENUE,
    });

    await expect(provider.rescheduleBooking(ctx, 'bk-1', NEW_START)).rejects.toMatchObject({
      code: 'TRAVEL_TIME_CONFLICT',
    });
  });

  it('lets the OWNER make the same move, and does not throw', async () => {
    // Feasibility is a hard constraint against the bot and a customer's manage link, never
    // against the person who owns the diary. Their picker warns instead.
    loadStoredNeighbours.mockResolvedValue([held('bk-2', '2026-06-10T07:30:00Z', '2026-06-10T08:00:00Z', LIEGE)]);
    loadTravelNeighbours.mockResolvedValue({
      neighbours: [held('bk-2', '2026-06-10T07:30:00Z', '2026-06-10T08:00:00Z', LIEGE)],
      venue: VENUE,
    });

    await expect(
      provider.rescheduleBooking({ ...ctx, isAdmin: true, travelPolicy: 'annotate' } as never, 'bk-1', NEW_START)
    ).resolves.toBeTruthy();
  });

  it('does not assert exposure at all when start-from-base is OFF', async () => {
    // "With the setting off, behaviour is byte-identical" is an acceptance criterion. With no
    // base leg there is nothing a newly-exposed first job acquires, and every other constraint
    // on it was validated when it was made.
    //
    // Asserted structurally rather than by outcome: a hostile diary would refuse through the
    // ORDINARY gate too, which would let this pass while proving nothing about exposure.
    resolveTravelEligibility.mockResolvedValue({ ...BASED, startFromBase: false } as any);
    await provider.rescheduleBooking(ctx, 'bk-1', NEW_START);
    // Once, for the in-lock re-assert of the moved booking itself. No second read.
    expect(loadStoredNeighbours).toHaveBeenCalledTimes(1);
  });

  it('DOES read the exposed day when start-from-base is on', async () => {
    // The mirror of the test above — otherwise a mechanism that never ran would satisfy it.
    await provider.rescheduleBooking(ctx, 'bk-1', NEW_START);
    expect(loadStoredNeighbours.mock.calls.length).toBeGreaterThan(1);
  });

  it('asserts exposure even for an AT-PREMISES move, which has no travel snapshot of its own', async () => {
    // The moved booking is a workshop job: `customerAddressRequired` false, so it is never
    // travel-checked itself and produces no snapshot. It is still a constraining neighbour, and
    // removing it exposes whatever sat behind it. Gating exposure on the MOVED booking's own
    // eligibility meant this asserted nothing at all.
    eventTypeFindOne.mockResolvedValue(EVENT_TYPE);
    loadStoredNeighbours.mockResolvedValue([held('bk-2', '2026-06-10T07:30:00Z', '2026-06-10T08:00:00Z', LIEGE)]);
    loadTravelNeighbours.mockResolvedValue({
      neighbours: [held('bk-2', '2026-06-10T07:30:00Z', '2026-06-10T08:00:00Z', LIEGE)],
      venue: VENUE,
    });

    await expect(provider.rescheduleBooking(ctx, 'bk-1', NEW_START)).rejects.toMatchObject({
      code: 'TRAVEL_TIME_CONFLICT',
    });
  });

  it('restamps the EXPOSED booking and warns, when the owner proceeds anyway', async () => {
    // The exposed row was not written to, but its journey changed. Left saying `ok` it would
    // claim a verification that no longer covers the leg it now has.
    loadStoredNeighbours.mockResolvedValue([held('bk-2', '2026-06-10T07:30:00Z', '2026-06-10T08:00:00Z', LIEGE)]);
    loadTravelNeighbours.mockResolvedValue({
      neighbours: [held('bk-2', '2026-06-10T07:30:00Z', '2026-06-10T08:00:00Z', LIEGE)],
      venue: VENUE,
    });

    const result = await provider.rescheduleBooking(
      { ...ctx, isAdmin: true, travelPolicy: 'annotate' } as never,
      'bk-1',
      NEW_START
    );
    expect(result.travelWarning).toMatch(/business address/i);
    const restamp = managerQuery.mock.calls.find((c: any) => String(c[0]).includes("travel_check='overridden'"));
    expect(restamp?.[1]).toContain('bk-2');
  });

  it('takes both itinerary locks in sorted order when the move crosses diaries', async () => {
    // A reschedule rewrites `calendar_key`, so a move can lift a booking off one itinerary onto
    // another. Sorted, so two concurrent moves in opposite directions cannot deadlock.
    bookingFindOne.mockResolvedValue({
      ...confirmedBooking(),
      customerAddress: 'Kerkstraat 12, 9000 Gent',
      calendarKey: 'zzz:old-diary',
    });
    await provider.rescheduleBooking(ctx, 'bk-1', NEW_START).catch(() => undefined);

    const locks = managerQuery.mock.calls
      .filter((c: any) => String(c[0]).includes('pg_advisory_xact_lock'))
      .map((c: any) => c[1][0]);
    expect(locks.length).toBeGreaterThan(1);
    expect(locks).toEqual([...locks].sort());
  });
});
