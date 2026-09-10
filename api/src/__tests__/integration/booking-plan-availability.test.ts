/**
 * Availability, travel and grouping cases the plan asks for that the suite never drove.
 *
 * Three holes, and each one is a wiring hole rather than an arithmetic hole:
 *
 * * [AVL-09] every existing fixture gave the Service a duration EQUAL to the grid, so closing
 *   time was only ever crossed by a start exactly ON closing. A 60-minute Service on a 30-minute
 *   grid — where 16:30 would run to 17:30 — had never been exercised. `AVL-08` (unit) covers the
 *   same shape across a lunch break; this is the closing-time twin, driven through the real
 *   `checkAvailability` path so the Service duration, the rule's granularity and the engine are
 *   wired together by the provider rather than by the test.
 *
 * * [TRV-05] `travelBaseFor`'s LOCATED branch (`internal.provider.ts:1019-1027`) was never
 *   reached from the offer path, because every `checkAvailability` fixture passed `venue: null`.
 *   The base-as-predecessor logic is pinned at function level; measuring the day's first job from
 *   the BASE's own coordinates was not.
 *
 * * [GEO-01] the provider's grouping wiring (`internal.provider.ts:914-920`) was never driven
 *   with `groupingPeriod !== 'none'`. The reorder-only invariant was pinned on `applyGrouping`
 *   itself, so a provider that passed the wrong list, the wrong `singleDay` or the wrong flag
 *   would have left every test green.
 *
 * GROUPING MAY ONLY REORDER. Maximum Travel Time (`travelMaxTravelMin`) is the hard refusal, it
 * is pinned elsewhere, and it is left NULL in every fixture here so the two cannot be confused.
 *
 * The travel cases need Google, so two seams are doubled and nothing else is: `geocodeAddress`
 * (where a point comes from) and `driveLookupFor` (how long a leg takes). Everything between
 * them — eligibility, the venue read, the neighbour scan, the gate, the scorer, the provider —
 * is the real code, which is the part these cases exist to exercise.
 *
 * EACH GROUP WAS FALSIFIED BEFORE IT WAS TRUSTED — the behaviour was broken, the failure was
 * observed, and the break was reverted:
 *
 *  * `slot-engine.ts:273` relaxed from `startMin + b.duration <= winEndMin` to
 *    `startMin < winEndMin` (validate the start, not the end): both AVL-09 assertions failed,
 *    the duration-30 control kept passing.
 *  * `internal.provider.ts` `travelBaseFor` forced to `location: { kind: 'unresolved' }` — the
 *    exact state `venue: null` produces: all three located-base tests failed.
 *  * `internal.provider.ts` `pilotOn` forced to `false`: both GEO-01 ordering tests failed,
 *    while the two invariant tests (no promotion, single-day only) stayed green, which is what
 *    they are for.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DateTime } from 'luxon';

/** A point, and the recorded legs, shared with the hoisted mock factories below. */
const travelStub = vi.hoisted(() => {
  interface Point {
    lat: number;
    lng: number;
  }
  const state = {
    /** Address substring → the point it places at. First match wins. */
    places: [] as Array<{ match: string; point: Point }>,
    /** Every leg a lookup was actually asked for. */
    legs: [] as Array<{ from: Point; to: Point; budgetMin: number; departAt: Date }>,
    /** Minutes for a leg, or null for "no answer" (which leaves a slot undecided). */
    drive: (_from: Point, _to: Point): number | null => null,
    reset() {
      state.places = [];
      state.legs = [];
      state.drive = () => null;
    },
  };
  return state;
});

vi.mock('../../config/environment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/environment')>();
  // Gate 1 of travel eligibility is the key's mere presence. Without it nothing below runs and
  // every travel assertion here would pass against a feature that never woke up.
  return {
    ...actual,
    config: { ...actual.config, travel: { ...actual.config.travel, googleMapsApiKey: 'plan-test-key' } },
  };
});

