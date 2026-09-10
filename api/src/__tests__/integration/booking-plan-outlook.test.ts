/**
 * [OUT-01] The Outlook path, through the provider-agnostic booking code.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PROVES, AND WHAT IT DOES NOT — read this before trusting the case.
 *
 * This file exercises the PROVIDER-AGNOSTIC booking path with a MICROSOFT-TYPED
 * `CalendarProvider` double. It does **NOT** call Microsoft Graph, and no HTTP request of any
 * kind leaves the process.
 *
 * What that leaves unproven, stated plainly so nobody reads more coverage into this file than it
 * has:
 *
 *  1. Nothing here proves `outlook-events.service.ts` / `outlook-calendar.service.ts` speak Graph
 *     correctly — the request shape, the `/me/calendar/getSchedule` payload, the OData filters,
 *     the delta-link handling, the token refresh. Those are axios-mocked in
 *     `unit/outlook-events-service.test.ts` and `unit/outlook-calendar-service.test.ts`, and they
 *     stay the only cover for the wire format.
 *  2. Nothing here proves Graph's own semantics: how Outlook reports an all-day event, a
 *     tentative block, a recurring series expansion, or a busy interval in a foreign timezone. A
 *     real Graph response that differs from `BusyInterval[]` in any of those ways would pass this
 *     file and still break a live Outlook tenant.
 *  3. Nothing here proves the real `microsoftProvider` object in
 *     `scheduler/calendar-provider.ts:99-109` is wired to the right functions. The mock replaces
 *     `resolveCalendarProvider`, so a mis-wired adapter table is invisible from here.
 *     `unit/calendar-provider.test.ts` is where that belongs.
 *
 * What it DOES prove, and what nothing in the suite proved before: the booking write path and the
 * availability path are genuinely provider-agnostic. Every existing "busy blocks a booking" test
 * is Google-sourced, so a Microsoft-typed adapter had never once driven a booking end to end. A
 * `providerType`-conditional branch anywhere between `InternalProvider.createBooking` and
 * `syncCalendarCreate` would be invisible to the rest of the suite and is caught here.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Why a LOCAL double rather than the harness's `PLAN_CALENDAR`: `CalendarProvider.providerType`
 * is `readonly` (`scheduler/calendar-provider.ts:61`) and `PLAN_CALENDAR.adapter` fixes it to
 * `'google'`. The harness must not be modified — another slice depends on it byte for byte — so
 * this file builds its own Microsoft-typed adapter. It is typed as the REAL port, not cast, so it
 * cannot drift from the interface `calendar-sync.ts` writes through.
 *
 * Why the mock is narrow: only `resolveCalendarProvider`, `providerFor` and the entitlement gate
 * are replaced. `loadActiveCredential` runs for real, so the DB credential row is still the
 * decider — the double is handed out only when the bot has an active `provider: 'microsoft'`
 * credential, and a bot with no credential still resolves to `null` and takes the
 * `CALENDAR_NOT_CONNECTED` downgrade. `hasHealthyCalendarConnection` (the auto-confirm gate,
 * `internal.provider.ts:351`) is left entirely real and reads that same Microsoft row.
 *
 * Fixtures are PER TEST: `src/__tests__/setup.ts` truncates in an `afterEach`.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  CalendarEventInput,
  CalendarProvider,
  CreateEventOpts,
} from '../../scheduler/calendar-provider';

interface OutlookCreateRecord {
  botId: string;
  input: CalendarEventInput;
  opts: CreateEventOpts;
  eventId: string;
}

interface OutlookDouble {
  busy: Array<{ start: Date; end: Date }>;
  creates: OutlookCreateRecord[];
  updates: Array<{ botId: string; eventId: string }>;
  deletes: Array<{ botId: string; eventId: string }>;
  busyCalls: Array<{ botId: string; startISO: string; endISO: string; timezone?: string }>;
  /** Mirrors that still exist, keyed by the id Microsoft minted. */
  live: Map<string, CalendarEventInput>;
  reset(): void;
  adapter: CalendarProvider;
}

/**
 * The Microsoft-typed double. Built inside `vi.hoisted` because a `vi.mock` factory is hoisted
 * above this file's imports, so a top-level binding would be uninitialised when the factory ran.
 * The type-only imports above are erased at compile time, so they are safe to use in here.
 */
