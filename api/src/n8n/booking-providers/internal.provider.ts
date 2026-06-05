/**
 * Internal booking provider — in-house scheduler, DB as source of truth.
 *
 * Slice #2: availability only. `checkAvailability` computes slots from the
 * bot's event type + availability rule via the slot engine. Create / reschedule
 * / cancel land in later slices and currently surface a clear
 * `BOOKING_NOT_IMPLEMENTED` so the bot degrades gracefully.
 */
import { AppDataSource } from '../../database/data-source';
import { EventType } from '../../database/entities/EventType';
import { AvailabilityRule } from '../../database/entities/AvailabilityRule';
import {
  BookingError,
  BookingContext,
  BookingProvider,
  ListBookingsResult,
  AvailabilityResult,
  CreateBookingResult,
  RescheduleResult,
  CancelResult,
} from './types';
import { computeSlots } from './slot-engine';

export class InternalProvider implements BookingProvider {
  private async loadConfig(botId: string): Promise<{ eventType: EventType; rule: AvailabilityRule }> {
    const eventType = await AppDataSource.getRepository(EventType).findOne({
      where: { botId, isActive: true },
    });
    const rule = await AppDataSource.getRepository(AvailabilityRule).findOne({ where: { botId } });
    if (!eventType || !rule) {
      throw new BookingError('Booking not configured for this bot', 'BOOKING_NOT_CONFIGURED', 400);
    }
    return { eventType, rule };
  }

  async checkAvailability(ctx: BookingContext, startDate: string, endDate: string): Promise<AvailabilityResult> {
    const { eventType, rule } = await this.loadConfig(ctx.bot.id);
    const slots = computeSlots({
      rule,
      eventType,
      rangeStart: startDate,
      rangeEnd: endDate,
      now: new Date(),
      busy: [],
    });
    return { slots, timezone: rule.timezone };
  }

  // No internal bookings exist until slice #3 — listing returns empty rather
  // than erroring, so "show my bookings" degrades gracefully.
  async listBookings(_ctx: BookingContext, _attendeeEmail: string): Promise<ListBookingsResult> {
    return { bookings: [] };
  }

  async createBooking(
    _ctx: BookingContext,
    _idempotencyKey: string,
    _startTime: string,
    _attendee: { name: string; email: string },
    _notes?: string
  ): Promise<CreateBookingResult> {
    throw new BookingError('Internal booking is not yet available', 'BOOKING_NOT_IMPLEMENTED', 501);
  }

  async rescheduleBooking(_ctx: BookingContext, _bookingId: string, _newStartTime: string): Promise<RescheduleResult> {
    throw new BookingError('Internal booking is not yet available', 'BOOKING_NOT_IMPLEMENTED', 501);
  }

  async cancelBooking(_ctx: BookingContext, _bookingId: string, _reason?: string): Promise<CancelResult> {
    throw new BookingError('Internal booking is not yet available', 'BOOKING_NOT_IMPLEMENTED', 501);
  }
}
