import type { BookingAddressReplyFact, ToolAdapter, ToolContext, ToolResult } from '../tool-adapter';
import { addressForTurn, addressToken, type TurnAddress } from '../../booking/travel/address-for-turn';
import { getPendingCorrection } from '../../booking/travel/address-binding';
import {
  checkAvailability,
  createBooking,
  requestBooking,
  listBookings,
  rescheduleBooking,
  cancelBooking,
  BookingError,
} from '../../booking/booking.service';
import { emitWebhookEvent, buildEventBase } from '../../webhooks/webhook.emitter';
import { ChatSession } from '../../database/entities/ChatSession';
import type { AppointmentBookedEvent } from '../../webhooks/webhook.types';
import type {
  AvailabilityResult,
  CreateBookingResult,
  EmptyRangeDiagnosis,
  TravelFilterSummary,
} from '../../booking/booking-providers/types';
import { retryRange } from '../../booking/booking-providers/booking-dates';
import { logger } from '../../utils/logger';
import { XSSProtectionService } from '../../security/xss-protection';
import { autocompleteAddress } from '../../booking/travel/places.service';
import { isCompleteCustomerAddress } from '../../booking/booking-providers/contact';
import { canRenderAddressControls } from '../../channels/address-controls';
import { randomUUID } from 'crypto';
import { contentToText } from '../../llm/llm.types';
import { latestCustomerTimeText, localClockTimes, namesSingleOfferedTime, unofferedSingleTimeIn } from '../clock-times';
import { rememberOfferedSlots, resolveBookingTime } from '../offered-slots-store';
import { refuseUnlessConfirmed, refuseUnlessRescheduleConfirmed, refuseUnlessCancelConfirmed, isAffirmativeReply, isConfirmingChip, lastCustomerUtterance } from '../pending-booking-confirmation';
import { DateTime } from 'luxon';

/**
 * The platform's own address check, reused rather than re-invented.
 *
 * Two other call sites already have this regex; a third copy is a third thing to keep in step.
 */
const emails = new XSSProtectionService();

async function addressPickerAffordance(
  ctx: ToolContext,
  reason: 'unverified' | 'too_vague',
  query: string | undefined,
) {
  if (!canRenderAddressControls(ctx.channel) || !query) return {};
  if (ctx.channel === 'widget') {
    return { affordance: { kind: 'address_picker' as const, reason, query } };
  }

  const result = await autocompleteAddress(ctx.tenantId, query);
  if (result.status !== 'ok' || !result.suggestions.length) return {};
  return {
    affordance: {
      kind: 'address_picker' as const,
      reason,
      query,
      // Three is the tightest supported Meta limit (WhatsApp), so one persisted reply renders
      // identically on Messenger, Instagram and WhatsApp.
      options: result.suggestions.slice(0, 3).map((suggestion) => ({
        // #97 D3: a random per-offer token, written as an offer row in the reply-persist transaction
        // and placed in the button. NOT a hash of the place, so an old render's button can never
        // consume a newer re-offer for the same place.
        id: randomUUID(),
        placeId: suggestion.placeId,
        text: suggestion.text,
      })),
    },
  };
}

/**
 * An address the confirmation can actually reach, or an error the model can fix.
 *
 * REJECTED AT THE TOOL, not stored and hoped for. Found by testing: `not-an-email` was accepted
 * and the booking confirmed, so the customer was told they were booked, the confirmation had
 * nowhere to go, and their manage link was unreachable. Nothing downstream fails loudly enough to
 * notice - `EmailService.send` returns `{ success: false }` rather than throwing.
 *
 * Returns null when there is nothing to check: email is optional on some paths, and absent is a
 * different thing from wrong.
 */
function rejectBadEmail(email: unknown): ToolResult | null {
  if (typeof email !== 'string' || !email.trim()) return null;
  if (emails.sanitizeEmail(email)) return null;
  return {
    success: false,
    error:
      'That email address is not valid, so the confirmation could not reach the customer. Ask them to check it and repeat it back, then try again. Do not book with it as given.',
    errorSafeForModel: true,
  };
}

/**
 * Surface a BookingError's machine-readable code to the LLM (e.g. "ADDRESS_REQUIRED:
 * …"), so the agent can branch on the codes the SERVICES prompt rules reference
 * (ADDRESS_REQUIRED / PHONE_REQUIRED / SERVICE_REQUIRED / SLOT_UNAVAILABLE / etc.).
 */
// R31: a BookingError is an authored DOMAIN error (its code + message are safe to
// show the model and help it respond well). Anything else is an unexpected infra
// exception — return it unmarked so the agent sanitizes it before the model sees it.
function toolError(err: unknown, fallback: string): { error: string; errorSafeForModel: boolean } {
  if (err instanceof BookingError) return { error: `${err.code}: ${err.message}`, errorSafeForModel: true };
  return { error: err instanceof Error ? err.message : fallback, errorSafeForModel: false };
}

/**
 * What the tool ACTUALLY booked against, said back to the model.
 *
 * Observed live on production, twice, on two different tools: the customer was told "your
 * appointment at Kerkstraat 12 is confirmed" while the row held Grote Markt 1 - the BOUND address,
 * which is the correct one to use. The data was right and the customer was misinformed, so they
 * would wait at one door while the business drove to another. The same outcome as #95, reached
 * from the opposite direction.
 *
 * The model was not being careless. It was UNINFORMED: `addressForTurn` silently replaces the
 * model's `customerAddress` argument with the customer's own choice, the result carried no address
 * at all, and so the only address the model knew was the one it had asked for. Reporting that was
 * the only thing it could do.
 *
 * This is the rule #92 produced and nobody implemented - a tool result should echo the RESOLVED
 * inputs it acted on, not only the outcome. It rides on `data` deliberately, unlike an affordance:
 * this one IS for the model, because the sentence it writes is the thing being corrected.
 */
function addressEcho(resolved: string | undefined): Record<string, string> {
  if (!resolved) return {};
  return {
    customerAddress: resolved,
    addressNote:
      `This appointment is at ${resolved}. Use THIS address when you tell the customer, ` +
      `even if they or you named a different one earlier.`,
  };
}

