import type { BookingAddressReplyFact, ToolAdapter, ToolContext, ToolResult } from '../tool-adapter';
import { addressForTurn, addressToken } from '../../booking/travel/address-for-turn';
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
import type { CreateBookingResult } from '../../booking/booking-providers/types';
import { logger } from '../../utils/logger';
import { XSSProtectionService } from '../../security/xss-protection';
import { autocompleteAddress } from '../../booking/travel/places.service';
import { canRenderAddressControls } from '../../channels/address-controls';
import { randomUUID } from 'crypto';
import { contentToText } from '../../llm/llm.types';
import { localClockTimes, namesSingleOfferedTime } from '../clock-times';
import { rememberOfferedSlots, resolveBookingTime } from '../offered-slots-store';

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
  'The customer already named this time and it is free. Confirm THAT time only. Do not list or offer other times. If they tapped a slot button or already asked you to book this time, and you have their name, call create_booking - do not ask them to pick a time again.';

function lastCustomerText(ctx: ToolContext): string {
  const history = ctx.conversationHistory;
  if (!Array.isArray(history)) return '';
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'user') return contentToText(m.content);
  }
  return '';
}

function namedTimeGuidance(
  ctx: ToolContext,
  data: { slots?: Array<{ start: string }>; timezone?: string; guidance?: string },
): Record<string, unknown> {
  const slots = data.slots;
  if (!Array.isArray(slots) || slots.length === 0) return {};
  const offered = localClockTimes(slots, data.timezone ?? 'UTC');
  if (!offered) return {};
  if (!namesSingleOfferedTime(lastCustomerText(ctx), offered)) return {};
  return {
    requestedTimeAvailable: true,
    guidance: data.guidance ? `${data.guidance} ${NAMED_TIME_GUIDANCE}` : NAMED_TIME_GUIDANCE,
  };
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
          "For a service whose duration is a range or AI-estimated (flagged in the SERVICES list), the chosen/estimated length in minutes, so the offered slots fit. Omit for fixed-duration services.",
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
          "The customer's address, when the prompt tells you to collect it before checking times. Only some businesses need it: for those, which times can be offered depends on where the job is, and calling without it returns ADDRESS_REQUIRED. For a 'customer chooses location' service, only required when locationChoice is 'customer'.",
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
      const locationChoice =
        args.locationChoice === 'business' || args.locationChoice === 'customer'
          ? args.locationChoice
          : undefined;
      const full = await checkAvailability(
        'agent',
        ctx.sessionId,
        args.startDate as string,
        args.endDate as string,
        args.serviceId as string | undefined,
        args.durationMin as number | undefined,
        chosen.address,
        locationChoice,
      );
      // #81 (LP4) SPLIT FIRST, before any branch below can spread `result` into a payload. `data`
      // is serialised into the tool message the model reads and truncated at 4000 characters, so
      // scoring left on it teaches a model that is meant to be unaware of any ranking AND competes
      // with the slot list for that budget - a shadow feature able to break the real one. Splitting
      // at the single early return instead would leak through the two branches that return sooner.
      const { grouping, ...result } = full;
      const measurement = grouping ? { measurement: { grouping } } : {};
      // OFFER TO VERIFY THE ADDRESS, computed here beside `measurement` and returned from every
      // branch below for exactly the reason stated there: this tool has four exits, and something
      // attached only at the last one ships from none of the others. Three of those exits are the
      // interesting cases - a fully requestable result, an empty range, a vague address - so
      // attaching it at the end would have offered the picker only when nothing was wrong.
      //
      // `result.travel` is the whole gate. Travel applies only to a service whose
      // `customerAddressRequired` is set (`booking-place.ts:80`), so its presence IS the server
      // saying this job happens at the customer's door. Paired with "no verified place bound yet"
      // (`chosen.placeId` is written only by `/places/select`), it names the one moment a picker
      // changes anything - and suggestions are billed per request, so offering it anywhere else
      // spends the tenant's money on a question with no answer worth having.
      const affordance = result?.travel && !chosen.placeId
        ? await addressPickerAffordance(
            ctx,
            result.travel.addressTooVague ? 'too_vague' : 'unverified',
            chosen.address,
          )
        : {};
      const replyFact = addressReplyFact(
        chosen.address,
        'availability',
        args.customerAddress as string | undefined,
        chosen.proposedAddress
      );
      // #82: computed here, beside `measurement`, and for the same reason - the branches below
      // return before the final one, so anything attached only at the end silently never ships.
      const groupedNote = result?.travel?.grouped?.customerReason
        ? {
            groupingNote: `The times in "slots" are already in the best order for this business. Offer them in the order given and do not re-sort them. If the customer asks why the first one is suggested, you may say: "${result.travel.grouped.customerReason}" Never invent a different reason, and never mention other customers or their addresses.`,
          }
        : {};
      const withNamedTime = (data: Record<string, unknown>) => ({
        ...data,
        ...namedTimeGuidance(ctx, data as { slots?: Array<{ start: string }>; timezone?: string; guidance?: string }),
      });
      // The booking tools later need to tell a verbatim slot instant (keep the Z) from a time
      // the model constructed from the customer's words (strip the Z). That judgement needs the
      // exact strings this call returned, which may be turns behind the booking.
      if (Array.isArray(result?.slots) && result.slots.length > 0) {
        void rememberOfferedSlots(
          ctx.sessionId,
          (result.slots as Array<{ start: string }>).map((s) => s.start),
          (result as { timezone?: string }).timezone ?? 'UTC',
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
          ...affordance,
          ...replyFact,
          data: withNamedTime({
            ...result,
            ...groupedNote,
            ...addressEcho(chosen.address),
            suggestedAction: 'request_appointment',
            guidance: travel.addressTooVague
              ? 'That address was only located to the town, so no time here can be confirmed automatically. Ask the customer for their postcode and call check_availability again — with a precise address most of these times can be confirmed outright. If they cannot give one, offer the times in travel.requestableSlots and capture the one they choose with request_appointment, saying plainly it is a request the business will confirm.'
              : 'Times in "slots" can be confirmed now. Times in "travel.requestableSlots" are further away and the journey has not been measured, so they CANNOT be auto-confirmed: offer them as times the business will confirm, and if the customer picks one, capture it with request_appointment rather than create_booking. Never present a requestable time as booked.',
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
          ...affordance,
          ...replyFact,
          data: withNamedTime({
            ...result,
            ...groupedNote,
            ...addressEcho(chosen.address),
            noSlotsInRange: true,
            suggestedAction: 'request_appointment',
            guidance:
              'No auto-confirmable times in this range. This does NOT mean the business is closed or fully booked. Do not turn the customer away and do not hand off: ask for their preferred date and time and capture it with request_appointment, making clear the business will confirm it.',
          }),
        };
      }
      return {
        success: true,
        data: withNamedTime({ ...result, ...groupedNote, ...addressEcho(chosen.address) }),
        ...measurement,
        ...affordance,
        ...replyFact,
      };
    } catch (err) {
      return { success: false, ...toolError(err, 'Failed to check availability') };
    }
  }
}

