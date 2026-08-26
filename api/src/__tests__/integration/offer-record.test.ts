/**
 * #80 (LP3) - the pre-steering baseline, and the rules that make it comparable later.
 *
 * LP5 has to prove that reordering slots helps, which means knowing how often a customer took the
 * FIRST slot offered before anything reordered them. That number cannot be reconstructed
 * afterwards, so the instrument has to be right the first time - a baseline that quietly
 * miscounts is worse than none, because LP5 would be compared against it and believed.
 *
 * The attribution rule is the part two engineers would most easily build differently, so it is
 * tested as the rule rather than as one happy path. Contract: `docs/specs/lp3-offer-record.md`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';

vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { AppDataSource } from '../../database/data-source';
import { AvailabilityCall } from '../../database/entities/AvailabilityCall';
import { BookingOffer } from '../../database/entities/BookingOffer';
import { OfferSelection } from '../../database/entities/OfferSelection';
import { baselineSummary, pilotCohorts, scorerGate } from '../../booking/offer-baseline.queries';
import {
  recordAvailabilityCall,
  recordBookingOffer,
  recordDeliveredOffer,
  recordOfferSelection,
} from '../../booking/offer-record.service';

const tenantId = randomUUID();
const botId = randomUUID();
const serviceId = randomUUID();
let sessionId: string;

const at = (iso: string) => new Date(iso);
const SLOT_A = '2026-09-01T09:00:00.000Z';
const SLOT_B = '2026-09-01T10:00:00.000Z';
const SLOT_C = '2026-09-01T11:00:00.000Z';

const offer = (starts: string[], over: Partial<Parameters<typeof recordBookingOffer>[0]> = {}) =>
  recordBookingOffer({
    tenantId,
    botId,
    sessionId,
    serviceId,
    slots: starts.map((start, i) => ({ start, title: `chip ${i + 1}` })),
    deliveryBasis: 'widget_assumed',
    ...over,
  });

const selections = () => AppDataSource.getRepository(OfferSelection).find();

beforeEach(async () => {
  vi.clearAllMocks();
  sessionId = randomUUID();
});

describe('availability calls - the range metric denominator', () => {
  it('records a call whatever came of it, including one that offered nothing', async () => {
    // Per CALL, not per offer: a call the model discards never becomes an offer, so an
    // offer-level denominator would understate how often customers ask.
    await recordAvailabilityCall({
      tenantId, botId, sessionId, serviceId,
      startDate: '2026-09-01', endDate: '2026-09-01', slotCount: 0,
    });
    const rows = await AppDataSource.getRepository(AvailabilityCall).find({ where: { sessionId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].rangeValid).toBe(true);
    expect(rows[0].slotCount).toBe(0);
  });

  it('marks a malformed range invalid rather than letting it look like a single day', async () => {
    // The failure this guards: a parse failure silently joining the single-day population would
    // understate the multi-day share, which is exactly the number #84's gate turns on.
    await recordAvailabilityCall({
      tenantId, botId, sessionId, startDate: 'next week', endDate: 'whenever', slotCount: 3,
    });
    const [row] = await AppDataSource.getRepository(AvailabilityCall).find({ where: { sessionId } });
    expect(row.rangeValid).toBe(false);
    expect(row.requestedStartDate).toBeNull();
    // The raw ask survives, so a bad range can be diagnosed instead of guessed at.
    expect(row.requestedRangeRaw).toContain('next week');
  });

  it('marks a backwards range invalid too', async () => {
    await recordAvailabilityCall({
      tenantId, botId, sessionId, startDate: '2026-09-05', endDate: '2026-09-01', slotCount: 0,
    });
    const [row] = await AppDataSource.getRepository(AvailabilityCall).find({ where: { sessionId } });
    expect(row.rangeValid).toBe(false);
  });

  it('records a call with no resolved service - a customer asking is still a customer asking', async () => {
    await recordAvailabilityCall({
      tenantId, botId, sessionId, startDate: '2026-09-01', endDate: '2026-09-03', slotCount: 5,
    });
    const [row] = await AppDataSource.getRepository(AvailabilityCall).find({ where: { sessionId } });
    expect(row.serviceId).toBeNull();
    expect(row.requestedEndDate).not.toBe(row.requestedStartDate);
  });
});

describe('what was actually delivered', () => {
  it('pairs the canonical instants with the chips the CHANNEL sent, not what the agent composed', async () => {
    // The finding that resized this ticket. Channels truncate quick replies, and the rendered
    // chip is natural-language text with no recoverable timestamp - so the record needs both, and
    // must stop at what the channel kept.
    await recordDeliveredOffer({
      tenantId,
      sessionId,
      channel: 'whatsapp',
      offer: { botId, serviceId, slotStarts: [SLOT_A, SLOT_B, SLOT_C] },
      // WhatsApp capped it at two.
      deliveredTitles: ['Tue 9:00 AM', 'Tue 10:00 AM'],
      deliveryBasis: 'provider_accepted',
    });

    const [row] = await AppDataSource.getRepository(BookingOffer).find({ where: { sessionId } });
    expect(row.offeredCount).toBe(2);
    expect(row.offeredSlots).toEqual([
      { start: SLOT_A, title: 'Tue 9:00 AM' },
      { start: SLOT_B, title: 'Tue 10:00 AM' },
    ]);
  });

  it('#82: counts as steered only when the DELIVERED prefix actually changed', async () => {
    // The pilot's treatment group has to be offers a customer experienced a reorder in. Channels
    // cap quick replies as low as three, so a reorder happening entirely below the cap changes
    // nothing anybody received - recording it as delivered steering would put an untreated offer
    // in the treatment group and quietly dilute the comparison the pilot exists to make.
    await recordDeliveredOffer({
      tenantId,
      sessionId,
      channel: 'whatsapp',
      offer: {
        botId,
        serviceId,
        slotStarts: [SLOT_A, SLOT_B, SLOT_C],
        groupingPilot: true,
        grouped: { savedMinutes: 40 },
        // Only C and B swapped, and the channel kept just the first two - so what went out is
        // byte-for-byte the order that would have gone out anyway.
        groupingPreviousOrder: [SLOT_A, SLOT_B, SLOT_C],
      },
      deliveredTitles: ['Tue 9:00 AM', 'Tue 10:00 AM'],
      deliveryBasis: 'provider_accepted',
    });

    const [row] = await AppDataSource.getRepository(BookingOffer).find({ where: { sessionId } });
    // Pilot ON, so not null; nothing reached the customer differently, so not true either.
    expect(row.groupingApplied).toBe(false);
    expect(row.groupingSavedMinutes).toBeNull();
  });

  it('#82: records the steering when the delivered prefix DID change', async () => {
    await recordDeliveredOffer({
      tenantId,
      sessionId,
      channel: 'whatsapp',
      offer: {
        botId,
        serviceId,
        slotStarts: [SLOT_C, SLOT_A, SLOT_B],
        groupingPilot: true,
        grouped: { savedMinutes: 40 },
        groupingPreviousOrder: [SLOT_A, SLOT_B, SLOT_C],
      },
      deliveredTitles: ['Tue 11:00 AM', 'Tue 9:00 AM'],
      deliveryBasis: 'provider_accepted',
    });

    const [row] = await AppDataSource.getRepository(BookingOffer).find({ where: { sessionId } });
    expect(row.groupingApplied).toBe(true);
    expect(row.groupingSavedMinutes).toBe(40);
  });

  it('#82: compares instants, not strings, when deciding the delivered order changed', async () => {
    // `previousOrder` is canonical ISO; `slotStarts` is whatever the provider emitted. The same
    // moment written two ways would report a reorder that never happened and put an untouched
    // offer in the treatment group.
    const offsetForm = SLOT_A.replace('Z', '+00:00');
    await recordDeliveredOffer({
      tenantId,
      sessionId,
      channel: 'whatsapp',
      offer: {
        botId,
        serviceId,
        slotStarts: [offsetForm, SLOT_B],
        groupingPilot: true,
        grouped: { savedMinutes: 40 },
        groupingPreviousOrder: [SLOT_A, SLOT_B],
      },
      deliveredTitles: ['Tue 9:00 AM', 'Tue 10:00 AM'],
      deliveryBasis: 'provider_accepted',
    });

    const [row] = await AppDataSource.getRepository(BookingOffer).find({ where: { sessionId } });
    expect(row.groupingApplied).toBe(false);
  });

  it('#82: never records a saving without a verdict, or a verdict without one', async () => {
    // Written against the WRITER, not the dispatch helper. The helper nulls `grouped` on its own
    // before it gets here, so a test routed through it cannot see whether these two columns are
    // decided together — which is the thing that must hold for any caller, now or later.
    await recordBookingOffer({
      tenantId,
      botId,
      sessionId,
      serviceId,
      // Pilot OFF, but a saving present: the shape a stale or mistaken caller produces.
      groupingPilot: false,
      grouped: { savedMinutes: 40 },
      slots: [{ start: SLOT_A, title: 'Tue 9:00 AM' }],
      deliveryBasis: 'provider_accepted',
    });

    const [row] = await AppDataSource.getRepository(BookingOffer).find({ where: { sessionId } });
    // A saving with a null verdict would leave a later reader guessing which to believe.
    expect(row.groupingApplied).toBeNull();
    expect(row.groupingSavedMinutes).toBeNull();
  });

  it('#82: leaves the cohort NULL when the pilot was off, never false', async () => {
    // Three states, and conflating the first two is what makes the pilot unanswerable: null means
    // the feature was off for this offer, false means it was on and left the order alone.
    await recordDeliveredOffer({
      tenantId,
      sessionId,
      channel: 'whatsapp',
      offer: { botId, serviceId, slotStarts: [SLOT_A, SLOT_B] },
      deliveredTitles: ['Tue 9:00 AM', 'Tue 10:00 AM'],
      deliveryBasis: 'provider_accepted',
    });

    const [row] = await AppDataSource.getRepository(BookingOffer).find({ where: { sessionId } });
    expect(row.groupingApplied).toBeNull();
  });

  it('records nothing when the channel dropped the chips entirely', async () => {
    // There was no offer, whatever the agent composed. Recording one would credit the baseline
    // with slots nobody saw.
    const id = await recordDeliveredOffer({
      tenantId, sessionId, channel: 'sms',
      offer: { botId, serviceId, slotStarts: [SLOT_A] },
      deliveredTitles: [],
      deliveryBasis: 'provider_accepted',
    });
    expect(id).toBeNull();
    expect(await AppDataSource.getRepository(BookingOffer).find({ where: { sessionId } })).toHaveLength(0);
  });
});

describe('attribution - the rule two engineers would otherwise build differently', () => {
  it('attributes to the LATEST offer containing that instant', async () => {
    await offer([SLOT_A, SLOT_B]);
    await new Promise((r) => setTimeout(r, 5));
    const latest = await offer([SLOT_C, SLOT_A]);

    const bookingId = randomUUID();
    await recordOfferSelection({
      sessionId, serviceId, bookingId, startUtc: at(SLOT_A), selectionType: 'booking',
    });

    const [row] = await selections();
    expect(row.offerId).toBe(latest);
    // Ordinal is the position in THAT offer - 2, not the 1 it held in the earlier one.
    expect(row.selectedOrdinal).toBe(2);
  });

  it('records ordinal 1, which is the entire point of the baseline', async () => {
    await offer([SLOT_A, SLOT_B]);
    const bookingId = randomUUID();
    await recordOfferSelection({
      sessionId, serviceId, bookingId, startUtc: at(SLOT_A), selectionType: 'booking',
    });
    expect((await selections())[0].selectedOrdinal).toBe(1);
  });

  it('never attributes to an offer whose delivery was REJECTED', async () => {
    // The customer cannot have taken a slot from a message that failed to send.
    await offer([SLOT_A], { deliveryBasis: 'provider_rejected' });
    await recordOfferSelection({
      sessionId, serviceId, bookingId: randomUUID(), startUtc: at(SLOT_A), selectionType: 'booking',
    });
    expect(await selections()).toHaveLength(0);
  });

  it('never attributes to an offer delivered AFTER the booking', async () => {
    const future = await offer([SLOT_A]);
    expect(future).not.toBeNull();
    await recordOfferSelection({
      sessionId, serviceId,
      bookingId: randomUUID(),
      startUtc: at(SLOT_A),
      // The booking happened before the offer existed, so it cannot have come from it.
      bookingCreatedAt: new Date(Date.now() - 60_000),
      selectionType: 'booking',
    });
    expect(await selections()).toHaveLength(0);
  });

  it('attributes a booking recorded a moment BEFORE the offer row it came from', async () => {
    // THE CI FLAKE, pinned. `created_at` is the database's clock in microseconds, read back
    // truncated to milliseconds, and the booking instant is this process's clock - in production
    // not even the same machine. A booking taken in the same millisecond as its offer compared
    // EQUAL and was dropped from the baseline, so `offer-record.test.ts` failed whenever CI was
    // fast enough to do both inside one millisecond, and passed against a slower Docker Postgres.
    //
    // MEASURED AGAINST THE ROW'S OWN TIMESTAMP, not against this process's clock: a test for a
    // clock bug that races the clock is the flake it is meant to remove. Both directions then
    // hold whatever the two clocks read - it attributes with the grace, and skips without it.
    const offerId = await offer([SLOT_A]);
    const row = await AppDataSource.getRepository(BookingOffer).findOneByOrFail({ id: offerId! });
    await recordOfferSelection({
      sessionId,
      serviceId,
      bookingId: randomUUID(),
      startUtc: at(SLOT_A),
      // Half a second BEFORE the offer row exists: the booking cannot have been taken from it by
      // the strict reading, which is exactly what the database leading the API looks like.
      bookingCreatedAt: new Date(row.createdAt.getTime() - 500),
      selectionType: 'booking',
    });
    expect(await selections()).toHaveLength(1);
  });

  it('leaves a booking UNATTRIBUTED rather than guessing', async () => {
    // An owner adding an appointment by hand was never steered and cannot evidence steering.
    // Guessing an offer for it would put a row in the denominator that nothing offered.
    await offer([SLOT_A, SLOT_B]);
    await recordOfferSelection({
      sessionId, serviceId, bookingId: randomUUID(), startUtc: at(SLOT_C), selectionType: 'booking',
    });
    expect(await selections()).toHaveLength(0);
  });

  it('does not attribute across sessions', async () => {
    await offer([SLOT_A]);
    await recordOfferSelection({
      sessionId: randomUUID(), serviceId, bookingId: randomUUID(), startUtc: at(SLOT_A), selectionType: 'booking',
    });
    expect(await selections()).toHaveLength(0);
  });

  it('attributes ONE booking exactly once, however often it is retried', async () => {
    // The uniqueness that matters. A rule on (offer, entity) would still let one Booking land on
    // several offers and be counted twice in every denominator.
    await offer([SLOT_A]);
    const bookingId = randomUUID();
    await recordOfferSelection({ sessionId, serviceId, bookingId, startUtc: at(SLOT_A), selectionType: 'booking' });
    await recordOfferSelection({ sessionId, serviceId, bookingId, startUtc: at(SLOT_A), selectionType: 'booking' });
    expect(await selections()).toHaveLength(1);
  });

  it('freezes what the row WAS - a Request accepted later must not become a conversion', async () => {
    // Derived from current status, every accepted Request would migrate out of expressed-choice
    // and into conversion, and the baseline would improve on its own without anything changing.
    await offer([SLOT_A]);
    await recordOfferSelection({
      sessionId, serviceId, bookingId: randomUUID(), startUtc: at(SLOT_A), selectionType: 'request',
    });
    expect((await selections())[0].selectionType).toBe('request');
  });
});

describe('measurement never breaks a booking', () => {
  it('swallows a write it cannot make', async () => {
    // A statistics row is never worth a lost booking or a lost reply. The cost is a visible gap:
    // an offer missing against a recorded availability call is countable.
    await expect(
      recordBookingOffer({
        tenantId,
        botId,
        sessionId: 'not-a-uuid',
        slots: [{ start: SLOT_A, title: 'x' }],
        deliveryBasis: 'widget_assumed',
      })
    ).resolves.toBeNull();

    await expect(
      recordOfferSelection({
        sessionId: 'not-a-uuid', bookingId: 'also-not', startUtc: at(SLOT_A), selectionType: 'booking',
      })
    ).resolves.toBeUndefined();
  });
});

describe('the canonical baseline, computed once so LP4 and LP5 cannot disagree', () => {
  const since = new Date(Date.now() - 3600_000);

  it('counts ordinal-1 BOOKINGS over attributed bookings', async () => {
    await offer([SLOT_A, SLOT_B]);
    await recordOfferSelection({ sessionId, serviceId, bookingId: randomUUID(), startUtc: at(SLOT_A), selectionType: 'booking' });

    const other = randomUUID();
    sessionId = other;
    await offer([SLOT_A, SLOT_B]);
    await recordOfferSelection({ sessionId, serviceId, bookingId: randomUUID(), startUtc: at(SLOT_B), selectionType: 'booking' });

    const summary = await baselineSummary({ since });
    expect(summary.firstOfferAcceptance).toMatchObject({ numerator: 1, denominator: 2, share: 0.5 });
  });

  it('leaves a REQUEST out of the booking metric but in conversion', async () => {
    // Expressed choice is not conversion. Folding them together would flatter LP5's comparison.
    await offer([SLOT_A]);
    await recordOfferSelection({ sessionId, serviceId, bookingId: randomUUID(), startUtc: at(SLOT_A), selectionType: 'request' });

    const summary = await baselineSummary({ since });
    expect(summary.firstOfferAcceptance.denominator).toBe(0);
    expect(summary.offerConversion.numerator).toBe(1);
  });

  it('excludes a REJECTED delivery from the conversion denominator, and counts it separately', async () => {
    // A message the transport refused is not an offer a customer could have taken. Counted, so a
    // shrinking population is visible rather than quietly making the ratio mean less.
    await offer([SLOT_A], { deliveryBasis: 'provider_rejected' });
    const summary = await baselineSummary({ since });
    expect(summary.offerConversion.denominator).toBe(0);
    expect(summary.excluded.rejectedOffers).toBe(1);
  });

  it('INCLUDES widget_assumed, because dropping it would omit most of the traffic', async () => {
    await offer([SLOT_A], { deliveryBasis: 'widget_assumed' });
    expect((await baselineSummary({ since })).offerConversion.denominator).toBe(1);
  });

  it('answers null rather than zero when nothing has happened yet', async () => {
    // No data is not the same as no uptake, and a 0% baseline would be read as the latter.
    const summary = await baselineSummary({ since: new Date(Date.now() + 3600_000) });
    expect(summary.firstOfferAcceptance.share).toBeNull();
    expect(summary.multiDayShare.share).toBeNull();
  });

  it('counts multi-day over PARSEABLE calls only, and reports the rest', async () => {
    await recordAvailabilityCall({ tenantId, botId, sessionId, startDate: '2026-09-01', endDate: '2026-09-03', slotCount: 2 });
    await recordAvailabilityCall({ tenantId, botId, sessionId, startDate: '2026-09-01', endDate: '2026-09-01', slotCount: 2 });
    await recordAvailabilityCall({ tenantId, botId, sessionId, startDate: 'soon', endDate: 'later', slotCount: 0 });

    const summary = await baselineSummary({ since });
    expect(summary.multiDayShare).toMatchObject({ numerator: 1, denominator: 2 });
    expect(summary.excluded.unparseableRanges).toBe(1);
  });

  it('counts a row whose database clock reads AHEAD of this process', async () => {
    // THE SECOND CI FLAKE, pinned, and the same cross-clock class as the attribution one. Every
    // baseline query bounds the window with `created_at < until`, and an absent `until` used to
    // default to a `new Date()` taken here. `created_at` is Postgres' clock: let it lead by a
    // millisecond and the row just written falls outside the window - always the newest row.
    // CI wrote three calls and counted them inside the same millisecond, and reported 0.
    await recordAvailabilityCall({ tenantId, botId, sessionId, startDate: 'soon', endDate: 'later', slotCount: 0 });
    // The lead is written from THIS process's clock, not `now()`, so both directions hold
    // whatever the database clock reads: 200ms ahead of here is inside a 1000ms grace and
    // outside a bare `new Date()`. Racing the real clocks would rebuild the flake being fixed.
    await AppDataSource.query(
      `UPDATE chatbot_availability_calls SET created_at = $2 WHERE session_id = $1`,
      [sessionId, new Date(Date.now() + 200)],
    );

    const summary = await baselineSummary({ since });
    expect(summary.excluded.unparseableRanges).toBe(1);
  });
});

/**
 * #81's gate, and #82's cohorts, as queries.
 *
 * Seven measurement columns were written across LP4 and LP5 and NOTHING read them. A measurement
 * nobody can ask a question of is not a measurement — and by the time the data exists, the person
 * who knew which question to ask has moved on. These tests pin the arithmetic while that is still
 * fresh, on rows shaped exactly like the ones production writes.
 */