function addressReplyFact(
  address: string | undefined,
  use: BookingAddressReplyFact['use'],
  ...candidates: Array<string | undefined>
): { replyFact: BookingAddressReplyFact } | Record<string, never> {
  if (!address?.trim()) return {};
  const alternatives = [...new Set(
    candidates
      .map((candidate) => candidate?.trim())
      .filter((candidate): candidate is string => Boolean(candidate) && candidate !== address.trim())
  )];
  return {
    replyFact: {
      kind: 'booking_address',
      address,
      use,
      alternatives,
    },
  };
}

const NAMED_TIME_GUIDANCE =
  'The customer already named this time and it is free. Confirm THAT time only. Do not list or offer other times. Call create_booking if you have their name. If it returns CONFIRMATION_REQUIRED, send a short summary of the service, date, time, name, and the final price from that service\'s SERVICES line when one is shown, then wait for an explicit yes. Do not tell them they are booked. Naming the time in the same message that gave their details is not confirmation. A tapped slot button after you asked is confirmation - then call create_booking again.';
const NAMED_TIME_AFTER_YES =
  'The customer already confirmed this time. Call create_booking now with the same details. Do not send another summary and do not ask for confirmation again.';

/**
 * The customer named a time this call has just ruled out.
 *
 * The positive twin below has existed since the model started re-offering hours somebody had
 * already chosen. Its absence said nothing, and "nothing" is what produced the 2026-08-26
 * failure: asked for 10:00 on a diary whose 15-minute pre-buffer ran into a 09:45 appointment,
 * the bot answered "10:00 is available" and only the create call refused it. A time this call
 * did not offer is a fact the tool knows and the model was left to infer.
 */
const NAMED_TIME_UNAVAILABLE_GUIDANCE =
  'That time is NOT in "slots", so it cannot be booked - the appointment length, the buffers around it, or another appointment rules it out. Never tell the customer it is available and never invent a time that is not in "slots": say plainly that it cannot be done, and offer the times in "slots" instead.';

function lastCustomerText(ctx: ToolContext): string {
  const history = ctx.conversationHistory;
  if (!Array.isArray(history)) return '';
  return latestCustomerTimeText(
    history.map((m) => ({ role: m.role, text: contentToText(m.content) })),
  );
}

/** Zoneless local ISO — the format create_booking/request_appointment already document. */
const WALL_CLOCK = "yyyy-MM-dd'T'HH:mm:ss";

/**
 * An instant, said in the business's own wall clock.
 *
 * THE MODEL IS NEVER SHOWN AN OFFSET, because it reads the digits rather than the zone. On
 * 2026-08-26 a Brussels bot asked for "the next valid time" answered 08:30 from a
 * `2026-10-09T08:30:00.000Z` slot that starts at 10:30 local, half an hour before the business
 * opens, while its own slot buttons said 10:30. The same call had already claimed 10:00 was free
 * off a `T10:00:00Z` slot that is 12:00 local. Both sentences are correct arithmetic on a string
 * nobody should have handed it.
 *
 * The result is also exactly what the booking tools ask for when the model constructs a time, so
 * copying a slot start verbatim is now right by construction rather than by luck.
 */
function wallClock(instant: string, timezone: string): string {
  const dt = DateTime.fromISO(instant, { zone: 'utc' }).setZone(timezone);
  // Unparseable can only be a fixture: keep the value rather than lose the slot.
  return dt.isValid ? dt.toFormat(WALL_CLOCK) : instant;
}

function wallClockSlots<T extends { start: string; end: string }>(slots: T[], timezone: string): T[] {
  return slots.map((s) => ({ ...s, start: wallClock(s.start, timezone), end: wallClock(s.end, timezone) }));
}


/**
 * What the model is told about the one time the customer named.
 *
 * Compared against the clock times of the slots this very call produced, so "free" and "not
 * free" are the same fact the write path will re-check seconds later. A requestable travel time
 * is neither: it is offerable as a request, so it must not be called unavailable.
 */
function namedTimeGuidance(
  ctx: ToolContext,
  offered: { confirmable: string[]; requestable: string[] },
  guidance?: string,
): Record<string, unknown> {
  const known = [...offered.confirmable, ...offered.requestable];
  if (known.length === 0) return {};
  const said = lastCustomerText(ctx);
  const append = (line: string) => (guidance ? `${guidance} ${line}` : line);
  if (namesSingleOfferedTime(said, offered.confirmable)) {
    const last = lastCustomerUtterance(ctx);
    const alreadyYes =
      isAffirmativeReply(last) ||
      offered.confirmable.some((clock) => isConfirmingChip(last, `1970-01-01T${clock}`));
    return {
      requestedTimeAvailable: true,
      guidance: append(alreadyYes ? NAMED_TIME_AFTER_YES : NAMED_TIME_GUIDANCE),
    };
  }
  const ruledOut = unofferedSingleTimeIn(said, known);
  if (ruledOut) {
    return { requestedTimeUnavailable: ruledOut, guidance: append(NAMED_TIME_UNAVAILABLE_GUIDANCE) };
  }
  return {};
}

/** The availability result minus the two fields split off before any branch reads it. */
type AvailabilityModel = Omit<AvailabilityResult, 'grouping' | 'emptyRange'>;
type AvailabilitySlots = AvailabilityResult['slots'];

/** The only two location choices the schema accepts; anything else is "not stated". */
function locationChoiceArg(value: unknown): 'business' | 'customer' | undefined {
  return value === 'business' || value === 'customer' ? value : undefined;
}

