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
}): Promise<string | null> {
  if (!input.slots.length) return null;
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
      })
    );
    return row.id;
  } catch (error) {
    logger.warn('[offer-record] could not record a delivered offer', { error });
    return null;
  }
}

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
      if (offer.createdAt.getTime() >= before.getTime()) continue;
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
  offer: { botId: string; serviceId?: string | null; availabilityCallId?: string | null; locationMode?: string | null; slotStarts: string[] };
  deliveredTitles: string[];
  deliveryBasis: OfferDeliveryBasis;
}): Promise<string | null> {
  const paired: OfferedSlot[] = input.deliveredTitles
    .slice(0, input.offer.slotStarts.length)
    .map((title, i) => ({ start: input.offer.slotStarts[i], title }));
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
  });
}