vi.mock('../../booking/travel/geocoding.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../booking/travel/geocoding.service')>();
  return {
    ...actual,
    geocodeAddress: async (_eligibility: unknown, address: string) => {
      const hit = travelStub.places.find((p) => address.includes(p.match));
      if (!hit) return { status: 'not_placeable' as const, cause: 'zero_results' as const };
      return {
        status: 'placed' as const,
        place: {
          placeId: `place-${hit.match}`,
          lat: hit.point.lat,
          lng: hit.point.lng,
          // `rooftop` is `known`, not `coarse`: a coarse point may refuse a slot but may never
          // clear one, so a coarse fixture would make the near-base control unfalsifiable.
          precision: 'rooftop' as const,
          formattedAddress: address,
        },
      };
    },
  };
});

vi.mock('../../booking/travel/routes.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../booking/travel/routes.service')>();
  return {
    ...actual,
    // The documented adapter seam: the gate is handed a function and never learns what HTTP is.
    driveLookupFor: () => async (leg: { from: { lat: number; lng: number }; to: { lat: number; lng: number }; budgetMin: number; departAt: Date }) => {
      travelStub.legs.push({ from: leg.from, to: leg.to, budgetMin: leg.budgetMin, departAt: leg.departAt });
      const minutes = travelStub.drive(leg.from, leg.to);
      return minutes === null ? { minutes: null, cause: 'not_cached' as const } : { minutes };
    },
  };
});

// The harness's calendar double, which every case here needs for a different reason than the
// delivered files do: `assertAvailabilityOfferable` refuses to offer times at all for an
// Auto-book Service with no healthy calendar connection.
vi.mock('../../scheduler/calendar-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/calendar-provider')>()),
  ...(await import('../helpers/booking-plan-harness')).planCalendarMockModule(),
}));

import { AppDataSource } from '../../database/data-source';
import type { Bot } from '../../database/entities/Bot';
import { InternalProvider } from '../../booking/booking-providers/internal.provider';
import { haversineKm } from '../../contracts/travel';
import { resolveItineraryKey } from '../../scheduler/itinerary-key';
import {
  createPlanBusiness,
  createPlanService,
  setPlanAvailability,
  setPlanBookingSettings,
  seedConfirmedBooking,
  PLAN_CALENDAR,
  PLAN_TZ,
  planSession,
  planBookingContext,
  planDate,
  localHHMM,
} from '../helpers/booking-plan-harness';

/** The local `HH:mm` each offered slot starts at — what the customer is actually shown. */
const offeredAt = (slots: Array<{ start: string }>): string[] => slots.map((s) => localHHMM(s.start));

/** The local end of an offered slot, so "runs past closing" can be stated directly. */
const endsAt = (slot: { end: string }): string => localHHMM(slot.end);

// One street per role, so the geocode double can tell them apart by substring alone.
const CUSTOMER_LINE = 'Klantstraat 1, 9100 Sint-Niklaas, BE';
const CUSTOMER_POINT = { lat: 51.165, lng: 4.14 };
/** Thirty metres from the customer: inside `certainlyReachableWithin` for a 30-minute budget. */
const NEAR_VENUE_POINT = { lat: 51.1652, lng: 4.1402 };
/** ~170 km away: outside `couldReachWithin` for the same 30 minutes, and certainly so. */
const FAR_VENUE_POINT = { lat: 49.61, lng: 6.13 };
/** A held job 30 km north of the customer. */
const FAR_JOB_LINE = 'Vertegstraat 5, 2900 Schoten, BE';
const FAR_JOB_POINT = { lat: 51.435, lng: 4.14 };
/** A held job one kilometre from the customer's door. */
const NEAR_JOB_LINE = 'Buurstraat 7, 9100 Sint-Niklaas, BE';
const NEAR_JOB_POINT = { lat: 51.174, lng: 4.14 };

/** The premises address, as the four columns `venueLocation` reads and joins into one line. */
const venueFields = (street: string) => ({
  venueStreet: street,
  venuePostalCode: '2018',
  venueCity: 'Antwerpen',
  venueCountry: 'BE',
});

/**
 * A held job on the diary, at a placeable address and on the diary the provider will read.
 *
 * Two corrections to `seedConfirmedBooking`, both of which decide whether this test asserts
 * anything at all:
 *
 *  * it writes NO address, and a neighbour with no address classifies as `unresolved` — which
 *    withholds slots rather than anchoring them;
 *  * it writes `calendar_key = bot:<id>`, while a file that installs the harness's calendar
 *    double resolves the itinerary key to `gcal:qacal:<id>`. On the wrong key the row is
 *    invisible to the busy scan AND the neighbour scan, so the day reads empty and every
 *    assertion here would pass against no diary at all. The key is RESOLVED rather than
 *    hardcoded, so it cannot drift from whatever the provider itself resolves.
 */
