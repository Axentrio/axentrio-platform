/**
 * Internal booking provider — in-house scheduler, DB as source of truth.
 *
 * Slice #2: availability. Slice #3: create (DB-authoritative, concurrency-safe).
 * Reschedule/cancel land in slice #5 and currently surface a clear
 * `BOOKING_NOT_IMPLEMENTED` so the bot degrades gracefully.
 */
import { v4 as uuidv4 } from 'uuid';
import { DateTime } from 'luxon';
import type { EntityManager } from 'typeorm';
import { In, MoreThan } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { notificationService } from '../../services/notification.service';
import { ServiceType } from '../../database/entities/ServiceType';
import type { Bot } from '../../database/entities/Bot';
import { AvailabilityRule } from '../../database/entities/AvailabilityRule';
import { resolveBookingEventLocation } from './event-location';
import { buildCustomerEventDescription } from './booking-content';
import { organizerAddressForTenant } from './organizer-address';
import {
  resolveServiceTiming,
  type ResolvedService,
} from './service-timing';
import { Booking } from '../../database/entities/Booking';
import { BookingLog } from '../../database/entities/BookingLog';
import { logger } from '../../utils/logger';
import {
  BookingError,
  BookingContext,
  BookingProvider,
  BookingExtras,
  ListBookingsResult,
  AvailabilityResult,
  TravelFilterSummary,
  CreateBookingResult,
  RescheduleResult,
  CancelResult,
} from './types';
import { computeSlots, diagnoseEmptyRange, bookableWindow, type SlotEngineInput } from './slot-engine';
import { buildBookingEventContent } from './booking-content';
import { cancelReminders, scheduleAndPersistReminders } from './reminders';
import { sendBookingEmail, sendRequestNotificationEmail } from './booking-email';
import {
  isCalendarSyncAllowed,
  hasHealthyCalendarConnection,
} from '../../scheduler/calendar-provider';
import {
  canonicalRef,
  syncCalendarCreate,
  syncCalendarReschedule,
  syncCalendarCancel,
} from './calendar-sync';
import { ChatSession } from '../../database/entities/ChatSession';
import { buildManageUrl } from '../../scheduler/booking-token';
import { returningRows } from '../../utils/raw-sql';
import { resolveItineraryKey, type ItineraryKey } from '../../scheduler/itinerary-key';
import { resolveServiceLocationMode, serviceNeedsCustomerAddress } from '../service-location';
import { scoreOfferedSlots, type OfferScoring } from '../travel/score-offer';
import { applyGrouping } from '../travel/apply-grouping';
import {
  placeBookingAddress,
  placeAddressFor,
  placeExistingBooking,
  bookingPlaceColumns,
  requestTravelCheck,
  type BookingPlacement,
} from '../travel/booking-place';
import type { GeoPoint } from '../../contracts/travel';
import { resolveTravelEligibility, type ActiveTravelEligibility } from '../travel/travel-eligibility';
import { loadTravelNeighbours, loadStoredNeighbours, NEIGHBOUR_MARGIN_MS } from '../travel/travel-neighbours';
import {
  assessSlotRouted,
  recordingLookup,
  replayLookup,
  routeBudget,
  withBaseNeighbour,
  selectFirstJob,
  type DriveLookup,
  type DriveRecords,
  type NeighbourLocation,
  type TravelNeighbour,
  type TravelVerdict,
} from '../travel/travel-gate';
import { baseDepartureInstant, localDayBounds, type DayRule } from '../travel/travel-day';
import { recordCause, recordRoutingSuccess } from '../travel/degradation-monitor';
import { notifyTenantCapExhausted } from '../travel/degradation-notify';
import { driveLookupFor } from '../travel/routes.service';
import {
  AddressBindingMovedError,
  consumeAddressBinding,
} from '../travel/address-binding';
import { emitWebhookEvent, buildEventBase } from '../../webhooks/webhook.emitter';
import type { BookingRequestCreatedEvent } from '../../webhooks/webhook.types';
import {
  SLOT_TAKEN_ON_CREATE,
  SLOT_NOT_OFFERABLE,
  SLOT_NOT_OFFERABLE_ON_RESCHEDULE,
  SLOT_TAKEN_ON_RESCHEDULE,
  requestTooSoon,
  requestTooFar,
} from './slot-messages';
import { normalizeIntakeAnswers, assertRequiredIntake } from './intake';
import { resolveContactFields, assertRequiredPhone } from './contact';
import { normalizeDateRange, parseBookingStart, formatBookingDisplayTime, retryRange } from './booking-dates';
import {
  resolveDuration,
  assertDurationChosen,
  effectiveDurationForAvailability,
} from './service-duration';
import {
  enforceServiceDayCapacity,
  loadBusinessRules,
  enforceBusinessCapacity,
} from './capacity';
import { loadAllBusy, loadDayLedger } from './busy';
import { evaluateServiceArea, assertInServiceArea } from './service-area-gate';
import {
  assertPlaceableForTravel,
  travelCandidatePoint,
} from './travel-asserts';
import {
  consumeBindingAfterIdempotentReturn,
  rowDedupIdentity,
  callDedupIdentity,
  createdWithinDedupWindow,
} from './dedup';

/**
 * The ICS organizer stamped on every NEW booking: a per-TENANT address on the platform's
 * already-verified sending domain.
 *
 * Still not the tenant's own address — Resend sends only from verified domains, and the
 * envelope sender has to stay on ours for DMARC alignment. But it is no longer one shared
 * `bookings@` for every tenant on the platform, which is the generic sending address
 * Google's Calendar guidance explicitly warns against: abuse from one tenant would land on
 * everyone's deliverability. See `organizer-address.ts` for why the local part is derived
 * from the immutable tenant id rather than the business name.
 *
 * The comment that used to live here claimed Gmail and Outlook "refuse to render RSVP
 * controls" when ORGANIZER disagrees with the envelope sender. That is FALSE, at least for
 * Gmail, and it was tested rather than reasoned about: two invites sent 2026-08-05 with an
 * identical From on the verified domain, differing ONLY in the ICS ORGANIZER (one matching,
 * one a foreign-domain address), both rendered Yes/Maybe/No. Repeated against a corporate
 * Microsoft 365 mailbox the same day: neither rendered RSVP controls, both arriving as an
 * inert .ics attachment behind an untrusted-sender banner — identical treatment, so
 * alignment made no difference there either. That tenant's policy, not our file: Gmail
 * rendered the same ICS as a full invite.
 *
 * So alignment is NOT what forces this design. The reasons that do survive are: Resend can
 * only send from a verified domain, DMARC wants From aligned with that domain, and putting
 * the owner's own address in ORGANIZER would print it into every customer's calendar — the
 * same disclosure the venue field exists to avoid. Alignment is kept because it is free,
 * not because a vendor requires it. See docs/booking-open-decisions-research.md §2.
 */
const frozenOrganizerFor = (tenantId: string): string => organizerAddressForTenant(tenantId);


/**
 * What the pre-lock travel pass measured, carried into the transaction.
 *
 * Every field here exists because the in-lock assert may not do the thing that produced it: it
 * cannot route (a Google round-trip under an advisory lock is the pool-exhaustion pattern this
 * file warns about), it cannot geocode, and so it cannot place a venue. Recomputing any of these
 * inside the lock would be a second answer to a question already paid for, and the two answers
 * would eventually differ. Named rather than inlined because it is now declared in two paths and
 * a field added to one of them silently would be a snapshot that no longer matches.
 */
type TravelSnapshot = {
  candidate: { point: GeoPoint; coarse: boolean };
  venue: NeighbourLocation | null;
  drives: DriveRecords;
  base: { at: Date; location: NeighbourLocation } | null;
  dayStart: Date;
};


export class InternalProvider implements BookingProvider {
  /**
   * Business availability for the bot (shared by all services).
   *
   * The rule's denormalized `timezone` is overwritten with the bot's canonical
   * `businessTimezone` HERE, at the single load boundary, so every downstream
   * `rule.timezone` reader — slot expansion, day boundaries, parse anchoring,
   * calendar all-day busy, capacity day-bucketing, display formatting — reads
   * the server-owned value without each site having to know about the cutover.
   */
  private async loadRule(bot: Bot): Promise<AvailabilityRule> {
    const rule = await AppDataSource.getRepository(AvailabilityRule).findOne({ where: { botId: bot.id } });
    if (!rule) {
      throw new BookingError('Online booking is not set up for this business yet (no availability is configured), so this cannot be completed online right now. Do not tell the customer a service is unavailable or blame them. Do NOT tell the customer their request was submitted, forwarded, or that the team will review, follow up on, or handle it — nothing is recorded. Explain briefly that it cannot be done online at the moment and that they should contact the business directly.', 'BOOKING_NOT_CONFIGURED', 400);
    }
    rule.timezone = bot.businessTimezone || rule.timezone;
    return rule;
  }

  /**
   * Resolve the service to book against. `serviceId` selects it explicitly (must
   * be active + onlineBookable + belong to this bot). When omitted: the sole
   * active+onlineBookable service is used; zero → `BOOKING_NOT_CONFIGURED`; ≥2 →
   * `SERVICE_REQUIRED` (so a slot chip / pre-multi-service payload without a
   * serviceId can never silently book the wrong service — the caller must
   * disambiguate). The `onlineBookable` filter mirrors the runtime GATE +
   * readiness so a service hidden from online booking is never silently resolved.
   */
  private async resolveService(botId: string, serviceId?: string): Promise<ResolvedService> {
    const repo = AppDataSource.getRepository(ServiceType);
    // Inheritance is applied HERE so every caller downstream sees resolved numbers.
    const rules = await loadBusinessRules(botId);
    if (serviceId) {
      const svc = await repo.findOne({ where: { id: serviceId, botId, isActive: true, onlineBookable: true } });
      if (!svc) throw new BookingError('That serviceId is not currently a bookable service for this business (it may have been changed or removed). Do not tell the customer the service is unavailable or send them to contact the business. Re-read the SERVICES list and call again with the current id of the service they mean; if only one service is listed there, omit serviceId and retry.', 'SERVICE_NOT_FOUND', 404);
      return resolveServiceTiming(svc, rules);
    }
    const active = await repo.find({ where: { botId, isActive: true, onlineBookable: true }, order: { sortOrder: 'ASC', createdAt: 'ASC' } });
    if (active.length === 0) {
      throw new BookingError('This business has no online-bookable service set up, so nothing can be booked or captured as an appointment request right now. Do not tell the customer a specific service is unavailable or blame them. Do NOT tell the customer their request was submitted, forwarded, or that the team will review, follow up on, or handle it — no request record is created, so any such claim is false. If you have a tool for taking their contact details or handing off to a person, use it; otherwise explain briefly that it cannot be arranged online and that they should contact the business directly.', 'BOOKING_NOT_CONFIGURED', 400);
    }
    if (active.length > 1) {
      throw new BookingError('Please specify which service to book', 'SERVICE_REQUIRED', 400);
    }
    return resolveServiceTiming(active[0], rules);
  }

  /**
   * The service an existing booking was made against (by stored `event_type_id`),
   * for reschedule/cancel — uses the original service's duration/buffers even if
   * it was later deactivated. Falls back to the sole active service for legacy
   * rows with no service id.
   */
  private async serviceForBooking(booking: Booking): Promise<ResolvedService> {
    if (booking.eventTypeId) {
      const svc = await AppDataSource.getRepository(ServiceType).findOne({ where: { id: booking.eventTypeId } });
      if (svc) return resolveServiceTiming(svc, await loadBusinessRules(booking.botId));
    }
    return this.resolveService(booking.botId);
  }

  /** Auto-confirmation requires a live calendar the owner actually sees — without one
   *  a "confirmed" booking would be invisible to them (no sync) and risk a no-show. So
   *  auto services degrade to request-mode when there is no healthy connected calendar. */
  private async hasConnectedCalendar(botId: string): Promise<boolean> {
    return hasHealthyCalendarConnection(botId);
  }

  /** Auto-confirm requires BOTH a healthy connected calendar AND calendar-sync entitlement
   *  — otherwise the booking would confirm without ever reaching the owner's external
   *  calendar (ghosting). Mirrors readiness willAutoConfirm. */
  private async canAutoConfirm(ctx: BookingContext): Promise<boolean> {
    return (await this.hasConnectedCalendar(ctx.bot.id)) && (await isCalendarSyncAllowed(ctx.tenant.id));
  }

  async checkAvailability(
    ctx: BookingContext,
    startDate: string,
    endDate: string,
    serviceId?: string,
    durationMin?: number,
    /**
     * The booking being RESCHEDULED, excluded from both busy intervals and the day ledger.
     *
     * Without it the picker counts the customer's own appointment against them: a solo
     * owner capped at one booking a day sees an empty day when trying to move that day's
     * only booking, and its buffers hide the slots either side — while the write path,
     * which has always passed this id, would have allowed the move. Silent: no error, just
     * missing options.
     */
    excludeBookingId?: string,
    /**
     * WHERE THE JOB IS, collected before any time is offered.
     *
     * Only read for a service that needs the customer's address, on an Agent with travel time
     * on. Asking for it earlier in the conversation is real friction, accepted because it is
     * confined to services whose customers must give an address anyway, and because the
     * alternative is offering a time and then refusing it — the behaviour this provider has
     * already ruled against once (see the SLOT_UNAVAILABLE note on create).
     */
    customerAddress?: string,
    locationChoice?: 'business' | 'customer',
    customerPhone?: string,
  ): Promise<AvailabilityResult> {
    const rule = await this.loadRule(ctx.bot);
    const service = await this.resolveService(ctx.bot.id, serviceId);
    // Request-only services aren't booked against the calendar — there are no
    // bookable slots to offer. Hard-stop here so the agent can't present times or
    // run an availability check for them (a prompt nudge alone wasn't enough).
    if (service.bookingMode === 'request') {
      throw new BookingError(
        `"${service.name}" is request-only and has no bookable time slots. Do not offer specific times — ask the customer for their preferred date/time in their own words and capture it with request_appointment.`,
        'REQUEST_ONLY_SERVICE',
        400
      );
    }
    // Agent path only. The owner filling their diary, and a customer moving an
    // existing booking, already have a number or do not need one to see times.
    if (!ctx.isAdmin && !excludeBookingId) {
      assertRequiredPhone(service, { customerPhone }, ctx.session);
    }
    // A paused business still HELPS — it just stops auto-confirming. Same fork, same
    // capture-don't-refuse machinery as a missing calendar, because the customer's
    // experience should be identical: their preferred time is taken down and confirmed
    // later. Admin/portal callers are exempt: adminAvailability shares this method, and an
    // owner must still be able to see and fill their own diary while paused.
    if (!ctx.isAdmin) {
      const { bookingsPaused } = await loadBusinessRules(ctx.bot.id);
      if (bookingsPaused) {
        throw new BookingError(
          `This business has paused NEW online bookings. Do not offer specific times and do not say they are fully booked or closed — ask the customer for their preferred date/time in their own words and capture it with request_appointment as a request the business will confirm. EXCEPTION: if this customer already has an appointment and wants to MOVE it, that is not a new booking — call reschedule_booking with their preferred time, which still works while bookings are paused. Never answer a reschedule with request_appointment: it leaves the original appointment standing and the business ends up with two.`,
          'BOOKINGS_PAUSED',
          409
        );
      }
    }
    if (!(await this.canAutoConfirm(ctx))) {
      // Distinguish the two reasons so the bot's guidance is accurate: a healthy
      // calendar with sync OFF (entitlement) is CALENDAR_SYNC_DISABLED; otherwise
      // (no/dead calendar) CALENDAR_NOT_CONNECTED. Both capture a request — no
      // bookable slots are offered because the booking can't reach the owner's
      // external calendar. Mirrors readiness willAutoConfirm.
      // canAutoConfirm failed; a still-healthy calendar means the blocker is sync.
      const calendarHealthy = await this.hasConnectedCalendar(ctx.bot.id);
      throw calendarHealthy
        ? new BookingError(
            `Online appointments can't be auto-confirmed because calendar sync is disabled on this plan. Do not offer specific times — ask the customer for their preferred date/time in their own words and capture it with request_appointment as a request the business will confirm.`,
            'CALENDAR_SYNC_DISABLED',
            409
          )
        : new BookingError(
            `Online appointments can't be auto-confirmed because this business has no connected calendar. Do not offer specific times — ask the customer for their preferred date/time in their own words and capture it with request_appointment as a request the business will confirm.`,
            'CALENDAR_NOT_CONNECTED',
            409
          );
    }
    const { rangeStart, rangeEnd } = normalizeDateRange(startDate, endDate, rule.timezone);
    // Resolved once and passed down, like every other booking path: the diary this
    // availability is being computed for is a fact about the request, not something each
    // helper should re-derive. Travel filtering will scope to this same key (ADR-0016).
    const itineraryKey = await resolveItineraryKey(ctx.bot.id);
    const busy = await loadAllBusy(
      ctx,
      itineraryKey,
      rangeStart,
      rangeEnd,
      rule.timezone,
      excludeBookingId
    );
    // P5c: for a range/ai service, fit slots to the chosen length when known, else the
    // shortest (minDurationMin) so no fittable start is hidden. Create re-validates length.
    const availDuration = effectiveDurationForAvailability(service, durationMin);
    // Day-level ceilings are applied HERE, not only at create. Offering a slot and then
    // refusing it is the behaviour to avoid - for the business cap AND the per-service cap.
    const business = await loadBusinessRules(ctx.bot.id);
    const dayLedger =
      business.maxBookingsPerDay || business.maxBookedMinutesPerDay
        ? await loadDayLedger(ctx.bot.id, rangeStart, rangeEnd, excludeBookingId)
        : undefined;
    const serviceCap =
      typeof service.maxBookingsPerDay === 'number' && service.maxBookingsPerDay > 0
        ? service.maxBookingsPerDay
        : 0;
    const serviceDayLedger = serviceCap
      ? await loadDayLedger(ctx.bot.id, rangeStart, rangeEnd, excludeBookingId, service.id)
      : undefined;
    // ONE instant for the whole computation. The diagnosis below re-runs this engine, and a
    // second `new Date()` would measure its window against a `now` milliseconds later than the
    // one the slots were built from - which at a window edge is a different answer.
    const engineInput: SlotEngineInput = {
      rule,
      eventType: { ...service, durationMin: availDuration },
      rangeStart,
      rangeEnd,
      now: new Date(),
      busy,
      business,
      dayLedger,
      serviceDayLedger,
    };
    const slots = computeSlots(engineInput);
    // WHY nothing came back, when the reason is this owner's notice, horizon, or service
    // daily cap, and not a full or closed diary. Only on the path that produced nothing, and
    // it costs no query: it re-runs the pure engine over the busy data already in hand.
    const emptyRange = slots.length === 0 ? diagnoseEmptyRange(engineInput) : null;
    // Travel time filters what the engine produced rather than teaching the engine about it.
    // The engine is pure and DST-critical and expresses everything as busy intervals; this pad
    // is asymmetric, per-neighbour and depends on where the customer lives, which that model
    // cannot say. Post-filtering also means an Agent without travel time runs byte-identical
    // code to yesterday's.
    const travel = await this.filterSlotsForTravel(ctx, {
      service,
      itineraryKey,
      rule,
      slots,
      rangeStart,
      rangeEnd,
      customerAddress,
      locationChoice,
      excludeBookingId,
    });
    return {
      slots: travel.slots,
      timezone: rule.timezone,
      serviceId: service.id,
      serviceName: service.name,
      // #80 (LP3): WHO TRAVELS for this service, as it stood when the slots were offered.
      // Resolved here rather than joined later, because a Service's mode can change and the
      // baseline is about what was true at the moment of the offer.
      locationMode: resolveServiceLocationMode(service),
      travel: travel.summary,
      ...(emptyRange ? { emptyRange } : {}),
      ...(travel.grouping ? { grouping: travel.grouping } : {}),
    };
  }

