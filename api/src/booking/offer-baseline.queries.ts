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
import { CLOCK_SKEW_GRACE_MS } from './offer-record.service';

/** Only these two count as delivered. Kept as one string so no query can drift from it. */
const DELIVERED = `('provider_accepted', 'widget_assumed')`;

export interface BaselineWindow {
  /** Inclusive lower bound on `created_at`. */
  since: Date;
  /** Exclusive upper bound. Defaults to now, plus a second of clock slack (see `untilBound`). */
  until?: Date;
  /** Narrow to one tenant. Omit for the platform-wide figure. */
  tenantId?: string;
  /** Narrow to one location mode, e.g. `customer_location`. Omit for all. */
  locationMode?: string;
}

/**
 * The exclusive upper bound every query below shares, and why it is not plainly `now`.
 *
 * `created_at` is POSTGRES' clock; a default taken here is THIS process's, read microseconds
 * later. Let the database lead by even a millisecond and the row just inserted satisfies
 * `created_at >= until`, so it drops out of the window - always the newest row, which is the one
 * a caller measuring "what just happened" cares about most. `offer-record.test.ts` failed exactly
 * this way on CI: a multi-day call and an unparseable call written and counted inside the same
 * millisecond, reported as 0.
 *
 * An absent `until` means "everything since", so this bound exists only to keep the eight
 * statements uniform. A second of slack keeps them uniform without letting two clocks decide
 * what is counted. An explicit `until` from a caller is honoured exactly as given.
 */
const untilBound = (window: BaselineWindow): Date =>
  window.until ?? new Date(Date.now() + CLOCK_SKEW_GRACE_MS);

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
    [window.since, untilBound(window), window.tenantId ?? null, window.locationMode ?? null]
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
    [window.since, untilBound(window), window.tenantId ?? null, window.locationMode ?? null]
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
    [window.since, untilBound(window), window.tenantId ?? null]
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
      [window.since, untilBound(window), window.tenantId ?? null]
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

/**
 * LP4's gate, as a query (#81).
 *
 * The epic gated LP5 on "scores stable and affordable, AND cheaper alternatives exist often
 * enough to be worth steering toward". The first two were answered by construction. The third
 * cannot be: it is a fact about real diaries, and it was left open because seeded test diaries
 * only measure what was seeded.
 *
 * Seven columns were written to answer it and nothing read them. That is the failure this closes:
 * a measurement nobody can ask a question of is not a measurement, and by the time the data
 * exists the person who knows which question to ask has moved on.
 *
 * SCORED offers only, everywhere. An offer made while the scorer did not run - no travel
 * entitlement, no anchors, an unconfigured Agent - is not evidence either way, and folding it in
 * would dilute every ratio here toward zero and make the gate look answered when it is not.
 */
export interface ScorerGate {
  /** Offers the scorer actually ran on. Every ratio below is over this population. */
  scoredOffers: number;
  /** THE gate: how often steering had somewhere better to point. */
  cheaperAlternative: Ratio;
  /** Slots it could price, over slots it was shown. Coverage, not accuracy. */
  slotCoverage: Ratio;
  /** Elements bought. Grouping buys only the baseline leg, so this should stay near zero. */
  elements: { total: number; perOffer: number | null };
  /** Milliseconds. The customer waits behind this. */
  latency: { meanMs: number | null; maxMs: number | null };
  /** Distinct scorer versions in the window — two disagreeing is not instability. */
  versions: string[];
}

type ScorerSummaryRow = {
  offers: string;
  cheaper: string;
  elements: string;
  mean_ms: string | null;
  max_ms: string | null;
};
type ScorerSlotRow = { scored: string; total: string };

/** `AVG`/`MAX` return null on an empty window, which is not a latency of zero. */
function scorerLatency(row?: ScorerSummaryRow): ScorerGate['latency'] {
  return {
    meanMs: row?.mean_ms == null ? null : Math.round(Number(row.mean_ms)),
    maxMs: row?.max_ms == null ? null : Number(row.max_ms),
  };
}

function scorerGateResult(
  summary: ScorerSummaryRow[],
  slots: ScorerSlotRow[],
  versions: Array<{ scorer_version: string }>,
): ScorerGate {
  const offers = Number(summary[0]?.offers ?? 0);
  return {
    scoredOffers: offers,
    cheaperAlternative: ratio(Number(summary[0]?.cheaper ?? 0), offers),
    slotCoverage: ratio(Number(slots[0]?.scored ?? 0), Number(slots[0]?.total ?? 0)),
    elements: {
      total: Number(summary[0]?.elements ?? 0),
      perOffer: offers > 0 ? Number(summary[0]?.elements ?? 0) / offers : null,
    },
    latency: scorerLatency(summary[0]),
    versions: versions.map((v) => v.scorer_version),
  };
}

