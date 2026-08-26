/**
 * Writing the pre-steering baseline (#80, LP3).
 *
 * Every function here is BEST-EFFORT AND NEVER THROWS. This is measurement riding alongside a
 * customer conversation: a booking must never fail, and a reply must never be lost, because a
 * statistics row could not be written. The cost of that choice is a gap in the data, which is
 * visible - an offer missing against a recorded availability call is countable - where a thrown
 * error would be a lost booking.
 *
 * Contract: `docs/specs/lp3-offer-record.md`.
 */
import { AppDataSource } from '../database/data-source';
import type { OfferScoring } from './travel/score-offer';
import { AvailabilityCall } from '../database/entities/AvailabilityCall';
import { BookingOffer, type OfferDeliveryBasis, type OfferedSlot } from '../database/entities/BookingOffer';
import { OfferSelection, type OfferSelectionType } from '../database/entities/OfferSelection';
import { logger } from '../utils/logger';

/** An ISO date (YYYY-MM-DD), or null when the caller sent something that is not one. */
function isoDateOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * Record one `check_availability` call, whatever came of it.
 *
 * Returns the row id so a resulting offer can point back at it, or null when nothing was written -
 * the caller must treat that as "no link", never as a failure worth surfacing.
 */
export async function recordAvailabilityCall(input: {
  tenantId: string;
  botId: string;
  sessionId: string;
  serviceId?: string | null;
  startDate?: string;
  endDate?: string;
  slotCount: number;
}): Promise<string | null> {
  try {
    const start = isoDateOrNull(input.startDate);
    const end = isoDateOrNull(input.endDate);
    // A range that did not parse is RECORDED and excluded from the metric's denominator, rather
    // than silently joining the single-day population. A parse failure is not a customer
    // behaviour, and counting it as one would understate how often people ask across days.
    const rangeValid = start !== null && end !== null && end >= start;
    const repo = AppDataSource.getRepository(AvailabilityCall);
    const row = await repo.save(
      repo.create({
        tenantId: input.tenantId,
        botId: input.botId,
        sessionId: input.sessionId,
        serviceId: input.serviceId ?? null,
        requestedStartDate: rangeValid ? start : null,
        requestedEndDate: rangeValid ? end : null,
        requestedRangeRaw: `${input.startDate ?? ''}..${input.endDate ?? ''}`.slice(0, 128),
        rangeValid,
        slotCount: input.slotCount,
      })
    );
    return row.id;
  } catch (error) {
    logger.warn('[offer-record] could not record an availability call', { error });
    return null;
  }
}

/**
 * Record an offer that actually reached a customer.
 *
 * `slots` must be what the CHANNEL sent, already truncated - not what the agent composed. The two
 * differ: `channels/types.ts` caps quick replies at `capabilities.maxQuickReplies` and drops them
 * entirely where the channel does not support them, so recording the agent's list would credit
 * the baseline with slots nobody saw.
 */