  /**
   * Keep the slots the owner can actually reach; hand back the ones nobody can vouch for.
   *
   * THREE OUTCOMES PER SLOT, because two would force a lie. Offering everything confirms drives
   * nobody checked; offering only what is proven would strip most of a country from a customer's
   * options on the strength of "we did not measure it". So a slot proven fine is offered, a slot
   * proven impossible is dropped without comment, and the undecided middle comes back separately
   * as times the owner can be asked about — a Request, which is this platform's answer to every
   * booking it cannot safely confirm.
   *
   * TWO POLICIES, AND THEY ARE NOT `isAdmin`. Everything the bot touches, and the customer's own
   * manage link, ENFORCE: a slot the owner cannot reach is removed. The OWNER's picker
   * ANNOTATES: nothing is removed, nothing throws, and the caller is told which slots are which
   * so it can warn. Feasibility is a hard constraint against the bot and never against the
   * person who owns the diary (ADR-0015), and a portal booking warns rather than blocks (plan
   * §6.17) — but a customer following a signed link is not the owner, and handing them a
   * proven-impossible time because they share an `isAdmin` flag is the bug that reading looks
   * like. An annotating caller that does not RENDER the warning is worse off than one that
   * filtered, which is why `travelPolicy` is documented as an obligation and not a preference.
   *
   * Returns the input untouched, with no summary, for every Agent that is not using this
   * feature. That is not an optimisation: it is the guarantee that turning travel time on is
   * the only thing that can change anybody's slots.
   */
  private async filterSlotsForTravel(
    ctx: BookingContext,
    input: {
      service: ResolvedService;
      itineraryKey: ItineraryKey;
      /** For the per-day opening instant start-from-base departs at. */
      rule: DayRule;
      slots: Array<{ start: string; end: string }>;
      rangeStart: string;
      rangeEnd: string;
      customerAddress?: string;
      locationChoice?: 'business' | 'customer';
      excludeBookingId?: string;
    }
  ): Promise<{
    slots: Array<{ start: string; end: string }>;
    summary?: TravelFilterSummary;
    /** #81, shadow. Never read by anything that decides a slot's fate — see `AvailabilityResult`. */
    grouping?: OfferScoring;
  }> {
    const { service } = input;
    // A phone consultation is not a travel job however the Agent is configured — the cheapest
    // gate, and a fact about the SERVICE rather than about the owner.
    if (!serviceNeedsCustomerAddress(service, {
      customerAddress: input.customerAddress,
      locationChoice: input.locationChoice,
    })) {
      return { slots: input.slots };
    }

    const eligibility = await resolveTravelEligibility({
      tenantId: ctx.tenant.id,
      botId: ctx.bot.id,
      itineraryKey: input.itineraryKey,
    });
    if (!eligibility.active) return { slots: input.slots };

    const annotating = ctx.travelPolicy === 'annotate';
    // AN ANNOTATING CALLER IS NEVER REFUSED. The owner asked to see their own diary; answering
    // with an error because a customer's address will not place would hide the whole day from
    // them over a fact about somebody else's typing. They get every slot and a reason why none
    // of it was judged, which their picker is obliged to show — see `travelPolicy`.
    const unjudged = (reason: TravelFilterSummary['unavailableReason']) => ({
      slots: input.slots,
      summary: { requestableSlots: [], unreachableSlots: [], unavailableReason: reason },
    });

    const address = await this.travelAddressFor(ctx, input.customerAddress, input.excludeBookingId);
    // NOT a pass. Without an address there is no filtering to do, and returning the unfiltered
    // list would quietly hand back exactly the slots this feature exists to remove — with the
    // model's compliance as the only thing standing between a customer and an impossible drive.
    // The code and its prompt recovery are the ones create has always used.
    if (!address) {
      if (annotating) return unjudged('no_address');
      throw new BookingError(
        "Where is the job? This service is carried out at the customer's address, and the times that can be offered depend on it. Ask for the address and call check_availability again with customerAddress.",
        'ADDRESS_REQUIRED',
        400
      );
    }

    const placement = await placeAddressFor(eligibility, address);
    if (annotating && (!placement.applies || placement.outcome !== 'placed')) {
      // The two ways a placement fails stay apart even here, because they are what an owner
      // would do next: a vague address is worth correcting on the booking, an outage is not.
      return unjudged(placement.applies && placement.outcome === 'not_placeable' ? 'not_placeable' : 'lookup_unavailable');
    }
    const candidate = travelCandidatePoint(placement);
    const { neighbours, venue } = await loadTravelNeighbours({
      eligibility,
      botId: ctx.bot.id,
      from: new Date(input.rangeStart),
      to: new Date(input.rangeEnd),
      excludeBookingId: input.excludeBookingId,
    });

    // ONE budget for the whole list, shared by every slot. It bounds two independent things: a
    // whole-pass DEADLINE (checked per slot in the gate, cache reads included) and a per-call COUNT
    // of real Google calls. The count is claimed inside the lookup on a cache MISS — so a full day
    // of one repeated leg routes from a single purchase instead of exhausting the budget on cache
    // hits and degrading the later (clustering) slots to Requests. See `routeBudget`.
    const budget = routeBudget();
    // Bound to this conversation, because that is the only scope a cached duration may have. The
    // budget is handed to the lookup so a miss consumes the count; a hit costs nothing.
    const lookup = driveLookupFor(eligibility, ctx.session?.id ?? null, { budget });

    const slotCauses = new Set<string>();
    const cleared: Array<{ start: string; end: string }> = [];
    const requestableSlots: Array<{ start: string; end: string }> = [];
    const unreachableSlots: Array<{ start: string; end: string }> = [];
    // Sequential so the shared budget is actually enforced: fired concurrently, every slot would
    // pass the deadline check before any of them advanced. The cache DOES make repeated same-leg
    // slots free — for a traffic-unaware (>24h) list every slot shares one departure bucket, so a
    // single purchase answers them all — which is exactly why the COUNT is now claimed on the spend
    // path (a cache miss) rather than per slot: burning it on hits is what degraded the later slots.
    // Enforce path only needs enough clear times to offer. Annotate (owner picker)
    // still judges the whole list so every diary row can be marked.
    const TRAVEL_ENFORCE_CLEAR_CAP = 20;
    for (const slot of input.slots) {
      if (!annotating && cleared.length >= TRAVEL_ENFORCE_CLEAR_CAP) break;
      const slotCandidate = {
        ...this.blockedRangeFor(service, new Date(slot.start), new Date(slot.end)),
        point: candidate.point,
        coarse: candidate.coarse,
      };
      // PER SLOT, not once for the list. A single availability call spans a fortnight, and each
      // day has its own opening instant — a Saturday's late start, a one-off closure, a
      // date-override's custom hours. One base computed for the range would apply Monday's
      // departure to every day in it.
      const { base, dayStart } = this.travelBaseFor(eligibility, input.rule, venue, slotCandidate.blockedStart);
      const { verdict, degradedCauses } = await assessSlotRouted({
        candidate: slotCandidate,
        neighbours: withBaseNeighbour(neighbours, slotCandidate, base, dayStart),
        slackMin: eligibility.slackMin,
        lookup,
        budget,
      });
      if (verdict === 'clear') cleared.push(slot);
      else if (verdict === 'undecided') requestableSlots.push(slot);
      else unreachableSlots.push(slot);
      for (const cause of degradedCauses) slotCauses.add(cause);
    }

    // Availability is the ONLY path with a budget, so `budget_spent` exists nowhere else —
    // logging causes only on the write path would make the one signal unique to a slot list
    // invisible. Also the only place an abandoned booking flow leaves any trace at all.
    if (slotCauses.size) {
      logger.info('[Travel] some slots went unmeasured', {
        tenantId: ctx.tenant.id,
        botId: ctx.bot.id,
        causes: [...slotCauses],
        requestable: requestableSlots.length,
      });
    }

    if (unreachableSlots.length || requestableSlots.length) {
      logger.info('[Travel] judged the offered slots', {
        botId: ctx.bot.id,
        tenantId: ctx.tenant.id,
        policy: annotating ? 'annotate' : 'enforce',
        cleared: cleared.length,
        requestable: requestableSlots.length,
        unreachable: unreachableSlots.length,
        coarseAddress: candidate.coarse,
      });
    }

    // #81 GROUPING, in shadow. Runs AFTER feasibility has decided and changes nothing it decided:
    // the returned list, the arrays below and every slot's class are exactly what they were. It
    // scores what is already confirmable so LP4's gate can be measured, and LP5 is the separate
    // decision to act on it.
    //
    // Only the ENFORCING path. An annotating caller is the owner's own picker, which keeps the
    // whole list including times travel refused, so "the confirmable slots" is not a set that
    // exists there to be scored.
    const grouping = annotating
      ? null
      : await scoreOfferedSlots({
          eligibility,
          sessionId: ctx.session?.id ?? null,
          rule: input.rule,
          slots: cleared,
          requestable: requestableSlots,
          // Coarse is not a position for this purpose. ADR-0014's rule reaches preference too.
          candidatePoint: candidate.coarse ? null : candidate.point,
          neighbours,
          baseFor: (at) => this.travelBaseFor(eligibility, input.rule, venue, at),
        });

    // #82 (LP5) THE ONE PLACE A CUSTOMER-VISIBLE ORDER CHANGES. Off for everyone until an owner
    // opts in; with the flag off this is the identity function and the epic stays measurement.
    //
    // An annotating caller is excluded on purpose: that is the owner's own picker, which shows
    // every time including the ones travel refused, in the order the day runs. Reordering somebody
    // reading their own diary would be nonsense.
    // `none` is off; anything else is a period to group within.
    const pilotOn = !annotating && eligibility.groupingPeriod !== 'none';
    const ranked = applyGrouping({
      slots: cleared,
      scoring: grouping ?? null,
      enabled: pilotOn,
      // ONE local day. The dates came from the model, not the customer, so a wide range is not
      // evidence anybody is free across it - see `applyGrouping`. #84 collects the real thing.
      //
      // `rangeEnd` is EXCLUSIVE: `normalizeDateRange` turns a date-only end into the following
      // local midnight so the end day is included. Comparing it directly puts a plain same-day
      // request on two different local days and switches the pilot off for exactly the call shape
      // it exists for. One millisecond back lands on the last instant that is actually in range.
      singleDay:
        localDayBounds(input.rule, new Date(input.rangeStart)).localDay.toISODate() ===
        localDayBounds(input.rule, new Date(new Date(input.rangeEnd).getTime() - 1)).localDay.toISODate(),
    });

    if (ranked.applied) {
      // The owner's audit trail. #82's first decision is that both parties are told, and the
      // owner's half is a log line they can be shown rather than a sentence in a chat.
      logger.info('[grouping] offered a grouped order', {
        tenantId: ctx.tenant.id,
        botId: ctx.bot.id,
        reasonCode: ranked.applied.reasonCode,
        savedMinutes: ranked.applied.savedMinutes,
        slots: ranked.slots.length,
      });
    }

    return {
      // The one line the policy decides. An annotating caller keeps the whole list and marks it
      // up from the two arrays below; an enforcing one is handed only what was proven.
      slots: annotating ? input.slots : ranked.slots,
      summary: {
        requestableSlots,
        unreachableSlots,
        ...(candidate.coarse ? { addressTooVague: true as const } : {}),
        ...(pilotOn ? { groupingPilot: true as const } : {}),
        ...(ranked.previousOrder ? { groupingPreviousOrder: ranked.previousOrder } : {}),
        ...(ranked.applied ? { grouped: ranked.applied } : {}),
      },
      ...(grouping ? { grouping } : {}),
    };
  }

  /**
   * The address to filter against, falling back to the one already on the booking being moved.
   *
   * A reschedule is not a new job. The customer picking a different time has not been asked for
   * their address again and should not be — it is on the row, verbatim, from when they booked.
   * Scoped by tenant AND bot rather than by row id, because an id arriving from a caller is not
   * on its own proof of anything.
   */
  private async travelAddressFor(
    ctx: BookingContext,
    supplied?: string,
    excludeBookingId?: string
  ): Promise<string | null> {
    const given = supplied?.trim();
    if (given) return given;
    if (!excludeBookingId) return null;
    const row = await AppDataSource.getRepository(Booking).findOne({
      where: { id: excludeBookingId, tenantId: ctx.tenant.id, botId: ctx.bot.id },
    });
    return row?.customerAddress?.trim() || null;
  }

  /**
   * A candidate's blocked range: the appointment plus the service's own buffers.
   *
   * The gap between two jobs is measured between BLOCKED ranges, never raw times, because the
   * buffers are already inside them — which is what makes a service buffer additive with the
   * flat gap while a drive composes with it by `max`. Same arithmetic the INSERT uses, kept
   * here so the offer path and the write path cannot disagree about where a job begins.
   */
  private blockedRangeFor(
    service: Pick<ResolvedService, 'bufferBeforeMin' | 'bufferAfterMin'>,
    start: Date,
    end: Date
  ): { blockedStart: Date; blockedEnd: Date } {
    return {
      blockedStart: new Date(start.getTime() - service.bufferBeforeMin * 60_000),
      blockedEnd: new Date(end.getTime() + service.bufferAfterMin * 60_000),
    };
  }