const OUTLOOK = vi.hoisted((): OutlookDouble => {
  let seq = 0;
  const double: OutlookDouble = {
    busy: [],
    creates: [],
    updates: [],
    deletes: [],
    busyCalls: [],
    live: new Map(),
    reset() {
      double.busy = [];
      double.creates = [];
      double.updates = [];
      double.deletes = [];
      double.busyCalls = [];
      double.live.clear();
      seq = 0;
    },
    adapter: null as never,
  };

  // Typed as the real port so a change to `CalendarProvider` stops this file compiling rather
  // than letting the double drift away from what production writes through.
  const adapter: CalendarProvider = {
    // The whole point of the case. Everything else in the suite is 'google'.
    providerType: 'microsoft',
    async getBusy(botId, startISO, endISO, timezone) {
      double.busyCalls.push({ botId, startISO, endISO, timezone });
      // Answer only what overlaps the asked-for window, the way Graph's getSchedule does. A
      // double that returned every seeded interval regardless of the window would hide a caller
      // that asked for the wrong range.
      const from = new Date(startISO).getTime();
      const to = new Date(endISO).getTime();
      return double.busy.filter((iv) => iv.start.getTime() < to && iv.end.getTime() > from);
    },
    async createEvent(botId, input, opts = {}) {
      // Microsoft mints its own id; unlike Google it does not accept a client-supplied one, so
      // the double deliberately IGNORES `opts.eventId`. A booking path that assumed the Google
      // id round-trip is caught by the `BookingReference` assertion below.
      const eventId = `AAMkAD-outlook-${++seq}`;
      double.creates.push({ botId, input, opts, eventId });
      double.live.set(eventId, input);
      return {
        eventId,
        // A Microsoft work/school account hosts Teams; the double answers the caller's flag
        // rather than always returning a link, so "no link on a phone booking" stays assertable.
        meetUrl: input.conferencing ? 'https://teams.microsoft.com/l/meetup-join/qa-outlook' : null,
        calendarId: opts.calendarId ?? 'primary',
      };
    },
    async updateEvent(botId, eventId, patch) {
      double.updates.push({ botId, eventId });
      const existing = double.live.get(eventId);
      if (existing) double.live.set(eventId, { ...existing, ...patch });
      return { status: 'ok', meetUrl: null };
    },
    async deleteEvent(botId, eventId) {
      double.deletes.push({ botId, eventId });
      double.live.delete(eventId);
      return 'ok';
    },
    async resolveIdentity(botId) {
      return `mscal:${botId}`;
    },
    async getEvent(_botId, eventId) {
      const found = double.live.get(eventId);
      if (!found) return { kind: 'not_found' };
      return { kind: 'found', startISO: found.startISO, endISO: found.endISO, cancelled: false };
    },
    async listChanges() {
      return { eventIds: [], cursor: 'ms-delta-qa', bootstrapped: true };
    },
  };
  double.adapter = adapter;
  return double;
});

vi.mock('../../scheduler/calendar-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scheduler/calendar-provider')>();
  return {
    ...actual,
    /**
     * The real resolver minus the Graph adapter. `loadActiveCredential` is the ACTUAL function,
     * so the DB row still decides: no credential ⇒ null ⇒ the request / `CALENDAR_NOT_CONNECTED`
     * downgrade, exactly as in production. Only the 'microsoft' branch is doubled, so a fixture
     * that accidentally seeded a Google credential fails loudly instead of quietly proving the
     * Google path all over again.
     */
    resolveCalendarProvider: async (botId: string) => {
      const cred = await actual.loadActiveCredential(botId);
      if (!cred) return null;
      if (cred.provider !== 'microsoft') {
        throw new Error(`[OUT-01] expected a microsoft credential, got '${cred.provider}'`);
      }
      return OUTLOOK.adapter;
    },
    providerFor: (provider: 'google' | 'microsoft') => {
      if (provider !== 'microsoft') {
        throw new Error(`[OUT-01] expected a microsoft provider, got '${provider}'`);
      }
      return OUTLOOK.adapter;
    },
    // Entitlement resolution needs a billing fixture this case is not about. The gate itself is
    // covered elsewhere; here it must simply not be the reason a booking downgrades.
    isCalendarSyncAllowed: async () => true,
  };
});

vi.mock('../../automations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../automations')>()),
  getEmailService: () => ({ send: vi.fn().mockResolvedValue({ success: true, messageId: 'qa' }) }),
  initializeAutomations: vi.fn(),
}));