export async function recordBookingOffer(input: {
  tenantId: string;
  botId: string;
  sessionId: string;
  serviceId?: string | null;
  availabilityCallId?: string | null;
  locationMode?: string | null;
  channel?: string | null;
  slots: OfferedSlot[];
  deliveryBasis: OfferDeliveryBasis;
  scoring?: OfferScoring;
  /** The LP5 pilot was ON for this offer, whatever it then decided. */
  groupingPilot?: boolean;
  grouped?: { savedMinutes: number } | null;
}): Promise<string | null> {
  if (!input.slots.length) return null;
  const steered = input.groupingPilot ? Boolean(input.grouped) : null;
  try {
    const repo = AppDataSource.getRepository(BookingOffer);
    const row = await repo.save(
      repo.create({
        tenantId: input.tenantId,
        botId: input.botId,
        sessionId: input.sessionId,
        serviceId: input.serviceId ?? null,
        availabilityCallId: input.availabilityCallId ?? null,
        locationMode: input.locationMode ?? null,
        channel: input.channel ?? null,
        offeredSlots: input.slots,
        offeredCount: input.slots.length,
        deliveryBasis: input.deliveryBasis,
        // #81 (LP4). Null throughout when the scorer did not run, which is a different fact from
        // a run that had no opinion - that one is a present row with null costs and a reason.
        scorerVersion: input.scoring?.scorerVersion ?? null,
        // Elements this scoring actually billed: baseline legs only, one per gap. The two legs
        // beside a candidate come from the cache the feasibility gate just filled.
        scoringElements: input.scoring?.elementsSpent ?? null,
        scoringMs: input.scoring?.ms ?? null,
        counterfactualOrder: input.scoring?.counterfactualOrder ?? null,
        // #85's pre-registered gate, stored rather than derived. It is a statement about the FULL
        // scored list, and the row keeps only the slots the channel delivered - so a later reader
        // could not recompute it from this row without inventing the slots that were truncated.
        cheaperAlternativeExisted: input.scoring?.cheaperAlternativeExisted ?? null,
        // #82, and the three states are the point. NULL means the pilot was off for this offer,
        // FALSE means it was on and left the order alone, TRUE means it reordered. Keying this on
        // whether the SCORER ran would collapse the first two - every shadow offer would read
        // `false` and land in the pilot's control group by accident.
        //
        // The two columns are derived from ONE decision so they cannot disagree. Written apart,
        // an offer could carry a saving with a null verdict, or a verdict with no saving, and a
        // later reader would have to guess which of the two to believe.
        groupingApplied: steered,
        groupingSavedMinutes: steered === true ? (input.grouped?.savedMinutes ?? 0) : null,
      })
    );
    return row.id;
  } catch (error) {
    logger.warn('[offer-record] could not record a delivered offer', { error });
    return null;
  }
}

/**
 * How far apart a database timestamp and a timestamp from THIS process may look, and still be
 * treated as the same moment.
 *
 * TWO CLOCKS AND TWO PRECISIONS. `created_at` is written by the DATABASE, in microseconds, and
 * truncated to milliseconds when it is read back; every instant we compare it against comes from
 * this process. So a row stored at 12:00:00.500_800 reads back as .500 and compares EQUAL to a
 * `new Date()` taken just after it, or even LATER than one - and in production the database is
 * not on the same machine as the API, so its clock may genuinely run a few milliseconds ahead.
 *
 * Two places pay for that. An attribution asks "was this offer delivered before the booking",
 * and the newest offer scored as delivered after it. The baseline's window asks "is this row
 * before `until`", and the row just written fell outside it. Both dropped exactly the newest
 * row, both only when the gap closed to under a millisecond - so `offer-record.test.ts` failed
 * on CI, twice in two different metrics, and passed against a slower Docker Postgres every time.
 *
 * Both questions are about human timescales: whether a customer could have acted, and which
 * period a row belongs to. A second of slack answers both, and no real case lives inside a
 * second - the "offer came later" test puts them a minute apart.
 */
export const CLOCK_SKEW_GRACE_MS = 1000;

/**
 * Attribute a Booking or Request to the offer it came from.
 *
 * THE RULE, stated exactly so two implementations agree: the LATEST offer where the session and
 * service match, delivery was not rejected, it was delivered strictly before this booking, and
 * one of its slots starts at exactly this instant. Ties break by id descending. No match writes
 * nothing - unattributed, never guessed.
 *
 * `selectionType` is a SNAPSHOT of what the row was now. A Request the owner later accepts must
 * not migrate into the conversion population, or the baseline improves on its own.
 */
export async function recordOfferSelection(input: {
  sessionId: string;
  serviceId?: string | null;
  bookingId: string;
  startUtc: Date;
  bookingCreatedAt?: Date;
  selectionType: OfferSelectionType;
}): Promise<void> {
  try {
    const before = input.bookingCreatedAt ?? new Date();
    const offers = await AppDataSource.getRepository(BookingOffer).find({
      where: {
        sessionId: input.sessionId,
        ...(input.serviceId ? { serviceId: input.serviceId } : {}),
      },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: 25,
    });

    const wanted = input.startUtc.getTime();
    for (const offer of offers) {
      if (offer.deliveryBasis === 'provider_rejected') continue;
      if (offer.createdAt.getTime() - CLOCK_SKEW_GRACE_MS >= before.getTime()) continue;
      const ordinal = offer.offeredSlots.findIndex((s) => new Date(s.start).getTime() === wanted);
      if (ordinal === -1) continue;

      const repo = AppDataSource.getRepository(OfferSelection);
      await repo.save(
        repo.create({
          offerId: offer.id,
          selectionEntityId: input.bookingId,
          selectionType: input.selectionType,
          selectedOrdinal: ordinal + 1,
        })
      );
      return;
    }
  } catch (error) {
    // Includes the unique-violation retry case, which is correct behaviour rather than a fault:
    // one Booking gets one attribution, and a second attempt must not create a second.
    logger.warn('[offer-record] could not attribute a selection', { bookingId: input.bookingId, error });
  }
}