async function seedNeighbourJob(bot: Bot, serviceId: string, startLocal: string, address: string) {
  const row = await seedConfirmedBooking({ bot, serviceId, startLocal, durationMin: 30 });
  await AppDataSource.query(
    'UPDATE chatbot_bookings SET customer_address = $2, calendar_key = $3 WHERE id = $1',
    [row.id, address, await resolveItineraryKey(bot.id)],
  );
  return row;
}

describe('booking plan · availability, travel and grouping', () => {
  beforeEach(() => {
    PLAN_CALENDAR.reset();
    travelStub.reset();
  });

  /**
   * AVL-09 — a Service longer than the grid must not be offered a start that runs past closing.
   *
   * The failure this catches is an engine that validates the START against the closing time and
   * not the END: 16:30 sits inside 09:00–17:00 and a 60-minute job from it finishes at 17:30.
   * Every fixture in the suite before this one had `durationMin === slotGranularityMin`, which
   * makes that bug invisible — the last start and the last legal start coincide.
   *
   * Driven through `checkAvailability` rather than the engine, because the wiring is half the
   * claim: the duration comes off the Service row and the grid off the Availability Rule, and a
   * provider that passed the granularity as the duration would pass an engine-level test.
   */
  describe('[AVL-09] when the Service is longer than the slot grid', () => {
    it('offers 16:00 as the last start and never 16:30, which would run to 17:30', async () => {
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      const service = await createPlanService(bot, { durationMin: 60 });
      const session = await planSession(bot);
      const day = planDate(35, { weekdayOnly: true });

      const result = await new InternalProvider().checkAvailability(
        planBookingContext(tenant, bot, session),
        day,
        day,
        service.id,
      );

      // The full list, because the failure being prevented is a single extra start appearing at
      // the end of it. 09:00–17:00 on a 30-minute grid, minus the two starts a 60-minute job
      // cannot finish inside the day from.
      expect(offeredAt(result.slots)).toEqual([
        '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
        '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00',
      ]);
      // Stated directly as well: 16:30 is the start the grid offers and the duration forbids.
      expect(offeredAt(result.slots)).not.toContain('16:30');
    });

    it('never returns a slot that ends after closing, whatever the list looks like', async () => {
      // The structural form of the same invariant. It cannot pass for the wrong reason by being
      // vacuous: the length is asserted first, so an empty or truncated list fails here rather
      // than satisfying the loop.
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      const service = await createPlanService(bot, { durationMin: 60 });
      const session = await planSession(bot);
      const day = planDate(35, { weekdayOnly: true });

      const result = await new InternalProvider().checkAvailability(
        planBookingContext(tenant, bot, session),
        day,
        day,
        service.id,
      );

      expect(result.slots).toHaveLength(15);
      for (const slot of result.slots) {
        expect(endsAt(slot) <= '17:00').toBe(true);
        // The half-open span really is 60 minutes, so the assertion above is about a 60-minute
        // job and not about a 30-minute one the provider silently substituted.
        expect(new Date(slot.end).getTime() - new Date(slot.start).getTime()).toBe(60 * 60_000);
      }
    });

    it('offers the 16:30 start back as soon as the Service fits inside the day from it', async () => {
      // The control. Same business, same grid, same date — only the duration changes. Without it
      // the two tests above would also pass against a provider that lost the last slot of every
      // day for an unrelated reason (a horizon, a notice, an off-by-one on the closing edge).
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      const service = await createPlanService(bot, { durationMin: 30 });
      const session = await planSession(bot);
      const day = planDate(35, { weekdayOnly: true });

      const result = await new InternalProvider().checkAvailability(
        planBookingContext(tenant, bot, session),
        day,
        day,
        service.id,
      );

      expect(offeredAt(result.slots)).toContain('16:30');
      expect(offeredAt(result.slots)).not.toContain('17:00');
    });
  });

  /**
   * TRV-05 — the day's first job is measured from the Base's OWN coordinates.
   *
   * The two runs below are byte-identical fixtures apart from the premises street, which is the
   * only thing that moves the base's point. So the assertion cannot pass for the wrong reason:
   *
   *  * if the base were never inserted (the setting ignored), both runs would offer 09:00;
   *  * if the venue arrived as `unresolved` rather than located — which is precisely what
   *    `venue: null` produces — the far run's 09:00 would come back UNDECIDED, i.e. in
   *    `requestableSlots`, never in `unreachableSlots`. Proven impossible is a claim only a
   *    located base can support.
   *
   * The van leaves 30 minutes before opening (`travelBaseDepartOffsetMin`), so the first slot
   * has a real 30-minute budget to be judged against instead of a zero one.
   */
  describe('[TRV-05] the Base as the day-start predecessor', () => {
    async function travelBusiness(venueStreet: string) {
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await setPlanBookingSettings(bot, {
        travelTimeEnabled: true,
        travelStartFromBase: true,
        travelBaseDepartOffsetMin: 30,
        minGapMin: 0,
        // NULL on purpose. Maximum Travel Time is the hard refusal and is pinned elsewhere;
        // leaving it set would make every refusal below ambiguous between the two rules.
        travelMaxTravelMin: null,
        ...venueFields(venueStreet),
      });
      const service = await createPlanService(bot, {
        locationType: 'customer_location',
        customerAddressRequired: true,
      });
      const session = await planSession(bot);
      return { tenant, bot, service, session };
    }

    async function firstSlotVerdict(venueStreet: string) {
      const { tenant, bot, service, session } = await travelBusiness(venueStreet);
      const day = planDate(35, { weekdayOnly: true });

      const result = await new InternalProvider().checkAvailability(
        planBookingContext(tenant, bot, session),
        day,
        day,
        service.id,
        undefined,
        undefined,
        CUSTOMER_LINE,
      );
      return {
        offered: offeredAt(result.slots),
        requestable: (result.travel?.requestableSlots ?? []).map((s) => localHHMM(s.start)),
        unreachable: (result.travel?.unreachableSlots ?? []).map((s) => localHHMM(s.start)),
      };
    }

    beforeEach(() => {
      travelStub.places = [
        { match: 'Klantstraat', point: CUSTOMER_POINT },
        { match: 'Dichtbijlaan', point: NEAR_VENUE_POINT },
        { match: 'Verweg', point: FAR_VENUE_POINT },
      ];
      // No routed answer at all. Everything asserted here is settled by the geometric bounds,
      // so a slot that needed Google shows up as `requestable` and the assertions notice.
      travelStub.drive = () => null;
    });

    it('refuses the first slot when the premises are too far from it to reach by opening', async () => {
      const verdict = await firstSlotVerdict('Verweg 9');

      expect(verdict.offered).not.toContain('09:00');
      // UNREACHABLE, not requestable: only a located base can prove a drive impossible.
      expect(verdict.unreachable).toContain('09:00');
      expect(verdict.requestable).not.toContain('09:00');
    });

    it('offers the first slot when the premises are beside it', async () => {
      const verdict = await firstSlotVerdict('Dichtbijlaan 1');

      expect(verdict.offered).toContain('09:00');
      expect(verdict.unreachable).not.toContain('09:00');
    });

    it('leaves the first slot alone when the owner has not switched start-from-base on', async () => {
      // The third leg of the control. With the setting off the base is `null` — "no constraint" —
      // so the FAR premises stop mattering entirely. This is what separates "the base is applied"
      // from "this customer is simply unreachable".
      const { tenant, bot, service, session } = await travelBusiness('Verweg 9');
      await setPlanBookingSettings(bot, { travelStartFromBase: false });
      const day = planDate(35, { weekdayOnly: true });

      const result = await new InternalProvider().checkAvailability(
        planBookingContext(tenant, bot, session),
        day,
        day,
        service.id,
        undefined,
        undefined,
        CUSTOMER_LINE,
      );

      expect(offeredAt(result.slots)).toContain('09:00');
    });

    it('departs from the Base at the offset before opening, not at opening', async () => {
      // The instant the located base is measured FROM, read off the leg the gate asked about.
      // A drive answer is supplied here so the middle band actually reaches the lookup.
      const { tenant, bot, service, session } = await travelBusiness('Dichtbijlaan 1');
      // Far enough that the bounds settle nothing for the early slots, so a leg is requested.
      travelStub.places = [
        { match: 'Klantstraat', point: CUSTOMER_POINT },
        { match: 'Dichtbijlaan', point: { lat: 51.35, lng: 4.3 } },
      ];
      travelStub.drive = () => 20;
      const day = planDate(35, { weekdayOnly: true });

      await new InternalProvider().checkAvailability(
        planBookingContext(tenant, bot, session),
        day,
        day,
        service.id,
        undefined,
        undefined,
        CUSTOMER_LINE,
      );

      const fromBase = travelStub.legs.filter(
        (leg) => haversineKm(leg.from, { lat: 51.35, lng: 4.3 }) < 0.01,
      );
      expect(fromBase.length).toBeGreaterThan(0);
      // 08:30 local — opening (09:00) minus the owner's 30-minute head start. An implementation
      // that departed at opening would read 09:00 here, and one that used the range start rather
      // than the day's own opening instant would read 00:00.
      expect(localHHMM(fromBase[0].departAt)).toBe('08:30');
      // And it drives TO the customer, which is what makes it the base leg rather than any other.
      expect(haversineKm(fromBase[0].to, CUSTOMER_POINT)).toBeLessThan(0.01);
    });
  });

  /**
   * GEO-01 — grouping, driven through the booking path.
   *
   * `applyGrouping` already refuses to add or drop a slot. What was never asserted is that the
   * PROVIDER hands it the right things: the confirmable list, the single-day verdict and the
   * owner's period. The two runs below differ only in `travelGroupingPeriod`, so:
   *
   *  * the pilot flag proves the wiring read the owner's setting;
   *  * the two slot lists being permutations of one another proves grouping only reordered;
   *  * the order differing proves it actually ran, rather than the flag being cosmetic.
   *
   * Maximum Travel Time stays NULL throughout. Grouping may reorder and may never refuse, and a
   * fixture that let a refusal happen would confuse this case with `GEO-05`'s.
   */
  describe('[GEO-01] grouping through the offer path', () => {
    async function groupingRun(period: 'none' | 'full_day') {
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await setPlanBookingSettings(bot, {
        travelTimeEnabled: true,
        travelStartFromBase: false,
        minGapMin: 0,
        travelMaxTravelMin: null,
        travelGroupingPeriod: period,
        ...venueFields('Dichtbijlaan 1'),
      });
      const service = await createPlanService(bot, {
        locationType: 'customer_location',
        customerAddressRequired: true,
      });
      const session = await planSession(bot);
      const day = planDate(35, { weekdayOnly: true });

      // TWO held jobs, and the geometry is the whole fixture. The morning job is 30 km away;
      // the afternoon job is a kilometre from the customer's door. So inserting the new job
      // BETWEEN them costs almost nothing (the van passes the door anyway) while putting it
      // before the morning job costs a 30 km leg. That is a preference grouping can express,
      // and it is one no chronological list would produce.
      await seedNeighbourJob(bot, service.id, `${day}T11:00`, FAR_JOB_LINE);
      await seedNeighbourJob(bot, service.id, `${day}T15:00`, NEAR_JOB_LINE);

      const result = await new InternalProvider().checkAvailability(
        planBookingContext(tenant, bot, session),
        day,
        day,
        service.id,
        undefined,
        undefined,
        CUSTOMER_LINE,
      );
      return result;
    }

    beforeEach(() => {
      travelStub.places = [
        { match: 'Klantstraat', point: CUSTOMER_POINT },
        { match: 'Dichtbijlaan', point: NEAR_VENUE_POINT },
        { match: 'Vertegstraat', point: FAR_JOB_POINT },
        { match: 'Buurstraat', point: NEAR_JOB_POINT },
      ];
      // One minute per kilometre, which is a plausible 60 km/h and, more importantly, is
      // MONOTONIC in distance — so the preference below is a fact about the geometry and not
      // about a hand-picked table of minutes.
      travelStub.drive = (from, to) => Math.max(1, Math.round(haversineKm(from, to)));
    });

    it('reorders the offered times and adds or removes none of them', async () => {
      const plain = await groupingRun('none');
      const grouped = await groupingRun('full_day');

      // The wiring read the owner's setting. With `none` the provider must not even claim it ran.
      expect(grouped.travel?.groupingPilot).toBe(true);
      expect(plain.travel?.groupingPilot).toBeUndefined();

      // REORDER ONLY. Same times, same count, same durations — a different sequence.
      expect([...offeredAt(grouped.slots)].sort()).toEqual([...offeredAt(plain.slots)].sort());
      expect(grouped.slots).toHaveLength(plain.slots.length);
      expect(offeredAt(grouped.slots)).not.toEqual(offeredAt(plain.slots));

      // And the order really was recorded for the owner, not silently swapped.
      expect(grouped.travel?.groupingPreviousOrder).toBeDefined();
      expect((grouped.travel?.groupingPreviousOrder ?? []).map((s) => localHHMM(s))).toEqual(
        offeredAt(plain.slots),
      );
    });

    it('offers the cheapest insertion first, which is the only thing grouping moves', async () => {
      const grouped = await groupingRun('full_day');
      const plain = await groupingRun('none');

      // Untouched, the list is chronological: 09:00 first, always.
      expect(offeredAt(plain.slots)[0]).toBe('09:00');

      // Grouped, it leads with the time that adds the fewest driving minutes. 16:00 follows the
      // 15:00 job, which is a kilometre from this customer's door, so it costs one minute of
      // extra driving; a morning start costs the whole 30 km leg to the 11:00 job. The order is
      // therefore geometry, not a hand-picked expectation — and it is not chronological, which
      // is what fails against a provider that hands the list on unranked.
      expect(offeredAt(grouped.slots)[0]).toBe('16:00');
      expect(offeredAt(grouped.slots)[0]).not.toBe(offeredAt(plain.slots)[0]);

      // Stated as the invariant as well: the whole offered list is in non-decreasing cost order,
      // and the costs really do differ, so the assertion above cannot hold by coincidence.
      const costs = grouped.grouping?.scores ?? {};
      const offeredCosts = grouped.slots.map((s) => costs[new Date(s.start).toISOString()]?.costMinutes ?? null);
      expect(offeredCosts).not.toContain(null);
      expect(offeredCosts).toEqual([...offeredCosts].sort((a, b) => (a as number) - (b as number)));
      expect(new Set(offeredCosts).size).toBeGreaterThan(1);
    });

    it('never promotes a time the gate could not confirm', async () => {
      // ADR-0017's other half, at the path level: the returned list is the CLEARED list, so a
      // requestable time cannot arrive in it however cheap it would have been to drive to.
      const grouped = await groupingRun('full_day');
      const offered = new Set(grouped.slots.map((s) => s.start));
      for (const slot of grouped.travel?.requestableSlots ?? []) {
        expect(offered.has(slot.start)).toBe(false);
      }
    });

    it('groups only a single-day request, so nothing steers a customer to another date', async () => {
      // The `singleDay` argument is computed by the provider from the normalised range, and the
      // exclusive end is easy to get wrong by one day in either direction. A two-day range must
      // switch the pilot's effect off even with the owner's setting on.
      const { tenant, bot } = await createPlanBusiness();
      await setPlanAvailability(bot);
      await setPlanBookingSettings(bot, {
        travelTimeEnabled: true,
        minGapMin: 0,
        travelMaxTravelMin: null,
        travelGroupingPeriod: 'full_day',
        ...venueFields('Dichtbijlaan 1'),
      });
      const service = await createPlanService(bot, {
        locationType: 'customer_location',
        customerAddressRequired: true,
      });
      const session = await planSession(bot);
      const first = planDate(35, { weekdayOnly: true });
      const second = DateTime.fromISO(first, { zone: PLAN_TZ }).plus({ days: 1 }).toFormat('yyyy-MM-dd');
      await seedNeighbourJob(bot, service.id, `${first}T11:00`, FAR_JOB_LINE);
      await seedNeighbourJob(bot, service.id, `${first}T15:00`, NEAR_JOB_LINE);

      const result = await new InternalProvider().checkAvailability(
        planBookingContext(tenant, bot, session),
        first,
        second,
        service.id,
        undefined,
        undefined,
        CUSTOMER_LINE,
      );

      expect(result.travel?.groupingPreviousOrder).toBeUndefined();
      const starts = result.slots.map((s) => new Date(s.start).getTime());
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    });
  });
});
