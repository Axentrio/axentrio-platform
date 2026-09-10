/**
 * The booking plan's system-level guarantees: the race, the pause, and the past.
 *
 * [CON-01] is the most important test in this file and the reason it exists at all. The ONLY
 * race-proof guarantee the product has is a Postgres exclusion constraint on
 * `(calendar_key, blocked_range)` — everything else that refuses a double booking is advisory,
 * because availability is computed before the write and can always be stale by the time it lands.
 * That constraint was shipped but never exercised: every existing `23P01` assertion INJECTS the
 * error code into a MOCKED repository, which proves only that the error is HANDLED, never that it
 * is RAISED. A constraint typo, a lost migration, or a status predicate that stopped matching
 * would have left the entire suite green while two customers could take the same slot.
 *
 * So this file drives real concurrent transactions against real Postgres and lets the database be
 * the thing that decides. It is slower than a mock and it is worth it, because the mock is the part
 * being trusted.
 *
 * Concurrency is made deterministic rather than hopeful: the first writer holds its transaction
 * open after inserting, so the second writer is provably blocked on the constraint's index and its
 * failure is caused by the first writer's commit rather than by being slower. No sleeps race.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// The calendar double and a silenced mail transport. Both matter for a reason beyond hygiene:
// WITHOUT a healthy connected calendar the write path DOWNGRADES every booking to a Request
// (`CALENDAR_NOT_CONNECTED`), which produces `requested: true` — the exact signal the pause test
// reads. Wiring a connected calendar is therefore what makes that test about the PAUSE rather than
// about a missing calendar, and it is why the pause assertion below would otherwise pass for
// entirely the wrong reason.
vi.mock('../../scheduler/calendar-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/calendar-provider')>()),
  ...(await import('../helpers/booking-plan-harness')).planCalendarMockModule(),
}));
vi.mock('../../automations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../automations')>()),
  getEmailService: () => ({ send: vi.fn().mockResolvedValue({ success: true, messageId: 'qa' }) }),
  initializeAutomations: vi.fn(),
}));

import { AppDataSource } from '../../database/data-source';
import {
  createPlanBusiness,
  createPlanService,
  setPlanAvailability,
  setPlanBookingSettings,
  seedPlanCalendarCredential,
  PLAN_CALENDAR,
  planSession,
  planBookingContext,
  planLocalTime,
  localInstant,
  bookingCount,
  requestCount,
  bookingsForService,
} from '../helpers/booking-plan-harness';
import { InternalProvider } from '../../booking/booking-providers/internal.provider';

/**
 * The constraint the whole guarantee rests on. Created defensively exactly as the one other real
 * race test in this suite does (`integration/travel-write-race.test.ts`): if the test schema ever
 * loses it, this file would otherwise pass by inserting happily, which is the opposite of the
 * intent.
 */
beforeAll(async () => {
  await AppDataSource.query(`
    DO $$ BEGIN
      ALTER TABLE chatbot_bookings ADD CONSTRAINT chatbot_bookings_no_overlap
        EXCLUDE USING gist ("calendar_key" WITH =, "blocked_range" WITH &&)
        WHERE (status IN ('pending','confirmed'));
    EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;`
  );
});

/** One writer's attempt at a slot, inserted the way the engine inserts it. */
type Outcome = 'written' | { conflict: string };