export async function scorerGate(window: BaselineWindow): Promise<ScorerGate> {
  const [summary, slots, versions]: [
    ScorerSummaryRow[],
    ScorerSlotRow[],
    Array<{ scorer_version: string }>,
  ] = (await Promise.all([
    AppDataSource.query(
      `SELECT COUNT(*) AS offers,
              COUNT(*) FILTER (WHERE cheaper_alternative_existed) AS cheaper,
              COALESCE(SUM(scoring_elements), 0) AS elements,
              AVG(scoring_ms) AS mean_ms,
              MAX(scoring_ms) AS max_ms
         FROM chatbot_booking_offers
        WHERE scorer_version IS NOT NULL
          AND delivery_basis IN ${DELIVERED}
          AND created_at >= $1 AND created_at < $2
          AND ($3::uuid IS NULL OR tenant_id = $3)
          AND ($4::text IS NULL OR location_mode = $4)`,
      [window.since, untilBound(window), window.tenantId ?? null, window.locationMode ?? null]
    ),
    // Per SLOT rather than per offer: an offer where one slot of eight scored is not 100% covered,
    // and counting offers would say it was.
    AppDataSource.query(
      `SELECT COUNT(*) FILTER (WHERE (s->>'costMinutes') IS NOT NULL) AS scored,
              COUNT(*) AS total
         FROM chatbot_booking_offers o, jsonb_array_elements(o.offered_slots) s
        WHERE o.scorer_version IS NOT NULL
          AND o.delivery_basis IN ${DELIVERED}
          AND o.created_at >= $1 AND o.created_at < $2
          AND ($3::uuid IS NULL OR o.tenant_id = $3)
          AND ($4::text IS NULL OR o.location_mode = $4)`,
      [window.since, untilBound(window), window.tenantId ?? null, window.locationMode ?? null]
    ),
    AppDataSource.query(
      `SELECT DISTINCT scorer_version
         FROM chatbot_booking_offers
        WHERE scorer_version IS NOT NULL
          AND created_at >= $1 AND created_at < $2
          AND ($3::uuid IS NULL OR tenant_id = $3)
        ORDER BY scorer_version`,
      [window.since, untilBound(window), window.tenantId ?? null]
    ),
  ])) as never;

  return scorerGateResult(summary, slots, versions);
}

/**
 * LP5's cohorts (#82), which only exist once an owner turns the pilot on.
 *
 * THREE populations, and conflating any two makes the comparison meaningless:
 *
 *   - `steered`   — the pilot was on AND the delivered order actually changed
 *   - `pilotHeld` — the pilot was on and it left the order alone
 *   - `shadow`    — the pilot was off; the scorer measured and did nothing
 *
 * `pilotHeld` belongs with `shadow` for a naive before/after and with `steered` for an
 * intention-to-treat reading, which is exactly why they are returned apart rather than summed
 * into a number whose meaning depends on who is reading it.
 */
export async function pilotCohorts(window: BaselineWindow): Promise<{
  steered: number;
  pilotHeld: number;
  shadow: number;
  minutesSaved: number;
}> {
  const rows: Array<{ steered: string; pilot_held: string; shadow: string; minutes: string }> =
    await AppDataSource.query(
      `SELECT COUNT(*) FILTER (WHERE grouping_applied IS TRUE) AS steered,
              COUNT(*) FILTER (WHERE grouping_applied IS FALSE) AS pilot_held,
              COUNT(*) FILTER (WHERE grouping_applied IS NULL AND scorer_version IS NOT NULL) AS shadow,
              COALESCE(SUM(grouping_saved_minutes), 0) AS minutes
         FROM chatbot_booking_offers
        WHERE delivery_basis IN ${DELIVERED}
          AND created_at >= $1 AND created_at < $2
          AND ($3::uuid IS NULL OR tenant_id = $3)`,
      [window.since, untilBound(window), window.tenantId ?? null]
    );
  return {
    steered: Number(rows[0]?.steered ?? 0),
    pilotHeld: Number(rows[0]?.pilot_held ?? 0),
    shadow: Number(rows[0]?.shadow ?? 0),
    minutesSaved: Number(rows[0]?.minutes ?? 0),
  };
}