/**
 * OFFER TO VERIFY THE ADDRESS, computed beside `measurement` and returned from every
 * branch below for exactly the reason stated there: this tool has four exits, and something
 * attached only at the last one ships from none of the others. Three of those exits are the
 * interesting cases - a fully requestable result, an empty range, a vague address - so
 * attaching it at the end would have offered the picker only when nothing was wrong.
 *
 * `result.travel` is the whole gate. Travel applies only to a service whose
 * `customerAddressRequired` is set (`booking-place.ts:80`), so its presence IS the server
 * saying this job happens at the customer's door. Paired with "no verified place bound yet"
 * (`chosen.placeId` is written only by `/places/select`), it names the one moment a picker
 * changes anything - and suggestions are billed per request, so offering it anywhere else
 * spends the tenant's money on a question with no answer worth having.
 *
 * A city name is not that moment. Autocomplete of "Antwerp" returns the city and the
 * station, which then ship as booking location options. The picker verifies a door the
 * customer already gave; it must not invent a place for them.
 *
 * NEITHER IS A CONFIRMABLE TIME, which is why the count gates every other test. The picker
 * does not sit beside the answer, it TAKES the answer's controls: on Meta channels
 * `renderChannelAddressControls` (`channels/address-controls.ts:43`) replaces the reply's
 * slot quick replies with the numbered address options. A customer who had been given a
 * bookable time was shown one address option and asked which day and time they wanted
 * (live report: Passtraat, Sint-Niklaas, 2026-09-01). A slot that survived the travel gate
 * was measured against this address already, so verifying it is record-tidying and must
 * never cost the customer their chips; the wrong-door risk stays covered at booking time by
 * `rejectUnsettledAddress` below. `addressTooVague` still reaches the picker because a
 * coarse placement yields no confirmable slots (`internal.provider.ts:580`).
 */
async function availabilityAffordance(
  ctx: ToolContext,
  travel: TravelFilterSummary | undefined,
  chosen: TurnAddress,
  confirmableSlotCount: number,
) {
  if (confirmableSlotCount > 0) return {};
  if (!travel || chosen.placeId) return {};
  if (!isCompleteCustomerAddress(chosen.address)) return {};
  return addressPickerAffordance(ctx, travel.addressTooVague ? 'too_vague' : 'unverified', chosen.address);
}

/**
 * #82: computed beside `measurement`, and for the same reason - the branches below
 * return before the final one, so anything attached only at the end silently never ships.
 */
function groupingNote(travel: TravelFilterSummary | undefined): Record<string, string> {
  const customerReason = travel?.grouped?.customerReason;
  if (!customerReason) return {};
  return {
    groupingNote: `The times in "slots" are already in the best order for this business. Offer them in the order given and do not re-sort them. If the customer asks why the first one is suggested, you may say: "${customerReason}" Never invent a different reason, and never mention other customers or their addresses.`,
  };
}

/**
 * ONE list, said two ways: the model is given the business's wall clock, the server keeps
 * the instants. Both come out of the same call, so the sentence the model writes and the
 * buttons the customer taps can no longer disagree - which is precisely what happened
 * while the model was left to convert a `Z` instant for itself.
 */
function modelFacingResult(result: AvailabilityModel, utcSlots: AvailabilitySlots, zone: string) {
  const slots = wallClockSlots(utcSlots, zone);
  const travel = result.travel;
  if (!travel) return { ...result, slots };
  return {
    ...result,
    slots,
    travel: {
      ...travel,
      requestableSlots: wallClockSlots(travel.requestableSlots ?? [], zone),
      unreachableSlots: wallClockSlots(travel.unreachableSlots ?? [], zone),
    },
  };
}

/**
 * The chips, the offer record and the invented-time guard all need real instants. They
 * travel OFF `data` for the same reason `measurement` does: `data` is what the model reads.
 */
function availabilityFacts(result: AvailabilityModel, utcSlots: AvailabilitySlots, zone: string) {
  const travel = result.travel;
  const facts = {
    slots: utcSlots,
    timezone: zone,
    serviceId: result.serviceId,
    serviceName: result.serviceName,
    locationMode: result.locationMode,
  };
  if (!travel) return { availability: facts };
  return {
    availability: {
      ...facts,
      // Offered in prose, so the reply guard must know them: they are times the
      // customer may legitimately name even though no chip carries them.
      requestableSlots: travel.requestableSlots ?? [],
      travel: {
        groupingPilot: travel.groupingPilot,
        grouped: travel.grouped,
        groupingPreviousOrder: travel.groupingPreviousOrder,
      },
    },
  };
}

/**
 * Judged on the CLOCK TIMES this call offered, so "free" and "not free" are the same fact
 * the create call will re-check seconds later.
 */
function offeredClockTimes(
  utcSlots: AvailabilitySlots,
  travel: TravelFilterSummary | undefined,
  zone: string,
): { confirmable: string[]; requestable: string[] } {
  return {
    confirmable: localClockTimes(utcSlots, zone) ?? [],
    requestable: localClockTimes(travel?.requestableSlots ?? [], zone) ?? [],
  };
}

/** What to do with a result whose remaining times all need a drive nobody has measured. */
function travelGuidance(travel: TravelFilterSummary): string {
  return travel.addressTooVague
    ? 'That address was only located to the town, so no time here can be confirmed automatically. Ask the customer for their postcode and call check_availability again — with a precise address most of these times can be confirmed outright. If they cannot give one, offer the times in travel.requestableSlots and capture the one they choose with request_appointment, saying plainly it is a request the business will confirm.'
    : 'Times in "slots" can be confirmed now. Times in "travel.requestableSlots" are further away and the journey has not been measured, so they CANNOT be auto-confirmed: offer them as times the business will confirm, and if the customer picks one, capture it with request_appointment rather than create_booking. Never present a requestable time as booked.';
}

/** Where to look instead, said as a range the business can actually take. */
function outOfWindowGuidance(
  outOfWindow: EmptyRangeDiagnosis,
  retry: { startDate: string; endDate: string },
): string {
  return (
    (outOfWindow.reason === 'too_soon'
      ? 'That range is too soon: this business needs more notice than that.'
      : outOfWindow.reason === 'too_far'
        ? 'That range is further ahead than this business takes bookings.'
        : 'This service already has its maximum number of bookings for that date, so NO time on that date can be booked - not the one they asked for and not any other hour.') +
    ` Call check_availability again with startDate ${retry.startDate} and endDate ${retry.endDate}, then offer the customer the times it returns.` +
    (outOfWindow.reason === 'service_day_full'
      ? ' SAY THE REASON: tell the customer plainly that this service is fully booked for that whole date because the business limits how many of these appointments it takes per day.' +
        ' Do NOT say only the time they asked for is unavailable, and do NOT offer another time on that same date - a second time on that date is refused for the same reason.' +
        ' Checking the same date again returns the same nothing, so do not repeat it.' +
        ' Offer ONLY times that call gives you.' +
        ' This does NOT mean the business is closed, so do not say that.'
      : ' Checking the same range again returns the same nothing, so do not repeat it.' +
        ' Offer ONLY times that call gives you: the notice and the horizon say nothing about opening hours, so do not work out a date yourself and do not promise the customer the soonest one.' +
        ' This does NOT mean the business is closed or fully booked, so do not say either.') +
    ' This service books automatically: do NOT capture it with request_appointment, do NOT offer to have anyone confirm the appointment by hand, and do not hand off - there are times this customer can book, and your job is to find them and offer them now.'
  );
}