  /**
   * The travel verdict for ONE candidate time, on the write path.
   *
   * `null` when travel does not apply, which every Agent on the platform is today.
   *
   * OUTSIDE THE TRANSACTION, always. Holding a database transaction open across a network call
   * is the pool-exhaustion pattern `loadBusinessRules` already warns about, and this reads a
   * diary and may geocode. The lock-scoped re-assert that closes the concurrent-booking race is
   * a separate ticket; what this closes is the larger hole, which is a model booking a time
   * availability never offered.
   */
  /**
   * The premises as a predecessor, for the day the candidate falls in.
   *
   * Returns `base: null` for the three situations that mean "no departure instant, so no
   * constraint": the setting is off, the business is `always_open`, or the day has no opening
   * window. `withBaseNeighbour` treats all three identically.
   *
   * A VENUE WE COULD NOT PLACE BECOMES `unresolved`, NEVER NULL. Null means "no constraint" and
   * clears; `unresolved` means "we could not evaluate" and never clears. The base exists to
   * constrain, so its failure has to fall to the safe side — the same side an at-premises
   * neighbour already falls to when its venue will not geocode. The visible consequence is that
   * an owner with this switch on and an unplaceable premises address gets every first job of the
   * day captured as a Request, which is harsh, correct, and fixed by fixing the address.
   */
  private travelBaseFor(
    eligibility: ActiveTravelEligibility,
    rule: DayRule,
    venue: NeighbourLocation | null,
    candidateStart: Date
  ): { base: { at: Date; location: NeighbourLocation } | null; dayStart: Date } {
    const { localDay, dayStart } = localDayBounds(rule, candidateStart);
    if (!eligibility.startFromBase) return { base: null, dayStart };
    // #91: the van leaves BEFORE opening when the owner says it does. Opening answers "when may a
    // customer be booked", which is not "when does the van move" - and equating them ruled out a
    // job at opening for any positive drive, costing the owner the first slot of every day.
    const at = baseDepartureInstant(rule, localDay, eligibility.baseDepartOffsetMin);
    if (!at) return { base: null, dayStart };
    return { base: { at, location: venue ?? { kind: 'unresolved' } }, dayStart };
  }

  /**
   * Which `(itinerary, day)` pairs a move disturbs, and how to project it onto each.
   *
   * THE PROJECTION IS PAIR-RELATIVE, and that is the whole subtlety. The old pair only ever
   * REMOVES the booking and the new pair only ever ADDS it. Applying both edits to both pairs
   * would, on a move that changes itinerary without changing day, insert the booking into the
   * old diary as well — hiding the very job whose exposure is being checked.
   *
   * Deduplicated on `(key, localDay)`, because the overwhelmingly common move is within one day
   * on one itinerary, and asserting that day twice would evaluate it against a diary that has
   * been half-projected.
   */
  private exposurePairs(input: {
    oldKey: ItineraryKey;
    oldDay: Date;
    newKey: ItineraryKey;
    newDay: Date;
    rule: DayRule;
    moved: TravelNeighbour;
  }): Array<{ key: ItineraryKey; day: Date; project: { removeId?: string; add?: TravelNeighbour } }> {
    const dayOf = (d: Date) => localDayBounds(input.rule, d).localDay.toISODate();
    const oldPair = {
      key: input.oldKey,
      day: input.oldDay,
      project: { removeId: input.moved.bookingId },
    };
    const newPair = { key: input.newKey, day: input.newDay, project: { add: input.moved } };
    const same = input.oldKey === input.newKey && dayOf(input.oldDay) === dayOf(input.newDay);
    // One pair carrying BOTH edits when they are the same pair — a same-day reorder still moves
    // the booking, and the projection has to show it gone from where it was and present where
    // it is going, or the exposed first job is read off a diary that never existed.
    return same
      ? [{ key: input.newKey, day: input.newDay, project: { removeId: input.moved.bookingId, add: input.moved } }]
      : [oldPair, newPair];
  }

  /**
   * The premises leg of a day's first job, for a day some write has just disturbed.
   *
   * ONE FUNCTION, TWO DIRECTIONS, because the pre-lock and in-lock passes must select the same
   * booking and measure the same legs. Pre-lock it runs over a PROJECTED diary with a recording
   * lookup, filling the snapshot; in-lock it runs over committed rows with a replaying one. Any
   * divergence between the two shows up as a replay miss, which refuses — so the failure mode of
   * getting this wrong is a retry, never a wrong yes.
   */
  private async assertExposedFirstJob(input: {
    eligibility: ActiveTravelEligibility;
    rule: DayRule;
    day: Date;
    venue: NeighbourLocation | null;
    lookup: DriveLookup;
    /**
     * How to read the diary, which DIFFERS between the two directions and must.
     *
     * Pre-lock the old day may never have been read by anything, so its bookings can still be
     * unplaced — that pass therefore uses the geocoding loader, which writes coordinates back.
     * In-lock nothing may touch the network, so that pass uses the stored loader and finds
     * exactly what the pre-lock pass just persisted. Handing the loader in is what keeps a
     * network call out of the transaction by construction rather than by remembering.
     */
    load: (from: Date, to: Date) => Promise<{ neighbours: TravelNeighbour[]; venue?: NeighbourLocation | null }>;
    /** Rows to drop (the moved booking's old occurrence) and add (its new one). */
    project?: { removeId?: string; add?: TravelNeighbour };
    /** Set by the pre-lock pass so the in-lock pass reuses the venue it paid for. */
    captureVenue?: (v: NeighbourLocation) => void;
  }): Promise<{ verdict: TravelVerdict; bookingId?: string }> {
    const { dayStart, dayEnd, localDay } = localDayBounds(input.rule, input.day);
    // THE SAME DEPARTURE THE READ PATH USED (#91). `travelBaseFor` applies the owner's offset, so
    // reading the bare opening here would make the two passes disagree: availability offers a job
    // at opening that the owner can reach by leaving early, and this rejects it on a departure
    // the van never makes. A read that offers what the write refuses is the failure mode this
    // whole re-assertion exists to prevent, not one to introduce.
    const at = baseDepartureInstant(input.rule, localDay, input.eligibility.baseDepartOffsetMin);
    // No departure instant, no base, nothing this function can add. Every other constraint on
    // the exposed booking was already checked when it was made.
    if (!at) return { verdict: 'clear' };

    // THE SAME SCOPE AS THE READ IT MUST MATCH. The gate has no day boundary — it picks
    // predecessors and successors from the whole list — so a day-scoped read would omit
    // yesterday's last job and tomorrow's first, and the two passes would measure different
    // legs. A margin mismatch here is a replay miss on every ordinary write.
    const loaded = await input.load(
      new Date(dayStart.getTime() - NEIGHBOUR_MARGIN_MS),
      new Date(dayEnd.getTime() + NEIGHBOUR_MARGIN_MS)
    );
    const stored = loaded.neighbours;
    // THE HANDED-IN VENUE WINS, and the order matters. The in-lock pass cannot place a venue, so
    // it only ever has the snapshot's; if the pre-lock pass preferred its own loader instead, a
    // spent geocode budget on the exposure read would give it `unresolved` where the in-lock pass
    // has `known` — a different base, a different leg, and a replay miss that refuses a write
    // nothing was wrong with. The loader's value is the fallback for the cancel path, which has
    // no snapshot at all. `unresolved` is the floor: a base we could not place must constrain.
    const venue = input.venue ?? loaded.venue ?? { kind: 'unresolved' as const };
    input.captureVenue?.(venue);

    // PAIR-RELATIVE projection. Remove only on the day the booking is leaving, add only on the
    // day it is arriving. Doing both on both would insert the booking into the old diary as
    // well on a cross-itinerary move, hiding the very job whose exposure is being checked.
    const projected = input.project
      ? [
          ...stored.filter((n) => !input.project?.removeId || n.bookingId !== input.project.removeId),
          ...(input.project.add ? [input.project.add] : []),
        ]
      : stored;

    const selection = selectFirstJob(projected, dayStart, dayEnd);
    if (selection.kind === 'none') return { verdict: 'clear' };
    // A first job whose own location we could not obtain. We cannot show the owner can reach it
    // and we must not pretend otherwise.
    if (selection.kind === 'unplaced') return { verdict: 'undecided', bookingId: selection.bookingId };

    const { verdict } = await assessSlotRouted({
      candidate: selection.candidate,
      neighbours: withBaseNeighbour(selection.others, selection.candidate, { at, location: venue }, dayStart),
      slackMin: input.eligibility.slackMin,
      lookup: input.lookup,
    });
    return { verdict, bookingId: selection.bookingId };
  }

  /**
   * The same verdict, re-reached UNDER THE ADVISORY LOCK, as the last thing before the write.
   *
   * WHY IT EXISTS AT ALL. Everything the pre-lock check saw was true when it looked, and two
   * customers finishing a conversation in the same second both see it. The `EXCLUDE USING gist`
   * constraint that stops them taking the same slot understands OVERLAP and nothing else — it
   * cannot express "these two are forty minutes apart and eighty kilometres apart", so without
   * this both bookings pass every check and land back to back at addresses the owner cannot
   * drive between. That is the exact failure this feature exists to prevent, arriving through
   * the one door the feature had left open.
   *
   * NOTHING HERE TOUCHES THE NETWORK. `loadStoredNeighbours` reads the placement columns and
   * cannot geocode; a neighbour it cannot place reads `unresolved`, which never clears a slot.
   * The venue was placed outside the lock and is handed in. Holding a transaction open across a
   * network call is the pool-exhaustion pattern `loadBusinessRules` already warns about.
   *
   * AND `undecided` IS A CONFLICT HERE, though it is a Request outside. There is nowhere to
   * capture a Request inside somebody else's transaction, and the honest answer to "a neighbour
   * appeared that I cannot vouch for" is to send the caller back to availability, which is where
   * the Request lives. That is the same 409 a genuinely impossible drive gets, and the message
   * says what to do rather than what happened.
   */
  private async assertTravelFeasible(
    manager: EntityManager,
    input: {
      eligibility: ActiveTravelEligibility;
      service: Pick<ResolvedService, 'bufferBeforeMin' | 'bufferAfterMin'>;
      candidate: { point: GeoPoint; coarse: boolean };
      venue: NeighbourLocation | null;
      start: Date;
      end: Date;
      excludeBookingId?: string;
      /** What the pre-lock pass paid Google for. Absent means nothing was routed. */
      drives?: DriveRecords;
      /**
       * The premises leg, carried from the pre-lock pass rather than recomputed.
       *
       * The day maths is deterministic, so recomputing it here would agree — but the VENUE
       * cannot be re-placed inside a transaction, and a base assembled from a venue this pass
       * does not have would differ from the one the pre-lock pass measured. Handing both halves
       * down together is what makes "the same base" a fact rather than a hope.
       */
      base?: { at: Date; location: NeighbourLocation } | null;
      dayStart?: Date;
    }
  ): Promise<void> {
    const { blockedStart, blockedEnd } = this.blockedRangeFor(input.service, input.start, input.end);
    const stored = await loadStoredNeighbours(manager, {
      eligibility: input.eligibility,
      from: input.start,
      to: input.end,
      excludeBookingId: input.excludeBookingId,
      venue: input.venue,
    });
    const neighbours = input.dayStart
      ? withBaseNeighbour(stored, { blockedStart }, input.base ?? null, input.dayStart)
      : stored;
    // Replayed, never routed. This runs inside the caller's transaction, and holding a pool
    // connection open across a Google round-trip is the pattern this file already warns
    // about. A leg the pre-lock pass did not record answers null, which reads as undecided
    // and refuses — so a diary that moved under the lock costs a retry, never a wrong yes.
    const { verdict } = await assessSlotRouted({
      candidate: { blockedStart, blockedEnd, point: input.candidate.point, coarse: input.candidate.coarse },
      neighbours,
      slackMin: input.eligibility.slackMin,
      lookup: replayLookup(input.drives ?? {}),
    });
    if (verdict === 'clear') return;

    logger.info('[Travel] refused under the lock — the diary moved after the pre-lock check', {
      tenantId: input.eligibility.tenantId,
      itineraryKey: input.eligibility.itineraryKey,
      start: input.start.toISOString(),
      verdict,
    });
    throw new BookingError(
      'Another appointment was taken while this one was being confirmed, and this time can no longer be reached from it. Check availability again and offer one of the times it returns.',
      'TRAVEL_TIME_CONFLICT',
      409,
      undefined,
      // #73: this one REACHES A CUSTOMER. The signed reschedule page enforces travel, so a
      // customer who picks a time that stops being drivable between the page loading and their
      // submitting lands here - and the message above tells the MODEL to offer other times.
      'Someone else booked that slot while you were choosing. Please pick another time.'
    );
  }

  private async travelVerdictForBooking(
    ctx: BookingContext,
    input: {
      eligibility: ActiveTravelEligibility;
      service: ResolvedService;
      placement: BookingPlacement;
      /** For the day boundary and the opening instant start-from-base departs at. */
      rule: DayRule;
      start: Date;
      end: Date;
      excludeBookingId?: string;
    }
  ): Promise<{
    verdict: TravelVerdict;
    candidate: { point: GeoPoint; coarse: boolean };
    venue: NeighbourLocation | null;
    /** True only when routing answered every constraining leg — this is what licenses `ok`. */
    fullyRouted: boolean;
    /** False when nothing constrained the verdict at all — see the NULL stamp at the callers. */
    hadConstrainingLeg: boolean;
    /** Carried into the transaction so the in-lock assert can replay rather than re-ask. */
    drives: DriveRecords;
    /** The premises leg this pass measured, so the in-lock pass asserts the identical one. */
    base: { at: Date; location: NeighbourLocation } | null;
    dayStart: Date;
  }> {
    const candidate = travelCandidatePoint(input.placement);
    const { blockedStart, blockedEnd } = this.blockedRangeFor(input.service, input.start, input.end);
    // The candidate point and the venue are carried out of here so the in-lock assert can reuse
    // them: it may not geocode, and re-deriving either would be a second answer to a question
    // this pass already paid Google to answer once.
    const { neighbours: stored, venue } = await loadTravelNeighbours({
      eligibility: input.eligibility,
      botId: ctx.bot.id,
      from: input.start,
      to: input.end,
      excludeBookingId: input.excludeBookingId,
    });
    // The day's first job departs from the premises. Carried out of here with the venue, for
    // the same reason the venue is: the in-lock pass may not place anything.
    const { base, dayStart } = this.travelBaseFor(input.eligibility, input.rule, venue, blockedStart);
    const neighbours = withBaseNeighbour(stored, { blockedStart }, base, dayStart);
    const drives: DriveRecords = {};
    const { verdict, fullyRouted, hadConstrainingLeg, degradedCauses } = await assessSlotRouted({
      candidate: { blockedStart, blockedEnd, point: candidate.point, coarse: candidate.coarse },
      neighbours,
      slackMin: input.eligibility.slackMin,
      lookup: recordingLookup(driveLookupFor(input.eligibility, ctx.session?.id ?? null), drives),
    });
    // The only place a degradation CAUSE exists — the column records that a booking degraded,
    // never why.
    if (degradedCauses.length) {
      logger.info('[Travel] a leg went unmeasured', {
        tenantId: input.eligibility.tenantId,
        itineraryKey: input.eligibility.itineraryKey,
        verdict,
        causes: degradedCauses,
      });
      // #68: the causes stop being only diagnosable here. A platform cause seen by real
      // bookings is a failure the synthetic probe's single journey may not reach, and a tenant
      // whose cap is spent is a definite fact about that business's month. Fire-and-forget:
      // a monitor that can break a booking is worse than the blindness it cures.
      for (const cause of degradedCauses) {
        // The identity travels with the cause: without it the operator aggregate cannot count
        // DISTINCT affected tenants, and distinct tenants is the only count that separates a
        // platform-wide pattern from one busy business at its cap. No Agent id, because the only
        // Agent-scoped cause is the shared itinerary, and that is recorded where it is detected.
        void recordCause(cause, { tenantId: input.eligibility.tenantId }).catch(() => undefined);
      }
      if (degradedCauses.includes('cap_exhausted')) {
        void notifyTenantCapExhausted(input.eligibility.tenantId).catch(() => undefined);
      }
    }
    // A leg that ANSWERED is what a recovery claim needs behind it - see the monitor. Recorded
    // whenever routing was actually consulted and came back, which `fullyRouted` is exactly.
    if (fullyRouted && hadConstrainingLeg) void recordRoutingSuccess().catch(() => undefined);
    return { verdict, candidate, venue, fullyRouted, hadConstrainingLeg, drives, base, dayStart };
  }


  private toResult(
    booking: Booking,
    idempotent: boolean,
    timezone?: string,
    serviceName?: string,
    preparationInstructions?: string | null,
  ): CreateBookingResult {
    return {
      success: true,
      idempotent: idempotent || undefined,
      requested: booking.status === 'request_created' || undefined,
      timezone,
      serviceName,
      preparationInstructions,
      booking: {
        id: booking.id,
        startTime: booking.startUtc.toISOString(),
        endTime: booking.endUtc.toISOString(),
        displayTime: timezone ? formatBookingDisplayTime(booking.startUtc, timezone) : undefined,
        attendee: {
          name: booking.attendeeName ?? undefined,
          email: booking.attendeeEmail ?? undefined,
        },
        // Read off the ROW, never off the arguments that produced it. On a deduped write those
        // two differ, and the row is the one that is true.
        customerAddress: booking.customerAddress ?? undefined,
      },
    };
  }

