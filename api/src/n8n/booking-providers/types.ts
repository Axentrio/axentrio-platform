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
    public statusCode: number
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

export interface AvailabilityResult {
  slots: BookingSlot[];
  timezone: string;
  /** The service these slots are for (so the agent can book the right one). */
  serviceId?: string;
  serviceName?: string;
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
}

export interface CancelResult {
  success: boolean;
  cancelled: boolean;
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
    durationMin?: number
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
