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