export class CheckAvailabilityTool implements ToolAdapter {
  name = 'check_availability';
  description = 'Check available appointment slots for a given date range and service.';
  parameters = {
    type: 'object',
    properties: {
      startDate: {
        type: 'string',
        description:
          'Start date in ISO 8601 format (e.g. 2026-04-01). Ask for the day the customer actually named. If they said a specific date, set startDate and endDate to THAT date - do not widen it into a week around it.',
      },
      endDate: {
        type: 'string',
        description:
          'End date in ISO 8601 format (e.g. 2026-04-07). Same as startDate whenever the customer named one day. Only widen the range when they were genuinely open about when - "sometime next week", "any day that suits" - and never past seven days.',
      },
      serviceId: {
        type: 'string',
        description:
          'The id of the service to check (from the SERVICES list). Omit only when the business has a single service.',
      },
      durationMin: {
        type: 'number',
        description:
          "For a service whose duration is a range or AI-estimated (flagged in the SERVICES list), the chosen/estimated length in minutes, so the offered slots fit. Omit for fixed-duration services. Pass a single number (e.g. 60), never a range string.",
      },
      locationChoice: {
        type: 'string',
        enum: ['business', 'customer'],
        description:
          "For a service flagged 'customer chooses location': where the appointment happens. 'business' = at the premises (no address). 'customer' = at theirs (then also pass customerAddress). Required for those services; omit otherwise.",
      },
      customerAddress: {
        type: 'string',
        description:
          "The customer's full appointment address as one string (street, house number, postal code, and city for a Belgian address). Required when the SERVICES entry flags 'needs address', or when it flags 'customer chooses location' AND locationChoice is 'customer'. A city name or the business location is not enough and returns ADDRESS_REQUIRED.",
      },
      customerPhone: {
        type: 'string',
        description:
          "The customer's contact phone number. Required if the SERVICES entry flags 'needs phone'. Calling without it returns PHONE_REQUIRED: ask for the number and call again. Do not treat that as the service being unavailable.",
      },
    },
    required: ['startDate', 'endDate'],
  };
  hasSideEffects = false;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      // The customer's own choice beats the model's reconstruction of it. This is the path that
      // MATTERS for travel: slots are filtered here, before any booking exists, so an address
      // that differs between checking and creating would clear a slot against one place and
      // confirm it against another.
      const chosen = await addressForTurn(
        ctx.sessionId,
        args.customerAddress as string | undefined
      );
      const locationChoice = locationChoiceArg(args.locationChoice);
      const full = await checkAvailability(
        'agent',
        ctx.sessionId,
        args.startDate as string,
        args.endDate as string,
        args.serviceId as string | undefined,
        args.durationMin as number | undefined,
        chosen.address,
        locationChoice,
        args.customerPhone as string | undefined,
      );
      // #81 (LP4) SPLIT FIRST, before any branch below can spread `result` into a payload. `data`
      // is serialised into the tool message the model reads and truncated at 4000 characters, so
      // scoring left on it teaches a model that is meant to be unaware of any ranking AND competes
      // with the slot list for that budget - a shadow feature able to break the real one. Splitting
      // at the single early return instead would leak through the two branches that return sooner.
      // `emptyRange` splits off here for the same reason, and one more: its `boundary` is a
      // POLICY instant (now + notice, or now + horizon), not a bookable time. On a Wednesday-only
      // 09:00-17:00 diary a notice bound landed on a Friday at 20:26. Left on `data` the model
      // reads it as the next appointment and says so, and the invented-time guard cannot catch
      // it because a turn that offered no slots has no clock times to judge against. Only the
      // retry RANGE derived from it is safe to say out loud.
      const { grouping, emptyRange, ...result } = full;
      const measurement = grouping ? { measurement: { grouping } } : {};
      // Read before the affordance because the affordance is gated on it: a confirmable slot
      // keeps its quick replies. Only `result.slots` is needed, and that exists above.
      const utcSlots = Array.isArray(result.slots) ? result.slots : [];
      const affordance = await availabilityAffordance(ctx, result.travel, chosen, utcSlots.length);
      const replyFact = addressReplyFact(
        chosen.address,
        'availability',
        args.customerAddress as string | undefined,
        chosen.proposedAddress
      );
      const groupedNote = groupingNote(result.travel);
      const zone = result.timezone ?? 'UTC';
      const modelResult = modelFacingResult(result, utcSlots, zone);
      const availability = availabilityFacts(result, utcSlots, zone);
      const offeredClocks = offeredClockTimes(utcSlots, result.travel, zone);
      const withNamedTime = (data: Record<string, unknown>) => ({
        ...data,
        ...namedTimeGuidance(ctx, offeredClocks, data.guidance as string | undefined),
      });
      // The booking tools later need to tell a verbatim slot instant (keep the Z) from a time
      // the model constructed from the customer's words (strip the Z). That judgement needs the
      // exact strings this call returned, which may be turns behind the booking.
      if (utcSlots.length > 0) {
        void rememberOfferedSlots(
          ctx.sessionId,
          utcSlots.map((s) => s.start),
          zone,
        );
      }
      // TRAVEL TIME FIRST, because a result can be entirely requestable — every candidate time
      // needs a drive nobody has measured — and that is NOT an empty range. Handled after the
      // empty-slots branch below it would be read out as "no times in this range", which turns
      // a list of perfectly askable times into a dead end.
      const travel = result?.travel;
      if (travel && travel.requestableSlots.length > 0) {
        return {
          success: true,
          ...measurement,
          ...availability,
          ...affordance,
          ...replyFact,
          data: withNamedTime({
            ...modelResult,
            ...groupedNote,
            ...addressEcho(chosen.address),
            suggestedAction: 'request_appointment',
            guidance: travelGuidance(travel),
          }),
        };
      }
      // THE RANGE WAS OUT OF BOUNDS, WHICH IS NOT AN EMPTY DIARY. Checked before the empty
      // branch below because it is a strictly better-informed version of it: both see no slots,
      // and only this one knows the business would have taken the customer on another day.
      //
      // Two live reports, one cause. An auto-book service with 1440 minutes of notice was asked
      // for the next morning, and one with a 14-day horizon was asked for the fifteenth day.
      // The engine refused both correctly, the branch below then advised a manual request, and
      // the bot offered to send the appointment for someone to confirm by hand - on a service
      // whose owner had chosen automatic booking, with bookable times sitting one day away. The
      // second report notes the customer had to ask a second time before the bot would name
      // them. Naming a DESTINATION here is what makes the retry land somewhere different: told
      // only "nothing in this range", a model re-checks the same day and gets the same nothing.
      //
      // A RANGE, never the bound itself. The bound is `now + notice` or `now + horizon`, which is
      // a policy instant and not an opening time: on a Wednesday-only 09:00-17:00 diary the notice
      // bound fell on a Friday at 20:26, and the first bookable slot was the following Wednesday.
      // Stated out loud that is a time the business cannot take, coming from the server, which the
      // model trusts over its own guess.
      const outOfWindow = emptyRange;
      if (outOfWindow) {
        const retry = retryRange(outOfWindow.reason, outOfWindow.boundary, zone);
        return {
          success: true,
          ...measurement,
          ...availability,
          ...affordance,
          ...replyFact,
          data: withNamedTime({
            ...modelResult,
            ...groupedNote,
            ...addressEcho(chosen.address),
            noSlotsInRange: true,
            suggestedAction: 'check_availability',
            guidance: outOfWindowGuidance(outOfWindow, retry),
          }),
        };
      }
      // An empty slot list is the single most consequential result this tool returns, and
      // until now the ONLY thing telling the model what to do about it was a prompt rule.
      // Prose is the right place for the wording; it is the wrong place for the decision.
      // A model that reads `slots: []` and concludes "they're fully booked" has just told a
      // customer to go elsewhere — the actual answer is always to capture a request.
      if (Array.isArray(result?.slots) && result.slots.length === 0) {
        return {
          success: true,
          ...measurement,
          ...availability,
          ...affordance,
          ...replyFact,
          data: withNamedTime({
            ...modelResult,
            ...groupedNote,
            ...addressEcho(chosen.address),
            noSlotsInRange: true,
            suggestedAction: 'request_appointment',
            guidance:
              'No auto-confirmable times in this range. This does NOT mean the business is closed or fully booked, and it does NOT mean a listed auto-book service is unavailable. Do not turn the customer away and do not hand off. If the chosen service flags "needs phone" and you have no number yet, ask for it, keep the date they named, and do not capture a request. Otherwise ask for their preferred date and time and capture it with request_appointment, making clear the business will confirm it.',
          }),
        };
      }
      return {
        success: true,
        data: withNamedTime({ ...modelResult, ...groupedNote, ...addressEcho(chosen.address) }),
        ...measurement,
        ...availability,
        ...affordance,
        ...replyFact,
      };
    } catch (err) {
      return { success: false, ...toolError(err, 'Failed to check availability') };
    }
  }
}