export class CreateBookingTool implements ToolAdapter {
  name = 'create_booking';
  description = 'Create an appointment booking for the customer. You can call this directly if availability was already checked in a recent conversation turn. If the service has intake questions, ask them first and pass the answers in intakeAnswers.';
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
        description: "The customer's address. Required only if the SERVICES entry flags 'needs address', or if it flags 'customer chooses location' AND locationChoice is 'customer'.",
      },
      customerPhone: {
        type: 'string',
        description: "The customer's contact phone number. Required only if the SERVICES entry flags 'needs phone'.",
      },
      durationMin: {
        type: 'number',
        description:
          "For a range/AI-duration service (flagged in SERVICES), the chosen/estimated length in minutes — pass the SAME value you checked availability with. Omit for fixed-duration services.",
      },
      fileSessionIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The ids of files the customer uploaded in THIS chat for this service (only if the service accepts files). Omit if none.',
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
      // THE ONE TOOL THAT MAY ASK, and it has to claim the right to before it does.
      //
      // `correctionPending` says the address is contested; it does not say asking is allowed.
      // ASKED is written exactly once per proposal, so a second attempt at the same booking
      // proceeds on the widget rather than refusing again. A customer whose address Google cannot
      // suggest is asked once and can still get the appointment at the address they chose. A
      // surface without controls degrades to a Request instead of guessing.
      //
      // The claim lives here rather than in `addressForTurn` because the other two tools call that
      // too, and neither of them can ask: `check_availability` is read-only and may be called
      // speculatively, and `request_appointment` never refuses over a contested address at all.
      // ASK ONLY IF THE QUESTION HAS NOT ALREADY REACHED THEM.
      //
      // Four guards have stood here, each counting something adjacent: proposals (three tools
      // propose, one asks), claims (a second call in the same batch booked past an unread tool
      // result), agent runs (the coalescer re-runs one message with a fresh id), and finally a SQL
      // lookup for the reply - which was forgeable, because `/widget/message` stores
      // customer-supplied metadata verbatim.
      //
      // `asked` is now set where the reply is PERSISTED, so the state means what the SQL was
      // asked to find out, in the same store as everything else it guards. Nothing claims; delivery
      // decides. Two concurrent asks are harmless: both refuse, and only one reply is delivered.
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
      // The address is in the key for the same reason it is in `request_appointment`'s: two calls
      // that differ only in where the van goes are not the same booking. The `correctionPending`
      // guard above is the first line of defence and a better one - it asks the customer - but it
      // only fires when a BINDING exists, and a binding is written in exactly one place
      // (`/places/select`). Wherever address suggestions are unavailable, that guard never runs
      // and this key is all that is left.
      const startTime = await resolveBookingTime(ctx.sessionId, args.startTime as string, lastCustomerText(ctx));
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
          locationChoice: args.locationChoice === 'business' || args.locationChoice === 'customer'
            ? args.locationChoice
            : undefined,
          customerAddress: booked.address,
          // The identity the customer PICKED, so the booking is placed by resolving it rather
          // than by geocoding the words again. Server-injected - it is deliberately absent from
          // this tool's schema, because an identity the model can write is one it can invent.
          customerPlaceId: booked.placeId,
          addressBinding: booked.binding,
          customerPhone: args.customerPhone as string | undefined,
          durationMin: args.durationMin as number | undefined,
          fileSessionIds: args.fileSessionIds as string[] | undefined,
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

      const preparationInstructions = r.preparationInstructions?.trim();
      if (!isRequest && !r.idempotent && preparationInstructions) {
        try {
          // Lazy to avoid booking.tool -> message-forwarding -> AgentService ->
          // booking.module -> booking.tool during module initialization.
          const { sendInformationalBotMessage } = await import('../../services/message-forwarding.service');
          await sendInformationalBotMessage(
            ctx.sessionId,
            `Before your appointment:\n${preparationInstructions}`,
          );
        } catch (err) {
          // The Booking is already confirmed. Chat notification is best-effort,
          // just like email/webhook delivery, and must never undo that success.
          logger.warn('[booking] preparation instructions chat notification failed', {
            sessionId: ctx.sessionId,
            bookingId: r.booking?.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
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
        description: "The customer's address. Required only if the SERVICES entry flags 'needs address', or if it flags 'customer chooses location' AND locationChoice is 'customer'.",
      },
      customerPhone: {
        type: 'string',
        description: "The customer's contact phone number. Required only if the SERVICES entry flags 'needs phone'.",
      },
      durationMin: {
        type: 'number',
        description:
          "For a range/AI-duration service (flagged in SERVICES), the chosen/estimated length in minutes. Omit for fixed-duration services.",
      },
      fileSessionIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The ids of files the customer uploaded in THIS chat for this service (only if the service accepts files). Omit if none.',
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
          fileSessionIds: args.fileSessionIds as string[] | undefined,
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