/**
 * Record what a channel ACTUALLY sent, pairing the delivered chips with their canonical instants.
 *
 * The two lists are positional: `slotStarts` is what the agent composed, in order, and
 * `deliveredTitles` is what survived the channel's cap - a prefix of the same sequence, because
 * `channels/types.ts` truncates with `.slice(0, capabilities.maxQuickReplies)` and never
 * reorders. Pairing by index is therefore exact, and pairing beyond the delivered length would
 * invent slots the customer never saw.
 *
 * A channel that drops quick replies entirely delivers nothing, and nothing is recorded: there
 * was no offer, whatever the agent composed.
 */
export async function recordDeliveredOffer(input: {
  tenantId: string;
  sessionId: string;
  channel?: string | null;
  offer: {
    botId: string;
    serviceId?: string | null;
    availabilityCallId?: string | null;
    locationMode?: string | null;
    slotStarts: string[];
    scoring?: OfferScoring;
    groupingPilot?: boolean;
    grouped?: { savedMinutes: number } | null;
    groupingPreviousOrder?: string[];
  };
  deliveredTitles: string[];
  deliveryBasis: OfferDeliveryBasis;
}): Promise<string | null> {
  const scoring = input.offer.scoring;
  const paired: OfferedSlot[] = input.deliveredTitles
    .slice(0, input.offer.slotStarts.length)
    .map((title, i) => {
      const start = input.offer.slotStarts[i];
      // BY INSTANT, never by position. The titles are a prefix of the slots, but the scores are
      // keyed by time precisely so a truncated delivery cannot attribute one slot's cost to
      // another's - which is the failure an index-paired array makes silently.
      //
      // NORMALISED on the way in, because "by instant" and "by string" are not the same lookup:
      // `2026-09-07T10:00:00+00:00` and `...Z` are one moment and two keys, and the mismatch does
      // not throw - it just quietly records no score.
      const key = Number.isNaN(Date.parse(start)) ? start : new Date(start).toISOString();
      const score = scoring?.scores[key];
      return score ? { start, title, ...score } : { start, title };
    });
  // DID THE CUSTOMER ACTUALLY EXPERIENCE A REORDER? Not the same question as "was the list
  // reordered". They see a prefix - channels cap quick replies as low as three - so a reorder
  // that happens entirely below the cap changes nothing anybody received, and recording it as
  // delivered steering would put an untreated offer in the pilot's treatment group.
  // NORMALISED on both sides. `previousOrder` is built from canonical ISO instants while
  // `slotStarts` is whatever the provider emitted, so `2026-09-07T10:00:00+00:00` and `...Z` are
  // one moment and two strings - and comparing them raw reports a reorder that never happened,
  // putting an untouched offer in the pilot's treatment group.
  const canonical = (v: string) => (Number.isNaN(Date.parse(v)) ? v : new Date(v).toISOString());
  const previous = input.offer.groupingPreviousOrder?.map(canonical);
  const deliveredChanged = previous
    ? paired.some((slot, i) => canonical(slot.start) !== previous[i])
    : false;

  return recordBookingOffer({
    tenantId: input.tenantId,
    botId: input.offer.botId,
    sessionId: input.sessionId,
    serviceId: input.offer.serviceId,
    availabilityCallId: input.offer.availabilityCallId,
    locationMode: input.offer.locationMode,
    channel: input.channel,
    slots: paired,
    deliveryBasis: input.deliveryBasis,
    scoring,
    groupingPilot: input.offer.groupingPilot === true,
    grouped: deliveredChanged ? (input.offer.grouped ?? { savedMinutes: 0 }) : null,
  });
}
