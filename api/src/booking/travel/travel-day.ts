/**
 * The day boundary the travel gate never had.
 *
 * `travel-gate.ts` is arithmetic over two points and two instants; `travel-neighbours.ts` is
 * the database. Neither knows what a *day* is, and start-from-base is the first rule in the
 * epic that needs one — a first job is only first relative to a day, and a departure instant
 * only exists because a business opens at a time. This file is that third thing: pure maths
 * over an availability rule, with no database and no HTTP, so the seam holds.
 *
 * IT DERIVES NOTHING ITSELF. The opening instant comes from `slot-engine.ts`'s `windowsForDay`,
 * which is the one place that resolves `dateOverrides` against the weekly grid — including the
 * ranged-closure asymmetry. A second derivation reading `weeklyHours` alone would take an
 * earlier opening than the day really has, and falsely clear a first job nobody can reach.
 */
import { DateTime } from 'luxon';
import type { AvailabilityRule } from '../../database/entities/AvailabilityRule';
import { windowsForDay } from '../booking-providers/slot-engine';

/** Everything the day maths needs, and nothing else. */
export type DayRule = Pick<
  AvailabilityRule,
  'timezone' | 'weeklyHours' | 'dateOverrides' | 'availabilityMode'
>;

/** The local calendar day an instant falls in, and its half-open bounds as instants. */
export function localDayBounds(
  rule: DayRule,
  instant: Date
): { localDay: DateTime; dayStart: Date; dayEnd: Date } {
  const localDay = DateTime.fromJSDate(instant).setZone(rule.timezone).startOf('day');
  return {
    localDay,
    dayStart: localDay.toJSDate(),
    // `plus({days:1})` rather than `endOf('day')`, and on the ZONED value: a DST day is 23 or
    // 25 hours long, and both a fixed 24h offset and a naive end-of-day would put the boundary
    // an hour out twice a year — silently, and only for the businesses in that hour.
    dayEnd: localDay.plus({ days: 1 }).toJSDate(),
  };
}

/**
 * When the owner can leave the premises on this day, or null when that question has no answer.
 *
 * Three different situations return null and they all mean the same thing — there is no
 * departure instant, so there is no base constraint to apply:
 *
 * - **`always_open`.** `windowsForDay` answers 00:00–24:00 in this mode, which is not an
 *   opening time. Taking it as one would gate every first job against a midnight departure and
 *   refuse mornings for a business that never closes. Checked BEFORE the windows, deliberately,
 *   because the windows themselves cannot tell the two cases apart.
 * - **A closed day.** No window, so nothing to depart at. A booking held on a day the business
 *   is shut is somebody's deliberate exception and travel has no opinion about it.
 * - **A day whose override closes it**, which `windowsForDay` already folds into the above.
 */
export function dayOpeningInstant(rule: DayRule, localDay: DateTime): Date | null {
  if (rule.availabilityMode === 'always_open') return null;
  // `slotGranularityMin` is irrelevant to which windows a day has; `windowsForDay` never reads
  // it. Supplied because the shared input type carries it.
  const windows = windowsForDay({ ...rule, slotGranularityMin: 0 }, localDay);
  if (!windows.length) return null;

  let earliest: DateTime | null = null;
  for (const w of windows) {
    const [h, m] = w.start.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
    const at = localDay.set({ hour: h, minute: m, second: 0, millisecond: 0 });
    if (!earliest || at < earliest) earliest = at;
  }
  return earliest ? earliest.toJSDate() : null;
}

/**
 * When the van leaves the premises for the day's first job (#91).
 *
 * The day's effective opening, less however long before it the owner actually sets off. Its own
 * function rather than a subtraction at the call site so the rule is testable without building a
 * BookingContext - the arithmetic is one line, and one line nobody can reach is one line nobody
 * checks.
 *
 * `offsetMin` of 0 returns the opening instant unchanged, which is what #76 shipped and what every
 * Agent stores today.
 */
export function baseDepartureInstant(rule: DayRule, localDay: DateTime, offsetMin: number): Date | null {
  const opening = dayOpeningInstant(rule, localDay);
  if (!opening) return null;
  // Off the EFFECTIVE opening, so a date override governs the departure exactly as #76 requires it
  // to govern the opening. Negatives are clamped by `clampBaseDepartOffset` before they arrive.
  const departure = opening.getTime() - Math.max(0, offsetMin) * 60_000;
  // NEVER BEFORE THE DAY STARTS, and this is a correctness floor rather than tidiness. The gate's
  // neighbour list is scoped to one local day, so a departure on the PREVIOUS day sits outside
  // everything that could suppress the base - and #76's rule is that any preceding job suppresses
  // it. A late job yesterday would then be invisible while the synthetic base leg cleared this
  // morning's first job regardless. Flooring can only move the departure LATER, which is the
  // conservative direction: it can refuse a job, never clear an unreachable one.
  //
  // Reachable in practice, not theoretical: a business opening at 00:00 crosses on any offset.
  const dayStart = localDay.toJSDate().getTime();
  return new Date(Math.max(departure, dayStart));
}