async function attemptWrite(input: {
  tenantId: string;
  botId: string;
  serviceId: string;
  sessionId: string;
  startISO: string;
  endISO: string;
  /** Runs INSIDE the transaction, after the INSERT and before the commit. */
  hold?: () => Promise<void>;
}): Promise<Outcome> {
  try {
    await AppDataSource.transaction(async (manager) => {
      const id = randomUUID();
      // `blocked_range` is the constrained column and is not mapped on the entity, so the write
      // has to be raw SQL — the same shape the provider itself uses.
      await manager.query(
        `INSERT INTO chatbot_bookings
           (id, tenant_id, bot_id, provider, status, start_utc, end_utc, calendar_key, blocked_range,
            ics_uid, attendee_name, attendee_email, event_type_id, session_id, booked_duration_min,
            created_at, updated_at)
         VALUES ($1, $2, $3, 'internal', 'confirmed', $4, $5, $6, tstzrange($4, $5, '[)'),
                 $7, 'QA Customer', 'qa@example.test', $8, $9, 30, now(), now())`,
        [
          id,
          input.tenantId,
          input.botId,
          input.startISO,
          input.endISO,
          // Same calendar key for both writers — one itinerary, which is what makes them contend.
          `bot:${input.botId}`,
          `uid-${id}`,
          input.serviceId,
          input.sessionId,
        ],
      );
      if (input.hold) await input.hold();
    });
    return 'written';
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'unknown';
    return { conflict: code };
  }
}

