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
import type { BotSettings } from '../../database/entities/Bot';

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
  botSettings: BotSettings;
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
}

export interface CreateBookingResult {
  success: boolean;
  idempotent?: boolean;
  booking: {
    id: string | undefined;
    startTime: string | undefined;
    endTime: string | undefined;
    attendee: { name?: string; email?: string };
  };
}

export interface RescheduleResult {
  success: boolean;
  booking: {
    id: string;
    startTime: string;
    endTime: string;
  };
}

export interface CancelResult {
  success: boolean;
  cancelled: boolean;
}

export interface BookingProvider {
  listBookings(ctx: BookingContext, attendeeEmail: string): Promise<ListBookingsResult>;
  checkAvailability(ctx: BookingContext, startDate: string, endDate: string): Promise<AvailabilityResult>;
  createBooking(
    ctx: BookingContext,
    idempotencyKey: string,
    startTime: string,
    attendee: { name: string; email: string },
    notes?: string
  ): Promise<CreateBookingResult>;
  rescheduleBooking(ctx: BookingContext, bookingId: string, newStartTime: string): Promise<RescheduleResult>;
  cancelBooking(ctx: BookingContext, bookingId: string, reason?: string): Promise<CancelResult>;
}
