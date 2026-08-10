import type { OfferScoring } from '../travel/score-offer';
/**
 * Booking provider seam.
 *
 * `booking.service` is a thin dispatcher that resolves the session/tenant/bot
 * context and delegates to the `BookingProvider` configured for the bot
 * (`bot.settings.integrations.provider`, default `'calcom'`). Each provider
 * implements the same five operations. The n8n booking tools, the
 * `/internal/booking/*` endpoints, and the booking prompt are unaware of which
 * provider is active.
 */
import type { ChatSession } from '../../database/entities/ChatSession';
import type { Tenant } from '../../database/entities/Tenant';
import type { Bot, BotSettings } from '../../database/entities/Bot';

export class BookingError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
    /**
     * Structured facts a caller needs in order to OFFER SOMETHING BETTER than the refusal.
     *
     * Added for #72, where declining to create a duplicate appointment is only useful if the
     * owner is told which existing one it would duplicate - a bare "cannot do that" leaves them
     * to go and find it. `ApiError` already carries `details` to the client; this is the half
     * that was missing on the way there. Must stay free of anything a customer-facing surface
     * cannot show: `booking-public.controller.ts` renders errors to a browser.
     */
    public details?: Record<string, unknown>,
    /**
     * What a CUSTOMER may read, when this error can reach one.
     *
     * `message` has two audiences and used to have one field. `booking.tool.ts` feeds it to the
     * LLM verbatim, so it is written as stage directions - *"Do not offer specific times and do
     * not say they are fully booked - capture it with `request_appointment`"*. The signed
     * manage and reschedule pages render errors to a human being's browser. Those two facts met
     * once already, and a customer clicking Reschedule at a business with no connected calendar
     * would have read the bot's instructions.
     *
     * DECLARED AT THE THROW SITE, which is the point. The first fix was an allow-list in
     * `booking-public.controller.ts`, and it kept the two audiences in sync by hand: a code
     * added to the engine with no entry there degraded to "This link is invalid or has
     * expired." - honest, and back to the uninformative message the whole exercise set out to
     * remove. Here the choice is visible where the error is raised, by whoever knows what
     * happened, instead of being reconciled in a controller that has to know every code in the
     * engine.
     *
     * Absent still means the controller's allow-list decides, so nothing silently starts
     * leaking; the list is now the fallback rather than the only mechanism.
     */
    public customerMessage?: string
  ) {
    super(message);
    this.name = 'BookingError';
  }
}

/** Provider-agnostic context resolved once by the dispatcher per request. */
export interface BookingContext {
  session: ChatSession;
  tenant: Tenant;
  /** The resolved bot (session's bot, or the tenant anchor). */
  bot: Bot;
  botSettings: BotSettings;
  /** True only for the Clerk-authenticated admin/portal path and the
   *  signed-token manage-link path, which may manage ANY booking in the tenant.
   *  The customer/widget path leaves this false so it is scoped to its own chat
   *  session (see loadOwned / listBookings in the internal provider). */
  isAdmin?: boolean;
  /**
   * Whose judgement decides whether a drive is possible — a DIFFERENT question from `isAdmin`.
   *
   * `isAdmin` answers "may this caller manage any booking in the tenant, and is this a new
   * online booking?", which is what the pause exemption and the address demand turn on. Both
   * the owner's portal picker and the customer's signed manage link answer yes to it, and they
   * are not remotely alike here: the owner may book anything in their own diary, and the
   * customer may not be handed a drive nobody can make. Collapsing the two onto one flag is
   * how a proven-impossible slot reaches a customer.
   *
   * `enforce` — the default, and everything the bot touches: unreachable slots are removed and
   * the undecided middle comes back separately as times to request.
   * `annotate` — the OWNER only: nothing is removed and nothing throws, and the caller is told
   * which slots are which so it can warn. Plan §6.17, "owner-created bookings in the portal
   * warn, never block"; ADR-0015, "feasibility is a hard constraint against the bot, never
   * against the person who owns the diary". A caller that asks for this MUST render the warning
   * — annotating without warning is strictly worse than filtering.
   */
  travelPolicy?: 'enforce' | 'annotate';
}

export interface BookingSlot {
  start: string;
  end: string;
}

export interface ListBookingsResult {
  bookings: Array<{
    id: string | undefined;
    startTime: string | undefined;
    endTime: string | undefined;
    attendee: { name?: string; email?: string };
    status: string;
  }>;
}

/**
 * What travel time did to a slot list, when it ran at all.
 *
 * `slots` above holds only times the owner is PROVEN able to reach. This holds the rest of the
 * story, and it exists because dropping the undecided ones silently would be a refusal wearing
 * the clothes of an empty diary — a customer an hour away would be told there is nothing free.
 */
export interface TravelFilterSummary {
  /**
   * Times that are reachable if the drive is short enough, and nothing has measured it.
   * NOT confirmable: they go through `request_appointment` for the owner to decide.
   */
  requestableSlots: BookingSlot[];
  /**
   * Times proven impossible from the jobs either side.
   *
   * NAMED, not counted. A count answers "how many did you drop", which is only ever
   * observability; an annotating caller has to answer "which of the rows I am SHOWING is the
   * dangerous one", and no integer can. `enforce` callers never see these in `slots`;
   * `annotate` callers see them and must mark them.
   */
  unreachableSlots: BookingSlot[];
  /**
   * The address placed only to a town centre, so NOTHING here can be confirmed — a coarse
   * point may refuse a drive and may never clear one. A postcode is what fixes it.
   */
  addressTooVague?: true;
  /**
   * The gate could not run AT ALL, so every slot beside it is unjudged.
   *
   * Only ever set for an `annotate` caller, because an `enforce` caller is refused outright in
   * these cases. It exists so the owner's picker cannot show an unassessed list that looks
   * exactly like a checked one — which is the state travel is in during a Google outage, and
   * precisely when an owner most needs telling they are on their own judgement.
   */
  unavailableReason?: 'no_address' | 'not_placeable' | 'lookup_unavailable';
}