import { DateTime } from 'luxon';
import { AppDataSource } from '../../database/data-source';
import { CalendarCredential } from '../../database/entities/CalendarCredential';
import { BookingReference } from '../../database/entities/BookingReference';
import { InternalProvider } from '../../booking/booking-providers/internal.provider';
import type { Bot } from '../../database/entities/Bot';
import {
  createPlanBusiness,
  createPlanService,
  setPlanAvailability,
  planSession,
  planBookingContext,
  planLocalTime,
  localInstant,
  localSpan,
  bookingCount,
  requestCount,
  soleConfirmedBooking,
  PLAN_TZ,
  PLAN_CUSTOMER_EMAIL,
} from '../helpers/booking-plan-harness';

/**
 * A connected OUTLOOK calendar. The harness's `seedPlanCalendarCredential` hardcodes
 * `provider: 'google'` and must not be modified, so this case seeds its own row. `accountId` is
 * set because `resolveStoredCalendarIdentity` derives the Microsoft conflict key from it
 * (`scheduler/calendar-provider.ts:148-154`); without it the bot falls back to a bot-scoped key
 * and this file would exercise the fallback rather than the Microsoft path.
 */
async function seedOutlookCredential(bot: Bot): Promise<CalendarCredential> {
  const repo = AppDataSource.getRepository(CalendarCredential);
  return repo.save(
    repo.create({
      tenantId: bot.tenantId,
      botId: bot.id,
      provider: 'microsoft',
      status: 'active',
      accountEmail: `owner+${bot.id.slice(0, 6)}@outlook.test`,
      accountId: `ms-account-${bot.id.slice(0, 8)}`,
      accessTokenEnc: 'enc:test',
      refreshTokenEnc: 'enc:test',
      calendarId: 'primary',
      tokenExpiry: new Date(Date.now() + 3_600_000),
    }),
  );
}

/** The local clock a recorded calendar write starts at — the owner's own Outlook view of it. */
function calendarLocalHHMM(iso: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(PLAN_TZ).toFormat('HH:mm');
}

/** An external Outlook busy interval, in the port's shape. */
function outlookBusy(localStart: string, minutes: number): { start: Date; end: Date } {
  const start = localInstant(localStart);
  return { start, end: new Date(start.getTime() + minutes * 60_000) };
}