/**
 * THE ONE TOOL THAT MAY ASK, and it has to claim the right to before it does.
 *
 * `correctionPending` says the address is contested; it does not say asking is allowed.
 * ASKED is written exactly once per proposal, so a second attempt at the same booking
 * proceeds on the widget rather than refusing again. A customer whose address Google cannot
 * suggest is asked once and can still get the appointment at the address they chose. A
 * surface without controls degrades to a Request instead of guessing.
 *
 * The claim lives here rather than in `addressForTurn` because the other two tools call that
 * too, and neither of them can ask: `check_availability` is read-only and may be called
 * speculatively, and `request_appointment` never refuses over a contested address at all.
 * ASK ONLY IF THE QUESTION HAS NOT ALREADY REACHED THEM.
 *
 * Four guards have stood here, each counting something adjacent: proposals (three tools
 * propose, one asks), claims (a second call in the same batch booked past an unread tool
 * result), agent runs (the coalescer re-runs one message with a fresh id), and finally a SQL
 * lookup for the reply - which was forgeable, because `/widget/message` stores
 * customer-supplied metadata verbatim.
 *
 * `asked` is now set where the reply is PERSISTED, so the state means what the SQL was
 * asked to find out, in the same store as everything else it guards. Nothing claims; delivery
 * decides. Two concurrent asks are harmless: both refuse, and only one reply is delivered.
 */
async function rejectUnsettledAddress(ctx: ToolContext, booked: TurnAddress): Promise<ToolResult | null> {
  const pendingNow = booked.proposalId ? await getPendingCorrection(ctx.sessionId) : null;

  if (booked.correctionPending && booked.proposalId && !canRenderAddressControls(ctx.channel)) {
    // This surface cannot render `address_confirm`, so it cannot produce ASKED evidence and
    // cannot safely settle A-or-B. Falling through used the older bound address and would turn
    // into a wrong-door booking as soon as any Meta channel gained an address picker. Preserve
    // the house fallback instead: a Request commits nobody to a journey and lets the owner
    // resolve the contested address before confirming it.
    return {
      success: false,
      error:
        `The customer has named a different address from the one previously selected, and ` +
        `this channel cannot securely confirm which one is correct. Do not create a confirmed ` +
        `booking. Use request_appointment instead so the business can verify the address before ` +
        `anyone travels.`,
      errorSafeForModel: true,
    };
  }

  if (booked.correctionPending && booked.proposalId && pendingNow?.status !== 'asked') {
    return {
      success: false,
      // The widget renders the server-authored control. Name both options in the prose too so
      // the persisted reply and its buttons express the same A-or-B question.
      error:
        `The address for this appointment is not settled. Ask the customer whether the ` +
        `appointment should be at "${booked.address}" (the address they chose earlier) or ` +
        `"${booked.proposedAddress}" (the one just mentioned). Offer exactly those two and ` +
        `invent no others. Do not book until they answer.`,
      // A DOMAIN error, not an exception: the model should read it and ask the customer.
      errorSafeForModel: true,
      // #95. The answer needs somewhere to go, and a typed "yes" is not somewhere: it reaches
      // the server through the model, which is the one source `address-binding` refuses. This
      // is the control that turns the answer into a server-observed event.
      ...(booked.proposedAddress && booked.address
        ? {
            affordance: {
              kind: 'address_confirm' as const,
              proposalId: booked.proposalId!,
              proposed: booked.proposedAddress,
              bound: booked.address,
            },
          }
        : {}),
    };
  }
  return null;
}