describe('booking plan · system guarantees', () => {
  beforeEach(() => {
    // The calendar double is module state, so it outlives the DB truncation that clears everything
    // else. Without this reset, one test's recorded creates and busy intervals leak into the next.
    PLAN_CALENDAR.reset();
  });

  describe('[CON-01] two customers race for the same slot', () => {
    it('lets exactly one booking win, at the database level', async () => {
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      const service = await createPlanService(bot);

      // Two different customers, two different sessions — the plan's own fixture. They must contend
      // through the shared itinerary (calendar_key), not through anything this test sets up.
      const sessionA = await planSession(bot);
      const sessionB = await planSession(bot);

      const day = planLocalTime(30, '10:00');
      const start = localInstant(day);
      const end = new Date(start.getTime() + 30 * 60_000);
      const base = {
        tenantId: tenant.id,
        botId: bot.id,
        serviceId: service.id,
        startISO: start.toISOString(),
        endISO: end.toISOString(),
      };

      // The first writer parks inside its transaction once the row is in, so the second writer's
      // INSERT is genuinely waiting on the exclusion constraint rather than simply arriving later.
      let releaseFirst: () => void = () => {};
      const firstHasInserted = new Promise<void>((resolve) => (releaseFirst = resolve));

      const first = attemptWrite({
        ...base,
        sessionId: sessionA.id,
        hold: async () => {
          releaseFirst();
          await new Promise((r) => setTimeout(r, 150));
        },
      });
      await firstHasInserted;
      const second = attemptWrite({ ...base, sessionId: sessionB.id });

      const [a, b] = await Promise.all([first, second]);
      const outcomes = [a, b];

      // Exactly one write. Not "at least one", not "the second was refused" — the guarantee is
      // mutual exclusion, so the assertion is on the count.
      expect(outcomes.filter((o) => o === 'written')).toHaveLength(1);

      // And the loser failed because Postgres refused it, not for some unrelated reason that would
      // make this test pass while the guarantee is broken.
      const loser = outcomes.find((o) => o !== 'written');
      expect(loser).toEqual({ conflict: '23P01' });

      // One row on the diary. This is what "no double booking" means to the customer.
      const rows = await bookingsForService(service.id);
      expect(rows.filter((r) => r.status === 'confirmed')).toHaveLength(1);

      // No Request was captured as a consolation prize: a race must not silently become a request.
      expect(await requestCount(service.id)).toBe(0);
    });

    it('refuses a plain duplicate even without concurrency, and still allows an abutting booking', async () => {
      // The same guarantee in its simplest form, so a reader can see the constraint's predicate
      // rather than infer it from the race. Two clauses matter and they point opposite ways:
      // overlapping is refused, but BUTTING UP is not an overlap (CAL-04), and a test that only
      // checked the first clause would let a stricter-than-intended constraint through.
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      const service = await createPlanService(bot);
      const session = await planSession(bot);

      const day = planLocalTime(31, '13:00');
      const start = localInstant(day);
      const end = new Date(start.getTime() + 30 * 60_000);
      const base = {
        tenantId: tenant.id,
        botId: bot.id,
        serviceId: service.id,
        sessionId: session.id,
        endISO: end.toISOString(),
      };

      expect(await attemptWrite({ ...base, startISO: start.toISOString() })).toBe('written');

      // Identical interval + a different session: refused.
      const sameAgain = await planSession(bot);
      expect(
        await attemptWrite({ ...base, sessionId: sameAgain.id, startISO: start.toISOString() }),
      ).toEqual({ conflict: '23P01' });

      // A partial overlap, 13:15–13:45 across the held 13:00–13:30: refused.
      const partial = new Date(start.getTime() + 15 * 60_000);
      expect(
        await attemptWrite({
          ...base,
          startISO: partial.toISOString(),
          endISO: new Date(partial.getTime() + 30 * 60_000).toISOString(),
        }),
      ).toEqual({ conflict: '23P01' });

      // Abutting exactly at 13:30: allowed. Half-open ranges do not overlap at a shared edge.
      const abutting = new Date(start.getTime() + 30 * 60_000);
      expect(
        await attemptWrite({
          ...base,
          startISO: abutting.toISOString(),
          endISO: new Date(abutting.getTime() + 30 * 60_000).toISOString(),
        }),
      ).toBe('written');

      expect(await bookingCount(service.id, 'confirmed')).toBe(2);
    });

    it('does not let a Request block the slot it is captured for', async () => {
      // A Request holds no time and consumes no capacity (`CONTEXT.md`), which is expressed in the
      // constraint's own predicate (`WHERE status IN ('pending','confirmed')`). If that predicate
      // ever stopped excluding `request_created`, a single enquiry would silently remove a slot
      // from the diary — a failure nobody would see until a customer was told a free time was gone.
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      const service = await createPlanService(bot);
      const session = await planSession(bot);

      const day = planLocalTime(32, '10:00');
      const start = localInstant(day);
      const end = new Date(start.getTime() + 30 * 60_000);

      const requestId = randomUUID();
      await AppDataSource.query(
        `INSERT INTO chatbot_bookings
           (id, tenant_id, bot_id, provider, status, start_utc, end_utc, calendar_key, blocked_range,
            ics_uid, attendee_name, attendee_email, event_type_id, session_id, request_kind,
            created_at, updated_at)
         VALUES ($1, $2, $3, 'internal', 'request_created', $4, $5, $6, tstzrange($4, $5, '[)'),
                 $7, 'QA Requester', 'qa@example.test', $8, $9, 'new', now(), now())`,
        [
          requestId, tenant.id, bot.id,
          start.toISOString(), end.toISOString(),
          `bot:${bot.id}`, `uid-${requestId}`, service.id, session.id,
        ],
      );

      // The identical interval must still be bookable, because the Request holds nothing.
      expect(
        await attemptWrite({
          tenantId: tenant.id,
          botId: bot.id,
          serviceId: service.id,
          sessionId: session.id,
          startISO: start.toISOString(),
          endISO: end.toISOString(),
        }),
      ).toBe('written');

      expect(await requestCount(service.id)).toBe(1);
      expect(await bookingCount(service.id, 'confirmed')).toBe(1);
    });
  });

  describe('[AVL-17] pause new online bookings', () => {
    it('captures a Request instead of confirming, and never refuses the customer', async () => {
      // The plan says pause converts new confirmations into requests and leaves existing bookings
      // alone. What it must NOT be asserted as is a refusal or a capacity block: a paused business
      // still takes the enquiry, and Requests consume no capacity, so any test written as "pause
      // blocks bookings" would be asserting a behaviour the product does not have.
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      // A CONNECTED calendar is what makes this test discriminating. Auto-confirm requires a healthy
      // connection, so without it the downgrade to a Request would happen for the wrong reason and
      // this test would still pass with the pause switch removed entirely.
      await seedPlanCalendarCredential(bot);
      await setPlanBookingSettings(bot, { bookingsPaused: true });
      const service = await createPlanService(bot);
      const session = await planSession(bot);

      const day = planLocalTime(33, '10:00');
      const provider = new InternalProvider();

      const result = await provider.createBooking(
        planBookingContext(tenant, bot, session),
        `idem-paused-${randomUUID()}`,
        localInstant(day).toISOString(),
        { name: 'QA Paused', email: 'qa-paused@example.test' },
        undefined,
        service.id,
      );

      // The write SUCCEEDED — it just did not confirm.
      expect(result.success).toBe(true);
      expect(result.requested).toBe(true);

      expect(await bookingCount(service.id, 'confirmed')).toBe(0);
      expect(await requestCount(service.id)).toBe(1);

      const [row] = await bookingsForService(service.id);
      expect(row.status).toBe('request_created');

      // Nothing was mirrored either: a pause must not put a tentative appointment on the owner's
      // calendar, or the diary would show a job nobody agreed to.
      expect(PLAN_CALENDAR.creates).toHaveLength(0);

      // Existing bookings are untouched by the switch.
      expect(await bookingCount(service.id, 'cancelled')).toBe(0);
    });

    it('still confirms normally once the pause is lifted', async () => {
      // The control that makes the case above about the PAUSE rather than about the fixture: the
      // identical setup, with the switch off, must confirm.
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await seedPlanCalendarCredential(bot);
      await setPlanBookingSettings(bot, { bookingsPaused: false });
      const service = await createPlanService(bot);
      const session = await planSession(bot);

      const provider = new InternalProvider();
      const result = await provider.createBooking(
        planBookingContext(tenant, bot, session),
        `idem-unpaused-${randomUUID()}`,
        localInstant(planLocalTime(34, '10:00')).toISOString(),
        { name: 'QA Live', email: 'qa-live@example.test' },
        undefined,
        service.id,
      );

      expect(result.success).toBe(true);
      expect(result.requested).toBeFalsy();
      expect(await bookingCount(service.id, 'confirmed')).toBe(1);
    });
  });

  describe('[SYS-05] the past-time guardrail', () => {
    it('refuses a booking for a time that has already passed', async () => {
      // Nothing may be written for a start before now — not a booking, and on the Auto-book path
      // not a Request either. Asserted on the persisted action rather than on the message, because
      // the plan's requirement is "no persisted action with start < now".
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      const service = await createPlanService(bot);
      const session = await planSession(bot);

      // Yesterday at 10:00 local, so the day HAS hours and the refusal is about the past rather
      // than about a closed day.
      const yesterday = planLocalTime(-1, '10:00', { weekdayOnly: false });
      const provider = new InternalProvider();

      // The write path REJECTS rather than returning a failure result: a slot that is not offerable
      // is a refusal, and the tool layer turns that into `success: false`. Asserting the shape the
      // provider actually has matters, because a test written against the wrong shape "fails" while
      // the product behaves correctly — this test did exactly that before it was corrected.
      let thrown: { code?: string } | null = null;
      try {
        await provider.createBooking(
          planBookingContext(tenant, bot, session),
          `idem-past-${randomUUID()}`,
          localInstant(yesterday).toISOString(),
          { name: 'QA Past', email: 'qa-past@example.test' },
          undefined,
          service.id,
        );
      } catch (err) {
        thrown = err as { code?: string };
      }

      expect(thrown).not.toBeNull();
      expect(thrown?.code).toBe('SLOT_UNAVAILABLE');

      // And nothing was persisted — not a booking, and not a Request either. The plan's requirement
      // is "no persisted action with start < now", which is stronger than "the reply was polite".
      expect(await bookingCount(service.id)).toBe(0);
      expect(await requestCount(service.id)).toBe(0);
      expect(await bookingsForService(service.id)).toEqual([]);
    });
  });
});