export interface AvailabilityResult {
  slots: BookingSlot[];
  timezone: string;
  /** The service these slots are for (so the agent can book the right one). */
  serviceId?: string;
  serviceName?: string;
  /**
   * WHO TRAVELS for this service (#79's resolver), as it stood when these slots were offered.
   *
   * Carried for LP3's baseline (#80) so the offer record can be filtered by location without
   * joining a Service whose mode may have changed since. Measurement only - nothing in the
   * booking path reads it.
   */
  locationMode?: string;
  /** Absent unless travel time actually ran — which is every bot on the platform today. */
  travel?: TravelFilterSummary;
  /**
   * What the grouping scorer thought of these slots (#81, LP4).
   *
   * SHADOW. Nothing reads it to decide anything: the list above is already in its final order and
   * every slot's class is already settled. It exists to be recorded, so LP5 can be measured
   * against a counterfactual that was written down at the time rather than reconstructed later.
   */
  grouping?: OfferScoring;
}

export interface CreateBookingResult {
  success: boolean;
  idempotent?: boolean;
  /** True when the service is request-only: a request/lead was captured, NOT a
   *  confirmed appointment (no calendar event). The AI must phrase accordingly. */
  requested?: boolean;
  /** Business timezone the booking time is in (IANA, e.g. Europe/Brussels). */
  timezone?: string;
  /** Service name, so the confirmation can name it without the model guessing. */
  serviceName?: string;
  booking: {
    id: string | undefined;
    startTime: string | undefined;
    endTime: string | undefined;
    /** #6: pre-formatted local time the AI must quote VERBATIM in the confirmation
     *  (it must NOT re-derive a local time from the UTC startTime — that drifts). */
    displayTime?: string;
    attendee: { name?: string; email?: string };
  };
}

export interface RescheduleResult {
  success: boolean;
  timezone?: string;
  serviceName?: string;
  booking: {
    id: string;
    startTime: string;
    endTime: string;
    /** #6: pre-formatted local time the AI must quote VERBATIM (never re-derive). */
    displayTime?: string;
  };
  /**
   * The move exposed ANOTHER booking that day as the day's first, and its journey from the
   * premises does not clear.
   *
   * Only ever set on the owner's own path. A caller that ENFORCES is refused outright rather
   * than warned, because stranding a confirmed job is a feasibility violation and not a matter
   * of taste — so this field being present means somebody deliberately chose to proceed.
   */
  travelWarning?: string;
}

export interface CancelResult {
  success: boolean;
  cancelled: boolean;
  /**
   * The cancelled job was that day's first, and what it exposed cannot be reached from the
   * premises. ADVICE, never a refusal — declining a cancellation because of a drive is absurd,
   * and the owner has hours to act on it.
   *
   * Only ever set for the OWNER. A customer cancelling from their signed manage link cannot do
   * anything about somebody else's morning, so they are told nothing and it becomes an
   * operator log line instead.
   */
  travelWarning?: string;
}

/**
 * Optional create-path fields the agent may supply, bundled so new ones (P5)
 * thread through one param instead of growing the positional signature. Tools
 * expose individual params (e.g. customerAddress); they're collected into this.
 */
export interface BookingExtras {
  /** P5a — required when service.customerAddressRequired. */
  customerAddress?: string;
  /** P5a — required when service.customerLocationRequired (a callback phone). */
  customerPhone?: string;
  /** P5c — chosen/estimated length for a range/ai service (ignored for fixed). */
  durationMin?: number;
  /** P5e — UploadSession ids the customer attached (validated + snapshotted at booking). */
  fileSessionIds?: string[];
  /**
   * A one-line summary of the job for the owner. Routed through extras rather than the
   * provider signature so CalcomProvider is untouched. The request path has always had
   * this; the auto path hardcoded null, so a confirmed booking reached the owner's
   * calendar with no context at all.
   */
  aiSummary?: string;
}

export interface BookingProvider {
  listBookings(ctx: BookingContext, attendeeEmail: string): Promise<ListBookingsResult>;
  /** `serviceId` selects the service; when omitted the provider falls back to the
   *  bot's sole active service (or errors `SERVICE_REQUIRED` if ≥2 exist). */
  checkAvailability(
    ctx: BookingContext,
    startDate: string,
    endDate: string,
    serviceId?: string,
    durationMin?: number,
    /** Booking being rescheduled — excluded from busy and from day-capacity totals. */
    excludeBookingId?: string,
    /**
     * Where the job is, for a service carried out at the customer's address. Only read when
     * travel time is active for the Agent; ignored otherwise, so a provider that does not
     * implement travel time is unaffected by its presence.
     */
    customerAddress?: string
  ): Promise<AvailabilityResult>;
  createBooking(
    ctx: BookingContext,
    idempotencyKey: string,
    startTime: string,
    attendee: { name: string; email?: string },
    notes?: string,
    serviceId?: string,
    intakeAnswers?: unknown,
    extras?: BookingExtras
  ): Promise<CreateBookingResult>;
  rescheduleBooking(ctx: BookingContext, bookingId: string, newStartTime: string): Promise<RescheduleResult>;
  cancelBooking(ctx: BookingContext, bookingId: string, reason?: string): Promise<CancelResult>;
}