/**
 * Tell the customer how to prepare, once, in chat.
 *
 * The Booking is already confirmed when this runs, so every failure here is swallowed: this
 * notification is best-effort, just like email/webhook delivery, and must never undo that
 * success.
 */
async function notifyPreparation(ctx: ToolContext, r: CreateBookingResult): Promise<void> {
  const preparationInstructions = r.preparationInstructions?.trim();
  if (!preparationInstructions) return;
  try {
    // Lazy to avoid booking.tool -> message-forwarding -> AgentService ->
    // booking.module -> booking.tool during module initialization.
    const { sendInformationalBotMessage } = await import('../../services/message-forwarding.service');
    await sendInformationalBotMessage(
      ctx.sessionId,
      `Before your appointment:\n${preparationInstructions}`,
    );
  } catch (err) {
    logger.warn('[booking] preparation instructions chat notification failed', {
      sessionId: ctx.sessionId,
      bookingId: r.booking?.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export class CreateBookingTool implements ToolAdapter {
  name = 'create_booking';
  description = 'Create an appointment booking. If this returns CONFIRMATION_REQUIRED, present a short summary (service, date, time, name, and the final price from that service\'s SERVICES line when one is shown) and wait for an explicit yes, then call again with the same details. Checking availability and collecting details is not confirmation. If the service has intake questions, ask them first and pass the answers in intakeAnswers.';
  parameters = {
    type: 'object',
    properties: {
      startTime: {
        type: 'string',
        description:
          'Start time of the booking. Prefer the exact slot start returned by check_availability, verbatim. If you must construct it from the customer\'s words, give a ZONELESS ISO 8601 local time in the business\'s timezone — e.g. "2026-06-19T14:00:00" — never append \'Z\' or an offset.',
      },
      attendeeName: {
        type: 'string',
        description: 'Full name of the person being booked.',
      },
      attendeeEmail: {
        type: 'string',
        description:
          'Email address of the person being booked. Optional — ask for it so we can email a calendar invite, but proceed without it if the customer has none. Never invent one.',
      },
      notes: {
        type: 'string',
        description: 'Optional notes or reason for the booking.',
      },
      serviceId: {
        type: 'string',
        description:
          'The id of the service being booked (from the SERVICES list). Use the same service whose availability you checked. Omit only when the business has a single service.',
      },
      intakeAnswers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          "The customer's answers to the service's intake questions, as a flat object keyed by the question id shown in the SERVICES block (e.g. {\"<question-id>\": \"answer\"}). Include every answer you collected; omit unanswered questions.",
      },
      locationChoice: {
        type: 'string',
        enum: ['business', 'customer'],
        description:
          "For a service flagged 'customer chooses location': 'business' (premises, no address) or 'customer' (theirs — also pass customerAddress). Omit otherwise.",
      },
      customerAddress: {
        type: 'string',
        description:
          "The customer's full appointment address as one string (street, house number, postal code, and city for a Belgian address). Required if the SERVICES entry flags 'needs address', or if it flags 'customer chooses location' AND locationChoice is 'customer'. A city name is not enough and returns ADDRESS_REQUIRED.",
      },
      customerPhone: {
        type: 'string',
        description: "The customer's contact phone number. Required only if the SERVICES entry flags 'needs phone'.",
      },
      durationMin: {
        type: 'number',
        description:
          "For a range/AI-duration service (flagged in SERVICES), the chosen/estimated length in minutes — pass the SAME value you checked availability with. Omit for fixed-duration services. If omitted on a range service, the tool returns DURATION_REQUIRED: ask the customer, then retry. Never treat that as a calendar or technical failure.",
      },
      aiSummary: {
        type: 'string',
        description:
          'A short one-line summary of the job for the business owner, written from the conversation (e.g. "Regular client, wants the same cut as last time; mentioned he is in a hurry"). This goes on the owner\'s calendar entry — it is never shown to the customer.',
      },
    },
    required: ['startTime', 'attendeeName'],
  };
  hasSideEffects = true;
  // Precondition removed — the skill instructions tell the LLM to check availability first.
  // Hard precondition caused issues: forced redundant re-checks that returned different results
  // from Cal.com's API when using narrow vs full-day date ranges.

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const badEmail = rejectBadEmail(args.attendeeEmail);
      if (badEmail) return badEmail;
      // Stable across turns (not per-runId) so a re-confirm in a later turn dedupes
      // to the same booking instead of inserting a duplicate (#35).
      // Settled BEFORE anything is written. A contested address is the one case where guessing
      // is unacceptable: confirming sends a van to a door, and the customer finds out it was the
      // wrong one when nobody arrives.
      const booked = await addressForTurn(
        ctx.sessionId,
        args.customerAddress as string | undefined
      );
      const unsettledAddress = await rejectUnsettledAddress(ctx, booked);
      if (unsettledAddress) return unsettledAddress;
      // Resolve BEFORE the confirm gate. Fingerprinting the raw arg treats
      // an offered `T10:00:00.000Z` and a later zoneless `T10:00:00` as different
      // bookings, so the customer had to say yes twice.
      const startTime = await resolveBookingTime(ctx.sessionId, args.startTime as string, lastCustomerText(ctx));
      const needsConfirm = await refuseUnlessConfirmed({ ...args, startTime }, ctx);
      if (needsConfirm) return needsConfirm;
      // Customer confirmation of the summary, not an availability re-check. The old
      // precondition forced a second check_availability and Cal.com drifted.
      // The address is in the key for the same reason it is in `request_appointment`'s: two calls
      // that differ only in where the van goes are not the same booking. The `correctionPending`
      // guard above is the first line of defence and a better one - it asks the customer - but it
      // only fires when a BINDING exists, and a binding is written in exactly one place
      // (`/places/select`). Wherever address suggestions are unavailable, that guard never runs
      // and this key is all that is left.
      const idempotencyKey = `create_booking:${ctx.sessionId}:${(args.serviceId as string) ?? 'default'}:${startTime}:${addressToken(booked)}`;
      const result = await createBooking(
        'agent',
        ctx.sessionId,
        idempotencyKey,
        startTime,
        { name: args.attendeeName as string, email: args.attendeeEmail as string | undefined },
        args.notes as string | undefined,
        args.serviceId as string | undefined,
        args.intakeAnswers,
        {
          locationChoice: locationChoiceArg(args.locationChoice),
          customerAddress: booked.address,
          // The identity the customer PICKED, so the booking is placed by resolving it rather
          // than by geocoding the words again. Server-injected - it is deliberately absent from
          // this tool's schema, because an identity the model can write is one it can invent.
          customerPlaceId: booked.placeId,
          addressBinding: booked.binding,
          customerPhone: args.customerPhone as string | undefined,
          durationMin: args.durationMin as number | undefined,
          aiSummary: args.aiSummary as string | undefined,

        }
      );

      // Fire-and-forget: emit appointment.booked — confirmed bookings only.
      // (lead.created is owned by the lead-capture service, fired from the booking
      // service's captureLeadFromBooking hook — emitting it here too would double-fire.)
      // A request-mode service short-circuits to a request inside the provider, which fires
      // booking.request_created itself; emitting appointment.booked here would wrongly
      // signal a confirmation (and would re-fire on idempotent re-returns).
      // Emit appointment.booked only for a NEW confirmed booking. Skip request-mode
      // (the provider fires booking.request_created itself) AND idempotent re-returns
      // (the original create already emitted — re-firing would double the webhook +
      // downstream automations).
      const r = result as CreateBookingResult;
      const isRequest = r.requested === true;

      if (!isRequest && !r.idempotent) await notifyPreparation(ctx, r);
      if (!isRequest && !r.idempotent) void (async () => {
        try {
          // #5: the id + canonical UTC time live at result.booking.{id,startTime} —
          // NOT result.bookingId (never existed → the webhook always fell back to the
          // synthetic idempotency key) and NOT args.startTime (raw, often zoneless).
          // A confirmed booking missing them is a provider-contract violation: log +
          // skip rather than emit a bogus id.
          if (!r.booking?.id || !r.booking?.startTime) {
            logger.warn('[booking] appointment.booked skipped — confirmed result missing booking id/startTime', {
              sessionId: ctx.sessionId,
              tenantId: ctx.tenantId,
            });
            return;
          }

          let session: ChatSession | null = null;
          try {
            session = await ctx.dataSource
              .getRepository(ChatSession)
              .findOne({ where: { id: ctx.sessionId } });
          } catch {
            // non-fatal
          }

          const sessionCtx = {
            id: ctx.sessionId,
            channel: session?.channel ?? 'widget',
            visitorId: session?.visitorId ?? 'unknown',
            startedAt: session?.startedAt?.toISOString() ?? new Date().toISOString(),
            messageCount: session?.messageCount ?? 0,
            tags: session?.tags,
          };

          const appointmentEvent: AppointmentBookedEvent = {
            ...buildEventBase('appointment.booked', ctx.tenantId, sessionCtx),
            type: 'appointment.booked',
            appointment: {
              bookingId: r.booking.id,
              startTime: r.booking.startTime,
              attendeeName: args.attendeeName as string,
              attendeeEmail: (args.attendeeEmail as string | undefined) ?? '',
              notes: args.notes as string | undefined,
            },
          };
          emitWebhookEvent(appointmentEvent);
        } catch {
          // non-fatal — booking succeeded, webhook emission is best-effort
        }
      })();

      // Keep the operational text out of the LLM-visible tool result: the
      // deterministic message above is the single customer notification.
      const { preparationInstructions: _preparationInstructions, ...modelResult } = r;
      return {
        success: true,
        data: { ...modelResult, ...addressEcho(booked.address) },
        ...addressReplyFact(
          booked.address,
          isRequest ? 'request' : 'confirmed_booking',
          args.customerAddress as string | undefined,
          booked.proposedAddress
        ),
      };
    } catch (err) {
      return { success: false, ...toolError(err, 'Failed to create booking') };
    }
  }
}

export class RequestAppointmentTool implements ToolAdapter {
  name = 'request_appointment';
  description =
    'Capture an appointment REQUEST (not a confirmed booking) for the customer to be reviewed by the business. Use this — never create_booking — when the service is request-only, the scope/duration is unclear, the job sounds complex/urgent/risky, or you are not confident you can safely confirm a time. The owner is notified and follows up. Only call once the service is identified.';
  parameters = {
    type: 'object',
    properties: {
      preferredTime: {
        type: 'string',
        description:
          "The customer's preferred appointment time as a ZONELESS ISO 8601 local time in the business's timezone — e.g. \"2026-06-19T14:00:00\" for 2 PM. Never append 'Z' or a timezone offset; the time is read as the business's local wall-clock.",
      },
      attendeeName: {
        type: 'string',
        description: 'Full name of the person requesting the appointment.',
      },
      attendeeEmail: {
        type: 'string',
        description:
          'Email address of the person requesting the appointment. Optional — ask for it so we can email a calendar invite, but proceed without it if the customer has none. Never invent one.',
      },
      notes: {
        type: 'string',
        description: 'Optional notes or details the customer provided about the request.',
      },
      serviceId: {
        type: 'string',
        description:
          'The id of the requested service (from the SERVICES list). Identify the service first; omit only when the business has a single service.',
      },
      aiSummary: {
        type: 'string',
        description:
          'A short one-line summary of the request for the business owner (e.g. "New client wants a deep-clean for a 3-bed flat, flexible on timing").',
      },
      intakeAnswers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          "The customer's answers to the service's intake questions, as a flat object keyed by the question id shown in the SERVICES block. Include every answer you collected; omit unanswered questions.",
      },
      locationChoice: {
        type: 'string',
        enum: ['business', 'customer'],
        description:
          "For a service flagged 'customer chooses location': 'business' (premises, no address) or 'customer' (theirs — also pass customerAddress). Omit otherwise.",
      },
      customerAddress: {
        type: 'string',
        description:
          "The customer's full appointment address as one string (street, house number, postal code, and city for a Belgian address). Required if the SERVICES entry flags 'needs address', or if it flags 'customer chooses location' AND locationChoice is 'customer'. A city name is not enough and returns ADDRESS_REQUIRED.",
      },
      customerPhone: {
        type: 'string',
        description: "The customer's contact phone number. Required only if the SERVICES entry flags 'needs phone'.",
      },
      durationMin: {
        type: 'number',
        description:
          "For a range/AI-duration service (flagged in SERVICES), the chosen/estimated length in minutes. Pass a single number (e.g. 60). Omit for fixed-duration services.",
      },
    },
    required: ['preferredTime', 'attendeeName'],
  };
  hasSideEffects = true;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      // A REQUEST NEVER REFUSES OVER A CONTESTED ADDRESS, and that is the difference between it
      // and create. Capturing a Request commits nobody to a journey: the owner reads it and
      // confirms before anyone drives anywhere, so an address still under discussion costs them
      // one glance, while refusing to capture costs the customer the booking entirely. Capturing
      // is this platform's universal degrade - refusing to do it is the house-rule violation.
      const requested = await addressForTurn(
        ctx.sessionId,
        args.customerAddress as string | undefined
      );
      // Stable across turns (not per-runId) so a re-confirm in a later turn dedupes
      // to the same request instead of inserting a duplicate (#35) - but keyed on the ADDRESS as
      // well, because a customer correcting where they live is not a re-confirm. Without the
      // token the correction deduped into the original row and the model was handed a success
      // carrying the OLD address, which is how a customer came to be told a booking was confirmed
      // at a door the system had never recorded.
      const preferredTime = await resolveBookingTime(ctx.sessionId, args.preferredTime as string, lastCustomerText(ctx));
      const idempotencyKey = `request_appointment:${ctx.sessionId}:${(args.serviceId as string) ?? 'default'}:${preferredTime}:${addressToken(requested)}`;
      const badEmail = rejectBadEmail(args.attendeeEmail);
      if (badEmail) return badEmail;
      const result = await requestBooking(
        'agent',
        ctx.sessionId,
        idempotencyKey,
        preferredTime,
        { name: args.attendeeName as string, email: args.attendeeEmail as string | undefined },
        args.notes as string | undefined,
        args.serviceId as string | undefined,
        args.aiSummary as string | undefined,
        args.intakeAnswers,
        {
          locationChoice: args.locationChoice === 'business' || args.locationChoice === 'customer'
            ? args.locationChoice
            : undefined,
          customerAddress: requested.address,
          customerPlaceId: requested.placeId,
          addressBinding: requested.binding,
          customerPhone: args.customerPhone as string | undefined,
          durationMin: args.durationMin as number | undefined,
        }
      );
      // This tool produced the SECOND live instance of the wrong-address sentence: the row said
      // Grote Markt 1 and the customer was told Kerkstraat 12. A Request is the one a customer is
      // most likely to act on wrongly, because nobody confirms it back to them afterwards.
      return {
        success: true,
        data: { ...result, ...addressEcho(requested.address) },
        ...addressReplyFact(
          requested.address,
          'request',
          args.customerAddress as string | undefined,
          requested.proposedAddress
        ),
      };
    } catch (err) {
      return { success: false, ...toolError(err, 'Failed to capture request') };
    }
  }
}

