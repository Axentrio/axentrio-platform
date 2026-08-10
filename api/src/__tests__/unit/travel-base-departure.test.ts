/**
 * #91 - when the van actually leaves the premises.
 *
 * `travelBaseFor` decides the instant the day's first job is measured FROM. Until now that was the
 * day's opening, which quietly equated two different times: when the owner leaves the premises,
 * and the earliest a customer may be booked. Any positive drive then ruled out a job at opening,
 * so an owner with start-from-base on lost the first slot of every day.
 *
 * Found on a live diary, not in review: a venue 14 minutes from the customer made 09:30 the
 * earliest offer on a completely empty day, and the bot said "9:00 AM is not available due to
 * travel time conflicts".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DateTime } from 'luxon';
import { baseDepartureInstant as departureInstant, dayOpeningInstant, type DayRule } from '../../booking/travel/travel-day';

const rule: DayRule = {
  timezone: 'Europe/Brussels',
  availabilityMode: 'business_hours',
  weeklyHours: {
    mon: [{ start: '09:00', end: '17:00' }],
    tue: [{ start: '09:00', end: '17:00' }],
    wed: [{ start: '09:00', end: '17:00' }],
    thu: [{ start: '09:00', end: '17:00' }],
    fri: [{ start: '09:00', end: '17:00' }],
    sat: [],
    sun: [],
  },
  dateOverrides: [],
} as unknown as DayRule;

/** Monday 10 August 2026, Brussels, in summer time (UTC+2). */
const MON = DateTime.fromISO('2026-08-10', { zone: 'Europe/Brussels' });

describe('when the van leaves the premises', () => {
  it('departs at opening when the offset is zero, exactly as #76 shipped', () => {
    // The default, and the whole safety of this change: every Agent that exists today stores 0,
    // so none of them moves. A regression here is silent — it would relax a feasibility gate for
    // every owner at once, offering jobs nobody can reach.
    expect(departureInstant(rule, MON, 0)?.toISOString()).toBe('2026-08-10T07:00:00.000Z');
  });

  it('departs EARLIER than opening by the offset, which is the whole point', () => {
    // 30 minutes of head start buys 30 minutes of reach, so a customer 14 minutes away is now
    // reachable at 09:00 instead of 09:30.
    expect(departureInstant(rule, MON, 30)?.toISOString()).toBe('2026-08-10T06:30:00.000Z');
  });

  it('reproduces the live failure: a 14-minute drive no longer costs the opening slot', () => {
    // The case that found the bug. Departing at opening, the van reaches the customer at 09:14 and
    // a 09:00 job is refused. Departing 30 minutes early it arrives at 08:44, comfortably before.
    const driveMin = 14;
    const opening = dayOpeningInstant(rule, MON)!;

    const atOpening = departureInstant(rule, MON, 0)!.getTime() + driveMin * 60_000;
    expect(atOpening).toBeGreaterThan(opening.getTime());

    const withHeadStart = departureInstant(rule, MON, 30)!.getTime() + driveMin * 60_000;
    expect(withHeadStart).toBeLessThanOrEqual(opening.getTime());
  });

  it('takes the offset off the EFFECTIVE opening, so a date override still governs', () => {
    // #76 is explicit that the departure comes from the day's effective windows and never from
    // the weekly grid. The offset must inherit that, or a one-off late opening would be measured
    // from a departure the owner never makes.
    const withOverride = {
      ...rule,
      dateOverrides: [{ date: '2026-08-10', windows: [{ start: '11:00', end: '15:00' }] }],
    } as unknown as DayRule;

    expect(departureInstant(withOverride, MON, 30)?.toISOString()).toBe('2026-08-10T08:30:00.000Z');
  });

  it('never departs before the local day starts, even on a midnight opening', () => {
    // Codex found this and it is reachable, not theoretical: the tenant this feature was measured
    // on really did open at 00:00. The gate's neighbour list covers ONE local day, so a departure
    // on the previous day sits outside everything that could suppress the base - and #76's rule is
    // that any preceding job suppresses it. A late job yesterday would be invisible while the base
    // leg cleared this morning's first job anyway.
    const allDay = {
      ...rule,
      weeklyHours: { ...(rule as unknown as { weeklyHours: Record<string, unknown> }).weeklyHours, mon: [{ start: '00:00', end: '23:45' }] },
    } as unknown as DayRule;

    // Midnight Brussels on a summer date is 22:00 UTC the day before; flooring holds it there
    // rather than letting a 4-hour offset walk it back to 18:00 UTC.
    expect(departureInstant(allDay, MON, 240)?.toISOString()).toBe('2026-08-09T22:00:00.000Z');
    expect(departureInstant(allDay, MON, 0)?.toISOString()).toBe('2026-08-09T22:00:00.000Z');
  });

  it('floors at the day start rather than refusing, so it can only ever be MORE conservative', () => {
    // The direction matters. A later departure can refuse a job; it can never clear an unreachable
    // one. Returning null instead would drop the base leg entirely and remove the check.
    const allDay = {
      ...rule,
      weeklyHours: { ...(rule as unknown as { weeklyHours: Record<string, unknown> }).weeklyHours, mon: [{ start: '00:30', end: '23:45' }] },
    } as unknown as DayRule;
    const floored = departureInstant(allDay, MON, 240);
    expect(floored).not.toBeNull();
    expect(floored!.getTime()).toBe(MON.toJSDate().getTime());
  });

  it('answers null on a closed day, offset or not', () => {
    // No opening means no departure instant and therefore no base leg at all — the offset must
    // not conjure one out of a day the business is shut.
    const sunday = DateTime.fromISO('2026-08-09', { zone: 'Europe/Brussels' });
    expect(departureInstant(rule, sunday, 30)).toBeNull();
  });
});