describe('the scorer gate (#81) and the pilot cohorts (#82)', () => {
  const since = new Date('2026-01-01T00:00:00.000Z');

  /** One offer row, with only the fields a given case is about. */
  const offer = (over: Partial<BookingOffer>) =>
    AppDataSource.getRepository(BookingOffer).save(
      AppDataSource.getRepository(BookingOffer).create({
        tenantId,
        botId,
        sessionId: randomUUID(),
        offeredSlots: [{ start: SLOT_A, title: '9:00 AM' }],
        offeredCount: 1,
        deliveryBasis: 'widget_assumed',
        ...over,
      } as BookingOffer)
    );

  it('measures the gate over SCORED offers only', async () => {
    // An offer made while the scorer did not run is not evidence either way. Folding it in would
    // drag every ratio toward zero and make the gate read as answered when it is not.
    await offer({ scorerVersion: 'lp4-1', cheaperAlternativeExisted: true, scoringElements: 1, scoringMs: 40 });
    await offer({ scorerVersion: 'lp4-1', cheaperAlternativeExisted: false, scoringElements: 0, scoringMs: 20 });
    await offer({}); // scorer never ran — must not appear in any denominator

    const gate = await scorerGate({ since });

    expect(gate.scoredOffers).toBe(2);
    expect(gate.cheaperAlternative).toMatchObject({ numerator: 1, denominator: 2, share: 0.5 });
    expect(gate.elements.total).toBe(1);
    expect(gate.latency.maxMs).toBe(40);
    expect(gate.versions).toEqual(['lp4-1']);
  });

  it('measures coverage per SLOT, not per offer', async () => {
    // An offer where one slot of three scored is not fully covered, and counting offers says it is.
    await offer({
      scorerVersion: 'lp4-1',
      offeredSlots: [
        { start: SLOT_A, title: 'a', costMinutes: 12 },
        { start: SLOT_B, title: 'b', costMinutes: null, neutralReason: 'unanchored' },
        { start: SLOT_C, title: 'c', costMinutes: null, neutralReason: 'straddles_boundary' },
      ],
      offeredCount: 3,
    });

    const gate = await scorerGate({ since });
    expect(gate.slotCoverage).toMatchObject({ numerator: 1, denominator: 3 });
  });

  it('keeps the three pilot cohorts apart', async () => {
    // Conflating any two makes the comparison meaningless: `pilotHeld` belongs with `shadow` for a
    // naive before/after and with `steered` for intention-to-treat, which is why they are separate.
    await offer({ scorerVersion: 'lp4-1', groupingApplied: true, groupingSavedMinutes: 63 });
    await offer({ scorerVersion: 'lp4-1', groupingApplied: false });
    await offer({ scorerVersion: 'lp4-1' }); // pilot off — shadow

    const cohorts = await pilotCohorts({ since });

    expect(cohorts).toMatchObject({ steered: 1, pilotHeld: 1, shadow: 1, minutesSaved: 63 });
  });

  it('answers null rather than zero when nothing was scored', async () => {
    // No data is not the same as no uptake, and a gate that reports 0% on an empty window would be
    // read as "steering never helps" by whoever glances at it first.
    const gate = await scorerGate({ since });
    expect(gate.scoredOffers).toBe(0);
    expect(gate.cheaperAlternative.share).toBeNull();
    expect(gate.elements.perOffer).toBeNull();
    expect(gate.latency.meanMs).toBeNull();
  });

  it('ignores an offer the transport rejected', async () => {
    // Same rule the baseline already applies: a message the channel refused is not an offer a
    // customer could have taken, so it cannot evidence whether steering would have helped.
    await offer({ scorerVersion: 'lp4-1', cheaperAlternativeExisted: true, deliveryBasis: 'provider_rejected' });
    expect((await scorerGate({ since })).scoredOffers).toBe(0);
  });
});