  async createBooking(
    ctx: BookingContext,
    idempotencyKey: string,
    startTime: string,
    attendee: { name: string; email?: string },
    notes?: string,
    serviceId?: string,
    intakeAnswers?: unknown,
    extras?: BookingExtras
  ): Promise<CreateBookingResult> {
    const rule = await this.loadRule(ctx.bot);
    // Create-time revalidation: the service must still exist, belong to this bot,
    // and be active (a slot chip / multi-turn gap can go stale).
    const service = await this.resolveService(ctx.bot.id, serviceId);
    const itineraryKey = await resolveItineraryKey(ctx.bot.id);
    const bookingRepo = AppDataSource.getRepository(Booking);

    // 1. Idempotency: a live (non-failed) booking with this key → return it.
    const existing = await bookingRepo.findOne({
      where: { tenantId: ctx.tenant.id, botId: ctx.bot.id, idempotencyKey, createdAt: createdWithinDedupWindow() },
    });
    // Any existing row for this idempotency key is a duplicate. (This used to exclude
    // 'failed', a status nothing ever wrote.)
    if (existing) {
      await consumeBindingAfterIdempotentReturn(ctx, extras);
      return this.toResult(existing, true, rule.timezone, service.name, service.preparationInstructions);
    }

    // 2. Compute times. P5c: effective length depends on durationMode (range/ai use
    //    the agent-supplied minutes; fixed ignores it). Throws DURATION_OUT_OF_RANGE.
    const start = parseBookingStart(startTime, rule.timezone);
    if (!start) {
      throw new BookingError('Invalid start time', 'INVALID_START_TIME', 400);
    }
    // A range/ai service with no chosen length must ASK, not confirm and not capture.
    // Capturing a request here is what the model then recites as a calendar failure.
    assertDurationChosen(service, extras?.durationMin);
    const effectiveDuration = resolveDuration(service, extras?.durationMin);
    const end = new Date(start.getTime() + effectiveDuration * 60_000);

    // Idempotency on the PARSED instant (codex): the model may pass the same time
    // as a `Z` slot one turn and a zoneless local string the next → different
    // idempotency keys. Catch it on (session, service, startUtc) so a re-confirm
    // returns the existing booking instead of failing SLOT_UNAVAILABLE on the now-
    // taken slot. Mirrors requestAppointment's dedup.
    const recentDup = await bookingRepo.findOne({
      where: {
        tenantId: ctx.tenant.id, botId: ctx.bot.id, sessionId: ctx.session.id,
        eventTypeId: service.id, startUtc: start,
        createdAt: createdWithinDedupWindow(),
      },
      order: { createdAt: 'DESC' },
    });
    // A cancelled row must NOT dedupe — the customer may legitimately rebook the same
    // slot. 'failed' and 'declined' were also listed here; neither is ever written
    // (declining a request writes 'cancelled').
    if (
      recentDup &&
      recentDup.status !== 'cancelled' &&
      rowDedupIdentity(recentDup, service.customerAddressRequired) ===
        callDedupIdentity(service.customerAddressRequired, extras)
    ) {
      await consumeBindingAfterIdempotentReturn(ctx, extras);
      return this.toResult(recentDup, true, rule.timezone, service.name, service.preparationInstructions);
    }

    // P3: normalize intake answers against THIS resolved service (the row's real service).
    const intakeJson = normalizeIntakeAnswers(service, intakeAnswers);
    assertRequiredIntake(service, intakeJson);

    // Request-only service → capture a request/lead. No confirmed appointment,
    // no calendar event, no email/reminders. (Owner notification UX is P2.)
    // The write path enforces it too: availability is advisory, and a model that skipped the
    // check (or a stale slot chip) must not slip a confirmation past a paused business.
    const canAuto = (await this.canAutoConfirm(ctx)) && !(await loadBusinessRules(ctx.bot.id)).bookingsPaused;
    // Request-only OR can't auto-confirm (no healthy calendar OR sync disabled) →
    // capture a request, not a confirmed booking. Missing length is DURATION_REQUIRED
    // above, not a silent request.
    if (service.bookingMode === 'request' || !canAuto) {
      // Carry the model's summary through the downgrade — passing `undefined` here meant a
      // job captured because the calendar was down reached the owner with no context.
      return this.createRequest(ctx, idempotencyKey, service, itineraryKey, start, end, attendee, notes, extras?.aiSummary, intakeAnswers, extras, effectiveDuration);
    }

    // P5a: required address/phone gate (recoverable; the agent re-asks). Auto path.
    const contact = resolveContactFields(service, extras, ctx.session);
    // P6: a job outside the business's service area must not be auto-confirmed. Recoverable
    // (the agent captures it with request_appointment instead) and deliberately AUTO-ONLY —
    // a request is exactly the right outcome for an out-of-area job, so createRequest never
    // runs this gate.
    await assertInServiceArea(ctx, service, contact.address);
    // Reaching here means the gate passed. Re-evaluate rather than assume 'inside': the gate
    // is a no-op when the service needs no address or no enforceable place is configured, and
    // recording 'inside' for those would claim a check that never ran.
    const { match: areaMatch } = await evaluateServiceArea(ctx, service, contact.address);
    // P5e: snapshot ready uploads from this chat (the model never sees file ids).
    const fileSessionIds = await this.resolveFileSessionIds(ctx, service);
    const uploadedFiles = await this.validateUploadedFiles(ctx, service, fileSessionIds);


    const blockedStart = new Date(start.getTime() - service.bufferBeforeMin * 60_000);
    const blockedEnd = new Date(end.getTime() + service.bufferAfterMin * 60_000);

    // 3. Re-validate: the requested start must be an actually-offered slot
    //    (rules, buffers, min-notice, horizon, internal + Google busy).
    const busy = await loadAllBusy(
      ctx,
      itineraryKey,
      new Date(start.getTime() - 24 * 3600_000).toISOString(),
      new Date(end.getTime() + 24 * 3600_000).toISOString(),
      rule.timezone
    );
    const offered = computeSlots({
      rule,
      // P5c: validate the slot against the EFFECTIVE length (a longer job must still fit).
      eventType: { ...service, durationMin: effectiveDuration },
      rangeStart: start.toISOString(),
      rangeEnd: new Date(start.getTime() + 1000).toISOString(),
      now: new Date(),
      busy,
    }).some((s) => new Date(s.start).getTime() === start.getTime());
    if (!offered) {
      // WHICH kind of "no" this is, because the two lead the customer somewhere different. An
      // occupied slot is bad luck and the answer is another time; a slot the rules never allowed
      // is a misunderstanding, and telling somebody it was "just taken" sends them to a Request
      // when picking a valid time would have booked them in.
      const occupied = busy.some(
        (b) => new Date(b.start).getTime() < blockedEnd.getTime() && new Date(b.end).getTime() > blockedStart.getTime()
      );
      throw new BookingError(occupied ? SLOT_TAKEN_ON_CREATE : SLOT_NOT_OFFERABLE, 'SLOT_UNAVAILABLE', 409);
    }

    // Travel time: place the address, LAST of the pre-transaction checks and deliberately so.
    // It is the only one that costs money, so every free way this booking could still fail —
    // a missing address, an out-of-area job, a slot that went while the customer was typing —
    // has already been given its chance to fail first. Outside the transaction for the other
    // reason the whole file cares about: a network call under an advisory lock is the
    // pool-exhaustion pattern documented on `loadBusinessRules`.
    const travelEligibility = serviceNeedsCustomerAddress(service, extras)
      ? await resolveTravelEligibility({ tenantId: ctx.tenant.id, botId: ctx.bot.id, itineraryKey })
      : { active: false as const, reason: 'bot_disabled' as const };
    const placement: BookingPlacement =
      travelEligibility.active && contact.address?.trim()
        ? await placeAddressFor(travelEligibility, contact.address, extras?.customerPlaceId)
        : { applies: false };
    const place = bookingPlaceColumns(placement);

    // CAN THE OWNER GET THERE? Availability already filtered this time out if not, so reaching
    // here with a bad verdict means the model booked a time it never checked, or checked it
    // several turns ago. Two of the three answers are not refusals: the undecided middle band
    // becomes a Request, which is the platform's answer to every booking it cannot safely
    // confirm, and only a drive PROVEN impossible is turned away.
    let travelCheck: 'ok' | 'degraded' | 'captured' | null = null;
    // Non-null only when the gate ran AND cleared, which is the only path that reaches the
    // transaction. Everything else has already thrown or become a Request by then.
    let travelSnapshot: TravelSnapshot | null = null;
    if (travelEligibility.active) {
      // An address we could not place at all still stops here, exactly as it did before there
      // was a drive to check: there is a postcode that would settle it and the prompt asks for
      // one. Everything else below reasons over coordinates.
      assertPlaceableForTravel(placement);
      const checked =
        placement.applies && placement.outcome === 'placed'
          ? await this.travelVerdictForBooking(ctx, {
              eligibility: travelEligibility,
              service,
              placement,
              rule,
              start,
              end,
            })
          : // Google unreachable or the tenant's month spent. Not the customer's address being
            // vague, so there is no question worth asking them — and nothing to reason over,
            // which ADR-0015 answers with a Request rather than a confirmation of a drive
            // nobody checked or a refusal of a job the owner may well want.
            null;
      const verdict: TravelVerdict = checked?.verdict ?? 'undecided';
      // Carried into the transaction so the in-lock assert can re-reach this verdict without
      // geocoding anything: the candidate's point and the venue were both paid for above.
      travelSnapshot = checked && verdict === 'clear'
        ? {
            candidate: checked.candidate,
            venue: checked.venue,
            drives: checked.drives,
            base: checked.base,
            dayStart: checked.dayStart,
          }
        : null;
      if (verdict === 'unreachable') {
        logger.info('[Travel] refusing a booking the owner could not reach', {
          botId: ctx.bot.id,
          tenantId: ctx.tenant.id,
          start: start.toISOString(),
        });
        throw new BookingError(
          'That time cannot be reached from the appointments either side of it. Offer one of the other available times instead, and do not retry this one.',
          'TRAVEL_TIME_CONFLICT',
          409,
          undefined,
          // Reachable from the customer's manage link, and phrased without blame or mechanism:
          // the reason is the owner's other appointments, which is not the customer's business.
          'That time is no longer available. Please pick another.'
        );
      }
      if (verdict === 'undecided') {
        logger.info('[Travel] capturing a request travel could not clear', {
          botId: ctx.bot.id,
          tenantId: ctx.tenant.id,
          start: start.toISOString(),
        });
        // The placement travels with it, so the request row records the SAME evidence the
        // verdict was reached on rather than paying to resolve the address a second time.
        return this.createRequest(
          ctx, idempotencyKey, service, itineraryKey, start, end, attendee, notes,
          extras?.aiSummary, intakeAnswers, extras, effectiveDuration,
          { placement, travelCheck: 'captured' }
        );
      }
      // CONTEXT.md is the vocabulary this column speaks and it draws the line at whether a
      // MEASUREMENT happened: `ok` is "verified against routing", `degraded` is "decided on
      // the haversine bounds alone". A bound CLEARS a drive, it does not measure one — so
      // even before the floor was found to be a calibration rather than a proof, clearing was
      // never enough to earn `ok`.
      //
      // A column that under-claims can never be mistaken for a verification that never ran;
      // one that over-claims is the silent wrongness this whole feature exists to prevent.
      //
      // `ok` requires that EVERY constraining leg got a routing answer — a booking where the
      // bounds settled one leg and routing the other stays `degraded`, or the word means two
      // things depending on what the diary happened to look like, and #68's alert inherits the
      // ambiguity. `fullyRouted` is the gate's all-or-nothing answer to exactly that.
      //
      // NULL when no leg constrained the verdict at all — an empty day, or one whose only
      // neighbours are phone jobs. Nothing was measured and nothing was unavailable, which is
      // exactly what NULL already means on this column. Reschedule must spell this the same
      // way; two paths disagreeing about the same situation is how the column stops meaning
      // anything.
      travelCheck = !checked?.hadConstrainingLeg ? null : checked.fullyRouted ? 'ok' : 'degraded';
    }

    // 4. Reserve + insert under a per-itinerary advisory lock. The exclusion
    //    constraint is the last-line guard: a racing create gets 23P01.
    const icsUid = `${uuidv4()}@axentrio`;
    let bookingId: string;
    try {
      bookingId = await AppDataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [itineraryKey]);
        // P5b: capacity gate — count held bookings for this service on the slot's local
        // day, inside the same lock so the count-then-insert is atomic.
        await enforceServiceDayCapacity(manager, service, start, rule.timezone);
        await enforceBusinessCapacity(
          manager,
          ctx.bot.id,
          itineraryKey,
          await loadBusinessRules(ctx.bot.id, manager),
          { start, end, blockedStart, blockedEnd },
          rule.timezone
        );
        // LAST, and inside the lock. Everything above is a fact about this booking alone; this
        // is the only check that asks what ELSE has landed in the diary since the pre-lock pass
        // looked, and it is the only protection against two customers confirming in the same
        // second at addresses the owner cannot drive between. The exclusion constraint below
        // cannot help: it understands overlap, and these two do not overlap.
        if (travelSnapshot && travelEligibility.active) {
          await this.assertTravelFeasible(manager, {
            eligibility: travelEligibility,
            service,
            candidate: travelSnapshot.candidate,
            venue: travelSnapshot.venue,
            drives: travelSnapshot.drives,
            base: travelSnapshot.base,
            dayStart: travelSnapshot.dayStart,
            start,
            end,
          });
        }
        // The binding and the booking share this transaction. A confirmation or fresh selection
        // that won the row lock first invalidates this attempt; if this transaction wins, it voids
        // both the active address and its question before the INSERT can commit.
        await consumeAddressBinding(manager, ctx.session.id, extras?.addressBinding);
        const rows: Array<{ id: string }> = await manager.query(
          `INSERT INTO chatbot_bookings
             (tenant_id, bot_id, provider, event_type_id, booking_mode, session_id, status,
              start_utc, end_utc, blocked_range, calendar_key,
              attendee_name, attendee_email, notes, ics_uid, idempotency_key, intake_answers,
              customer_address, customer_phone, booked_duration_min, uploaded_files, source_channel,
              ai_summary, organizer_email, service_area_match,
              customer_place_id, customer_lat, customer_lng, customer_coords_at,
              customer_address_verified, geocode_precision, location_source, travel_check)
           VALUES ($1,$2,'internal',$3,'auto',$4,'confirmed',$5,$6, tstzrange($7,$8,'[)'),$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19::jsonb,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
           RETURNING id`,
          [
            ctx.tenant.id,
            ctx.bot.id,
            service.id,
            ctx.session.id,
            start.toISOString(),
            end.toISOString(),
            blockedStart.toISOString(),
            blockedEnd.toISOString(),
            itineraryKey,
            attendee.name,
            attendee.email ?? null,
            notes ?? null,
            icsUid,
            idempotencyKey,
            intakeJson ? JSON.stringify(intakeJson) : null,
            contact.address,
            contact.phone,
            effectiveDuration,
            uploadedFiles ? JSON.stringify(uploadedFiles) : null,
            ctx.session?.channel ?? null,
            extras?.aiSummary ?? null,
            frozenOrganizerFor(ctx.tenant.id),
            // The gate above already passed, so this is 'inside' whenever it applied at all.
            areaMatch,
            // All null unless travel time is active for this Agent and the address placed to
            // a precision worth trusting.
            place.placeId,
            place.lat,
            place.lng,
            place.coordsAt,
            place.addressVerified,
            place.precision,
            place.locationSource,
            // `ok` only when the gate ran and PROVED the drives either side. Null means it
            // never applied — no travel time on this Agent, or a service nobody drives to.
            travelCheck,
          ]
        );
        return rows[0].id;
      });
    } catch (err) {
      if (err instanceof AddressBindingMovedError) {
        throw new BookingError(
          'The customer changed their address while the appointment was being created. Read the latest address and try the booking once more.',
          'ADDRESS_BINDING_CHANGED',
          409
        );
      }
      const code = (err as { code?: string })?.code;
      if (code === '23P01') {
        throw new BookingError(SLOT_TAKEN_ON_CREATE, 'SLOT_UNAVAILABLE', 409);
      }
      if (code === '23505') {
        // Idempotency race: a concurrent create inserted the same key.
        const dup = await bookingRepo.findOne({
          where: { tenantId: ctx.tenant.id, botId: ctx.bot.id, idempotencyKey, createdAt: createdWithinDedupWindow() },
        });
        if (dup) {
          await consumeBindingAfterIdempotentReturn(ctx, extras);
          return this.toResult(dup, true, rule.timezone, service.name, service.preparationInstructions);
        }
        throw new BookingError(SLOT_TAKEN_ON_CREATE, 'SLOT_UNAVAILABLE', 409);
      }
      throw err;
    }

    // 5. Audit log (parity with CalcomProvider).
    const logRepo = AppDataSource.getRepository(BookingLog);
    await logRepo.save(
      logRepo.create({
        tenantId: ctx.tenant.id,
        sessionId: ctx.session.id,
        idempotencyKey,
        calBookingId: bookingId,
        eventType: 'created',
        attendeeName: attendee.name,
        attendeeEmail: attendee.email,
        startTime: start,
        endTime: end,
        notes,
      })
    );

    logger.info('[Booking] Internal booking created', {
      bookingId,
      botId: ctx.bot.id,
      start: start.toISOString(),
    });

    // Mirror to the owner's Google calendar (best-effort). The booking is the
    // source of truth — if the mirror fails the booking still stands and is
    // flagged sync_pending for later reconciliation. The rich event body comes
    // from the single P6a builder (ai_summary now flows on the auto path too — no
    // value flows in here yet, the builder simply omits that line).
    const eventContent = buildBookingEventContent(
      {
        attendeeName: attendee.name,
        attendeeEmail: attendee.email,
        customerPhone: contact.phone,
        customerAddress: contact.address,
        aiSummary: extras?.aiSummary ?? null,
        notes,
        intakeAnswers: intakeJson,
        bookingId,
        durationMin: effectiveDuration,
        sourceChannel: ctx.session?.channel ?? null,
        uploadedFileCount: uploadedFiles?.length ?? 0,
      },
      service,
      buildManageUrl(bookingId),
    );
    // Read the venue BEFORE the mirror, not after: the calendar event is created here, so
    // a venue loaded at the email tail arrived too late to reach it at all.
    const { venue } = await loadBusinessRules(ctx.bot.id);
    const eventLocation = resolveBookingEventLocation(service, {
      // Explicitly null: the Meet URL is a RESULT of creating this event, so it cannot be
      // an input to it. The physical venue is what the mirror carries; Google renders the
      // Meet link itself from conferenceData.
      meetUrl: null,
      customerAddress: contact.address,
      venue,
      locationChoice: extras?.locationChoice,
    });
    const meetUrl = await syncCalendarCreate(
      ctx,
      bookingId,
      eventContent,
      start,
      end,
      rule.timezone,
      eventLocation,
      // A conference belongs to a VIDEO service and nothing else. Minting one for an
      // in-person job also stole the LOCATION field from the venue.
      service.locationType === 'google_meet'
    );

    // Confirmation invite (non-fatal). Customer always gets the ICS (+ owner in
    // Phase 0 fallback); the Meet link rides along when present.
    await sendBookingEmail({
      method: 'REQUEST',
      uid: icsUid,
      sequence: 0,
      start,
      end,
      summary: service.name,
      // LOCATION is a VENUE (RFC 5545 §3.8.1.7). This used to send the literal "In person",
      // which is a modality — it told the customer nothing and occupied the field their
      // calendar would otherwise use for directions. Omitted entirely when unknown.
      location: resolveBookingEventLocation(service, {
        meetUrl,
        customerAddress: contact.address,
        venue,
        locationChoice: extras?.locationChoice,
      }),
      // The CUSTOMER's copy — what they need, not the owner's operational detail.
      description: buildCustomerEventDescription({
        serviceName: service.name,
        serviceDescription: service.description,
        durationMin: effectiveDuration,
        meetUrl,
        preparationInstructions: service.preparationInstructions,
        manageUrl: buildManageUrl(bookingId),
        businessName: ctx.botSettings.ai?.brandVoice?.businessName || ctx.tenant.name,
      }),
      // The owner's copy says exactly what their calendar entry says.
      ownerDetail: eventContent.description,
      timezone: rule.timezone,
      attendeeName: attendee.name,
      attendeeEmail: attendee.email,
      ownerEmail: ctx.botSettings.ai?.supportEmail ?? undefined,
      organizerEmail: frozenOrganizerFor(ctx.tenant.id),
      organizerName: ctx.botSettings.ai?.brandVoice?.businessName || ctx.tenant.name,
      manageUrl: buildManageUrl(bookingId),
      durationMin: effectiveDuration,
      preparationInstructions: service.preparationInstructions,
    });

    await scheduleAndPersistReminders(bookingId, start, 0);

    return {
      success: true,
      timezone: rule.timezone,
      serviceName: service.name,
      preparationInstructions: service.preparationInstructions,
      booking: {
        id: bookingId,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        displayTime: formatBookingDisplayTime(start, rule.timezone),
        attendee,
      },
    };
  }

  /**
   * Request-only capture: store a `request_created` Booking (a lead) with the
   * customer's preferred time, but NO calendar event, email, or reminders. The
   * owner reviews it (richer request UX + notification is P2). Requests don't
   * block the calendar — the exclusion constraint only covers pending/confirmed.
   */
  private async createRequest(
    ctx: BookingContext,
    idempotencyKey: string,
    service: ServiceType,
    itineraryKey: ItineraryKey,
    start: Date,
    end: Date,
    attendee: { name: string; email?: string },
    notes?: string,
    aiSummary?: string,
    intakeAnswers?: unknown,
    extras?: BookingExtras,
    bookedDurationMin?: number,
    /**
     * A verdict the AUTO path already reached, handed down rather than re-derived.
     *
     * Set only when create ran the travel gate and could not clear the drive. Carrying the
     * placement across means the request row records the very evidence the verdict was reached
     * on — and does not pay Google a second time for the same address moments later.
     */
    travel?: { placement: BookingPlacement; travelCheck: 'captured' }
  ): Promise<CreateBookingResult> {
    const bookingRepo = AppDataSource.getRepository(Booking);
    const icsUid = `${uuidv4()}@axentrio`;
    const sourceChannel = ctx.session?.channel ?? null;
    // P3: normalize intake answers against this resolved (request-mode) service.
    const intakeJson = normalizeIntakeAnswers(service, intakeAnswers);
    assertRequiredIntake(service, intakeJson);
    // P5a: required address/phone gate (request path).
    const contact = resolveContactFields(service, extras, ctx.session);
    // Travel time: place the address here too, and NEVER enforce it. A request the owner
    // will read is exactly the right home for a job we could not locate — refusing one is
    // the single outcome the prompt forbids — but capturing it silently is how an owner
    // ends up standing in the wrong town holding a request nobody flagged.
    const placement =
      travel?.placement ??
      (await placeBookingAddress({
        tenantId: ctx.tenant.id,
        botId: ctx.bot.id,
        itineraryKey,
        service,
        address: contact.address,
        placeId: extras?.customerPlaceId,
      }));
    const place = bookingPlaceColumns(placement);
    // The row records THAT the gate had nothing to work with; only this line records WHY.
    // `travel_check` has four values describing what the gate DID, and it did nothing in
    // both of these cases, so a vague address and a Google outage land on one value. Telling
    // a sustained run of the second apart from a bad week of the first is what this is for.
    if (requestTravelCheck(placement) === 'captured') {
      logger.info('[Booking] capturing a request travel could not place', {
        botId: ctx.bot.id,
        tenantId: ctx.tenant.id,
        outcome: placement.applies ? placement.outcome : 'n/a',
      });
    }
    // P5e: snapshot ready uploads from this chat (the model never sees file ids).
    const fileSessionIds = await this.resolveFileSessionIds(ctx, service);
    const uploadedFiles = await this.validateUploadedFiles(ctx, service, fileSessionIds);

    let bookingId: string;
    const requestAreaMatch = (await evaluateServiceArea(ctx, service, contact.address ?? null)).match;
    try {
      const rows = await AppDataSource.transaction(async (manager) => {
        await consumeAddressBinding(manager, ctx.session.id, extras?.addressBinding);
        return manager.query(
          `INSERT INTO chatbot_bookings
           (tenant_id, bot_id, provider, event_type_id, booking_mode, session_id, status,
            start_utc, end_utc, blocked_range, calendar_key,
            attendee_name, attendee_email, notes, ics_uid, idempotency_key,
            source_channel, ai_summary, intake_answers, customer_address, customer_phone, booked_duration_min, uploaded_files,
            organizer_email, service_area_match,
            customer_place_id, customer_lat, customer_lng, customer_coords_at,
            customer_address_verified, geocode_precision, location_source, travel_check)
         VALUES ($1,$2,'internal',$3,'request',$4,'request_created',$5,$6, tstzrange($5,$6,'[)'),$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19::jsonb,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
           RETURNING id`,
          [
          ctx.tenant.id,
          ctx.bot.id,
          service.id,
          ctx.session.id,
          start.toISOString(),
          end.toISOString(),
          itineraryKey,
          attendee.name,
          attendee.email ?? null,
          notes ?? null,
          icsUid,
          idempotencyKey,
          sourceChannel,
          aiSummary ?? null,
          intakeJson ? JSON.stringify(intakeJson) : null,
          contact.address,
          contact.phone,
          bookedDurationMin ?? null,
          uploadedFiles ? JSON.stringify(uploadedFiles) : null,
          frozenOrganizerFor(ctx.tenant.id),
          // EVALUATED, never enforced. Capturing an out-of-area job is correct — refusing
          // one is the single outcome the prompt forbids — but capturing it silently is how
          // an owner turns work away for months without ever seeing it.
          requestAreaMatch,
          place.placeId,
          place.lat,
          place.lng,
          place.coordsAt,
          place.addressVerified,
          place.precision,
          place.locationSource,
          // `captured` — held as a request because the gate could not clear it. Two writers,
          // one meaning: a request the customer asked for whose address would not place, and a
          // booking the AUTO path downgraded because the drive could not be settled. A request
          // whose address placed cleanly and was never travel-checked keeps a null, because
          // nothing has judged its drive.
            travel?.travelCheck ?? requestTravelCheck(placement),
          ]
        ) as Promise<Array<{ id: string }>>;
      });
      bookingId = rows[0].id;
    } catch (err) {
      if (err instanceof AddressBindingMovedError) {
        throw new BookingError(
          'The customer changed their address while the request was being created. Read the latest address and try once more.',
          'ADDRESS_BINDING_CHANGED',
          409
        );
      }
      if ((err as { code?: string })?.code === '23505') {
        const dup = await bookingRepo.findOne({
          where: { tenantId: ctx.tenant.id, botId: ctx.bot.id, idempotencyKey, createdAt: createdWithinDedupWindow() },
        });
        if (dup) {
          await consumeBindingAfterIdempotentReturn(ctx, extras);
          return this.toResult(dup, true);
        }
      }
      throw err;
    }

    // Audit log is best-effort — a log failure must not abort the request (the row is
    // already committed) nor block the single "exactly once per new row" notification below.
    try {
      const logRepo = AppDataSource.getRepository(BookingLog);
      await logRepo.save(
        logRepo.create({
          tenantId: ctx.tenant.id,
          sessionId: ctx.session.id,
          idempotencyKey,
          calBookingId: bookingId,
          eventType: 'created',
          attendeeName: attendee.name,
          attendeeEmail: attendee.email,
          startTime: start,
          endTime: end,
          notes,
        })
      );
    } catch (err) {
      logger.warn('[Booking] request audit log failed (non-fatal)', {
        bookingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info('[Booking] Internal request captured', { bookingId, botId: ctx.bot.id, service: service.name });

    // Single, idempotent post-create notification path (fires once per NEW request only —
    // the idempotent re-return above short-circuits before reaching here).
    this.notifyRequestCreated(ctx, service, {
      bookingId,
      start,
      end,
      attendee,
      notes,
      aiSummary,
    });

    return {
      success: true,
      requested: true,
      booking: {
        id: bookingId,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        attendee,
      },
    };
  }

  /**
   * Capture an appointment **request** (the agent's `request_appointment` fallback).
   * A request always has a resolved service + preferred time; it is NOT a confirmed
   * slot, so we deliberately skip slot re-validation and never touch the calendar.
   * Routes through the same `createRequest()` as the auto-flow's request-mode
   * short-circuit, so both share one idempotent notification path.
   */
  async requestAppointment(
    ctx: BookingContext,
    idempotencyKey: string,
    preferredTime: string,
    attendee: { name: string; email?: string },
    notes?: string,
    serviceId?: string,
    aiSummary?: string,
    intakeAnswers?: unknown,
    extras?: BookingExtras
  ): Promise<CreateBookingResult> {
    // Idempotency FIRST: a live (non-failed) row with this key → return it (no re-notify),
    // before resolving the service — a catalog change must not turn a retry into an error.
    const bookingRepo = AppDataSource.getRepository(Booking);
    const existing = await bookingRepo.findOne({
      where: { tenantId: ctx.tenant.id, botId: ctx.bot.id, idempotencyKey, createdAt: createdWithinDedupWindow() },
    });
    // Any existing row for this idempotency key is a duplicate. (This used to exclude
    // 'failed', a status nothing ever wrote.)
    if (existing) {
      await consumeBindingAfterIdempotentReturn(ctx, extras);
      return this.toResult(existing, true);
    }

    // Resolve the service (sole-active default / SERVICE_REQUIRED / SERVICE_NOT_FOUND).
    const rule = await this.loadRule(ctx.bot);
    const service = await this.resolveService(ctx.bot.id, serviceId);
    const itineraryKey = await resolveItineraryKey(ctx.bot.id);

    const start = parseBookingStart(preferredTime, rule.timezone);
    if (!start) {
      throw new BookingError('Invalid preferred time', 'INVALID_START_TIME', 400);
    }
    // P5c: requests validate the duration BOUNDS (DURATION_OUT_OF_RANGE) but not slot-fit;
    // the end + persisted length are purely informational for the owner.
    const effectiveDuration = resolveDuration(service, extras?.durationMin);
    const end = new Date(start.getTime() + effectiveDuration * 60_000);

    // AN AUTO-BOOK SERVICE MUST NOT BANK A TIME ITS OWN POLICY REFUSES.
    //
    // Requests deliberately skip slot validation: a request is a preference and the owner
    // decides. That holds for a full day, an out-of-area job, or an unmeasured drive - all
    // times the owner COULD say yes to. It does not hold outside their notice or horizon,
    // or once this service has reached maxBookingsPerDay: they have already said no and no
    // decision is left to make.
    //
    // Seen on production with this fix's other half already deployed: the model skipped
    // check_availability entirely, asked for a name, and captured a request for a date 63 days
    // out against a 60-day horizon. The customer was promised a callback nobody could honour.
    // The same skip then captured a request after CAPACITY_REACHED on an auto-book service
    // with two jobs and a cap of two. The gate has to be here, because the tool the model
    // chose never looked at a slot.
    //
    // Narrow on purpose. Request-only services, a paused business and a dead calendar all keep
    // capturing exactly as before - a request is the RIGHT answer for those - and so does any
    // time inside the window that is merely taken. A daily cap is not "merely taken".
    const canAuto =
      (await this.canAutoConfirm(ctx)) && !(await loadBusinessRules(ctx.bot.id)).bookingsPaused;
    if (service.bookingMode !== 'request' && canAuto) {
      const { earliestMs, latestMs } = bookableWindow(service, new Date());
      const startMs = start.getTime();
      // The RANGE goes into the message, never the bound: it is a policy instant, not an opening
      // time - see the note on `requestTooSoon`.
      if (startMs < earliestMs) {
        const { startDate, endDate } = retryRange('too_soon', new Date(earliestMs).toISOString(), rule.timezone);
        throw new BookingError(requestTooSoon(startDate, endDate), 'REQUEST_OUTSIDE_WINDOW', 409);
      }
      if (startMs > latestMs) {
        const { startDate, endDate } = retryRange('too_far', new Date(latestMs).toISOString(), rule.timezone);
        throw new BookingError(requestTooFar(startDate, endDate), 'REQUEST_OUTSIDE_WINDOW', 409);
      }
      await enforceServiceDayCapacity(null, service, start, rule.timezone);
    }

    // Dedup on the PARSED time (#35): a rapid re-confirm in another turn resolves to
    // the same normalized start, but the LLM may pass a slightly different raw
    // preferredTime string, so the idempotency-key check above can miss. Catch it on
    // (session, service, startUtc) within the dedup window. Requests don't block
    // calendar time, so without this they'd double up; auto-bookings are already
    // guarded by the calendar conflict constraint.
    const recentDup = await bookingRepo.findOne({
      where: {
        tenantId: ctx.tenant.id, botId: ctx.bot.id, sessionId: ctx.session.id,
        eventTypeId: service.id, startUtc: start,
        createdAt: createdWithinDedupWindow(),
      },
      order: { createdAt: 'DESC' },
    });
    // A cancelled row must NOT dedupe — the customer may legitimately rebook the same
    // slot. 'failed' and 'declined' were also listed here; neither is ever written
    // (declining a request writes 'cancelled').
    if (
      recentDup &&
      recentDup.status !== 'cancelled' &&
      rowDedupIdentity(recentDup, service.customerAddressRequired) ===
        callDedupIdentity(service.customerAddressRequired, extras)
    ) {
      await consumeBindingAfterIdempotentReturn(ctx, extras);
      return this.toResult(recentDup, true);
    }

    return this.createRequest(ctx, idempotencyKey, service, itineraryKey, start, end, attendee, notes, aiSummary, intakeAnswers, extras, effectiveDuration);
  }

  /**
   * Fire-and-forget owner notification for a NEWLY created request. The single place
   * request side effects live, so the auto-flow short-circuit and `request_appointment`
   * notify identically and exactly once. Webhook now (P2a); owner email lands in P2b.
   */
  private notifyRequestCreated(
    ctx: BookingContext,
    service: ServiceType,
    req: {
      bookingId: string;
      start: Date;
      end: Date;
      attendee: { name: string; email?: string };
      notes?: string;
      aiSummary?: string;
    }
  ): void {
    try {
      const sessionCtx = {
        id: ctx.session.id,
        channel: ctx.session?.channel ?? 'widget',
        visitorId: ctx.session?.visitorId ?? 'unknown',
        startedAt: ctx.session?.startedAt?.toISOString() ?? new Date().toISOString(),
        messageCount: ctx.session?.messageCount ?? 0,
        tags: ctx.session?.tags,
      };
      const event: BookingRequestCreatedEvent = {
        ...buildEventBase('booking.request_created', ctx.tenant.id, sessionCtx),
        type: 'booking.request_created',
        booking: {
          bookingId: req.bookingId,
          startTime: req.start.toISOString(),
          endTime: req.end.toISOString(),
          attendeeName: req.attendee.name,
          attendeeEmail: req.attendee.email ?? '',
          notes: req.notes,
        },
        service: { id: service.id, name: service.name },
      };
      emitWebhookEvent(event);
    } catch (err) {
      logger.warn('[Booking] request_created webhook emit failed (non-fatal)', {
        bookingId: req.bookingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Push notification to operators (fire-and-forget; never blocks the booking).
    void notificationService
      .createForTenant({
        tenantId: ctx.tenant.id,
        type: 'booking_request',
        title: 'New booking request',
        message: `${req.attendee.name} requested ${service.name}`,
        data: { bookingId: req.bookingId, sessionId: ctx.session.id },
        dedupeBase: `booking_request:${req.bookingId}`,
      })
      .catch(() => {});

    // Owner email — fire-and-forget. Skipped (and logged) when no supportEmail is set;
    // that's an accepted degraded state — the portal Requests tab is the guaranteed surface
    // and the webhook above still fires.
    const ownerEmail = ctx.botSettings.ai?.supportEmail;
    if (!ownerEmail) {
      logger.info('[Booking] request owner email skipped — no supportEmail configured', {
        bookingId: req.bookingId,
        botId: ctx.bot.id,
      });
      return;
    }
    void (async () => {
      // Canonical, server-owned business timezone — already on the resolved bot.
      const timezone = ctx.bot.businessTimezone || 'UTC';
      await sendRequestNotificationEmail({
        ownerEmail,
        serviceName: service.name,
        start: req.start,
        timezone,
        attendeeName: req.attendee.name,
        attendeeEmail: req.attendee.email,
        notes: req.notes,
        aiSummary: req.aiSummary,
      });
    })();
  }

  /**
   * Auto-collect the chat session's ready uploads for a file-accepting service.
   * The model never sees upload ids; this is how a customer's file reaches the
   * booking. A no-file service auto-collects nothing, so a stray upload
   * elsewhere in the chat cannot block a booking.
   */

  private async resolveFileSessionIds(
    ctx: BookingContext,
    service: ServiceType,
  ): Promise<string[] | undefined> {
    if (!service.fileUploadAllowed) return undefined;
    const { getUploadService } = await import('../../file-handling/upload.service');
    const ids = await getUploadService().getReadySessionFileIds(ctx.session.id, ctx.tenant.id);
    return ids.length ? ids : undefined;
  }

  /**
   * Snapshot ready uploads from this chat onto the booking. Auto-collect is the
   * only source of ids, so a malformed row is skipped (and logged) rather than
   * thrown: FILE_NOT_READY would poison every later booking in this chat.
   * Returns the JSON array or null when nothing well-formed was attached.
   */

  private async validateUploadedFiles(
    ctx: BookingContext,
    service: ServiceType,
    fileSessionIds?: string[]
  ): Promise<Array<{ fileSessionId: string; fileName: string; mimeType: string; fileSize: number; fileKey: string }> | null> {
    const ids = Array.isArray(fileSessionIds) ? fileSessionIds.filter((s) => typeof s === 'string' && s) : [];
    if (!ids.length) return null;
    if (!service.fileUploadAllowed) {
      throw new BookingError('This service does not accept file uploads', 'FILE_UPLOAD_NOT_ALLOWED', 400);
    }
    const distinct = [...new Set(ids)];
    if (distinct.length > 5) {
      throw new BookingError('Too many files attached', 'TOO_MANY_FILES', 400);
    }
    const { getUploadService } = await import('../../file-handling/upload.service');
    const uploadService = getUploadService();
    const out: Array<{ fileSessionId: string; fileName: string; mimeType: string; fileSize: number; fileKey: string }> = [];
    for (const id of distinct) {
      const session = await uploadService.getSession(id);
      const wellFormed =
        !!session &&
        session.status === 'ready' &&
        session.tenantId === ctx.tenant.id &&
        session.chatSessionId === ctx.session.id &&
        typeof session.originalName === 'string' && !!session.originalName &&
        typeof session.fileKey === 'string' && !!session.fileKey &&
        typeof session.mimeType === 'string' && !!session.mimeType &&
        typeof session.fileSize === 'number' && session.fileSize > 0;
      if (!wellFormed) {
        logger.warn('[Booking] skipping auto-collected file that is not ready', {
          fileSessionId: id,
          tenantId: ctx.tenant.id,
          sessionId: ctx.session.id,
          status: session?.status ?? 'missing',
        });
        continue;
      }
      out.push({
        fileSessionId: id,
        fileName: session.originalName,
        mimeType: session.mimeType,
        fileSize: session.fileSize,
        fileKey: session.fileKey,
      });
    }
    return out.length ? out : null;
  }

  /**
   * Owner accepts a `request_created` lead → confirm it. Uses the request's FROZEN
   * start/end + booked duration; refreshes the itinerary key + buffer-expanded range
   * to current; re-checks availability + capacity under the per-itinerary lock; then
   * creates the calendar event, sends the confirmation, and schedules reminders. The
   * request's already-snapshotted uploaded_files ride along unchanged.
   */
  async acceptRequest(
    ctx: BookingContext,
    bookingId: string,
    /**
     * The owner has SEEN the appointment this would duplicate and wants it anyway.
     *
     * Repeat business is real - a customer booking a second appointment of the same service is
     * an ordinary thing - so the guard below refuses rather than forbids. Without this flag it
     * would block the legitimate case; with it defaulting to false, the accidental case cannot
     * happen in silence. Both halves are needed: refusing outright and allowing silently are
     * each wrong in the other direction.
     */
    options?: { allowDuplicate?: boolean }
  ): Promise<CreateBookingResult> {
    const booking = await this.loadOwned(ctx, bookingId);
    if (booking.provider !== 'internal' || booking.status !== 'request_created') {
      throw new BookingError('This booking is not a pending request', 'NOT_A_REQUEST', 409);
    }

    const start = booking.startUtc;
    const end = booking.endUtc;
    if (start.getTime() <= Date.now()) {
      throw new BookingError('This request is for a time in the past', 'REQUEST_EXPIRED', 409);
    }
    const rule = await this.loadRule(ctx.bot);
    const service = await this.serviceForBooking(booking);
    // Frozen length (stored span for legacy rows; never recompute from the service).
    const effectiveDuration = booking.bookedDurationMin ?? Math.round((end.getTime() - start.getTime()) / 60_000);
    // Refresh the itinerary key (owner may have connected/switched/disconnected since)
    // and the buffer-expanded range (request rows store the RAW start/end).
    const itineraryKey = await resolveItineraryKey(ctx.bot.id);
    const blockedStart = new Date(start.getTime() - service.bufferBeforeMin * 60_000);
    const blockedEnd = new Date(end.getTime() + service.bufferAfterMin * 60_000);

    // Re-validate the stored slot at the frozen duration (the lead may be days old).
    const busy = await loadAllBusy(
      ctx,
      itineraryKey,
      new Date(start.getTime() - 24 * 3600_000).toISOString(),
      new Date(end.getTime() + 24 * 3600_000).toISOString(),
      rule.timezone,
      bookingId
    );
    const offered = computeSlots({
      rule,
      eventType: { ...service, durationMin: effectiveDuration },
      rangeStart: start.toISOString(),
      rangeEnd: new Date(start.getTime() + 1000).toISOString(),
      now: new Date(),
      busy,
    }).some((s) => new Date(s.start).getTime() === start.getTime());
    if (!offered) {
      const occupied = busy.some(
        (b) => new Date(b.start).getTime() < blockedEnd.getTime() && new Date(b.end).getTime() > blockedStart.getTime()
      );
      throw new BookingError(
        occupied ? SLOT_TAKEN_ON_RESCHEDULE : SLOT_NOT_OFFERABLE_ON_RESCHEDULE,
        'SLOT_UNAVAILABLE',
        409
      );
    }

    // #72, and LAST of the checks on purpose. The request must first be a thing that could be
    // confirmed at all - not expired, not already handled, its time still offered - because
    // "this would duplicate an appointment" is the least specific reason to refuse, and saying
    // it about a request whose time has simply passed sends the owner looking for the wrong
    // problem. Checked at accept rather than at the write: a captured request is a question,
    // not a commitment, and refusing to capture one would throw away what the customer said.
    if (!options?.allowDuplicate) {
      const duplicate = await this.liveDuplicateFor(booking);
      if (duplicate) {
        throw new BookingError(
          'This customer already has a confirmed appointment for this service',
          'REQUEST_WOULD_DUPLICATE',
          409,
          {
            existingBookingId: duplicate.id,
            existingStartTime: duplicate.startUtc.toISOString(),
            // Enough to open the reschedule picker against the EXISTING appointment without
            // going and finding it. The owner is looking at the Requests tab; the appointment
            // in question is on Upcoming, so the client has no row to read these from - and
            // guessing them from the request would silently use the wrong frozen duration the
            // day a service's length changes.
            existingServiceId: duplicate.eventTypeId ?? null,
            existingDurationMin:
              duplicate.bookedDurationMin ??
              Math.round((duplicate.endUtc.getTime() - duplicate.startUtc.getTime()) / 60_000),
            // What the owner should almost always do instead. A request captured during a
            // pause is usually a reschedule wearing the wrong hat.
            suggestion: 'reschedule',
          }
        );
      }
    }

    // Flip request → confirmed under the lock (capacity + exclusion guard).
    let updatedRows: Array<{ id: string }>;
    try {
      // UPDATE…RETURNING via .query() yields [rows, count] — normalize (raw-sql.ts).
      updatedRows = returningRows<{ id: string }>(await AppDataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [itineraryKey]);
        await enforceServiceDayCapacity(manager, service, start, rule.timezone, bookingId);
        // A request consumes no capacity while it sits as a request — accepting it is the
        // moment it does, so this is the gate that matters for a captured lead.
        await enforceBusinessCapacity(
          manager,
          ctx.bot.id,
          itineraryKey,
          await loadBusinessRules(ctx.bot.id, manager),
          { start, end, blockedStart, blockedEnd },
          rule.timezone,
          bookingId
        );
        return manager.query(
          // NO TRAVEL ASSERT ANYWHERE ABOVE THIS, and that is the design rather than an
          // omission. `computeSlots` and `enforceBusinessCapacity` run here, which is exactly
          // where a travel check would naturally sit — and it is exactly why it must not.
          // A Request the travel gate captured would then be refused by the same gate that
          // captured it, and the owner could never clear it: the feature would have built a
          // queue with no exit. Feasibility is a hard constraint against the BOT, never against
          // the person who owns the diary (ADR-0015).
          //
          // `overridden` IS DERIVED FROM THE ROW, NOT FROM TODAY'S SETTINGS. The condition is
          // the row's own `travel_check = 'captured'`, evaluated by Postgres inside the same
          // statement that confirms. Between capture and acceptance a tenant can lose the
          // entitlement, an owner can flip the toggle, and a service can stop needing an
          // address — and in every one of those the owner is still overriding a job travel
          // captured. Reading live eligibility here would stop recording the override at
          // precisely the moment the configuration moved under it.
          `UPDATE chatbot_bookings
              SET status='confirmed', calendar_key=$2, blocked_range=tstzrange($3,$4,'[)'),
                  travel_check = CASE WHEN travel_check = 'captured' THEN 'overridden' ELSE travel_check END,
                  updated_at=now()
            WHERE id=$1 AND tenant_id=$5 AND status='request_created'
            RETURNING id`,
          [bookingId, itineraryKey, blockedStart.toISOString(), blockedEnd.toISOString(), ctx.tenant.id]
        );
      }));
    } catch (err) {
      if ((err as { code?: string })?.code === '23P01') {
        throw new BookingError(SLOT_TAKEN_ON_RESCHEDULE, 'SLOT_UNAVAILABLE', 409);
      }
      throw err;
    }
    if (!updatedRows.length) {
      throw new BookingError('This request was already handled', 'REQUEST_ALREADY_HANDLED', 409);
    }

    const confirmed = await this.loadOwned(ctx, bookingId);
    await this.writeLog(ctx, 'created', confirmed, start, end).catch(() => undefined);

    // Mirror to the connected calendar (best-effort), P6a rich body from the row.
    const eventContent = buildBookingEventContent(
      {
        attendeeName: confirmed.attendeeName,
        attendeeEmail: confirmed.attendeeEmail,
        customerPhone: confirmed.customerPhone,
        customerAddress: confirmed.customerAddress,
        aiSummary: confirmed.aiSummary,
        notes: confirmed.notes,
        intakeAnswers: confirmed.intakeAnswers,
        bookingId,
        durationMin: effectiveDuration,
        sourceChannel: confirmed.sourceChannel,
        uploadedFileCount: Array.isArray(confirmed.uploadedFiles) ? confirmed.uploadedFiles.length : 0,
      },
      service,
      buildManageUrl(bookingId)
    );
    // Read the venue BEFORE the mirror, not after: the calendar event is created here, so
    // a venue loaded at the email tail arrived too late to reach it at all.
    const { venue } = await loadBusinessRules(ctx.bot.id);
    const eventLocation = resolveBookingEventLocation(service, {
      // Explicitly null: the Meet URL is a RESULT of creating this event, so it cannot be
      // an input to it. The physical venue is what the mirror carries; Google renders the
      // Meet link itself from conferenceData.
      meetUrl: null,
      customerAddress: confirmed.customerAddress,
      venue,
    });
    const meetUrl = await syncCalendarCreate(
      ctx,
      bookingId,
      eventContent,
      start,
      end,
      rule.timezone,
      eventLocation,
      // A conference belongs to a VIDEO service and nothing else. Minting one for an
      // in-person job also stole the LOCATION field from the venue.
      service.locationType === 'google_meet'
    );

    await sendBookingEmail({
      method: 'REQUEST',
      uid: confirmed.icsUid,
      sequence: 0,
      start,
      end,
      summary: service.name,
      // LOCATION is a VENUE (RFC 5545 §3.8.1.7). This used to send the literal "In person",
      // which is a modality — it told the customer nothing and occupied the field their
      // calendar would otherwise use for directions. Omitted entirely when unknown.
      location: resolveBookingEventLocation(service, {
        meetUrl,
        customerAddress: confirmed.customerAddress,
        venue,
      }),
      // The CUSTOMER's copy — what they need, not the owner's operational detail.
      description: buildCustomerEventDescription({
        serviceName: service.name,
        serviceDescription: service.description,
        durationMin: effectiveDuration,
        meetUrl,
        preparationInstructions: service.preparationInstructions,
        manageUrl: buildManageUrl(bookingId),
        businessName: ctx.botSettings.ai?.brandVoice?.businessName || ctx.tenant.name,
      }),
      // The owner's copy says exactly what their calendar entry says.
      ownerDetail: eventContent.description,
      timezone: rule.timezone,
      attendeeName: confirmed.attendeeName ?? '',
      attendeeEmail: confirmed.attendeeEmail ?? '',
      ownerEmail: ctx.botSettings.ai?.supportEmail ?? undefined,
      organizerEmail: confirmed.organizerEmail,
      organizerName: ctx.botSettings.ai?.brandVoice?.businessName || ctx.tenant.name,
      manageUrl: buildManageUrl(bookingId),
      durationMin: effectiveDuration,
      preparationInstructions: service.preparationInstructions,
    });

    await scheduleAndPersistReminders(bookingId, start, 0);

    return this.toResult(confirmed, false, rule.timezone, service.name);
  }

  /** Owner declines a `request_created` lead → close it (no calendar event existed,
   *  no customer email in v1). Idempotent on a row that's already cancelled/handled. */
  async declineRequest(ctx: BookingContext, bookingId: string, reason?: string): Promise<CancelResult> {
    const booking = await this.loadOwned(ctx, bookingId);
    if (booking.status === 'cancelled') {
      return { success: true, cancelled: true };
    }
    if (booking.provider !== 'internal' || booking.status !== 'request_created') {
      throw new BookingError('This booking is not a pending request', 'NOT_A_REQUEST', 409);
    }
    const rows = returningRows<{ id: string }>(await AppDataSource.getRepository(Booking).query(
      `UPDATE chatbot_bookings
          SET status='cancelled', notes=COALESCE($3, notes), updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND status='request_created'
        RETURNING id`,
      [bookingId, ctx.tenant.id, reason ?? null]
    ));
    if (!rows.length) {
      // Lost a race / already handled — idempotent success.
      return { success: true, cancelled: true };
    }
    await this.writeLog(ctx, 'cancelled', booking, booking.startUtc, booking.endUtc, reason).catch(() => undefined);
    return { success: true, cancelled: true };
  }

  async listBookings(ctx: BookingContext, attendeeEmail: string): Promise<ListBookingsResult> {
    // Customer/widget path only (admin uses adminListBookings). Scope to the caller's
    // STABLE visitor identity on this bot (channel PSID / persisted widget visitorId)
    // so a returning customer sees the bookings they made in earlier sessions too —
    // never another visitor's. Falls back to the current session when no visitor id.
    const visitor = ctx.session.visitorId;
    const rows: Array<{
      id: string;
      start_utc: Date;
      end_utc: Date;
      attendee_name: string | null;
      attendee_email: string | null;
      status: string;
    }> = visitor
      ? await AppDataSource.getRepository(Booking).query(
          `SELECT b.id, b.start_utc, b.end_utc, b.attendee_name, b.attendee_email, b.status
             FROM chatbot_bookings b
             JOIN chat_sessions s ON s.id = b.session_id
            WHERE b.tenant_id = $1 AND b.bot_id = $2 AND b.status = 'confirmed'
              AND s.visitor_id = $3 AND b.attendee_email = $4
            ORDER BY b.start_utc ASC`,
          [ctx.tenant.id, ctx.bot.id, visitor, attendeeEmail]
        )
      : await AppDataSource.getRepository(Booking).query(
          `SELECT id, start_utc, end_utc, attendee_name, attendee_email, status
             FROM chatbot_bookings
            WHERE tenant_id = $1 AND bot_id = $2 AND status = 'confirmed'
              AND session_id = $3 AND attendee_email = $4
            ORDER BY start_utc ASC`,
          [ctx.tenant.id, ctx.bot.id, ctx.session.id, attendeeEmail]
        );
    return {
      bookings: rows.map((b) => ({
        id: b.id,
        startTime: new Date(b.start_utc).toISOString(),
        endTime: new Date(b.end_utc).toISOString(),
        attendee: { name: b.attendee_name ?? undefined, email: b.attendee_email ?? undefined },
        status: b.status,
      })),
    };
  }

  /** Load a booking and verify it belongs to this tenant + bot (else 404). */
  private async loadOwned(ctx: BookingContext, bookingId: string): Promise<Booking> {
    const booking = await AppDataSource.getRepository(Booking).findOne({ where: { id: bookingId } });
    if (!booking || booking.tenantId !== ctx.tenant.id || booking.botId !== ctx.bot.id) {
      throw new BookingError('Booking not found', 'BOOKING_NOT_FOUND', 404);
    }
    // Customer/widget path: a visitor may manage a booking from their own session
    // OR an earlier session sharing their STABLE visitor identity on this bot
    // (channel = the platform PSID from Meta's signed webhook; widget = the
    // persisted visitorId). A different identity (different PSID/visitorId) is still
    // walled off, even within the same tenant — the attendee email is an unverified
    // tool arg. The admin/portal + signed manage-link paths (isAdmin) bypass this.
    if (!ctx.isAdmin && !(await this.callerOwnsBooking(booking, ctx))) {
      throw new BookingError('Booking not found', 'BOOKING_NOT_FOUND', 404);
    }
    return booking;
  }

  /**
   * A live appointment the SAME customer already holds for the SAME service (#72).
   *
   * The reason this exists is a pause. The pause gate is create-shaped: it tells the model to
   * capture the customer's preferred time with `request_appointment`. Applied to a customer
   * MOVING an existing appointment, that writes a second row while the original confirmed
   * booking stands - and nothing links or dedups them, because `requestAppointment` dedups on
   * the idempotency key or `(session, service, startUtc)`, and a reschedule differs in the time
   * by definition. Accepting it then leaves the owner with two confirmed appointments, two
   * calendar events, and a customer holding the old invite.
   *
   * The prompt now names the exception and tells the model to keep using `reschedule_booking`
   * while paused. That is a prompt-level guard, and this codebase has repeatedly ruled those
   * insufficient on their own: if the model ignores it, or a later prompt edit erodes it, the
   * duplicate is written without complaint. This is the code-side half.
   *
   * Customer identity is the same rule `callerOwnsBooking` uses - the session, or an earlier
   * session carrying the same stable visitor identity - so a channel customer who came back
   * days later is still recognised as the same person.
   */
  private async liveDuplicateFor(request: Booking): Promise<Booking | null> {
    if (!request.eventTypeId || !request.sessionId) return null;

    const sessionIds = [request.sessionId];
    const owning = await AppDataSource.getRepository(ChatSession).findOne({
      where: { id: request.sessionId },
      select: ['id', 'visitorId'],
    });
    if (owning?.visitorId) {
      const siblings = await AppDataSource.getRepository(ChatSession).find({
        where: { visitorId: owning.visitorId, botId: request.botId },
        select: ['id'],
      });
      for (const s of siblings) if (!sessionIds.includes(s.id)) sessionIds.push(s.id);
    }

    return AppDataSource.getRepository(Booking).findOne({
      where: {
        botId: request.botId,
        eventTypeId: request.eventTypeId,
        sessionId: In(sessionIds),
        status: 'confirmed',
        endUtc: MoreThan(new Date()),
      },
      order: { startUtc: 'ASC' },
    });
  }

  /** True when the customer caller owns this booking: their own session, or an
   *  earlier session with the same stable visitor identity on the same bot (channel
   *  PSID / persisted widget visitorId). Bot ownership is already checked by the
   *  caller (loadOwned). */
  private async callerOwnsBooking(booking: Booking, ctx: BookingContext): Promise<boolean> {
    if (booking.sessionId && booking.sessionId === ctx.session.id) return true;
    const visitor = ctx.session.visitorId;
    if (!visitor || !booking.sessionId) return false;
    const owning = await AppDataSource.getRepository(ChatSession).findOne({
      where: { id: booking.sessionId },
      select: ['id', 'visitorId'],
    });
    return !!owning?.visitorId && owning.visitorId === visitor;
  }

  async rescheduleBooking(ctx: BookingContext, bookingId: string, newStartTime: string): Promise<RescheduleResult> {
    const booking = await this.loadOwned(ctx, bookingId);
    if (booking.status !== 'confirmed') {
      throw new BookingError('Only confirmed bookings can be rescheduled', 'BOOKING_NOT_RESCHEDULABLE', 409);
    }
    const rule = await this.loadRule(ctx.bot);
    const service = await this.serviceForBooking(booking);
    const itineraryKey = await resolveItineraryKey(ctx.bot.id);

    // Anchor a zoneless/loose time to the business timezone (mirrors create/request):
    // raw `new Date(newStartTime)` reads a zoneless string as UTC, drifting the booking
    // by the tz offset (e.g. "4 PM" → 6 PM in a UTC+2 business).
    const start = parseBookingStart(newStartTime, rule.timezone);
    if (!start) {
      throw new BookingError('Invalid start time', 'INVALID_START_TIME', 400);
    }
    // P5c: carry the booking's FROZEN length forward (grandfathered — never re-validated
    // against the service's current bounds). Legacy rows fall back to service.durationMin.
    const effectiveDuration = booking.bookedDurationMin ?? service.durationMin;
    const end = new Date(start.getTime() + effectiveDuration * 60_000);
    const blockedStart = new Date(start.getTime() - service.bufferBeforeMin * 60_000);
    const blockedEnd = new Date(end.getTime() + service.bufferAfterMin * 60_000);

    // Re-validate the new slot (excluding this booking's own current range).
    const busy = await loadAllBusy(
      ctx,
      itineraryKey,
      new Date(start.getTime() - 24 * 3600_000).toISOString(),
      new Date(end.getTime() + 24 * 3600_000).toISOString(),
      rule.timezone,
      bookingId,
      { start: booking.startUtc, end: booking.endUtc }
    );
    const offered = computeSlots({
      rule,
      eventType: { ...service, durationMin: effectiveDuration },
      rangeStart: start.toISOString(),
      rangeEnd: new Date(start.getTime() + 1000).toISOString(),
      now: new Date(),
      busy,
    }).some((s) => new Date(s.start).getTime() === start.getTime());
    if (!offered) {
      const occupied = busy.some(
        (b) => new Date(b.start).getTime() < blockedEnd.getTime() && new Date(b.end).getTime() > blockedStart.getTime()
      );
      throw new BookingError(
        occupied ? SLOT_TAKEN_ON_RESCHEDULE : SLOT_NOT_OFFERABLE_ON_RESCHEDULE,
        'SLOT_UNAVAILABLE',
        409
      );
    }

    // CAN THE OWNER STILL GET THERE, at the new time? A reschedule is a booking being made
    // again — the same job, against a different set of neighbours — so it earns the same check.
    // Without it the gate is a front door with the side door left open: a customer who books a
    // reachable slot and then moves it lands wherever they like.
    //
    // The address comes off the ROW, not from a caller. The customer gave it when they booked
    // and has not been asked again; asking would be the wrong question anyway, since the job has
    // not moved, only the time.
    //
    // And it is placed by IDENTITY, not by re-reading the typed words. A booking rescheduled
    // more than thirty days after it was made has had its coordinates deleted by then (ADR-0014
    // and the expiry sweep), which is ordinary rather than exceptional at a 60-day horizon —
    // and re-geocoding the same string can land somewhere else months later, moving a confirmed
    // appointment nobody touched. `placeExistingBooking` refreshes from `customer_place_id` and
    // writes the fresh position back.
    const travelEligibility = service.customerAddressRequired
      ? await resolveTravelEligibility({ tenantId: ctx.tenant.id, botId: ctx.bot.id, itineraryKey })
      : { active: false as const, reason: 'bot_disabled' as const };
    let travelSnapshot: TravelSnapshot | null = null;
    let travelCheck: 'ok' | 'degraded' | 'overridden' | null = null;
    if (travelEligibility.active && (booking.customerPlaceId || booking.customerAddress?.trim())) {
      const placement = await placeExistingBooking(booking, travelEligibility);
      // An owner moving a job in their own diary is warned by their picker, never blocked
      // (ADR-0015). A customer on a signed manage link gets the same enforcement the bot does:
      // they may not move themselves into a drive nobody can make.
      const enforcing = ctx.travelPolicy !== 'annotate';
      const checked =
        placement.applies && placement.outcome === 'placed'
          ? await this.travelVerdictForBooking(ctx, {
              eligibility: travelEligibility,
              service,
              placement,
              rule,
              start,
              end,
              excludeBookingId: bookingId,
            })
          : null;
      const verdict: TravelVerdict = checked?.verdict ?? 'undecided';
      if (verdict !== 'clear' && enforcing) {
        logger.info('[Travel] refusing a reschedule the owner could not reach', {
          botId: ctx.bot.id,
          tenantId: ctx.tenant.id,
          bookingId,
          verdict,
        });
        throw new BookingError(
          verdict === 'unreachable'
            ? 'That time cannot be reached from the appointments either side of it. Offer one of the other available times instead, and do not retry this one.'
            : 'The journey to that time could not be checked. Check availability again and offer one of the times it returns.',
          'TRAVEL_TIME_CONFLICT',
          409,
          undefined,
          // #73: the customer's manage link reaches this. Both branches keep the difference the
          // owner-facing wording is careful about - one is a refusal, the other is an unchecked
          // journey - without the instruction to the model or a claim of proof.
          verdict === 'unreachable'
            ? 'That time is no longer available. Please pick another.'
            : 'We could not check the journey to that time just now. Please pick another, or try again shortly.'
        );
      }
      travelSnapshot =
        checked && verdict === 'clear'
          ? {
              candidate: checked.candidate,
              venue: checked.venue,
              drives: checked.drives,
              base: checked.base,
              dayStart: checked.dayStart,
            }
          : null;
      // The MOVE invalidates whatever the old time was checked against, so the column is
      // rewritten rather than left describing a journey nobody is making any more. `ok` when
      // routing answered every constraining leg, `degraded` when the proofs alone cleared it,
      // and `overridden` when the owner moved it anyway past a verdict that did not clear.
      travelCheck =
        verdict !== 'clear'
          ? 'overridden'
          : !checked?.hadConstrainingLeg
            ? null
            : checked.fullyRouted
              ? 'ok'
              : 'degraded';
    }

    // A MOVE IS A REMOVAL TOO, and the removal half is the one that gets forgotten.
    //
    // Moving the day's first job does not merely place it somewhere new — it EXPOSES the next
    // booking on the old day as that day's new first, which now carries a premises leg nobody
    // has ever checked. Moving it LATER on the same day does exactly that without leaving the
    // day at all. Asserting only the moved booking at its new position would let a customer
    // move themselves out of a morning and strand a confirmed appointment, with every check
    // having passed.
    //
    // The unit is `(itineraryKey, localDay)` rather than the day alone, because the UPDATE below
    // rewrites `calendar_key` and a move can therefore cross itineraries. Deduplicated, or a
    // same-day move asserts one day twice.
    // RESOLVED INDEPENDENTLY OF THE MOVED BOOKING'S SERVICE, and that is the whole of finding 2.
    // `travelEligibility` above is gated on `service.customerAddressRequired`, because a phone
    // consultation is not a travel job. But exposure is not about the booking being MOVED — it is
    // about the one left behind, and an at-premises job (the owner's own workshop) is a
    // constraining neighbour whose removal exposes a first job just as surely as a mobile one.
    // Reusing the service-gated eligibility meant moving a workshop appointment asserted nothing.
    //
    // GATED ON `startFromBase`, and that is not an optimisation. Exposing a day's first job only
    // matters because that job acquires a PREMISES leg nobody checked; with the setting off there
    // is no such leg, every other constraint on the exposed booking was already validated when it
    // was made, and asserting anyway would refuse moves that have always been legal. "With the
    // setting off, behaviour is byte-identical" is an acceptance criterion, and this line is it.
    const itineraryEligibility = await resolveTravelEligibility({
      tenantId: ctx.tenant.id,
      botId: ctx.bot.id,
      itineraryKey,
    });
    const exposureEligibility =
      itineraryEligibility.active && itineraryEligibility.startFromBase ? itineraryEligibility : null;

    // ITS OWN SNAPSHOT, not the moved booking's. There may not BE a moved-booking snapshot — an
    // at-premises move never produces one — and the venue and drives the exposure pass pays for
    // are the ones its in-lock half has to replay.
    const exposureSnapshot: { venue: NeighbourLocation | null; drives: DriveRecords } = {
      venue: null,
      drives: {},
    };
    // Set only on the owner path, where the move is allowed to stand. "Allow and warn" is not a
    // warning until something can carry it out of here.
    let exposureWarning: string | undefined;
    const exposure = exposureEligibility
      ? this.exposurePairs({
          oldKey: (booking.calendarKey ?? itineraryKey) as ItineraryKey,
          // The RAW start, not the buffer-expanded one. A day's first job is first by when the
          // appointment is, and a long pre-buffer on an early booking can push the blocked range
          // back across midnight — which would file the booking under the previous day and
          // assert exposure on a day it was never on.
          oldDay: booking.startUtc,
          newKey: itineraryKey,
          newDay: start,
          rule,
          moved: {
            bookingId,
            blockedStart,
            blockedEnd,
            // Where the moved booking LANDS. Absent a travel snapshot (an at-premises or phone
            // job) it has no customer position, and `locationless` is the honest answer: such a
            // booking constrains nothing and can never be a day's first job.
            location: travelSnapshot
              ? travelSnapshot.candidate.coarse
                ? { kind: 'coarse' as const, point: travelSnapshot.candidate.point }
                : { kind: 'known' as const, point: travelSnapshot.candidate.point }
              : { kind: 'locationless' as const },
          },
        })
      : [];

    // PRE-LOCK, over the PROJECTED diary — the mutation applied in memory before it is applied
    // in the database. Selecting from the diary as it stands would pick the booking that is
    // LEAVING rather than the one exposed behind it, so the snapshot would hold the wrong legs
    // and the in-lock replay would miss on every ordinary move. Routed here, replayed there.
    for (const pair of exposure) {
      await this.assertExposedFirstJob({
        eligibility: exposureEligibility!,
        rule,
        day: pair.day,
        venue: null,
        captureVenue: (v) => {
          exposureSnapshot.venue ??= v;
        },
        project: pair.project,
        lookup: recordingLookup(
          driveLookupFor(exposureEligibility!, ctx.session?.id ?? null),
          exposureSnapshot.drives
        ),
        load: (from, to) =>
          loadTravelNeighbours({
            eligibility: { ...exposureEligibility!, itineraryKey: pair.key },
            botId: ctx.bot.id,
            from,
            to,
          }),
      });
    }

    // Single atomic UPDATE under the itinerary lock: frees the old slot and
    // reserves the new one in one statement; the exclusion constraint validates
    // the new range against other bookings (the row is excluded from itself).
    let sequence: number;
    try {
      sequence = await AppDataSource.transaction(async (manager) => {
        // BOTH KEYS, IN A DETERMINISTIC ORDER. A reschedule after a calendar change lifts the
        // booking off one itinerary and lands it on another, and re-asserting the old diary
        // while holding only the new key's lock would race the very write that exposed it.
        // Sorted, so two concurrent reschedules moving in opposite directions take them in the
        // same order and cannot deadlock. Postgres advisory locks are re-entrant within a
        // transaction, so the equal-keys case is unchanged.
        for (const key of [...new Set([itineraryKey, ...exposure.map((p) => p.key)])].sort()) {
          await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
        }
        // P5b: a reschedule into a DIFFERENT local day consumes capacity on the target
        // day — gate it (excluding this booking's own row). Same-day time moves don't.
        const oldDay = DateTime.fromJSDate(booking.startUtc).setZone(rule.timezone).toISODate();
        const newDay = DateTime.fromJSDate(start).setZone(rule.timezone).toISODate();
        if (oldDay !== newDay) {
          await enforceServiceDayCapacity(manager, service, start, rule.timezone, bookingId);
        }
        // UNCONDITIONALLY, unlike the count above: the same-day shortcut is sound for a
        // count (moving within a day cannot change it) but wrong for a gap or a minutes
        // total, both of which a same-day move can violate.
        await enforceBusinessCapacity(
          manager,
          ctx.bot.id,
          itineraryKey,
          await loadBusinessRules(ctx.bot.id, manager),
          { start, end, blockedStart, blockedEnd },
          rule.timezone,
          bookingId
        );
        if (travelSnapshot && travelEligibility.active) {
          await this.assertTravelFeasible(manager, {
            eligibility: travelEligibility,
            service,
            candidate: travelSnapshot.candidate,
            venue: travelSnapshot.venue,
            drives: travelSnapshot.drives,
            base: travelSnapshot.base,
            dayStart: travelSnapshot.dayStart,
            start,
            end,
            excludeBookingId: bookingId,
          });
        }
        const rows = returningRows<{ sequence: number }>(await manager.query(
          // `calendar_key` MOVES WITH THE BOOKING, and until now it did not.
          //
          // Everything above this line resolved the itinerary key freshly — the lock is taken
          // on it, `loadAllBusy` filters on it, `enforceBusinessCapacity` scopes the gap to it —
          // because the owner may have connected, switched or disconnected a calendar since the
          // booking was made, and `rekeyBotBookings` rewrites the key on their future bookings
          // when they do. The UPDATE then left the row on its OLD key. So a reschedule after a
          // calendar change validated against one diary and wrote into another, and the row
          // became invisible to every later query scoped by the key: its own next reschedule,
          // the Minimum Gap check, and now the travel gate's neighbour scan. The booking still
          // existed and still blocked its range through the exclusion constraint, which is why
          // this never showed up as a double-booking — it showed up as a gap that was not
          // enforced, against a job nobody could see.
          //
          // `acceptRequest` has always refreshed the key here, for exactly this reason. This is
          // the same line, in the path that was missing it.
          `UPDATE chatbot_bookings
              SET start_utc=$1, end_utc=$2, blocked_range=tstzrange($3,$4,'[)'),
                  calendar_key=$5, travel_check=$8, sequence=sequence+1, updated_at=now()
            WHERE id=$6 AND tenant_id=$7 AND status='confirmed'
            RETURNING sequence`,
          [
            start.toISOString(),
            end.toISOString(),
            blockedStart.toISOString(),
            blockedEnd.toISOString(),
            itineraryKey,
            bookingId,
            ctx.tenant.id,
            // Null when travel did not apply, which also CLEARS a stale value from a booking
            // whose service or Agent stopped needing one. A check nobody ran must not be
            // inherited from a time nobody is keeping.
            travelCheck,
          ]
        ));
        if (!rows.length) {
          throw new BookingError('Booking is no longer reschedulable', 'BOOKING_NOT_RESCHEDULABLE', 409);
        }

        // AFTER the UPDATE, against committed rows. The projection above predicted this state;
        // this is the assertion that it arrived. No projection is passed, because the database
        // now IS the projection.
        //
        // A replay miss here means the diary genuinely moved under the lock — the leg reads
        // undecided and the write refuses. That costs a retry and can never cost a wrong yes.
        for (const pair of exposure) {
          const { verdict, bookingId: exposedId } = await this.assertExposedFirstJob({
            eligibility: exposureEligibility!,
            rule,
            day: pair.day,
            venue: travelSnapshot?.venue ?? null,
            lookup: replayLookup(exposureSnapshot.drives),
            load: async (from, to) => ({
              neighbours: await loadStoredNeighbours(manager, {
                eligibility: { ...exposureEligibility!, itineraryKey: pair.key },
                from,
                to,
                venue: exposureSnapshot.venue,
              }),
            }),
          });
          if (verdict === 'clear') continue;
          // FEASIBILITY, NOT EFFICIENCY, so the policy split that governs everything else here
          // governs this too: the bot and a customer on a signed manage link may not strand a
          // confirmed job behind an unreachable premises leg; the owner may, because it is their
          // diary and their judgement. Annotating callers fall through and the move stands.
          if (ctx.travelPolicy === 'annotate') {
            // RESTAMP THE BOOKING WHOSE SITUATION CHANGED. It was not written to, but it has
            // acquired a premises leg nobody verified — and a row still saying `ok` would claim a
            // routing answer that no longer covers the journey it now has. `overridden` is the
            // value this file already uses for "the owner proceeded past a verdict that did not
            // clear", which is exactly what happened, to a different booking.
            if (exposedId) {
              await manager.query(
                `UPDATE chatbot_bookings SET travel_check='overridden', updated_at=now()
                  WHERE id=$1 AND tenant_id=$2`,
                [exposedId, ctx.tenant.id]
              );
            }
            exposureWarning =
              verdict === 'unreachable'
                ? 'Another appointment that day now starts from your business address and is too far to reach in time.'
                : 'Another appointment that day now starts from your business address, and that journey could not be checked.';
            logger.info('[Travel] owner moved a booking that leaves a first job unreachable', {
              tenantId: ctx.tenant.id,
              bookingId,
              exposedId,
              key: pair.key,
              verdict,
            });
            continue;
          }
          logger.info('[Travel] refusing a move that would strand another booking', {
            tenantId: ctx.tenant.id,
            bookingId,
            key: pair.key,
            verdict,
          });
          // TWO VERDICTS, TWO CLAIMS. `unreachable` is a drive the bounds PROVED impossible;
          // `undecided` is one nobody could establish, usually because a leg went unmeasured.
          // Saying "too far" for the second claims a proof the gate does not have — the exact
          // over-claiming three rounds of #64's review kept finding.
          throw new BookingError(
            verdict === 'unreachable'
              ? 'Moving this appointment would leave another one that day too far from your starting point to reach. Check availability again and offer one of the times it returns.'
              : 'Moving this appointment would leave another one that day whose journey could not be checked. Check availability again and offer one of the times it returns.',
            'TRAVEL_TIME_CONFLICT',
            409,
            undefined,
            // The most customer-reachable of the four: this fires while a customer is MOVING
            // their own appointment through the signed link. The owner's other appointments are
            // not the customer's business, so the reason is left out rather than paraphrased.
            'That time is no longer available. Please pick another.'
          );
        }
        return rows[0].sequence;
      });
    } catch (err) {
      if (err instanceof BookingError) throw err;
      if ((err as { code?: string })?.code === '23P01') {
        throw new BookingError(SLOT_TAKEN_ON_CREATE, 'SLOT_UNAVAILABLE', 409);
      }
      throw err;
    }

    await this.writeLog(ctx, 'rescheduled', booking, start, end);

    // Carry the meeting join URL onto the rescheduled invite. The ICS reuses the
    // same UID with a bumped SEQUENCE (an in-place UPDATE), so omitting LOCATION/
    // DESCRIPTION here would BLANK the join link on the attendee's calendar event.
    // The mirrored event is updated (not recreated) on reschedule, so the stored
    // meetingUrl is still valid. Mirror the create path's location/description.
    const ref = await canonicalRef(ctx.bot.id, bookingId);
    const meetUrl = ref?.meetingUrl ?? null;
    // The venue comes off the same booking-settings row the rules do; read at the tail
    // because the transaction has already committed by here.
    const { venue } = await loadBusinessRules(ctx.bot.id);
    await sendBookingEmail({
      method: 'REQUEST',
      uid: booking.icsUid,
      sequence,
      start,
      end,
      summary: service.name,
      // LOCATION is a VENUE (RFC 5545 §3.8.1.7). This used to send the literal "In person",
      // which is a modality — it told the customer nothing and occupied the field their
      // calendar would otherwise use for directions. Omitted entirely when unknown.
      location: resolveBookingEventLocation(service, {
        meetUrl,
        customerAddress: booking.customerAddress,
        venue,
      }),
      // The CUSTOMER's copy — what they need, not the owner's operational detail.
      description: buildCustomerEventDescription({
        serviceName: service.name,
        serviceDescription: service.description,
        durationMin: booking.bookedDurationMin,
        meetUrl,
        preparationInstructions: service.preparationInstructions,
        manageUrl: buildManageUrl(booking.id),
        businessName: ctx.botSettings.ai?.brandVoice?.businessName || ctx.tenant.name,
      }),
      timezone: rule.timezone,
      attendeeName: booking.attendeeName ?? '',
      attendeeEmail: booking.attendeeEmail ?? '',
      ownerEmail: ctx.botSettings.ai?.supportEmail ?? undefined,
      organizerEmail: booking.organizerEmail,
      organizerName: ctx.botSettings.ai?.brandVoice?.businessName || ctx.tenant.name,
      manageUrl: buildManageUrl(bookingId),
      durationMin: effectiveDuration,
      preparationInstructions: service.preparationInstructions,
    });

    // Replace reminders: drop the old jobs, schedule fresh ones for the new time.
    await cancelReminders(booking.reminderJobIds).catch(() => undefined);
    await scheduleAndPersistReminders(bookingId, start, sequence);

    // Move the mirrored Google event (best-effort).
    const rescheduledContent = buildBookingEventContent(
      {
        attendeeName: booking.attendeeName,
        attendeeEmail: booking.attendeeEmail,
        customerPhone: booking.customerPhone,
        customerAddress: booking.customerAddress,
        aiSummary: booking.aiSummary,
        notes: booking.notes,
        intakeAnswers: booking.intakeAnswers,
        bookingId,
        durationMin: effectiveDuration,
        sourceChannel: booking.sourceChannel,
        uploadedFileCount: Array.isArray(booking.uploadedFiles) ? booking.uploadedFiles.length : 0,
      },
      service,
      buildManageUrl(bookingId)
    );
    await syncCalendarReschedule(
      ctx,
      bookingId,
      rescheduledContent,
      start,
      end,
      rule.timezone,
      // Same derivation as the create path — a recreate has to rebuild the whole event, so it
      // needs the venue, and `meetUrl: null` because a conference is a RESULT of creating the
      // event: Google mints a fresh one from `conferencing` and we store what comes back.
      {
        location: resolveBookingEventLocation(service, {
          meetUrl: null,
          customerAddress: booking.customerAddress,
          venue,
        }),
        conferencing: service.locationType === 'google_meet',
      }
    ).catch(() => undefined);

    return {
      success: true,
      timezone: rule.timezone,
      serviceName: service.name,
      booking: {
        id: bookingId,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        displayTime: formatBookingDisplayTime(start, rule.timezone),
      },
      travelWarning: exposureWarning,
    };
  }

  async cancelBooking(ctx: BookingContext, bookingId: string, reason?: string): Promise<CancelResult> {
    const booking = await this.loadOwned(ctx, bookingId);
    // Idempotent: already cancelled → success, no email/log.
    if (booking.status === 'cancelled') {
      return { success: true, cancelled: true };
    }
    if (booking.status !== 'confirmed') {
      throw new BookingError('Only confirmed bookings can be cancelled', 'BOOKING_NOT_CANCELLABLE', 409);
    }
    const rule = await this.loadRule(ctx.bot);
    const service = await this.serviceForBooking(booking);

    const rows = returningRows<{ sequence: number }>(await AppDataSource.getRepository(Booking).query(
      `UPDATE chatbot_bookings
          SET status='cancelled', sequence=sequence+1, notes=COALESCE($3, notes), updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND status='confirmed'
        RETURNING sequence`,
      [bookingId, ctx.tenant.id, reason ?? null]
    ));
    if (!rows.length) {
      // Lost a race with another cancel — treat as idempotent success.
      return { success: true, cancelled: true };
    }

    await this.writeLog(ctx, 'cancelled', booking, booking.startUtc, booking.endUtc, reason);

    await sendBookingEmail({
      method: 'CANCEL',
      uid: booking.icsUid,
      sequence: rows[0].sequence,
      start: booking.startUtc,
      end: booking.endUtc,
      summary: service.name,
      timezone: rule.timezone,
      attendeeName: booking.attendeeName ?? '',
      attendeeEmail: booking.attendeeEmail ?? '',
      ownerEmail: ctx.botSettings.ai?.supportEmail ?? undefined,
      organizerEmail: booking.organizerEmail,
      organizerName: ctx.botSettings.ai?.brandVoice?.businessName || ctx.tenant.name,
    });

    // Drop pending reminders (they'd no-op via sequence/status anyway).
    await cancelReminders(booking.reminderJobIds).catch(() => undefined);
    await AppDataSource.getRepository(Booking)
      .query(`UPDATE chatbot_bookings SET reminder_job_ids='[]'::jsonb WHERE id=$1`, [bookingId])
      .catch(() => undefined);

    // Delete the mirrored Google event (best-effort).
    await syncCalendarCancel(ctx, bookingId).catch(() => undefined);

    return { success: true, cancelled: true, travelWarning: await this.cancelExposedWarning(ctx, booking) };
  }

  /**
   * Did cancelling this booking strand the job behind it?
   *
   * AFTER THE COMMIT, OUTSIDE ANY TRANSACTION, AND DELIBERATELY BEST-EFFORT. Cancel never
   * blocks, so this needs no lock, no rollback path and no place in the write: it may route
   * live precisely because it is holding nothing. The cost is that another write can land
   * between the commit and this read, so the warning can be stale — which is accepted, because
   * it is advice about a drive the owner has hours to act on, and a lock held across a Google
   * round-trip is the pool-exhaustion pattern this file exists to avoid.
   *
   * Never throws. A warning that could not be computed is simply absent; a cancellation that
   * already succeeded must not be reported as a failure because of it.
   */
  private async cancelExposedWarning(ctx: BookingContext, booking: Booking): Promise<string | undefined> {
    try {
      const key = (booking.calendarKey ?? (await resolveItineraryKey(ctx.bot.id))) as ItineraryKey;
      const eligibility = await resolveTravelEligibility({
        tenantId: ctx.tenant.id,
        botId: ctx.bot.id,
        itineraryKey: key,
      });
      if (!eligibility.active || !eligibility.startFromBase) return undefined;
      const rule = await this.loadRule(ctx.bot);
      const { verdict } = await this.assertExposedFirstJob({
        eligibility,
        rule,
        day: booking.startUtc,
        // Placed by the loader below, which is free to reach Google here.
        venue: null,
        lookup: driveLookupFor(eligibility, ctx.session?.id ?? null),
        load: (from, to) => loadTravelNeighbours({ eligibility, botId: ctx.bot.id, from, to }),
      });
      if (verdict === 'clear') return undefined;
      // A CUSTOMER IS TOLD NOTHING, BUT SOMEONE IS TOLD. They cannot act on the owner's next
      // drive, so surfacing it to them would attach somebody else's operational problem to a
      // cancellation they are entitled to make. Returning silently would lose the fact
      // altogether, though — so the check still runs and the answer becomes an operator line.
      if (ctx.travelPolicy !== 'annotate') {
        logger.info('[Travel] a customer cancellation exposed a first job that cannot be reached', {
          tenantId: ctx.tenant.id,
          botId: ctx.bot.id,
          bookingId: booking.id,
          verdict,
        });
        return undefined;
      }
      return 'The next appointment that day now starts your journey from your business address. Check you can still reach it in time.';
    } catch (error) {
      logger.warn('[Travel] could not check what a cancellation exposed', { bookingId: booking.id, error });
      return undefined;
    }
  }

  private async writeLog(
    ctx: BookingContext,
    eventType: 'rescheduled' | 'cancelled' | 'created',
    booking: Booking,
    start: Date,
    end: Date,
    reason?: string
  ): Promise<void> {
    const logRepo = AppDataSource.getRepository(BookingLog);
    await logRepo.save(
      logRepo.create({
        tenantId: ctx.tenant.id,
        sessionId: ctx.session.id,
        calBookingId: booking.id,
        eventType,
        attendeeName: booking.attendeeName ?? undefined,
        attendeeEmail: booking.attendeeEmail ?? undefined,
        startTime: start,
        endTime: end,
        notes: reason,
      })
    );
  }
}