describe('the offset the resolver hands the gate', () => {
  it('clamps a negative to zero rather than departing LATER than opening', async () => {
    // A negative would push the departure past opening and quietly TIGHTEN a rule the owner was
    // trying to relax — the opposite of what they asked for, and invisible.
    const { clampBaseDepartOffset } = await import('../../booking/travel/travel-eligibility');
    expect(clampBaseDepartOffset(-30)).toBe(0);
    expect(clampBaseDepartOffset(null)).toBe(0);
    expect(clampBaseDepartOffset(undefined)).toBe(0);
    expect(clampBaseDepartOffset(45)).toBe(45);
  });

  it('clamps an oversized stored value, which is the dangerous direction', async () => {
    // The API refuses >240 and the column now carries a CHECK, but this is the READ path and it
    // does not get to assume either ran: a row predating the constraint still arrives here. An
    // unbounded offset departs arbitrarily early and CLEARS a first job nobody can reach, which is
    // the one thing a feasibility gate must never do.
    const { clampBaseDepartOffset, MAX_BASE_DEPART_OFFSET_MIN } = await import('../../booking/travel/travel-eligibility');
    expect(clampBaseDepartOffset(100_000)).toBe(MAX_BASE_DEPART_OFFSET_MIN);
    expect(MAX_BASE_DEPART_OFFSET_MIN).toBe(240);
  });

  it('reads a non-number as no head start rather than NaN', async () => {
    // NaN would propagate into the departure arithmetic and make the instant Invalid Date, which
    // compares false against everything and silently disables the base leg.
    const { clampBaseDepartOffset } = await import('../../booking/travel/travel-eligibility');
    expect(clampBaseDepartOffset(Number.NaN)).toBe(0);
    expect(clampBaseDepartOffset('30' as unknown as number)).toBe(0);
  });
});

describe('the read and write paths agree on when the van left', () => {
  it('is the only source of a departure instant in the provider', () => {
    // A SOURCE-LEVEL invariant, because the failure it guards is invisible to any single test.
    // `travelBaseFor` (availability) and `assertExposedFirstJob` (the write-time re-assertion)
    // must measure the day's first job from the SAME instant. They did not: the write path read
    // the bare opening and ignored the owner's offset, so availability would offer a job at
    // opening that the owner can reach by leaving early and the write would then refuse it.
    //
    // A read that offers what the write rejects is precisely what the re-assertion exists to
    // prevent, so the rule is stated once here rather than re-tested at each call site.
    const src = readFileSync(join(__dirname, '..', '..', 'booking', 'booking-providers', 'internal.provider.ts'), 'utf8');

    expect(src).not.toContain('dayOpeningInstant(');
    // ...and it does reach for the offset-aware one, so the assertion above cannot pass merely
    // because somebody deleted the base leg altogether.
    expect(src.match(/baseDepartureInstant\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
