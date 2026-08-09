/**
 * The baseline, as three named queries (#80, LP3).
 *
 * WRITTEN ONCE ON PURPOSE. LP4's shadow scorer and LP5's live pilot are both compared against
 * these numbers, and if each phase re-derives "the baseline" from the raw tables they will
 * eventually disagree about the denominator and nobody will be able to say which comparison was
 * the real one. Two implementations of a baseline is the failure this whole record exists to
 * prevent, so the arithmetic lives here and the phases call it.
 *
 * Every ambiguity the specification closed is closed HERE, in SQL, rather than left to whoever
 * writes the next query:
 *
 *   - "Delivered" means `provider_accepted` OR `widget_assumed`, never `provider_rejected`. A
 *     message the transport refused is not an offer a customer could have taken.
 *   - `widget_assumed` IS included, because excluding it would silently omit most of the traffic.
 *     `delivery_basis` is on the row so a reader can split it, not so the canonical number
 *     quietly drops a channel.
 *   - First-offer acceptance counts BOOKINGS only. A Request is expressed choice, not conversion,
 *     and folding the two together would flatter LP5's comparison later.
 *   - The range metric's denominator excludes calls whose range did not parse. A parse failure is
 *     not a customer behaviour.
 *
 * Contract: `docs/specs/lp3-offer-record.md`.
 */
import { AppDataSource } from '../database/data-source';

/** Only these two count as delivered. Kept as one string so no query can drift from it. */
const DELIVERED = `('provider_accepted', 'widget_assumed')`;

export interface BaselineWindow {
  /** Inclusive lower bound on `created_at`. */
  since: Date;
  /** Exclusive upper bound. Defaults to now. */
  until?: Date;
  /** Narrow to one tenant. Omit for the platform-wide figure. */
  tenantId?: string;
  /** Narrow to one location mode, e.g. `customer_location`. Omit for all. */
  locationMode?: string;
}

export interface Ratio {
  numerator: number;
  denominator: number;
  /** Null rather than zero when the denominator is empty: no data is not the same as no uptake. */
  share: number | null;
}

const ratio = (numerator: number, denominator: number): Ratio => ({
  numerator,
  denominator,
  share: denominator > 0 ? numerator / denominator : null,
});

/**
 * THE number LP5 has to beat: how often a customer took the first slot they were offered.
 *
 * Denominator is attributed BOOKINGS - bookings that matched a delivered offer. A booking with no
 * matching offer is in neither side: an owner adding an appointment by hand was never steered and
 * cannot evidence steering, so counting it would understate acceptance for free.
 */
export async function firstOfferAcceptance(window: BaselineWindow): Promise<Ratio> {
  const rows: Array<{ ordinal_one: string; total: string }> = await AppDataSource.query(
    `SELECT
       COUNT(*) FILTER (WHERE s.selected_ordinal = 1) AS ordinal_one,
       COUNT(*) AS total
     FROM chatbot_offer_selections s
     JOIN chatbot_booking_offers o ON o.id = s.offer_id
     WHERE s.selection_type = 'booking'
       AND s.created_at >= $1 AND s.created_at < $2
       AND ($3::uuid IS NULL OR o.tenant_id = $3)
       AND ($4::varchar IS NULL OR o.location_mode = $4)`,
    [window.since, window.until ?? new Date(), window.tenantId ?? null, window.locationMode ?? null]
  );
  return ratio(Number(rows[0]?.ordinal_one ?? 0), Number(rows[0]?.total ?? 0));
}

/**
 * How often a delivered offer produced anything at all - a Booking OR a Request.
 *
 * A different question from the one above, and named separately so the two are never confused.
 * This one counts Requests, because "did the customer choose a time" is exactly what it asks.
 */
export async function offerConversion(window: BaselineWindow): Promise<Ratio> {
  const rows: Array<{ converted: string; total: string }> = await AppDataSource.query(
    `SELECT
       COUNT(*) FILTER (WHERE s.id IS NOT NULL) AS converted,
       COUNT(*) AS total
     FROM chatbot_booking_offers o
     LEFT JOIN chatbot_offer_selections s ON s.offer_id = o.id
     WHERE o.delivery_basis IN ${DELIVERED}
       AND o.created_at >= $1 AND o.created_at < $2
       AND ($3::uuid IS NULL OR o.tenant_id = $3)
       AND ($4::varchar IS NULL OR o.location_mode = $4)`,
    [window.since, window.until ?? new Date(), window.tenantId ?? null, window.locationMode ?? null]
  );
  return ratio(Number(rows[0]?.converted ?? 0), Number(rows[0]?.total ?? 0));
}

/**
 * #84's gate: how often a customer asks about more than one day.
 *
 * Per CALL, not per offer, and location-independent - which is why it reads a different table.
 * Calls the model never surfaced still count: the question is what customers ask for, not what
 * the model chose to show them.
 */
export async function multiDayShare(window: BaselineWindow): Promise<Ratio> {
  const rows: Array<{ multi_day: string; total: string }> = await AppDataSource.query(
    `SELECT
       COUNT(*) FILTER (WHERE requested_end_date > requested_start_date) AS multi_day,
       COUNT(*) AS total
     FROM chatbot_availability_calls
     WHERE range_valid = true
       AND created_at >= $1 AND created_at < $2
       AND ($3::uuid IS NULL OR tenant_id = $3)`,
    [window.since, window.until ?? new Date(), window.tenantId ?? null]
  );
  return ratio(Number(rows[0]?.multi_day ?? 0), Number(rows[0]?.total ?? 0));
}

/**
 * All three at once, which is how a human actually reads them.
 *
 * Also reports how many offers were NOT delivered and how many calls had an unparseable range -
 * both excluded from the ratios above, and both worth seeing, because a baseline computed over a
 * population that is quietly shrinking is the kind of number that looks stable while meaning less
 * every week.
 */
export async function baselineSummary(window: BaselineWindow): Promise<{
  firstOfferAcceptance: Ratio;
  offerConversion: Ratio;
  multiDayShare: Ratio;
  excluded: { rejectedOffers: number; unparseableRanges: number };
}> {
  const [acceptance, conversion, multiDay, excluded] = await Promise.all([
    firstOfferAcceptance(window),
    offerConversion(window),
    multiDayShare(window),
    AppDataSource.query(
      `SELECT
         (SELECT COUNT(*) FROM chatbot_booking_offers
           WHERE delivery_basis = 'provider_rejected'
             AND created_at >= $1 AND created_at < $2
             AND ($3::uuid IS NULL OR tenant_id = $3)) AS rejected_offers,
         (SELECT COUNT(*) FROM chatbot_availability_calls
           WHERE range_valid = false
             AND created_at >= $1 AND created_at < $2
             AND ($3::uuid IS NULL OR tenant_id = $3)) AS unparseable_ranges`,
      [window.since, window.until ?? new Date(), window.tenantId ?? null]
    ) as Promise<Array<{ rejected_offers: string; unparseable_ranges: string }>>,
  ]);
  return {
    firstOfferAcceptance: acceptance,
    offerConversion: conversion,
    multiDayShare: multiDay,
    excluded: {
      rejectedOffers: Number(excluded[0]?.rejected_offers ?? 0),
      unparseableRanges: Number(excluded[0]?.unparseable_ranges ?? 0),
    },
  };
}