describe('booking plan · Outlook', () => {
  beforeEach(() => {
    // The double is module state and outlives the DB truncation `setup.ts` does in `afterEach`.
    OUTLOOK.reset();
  });

  describe('[OUT-01] the provider-agnostic path with a Microsoft-typed adapter', () => {
    it('[OUT-01] mirrors a confirmed booking through the microsoft adapter', async () => {
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await seedOutlookCredential(bot);
      const service = await createPlanService(bot);
      const session = await planSession(bot);

      const day = planLocalTime(40, '10:00');
      const result = await new InternalProvider().createBooking(
        planBookingContext(tenant, bot, session),
        `idem-outlook-${randomUUID()}`,
        localInstant(day).toISOString(),
        { name: 'QA Outlook', email: PLAN_CUSTOMER_EMAIL },
        undefined,
        service.id,
      );

      // An Outlook tenant must AUTO-CONFIRM, not downgrade to a Request. This is the regression
      // `hasHealthyCalendarConnection`'s own comment (`calendar-provider.ts:191-192`) names: a
      // Google-only readiness gate regressed every Outlook tenant to request mode, and until now
      // no test drove that gate with a Microsoft credential.
      expect(result.success).toBe(true);
      expect(result.requested).toBeFalsy();
      expect(await bookingCount(service.id, 'confirmed')).toBe(1);
      expect(await requestCount(service.id)).toBe(0);

      // The mirror WAS written, through this adapter — one create, for this bot, at the
      // customer's local time.
      expect(OUTLOOK.creates).toHaveLength(1);
      const [write] = OUTLOOK.creates;
      expect(write.botId).toBe(bot.id);
      expect(calendarLocalHHMM(write.input.startISO)).toBe('10:00');
      expect(calendarLocalHHMM(write.input.endISO)).toBe('10:30');
      expect(write.input.timezone).toBe(PLAN_TZ);

      // …and the durable proof, which is what makes this more than a spy count.
      // `syncCalendarCreate` stamps the ref with `provider.providerType` (`calendar-sync.ts:94`)
      // and with the id the provider actually minted (`:95`). So this row can only read
      // 'microsoft' if a Microsoft-typed adapter served the write.
      //
      // WHY THIS CANNOT PASS FOR THE WRONG REASON — verified by breaking it, not assumed. Two
      // independent breakages were run against this file and then reverted:
      //
      //   * the double's `providerType` set to 'google' ⇒ fails here with
      //     `expected 'google' to be 'microsoft'`;
      //   * `createEvent` changed to echo `opts.eventId` (the Google client-supplied-id
      //     behaviour, which Microsoft does not have) ⇒ fails on the last line below with
      //     `expected 'c3f0…' not to be 'c3f0…'`.
      //
      // So the row genuinely records WHICH adapter served the write, and the id genuinely comes
      // from the provider rather than from Axentrio's own request.
      const booking = await soleConfirmedBooking(service.id);
      const refs = await AppDataSource.getRepository(BookingReference).find({
        where: { bookingId: booking.id },
      });
      expect(refs).toHaveLength(1);
      expect(refs[0].providerType).toBe('microsoft');
      expect(refs[0].externalEventId).toBe(write.eventId);
      expect(refs[0].externalEventId).not.toBe(write.opts.eventId);

      // The row and the invite agree on the wall clock the customer was given.
      const span = localSpan(booking);
      expect(span.start).toBe('10:00');
      expect(span.end).toBe('10:30');
      expect(span.date).toBe(day.slice(0, 10));

      // Availability really consulted the Outlook adapter on the way in. A path that skipped
      // `getBusy` for a non-Google provider would leave this empty while everything above still
      // passed.
      expect(OUTLOOK.busyCalls.length).toBeGreaterThan(0);
      expect(OUTLOOK.busyCalls.every((c) => c.botId === bot.id)).toBe(true);
      expect(OUTLOOK.busyCalls.some((c) => c.timezone === PLAN_TZ)).toBe(true);
    });

    it('[OUT-01] refuses a slot an Outlook busy interval covers, and writes nothing', async () => {
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await seedOutlookCredential(bot);
      const service = await createPlanService(bot);
      const session = await planSession(bot);
      const provider = new InternalProvider();
      const ctx = planBookingContext(tenant, bot, session);

      const day = planLocalTime(41, '10:00');
      const freeSlot = `${day.slice(0, 10)}T14:00`;

      // An external event nobody at Axentrio created. Busy must be busy whoever wrote it.
      OUTLOOK.busy.push(outlookBusy(day, 30));

      await expect(
        provider.createBooking(
          ctx,
          `idem-outlook-busy-${randomUUID()}`,
          localInstant(day).toISOString(),
          { name: 'QA Outlook Busy', email: PLAN_CUSTOMER_EMAIL },
          undefined,
          service.id,
        ),
      ).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });

      // No double booking, by SQL — not by "a writer was not called". And no Request captured as
      // a consolation prize, which would be a different bug wearing the same green tick.
      expect(await bookingCount(service.id)).toBe(0);
      expect(await requestCount(service.id)).toBe(0);
      expect(OUTLOOK.creates).toHaveLength(0);

      // WHY THIS CANNOT PASS FOR THE WRONG REASON. A refusal test is satisfied by a broken
      // fixture: a service that cannot be booked at all, a date outside the availability rule, a
      // mis-mocked provider. Two guards. First, removing the `OUTLOOK.busy.push` above was run
      // and reverted: the call then RESOLVES with `{ success: true }` and the `rejects`
      // assertion fails, so the refusal is caused by the Outlook busy interval and by nothing
      // else. Second, the SAME fixture on the SAME day books a slot the busy interval does not
      // cover, so fixture damage cannot masquerade as a conflict.
      const control = await provider.createBooking(
        ctx,
        `idem-outlook-free-${randomUUID()}`,
        localInstant(freeSlot).toISOString(),
        { name: 'QA Outlook Free', email: PLAN_CUSTOMER_EMAIL },
        undefined,
        service.id,
      );
      expect(control.success).toBe(true);
      expect(control.requested).toBeFalsy();
      expect(await bookingCount(service.id, 'confirmed')).toBe(1);
      expect(OUTLOOK.creates).toHaveLength(1);
      expect(calendarLocalHHMM(OUTLOOK.creates[0].input.startISO)).toBe('14:00');

      // The one confirmed booking is the 14:00 one, so the 10:00 attempt left nothing behind.
      const booked = await soleConfirmedBooking(service.id);
      expect(localSpan(booked).start).toBe('14:00');
    });
  });
});