export class ListBookingsTool implements ToolAdapter {
  name = 'list_bookings';
  description = 'List existing bookings for a customer by email address.';
  parameters = {
    type: 'object',
    properties: {
      attendeeEmail: {
        type: 'string',
        description: 'Email address of the customer whose bookings to retrieve.',
      },
    },
    required: ['attendeeEmail'],
  };
  hasSideEffects = false;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = await listBookings('agent', ctx.sessionId, args.attendeeEmail as string);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, ...toolError(err, 'Failed to list bookings') };
    }
  }
}

export class RescheduleBookingTool implements ToolAdapter {
  name = 'reschedule_booking';
  description = 'Reschedule an existing booking to a new time.';
  parameters = {
    type: 'object',
    properties: {
      bookingId: {
        type: 'string',
        description: 'The ID of the booking to reschedule.',
      },
      newStartTime: {
        type: 'string',
        description:
          'New start time. Prefer the exact slot start returned by check_availability, verbatim. If you must construct it from the customer\'s words, give a ZONELESS ISO 8601 local time in the business\'s timezone — e.g. "2026-06-19T14:00:00" — never append \'Z\' or an offset.',
      },
    },
    required: ['bookingId', 'newStartTime'],
  };
  hasSideEffects = true;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const needsConfirm = await refuseUnlessRescheduleConfirmed(args, ctx);
      if (needsConfirm) return needsConfirm;
      const result = await rescheduleBooking(
        'agent',
        ctx.sessionId,
        args.bookingId as string,
        args.newStartTime as string
      );
      return { success: true, data: result };
    } catch (err) {
      return { success: false, ...toolError(err, 'Failed to reschedule booking') };
    }
  }
}

export class CancelBookingTool implements ToolAdapter {
  name = 'cancel_booking';
  description = 'Cancel an existing booking.';
  parameters = {
    type: 'object',
    properties: {
      bookingId: {
        type: 'string',
        description: 'The ID of the booking to cancel.',
      },
      reason: {
        type: 'string',
        description: 'Optional reason for cancellation.',
      },
    },
    required: ['bookingId'],
  };
  hasSideEffects = true;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const needsConfirm = await refuseUnlessCancelConfirmed(args, ctx);
      if (needsConfirm) return needsConfirm;
      const result = await cancelBooking(
        'agent',
        ctx.sessionId,
        args.bookingId as string,
        args.reason as string | undefined
      );
      return { success: true, data: result };
    } catch (err) {
      return { success: false, ...toolError(err, 'Failed to cancel booking') };
    }
  }
}
