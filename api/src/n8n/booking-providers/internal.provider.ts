/**
 * Internal booking provider — in-house scheduler, DB as source of truth.
 *
 * Slice #2: availability. Slice #3: create (DB-authoritative, concurrency-safe).
 * Reschedule/cancel land in slice #5 and currently surface a clear
 * `BOOKING_NOT_IMPLEMENTED` so the bot degrades gracefully.
 */
import { v4 as uuidv4 } from 'uuid';
import { AppDataSource } from '../../database/data-source';
import { EventType } from '../../database/entities/EventType';
import { AvailabilityRule } from '../../database/entities/AvailabilityRule';
import { Booking } from '../../database/entities/Booking';
import { BookingLog } from '../../database/entities/BookingLog';
import { logger } from '../../utils/logger';
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
import { computeSlots, BusyInterval } from './slot-engine';

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

  /** Conflict key for a bot. Internal: the bot id (Phase 1: external calendar id). */
  private calendarKey(ctx: BookingContext): string {
    return `bot:${ctx.bot.id}`;
  }

  async checkAvailability(ctx: BookingContext, startDate: string, endDate: string): Promise<AvailabilityResult> {
    const { eventType, rule } = await this.loadConfig(ctx.bot.id);
    const busy = await this.loadBusy(this.calendarKey(ctx), startDate, endDate);
    const slots = computeSlots({
      rule,
      eventType,
      rangeStart: startDate,
      rangeEnd: endDate,
      now: new Date(),
      busy,
    });
    return { slots, timezone: rule.timezone };
  }

  /** Existing pending/confirmed bookings' blocked ranges overlapping [start,end). */
  private async loadBusy(calendarKey: string, rangeStartIso: string, rangeEndIso: string): Promise<BusyInterval[]> {
    const rows: Array<{ s: string; e: string }> = await AppDataSource.getRepository(Booking).query(
      `SELECT lower(blocked_range) AS s, upper(blocked_range) AS e
         FROM chatbot_bookings
        WHERE calendar_key = $1 AND status IN ('pending','confirmed')
          AND blocked_range && tstzrange($2, $3, '[)')`,
      [calendarKey, rangeStartIso, rangeEndIso]
    );
    return rows.map((r) => ({ start: new Date(r.s), end: new Date(r.e) }));
  }

  private toResult(booking: Booking, idempotent: boolean): CreateBookingResult {
    return {
      success: true,
      idempotent: idempotent || undefined,
      booking: {
        id: booking.id,
        startTime: booking.startUtc.toISOString(),
        endTime: booking.endUtc.toISOString(),
        attendee: {
          name: booking.attendeeName ?? undefined,
          email: booking.attendeeEmail ?? undefined,
        },
      },
    };
  }

  async createBooking(
    ctx: BookingContext,
    idempotencyKey: string,
    startTime: string,
    attendee: { name: string; email: string },
    notes?: string
  ): Promise<CreateBookingResult> {
    const { eventType, rule } = await this.loadConfig(ctx.bot.id);
    const calendarKey = this.calendarKey(ctx);
    const bookingRepo = AppDataSource.getRepository(Booking);

    // 1. Idempotency: a live (non-failed) booking with this key → return it.
    const existing = await bookingRepo.findOne({
      where: { tenantId: ctx.tenant.id, botId: ctx.bot.id, idempotencyKey },
    });
    if (existing && existing.status !== 'failed') {
      return this.toResult(existing, true);
    }

    // 2. Compute times + buffered blocked range.
    const start = new Date(startTime);
    if (Number.isNaN(start.getTime())) {
      throw new BookingError('Invalid start time', 'INVALID_START_TIME', 400);
    }
    const end = new Date(start.getTime() + eventType.durationMin * 60_000);
    const blockedStart = new Date(start.getTime() - eventType.bufferBeforeMin * 60_000);
    const blockedEnd = new Date(end.getTime() + eventType.bufferAfterMin * 60_000);

    // 3. Re-validate: the requested start must be an actually-offered slot
    //    (rules, buffers, min-notice, horizon, and existing-booking busy).
    const busy = await this.loadBusy(
      calendarKey,
      new Date(start.getTime() - 24 * 3600_000).toISOString(),
      new Date(end.getTime() + 24 * 3600_000).toISOString()
    );
    const offered = computeSlots({
      rule,
      eventType,
      rangeStart: start.toISOString(),
      rangeEnd: new Date(start.getTime() + 1000).toISOString(),
      now: new Date(),
      busy,
    }).some((s) => new Date(s.start).getTime() === start.getTime());
    if (!offered) {
      throw new BookingError('Selected time is not available', 'SLOT_UNAVAILABLE', 409);
    }

    // 4. Reserve + insert under a per-calendar advisory lock. The exclusion
    //    constraint is the last-line guard: a racing create gets 23P01.
    const icsUid = `${uuidv4()}@axentrio`;
    let bookingId: string;
    try {
      bookingId = await AppDataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [calendarKey]);
        const rows: Array<{ id: string }> = await manager.query(
          `INSERT INTO chatbot_bookings
             (tenant_id, bot_id, provider, event_type_id, session_id, status,
              start_utc, end_utc, blocked_range, calendar_key,
              attendee_name, attendee_email, notes, ics_uid, idempotency_key)
           VALUES ($1,$2,'internal',$3,$4,'confirmed',$5,$6, tstzrange($7,$8,'[)'),$9,$10,$11,$12,$13,$14)
           RETURNING id`,
          [
            ctx.tenant.id,
            ctx.bot.id,
            eventType.id,
            ctx.session.id,
            start.toISOString(),
            end.toISOString(),
            blockedStart.toISOString(),
            blockedEnd.toISOString(),
            calendarKey,
            attendee.name,
            attendee.email,
            notes ?? null,
            icsUid,
            idempotencyKey,
          ]
        );
        return rows[0].id;
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === '23P01') {
        throw new BookingError('This time slot is no longer available', 'SLOT_UNAVAILABLE', 409);
      }
      if (code === '23505') {
        // Idempotency race: a concurrent create inserted the same key.
        const dup = await bookingRepo.findOne({
          where: { tenantId: ctx.tenant.id, botId: ctx.bot.id, idempotencyKey },
        });
        if (dup && dup.status !== 'failed') return this.toResult(dup, true);
        throw new BookingError('This time slot is no longer available', 'SLOT_UNAVAILABLE', 409);
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

    return {
      success: true,
      booking: {
        id: bookingId,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        attendee,
      },
    };
  }

  // Listing internal bookings lands with reschedule/cancel in slice #5.
  async listBookings(_ctx: BookingContext, _attendeeEmail: string): Promise<ListBookingsResult> {
    return { bookings: [] };
  }

  async rescheduleBooking(_ctx: BookingContext, _bookingId: string, _newStartTime: string): Promise<RescheduleResult> {
    throw new BookingError('Internal reschedule is not yet available', 'BOOKING_NOT_IMPLEMENTED', 501);
  }

  async cancelBooking(_ctx: BookingContext, _bookingId: string, _reason?: string): Promise<CancelResult> {
    throw new BookingError('Internal cancel is not yet available', 'BOOKING_NOT_IMPLEMENTED', 501);
  }
}
