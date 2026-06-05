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
import { sendBookingEmail } from './booking-email';
import { scheduleReminders, cancelReminders } from './reminders';
import {
  getGoogleBusyForBot,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from '../../integrations/google/google-calendar.service';
import { BookingReference } from '../../database/entities/BookingReference';

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
    const busy = await this.loadAllBusy(ctx, this.calendarKey(ctx), startDate, endDate);
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

  /**
   * Existing pending/confirmed bookings' blocked ranges overlapping [start,end).
   * `excludeId` omits a booking from the result (used on reschedule so a booking
   * never conflicts with its own current slot).
   */
  private async loadBusy(
    calendarKey: string,
    rangeStartIso: string,
    rangeEndIso: string,
    excludeId?: string
  ): Promise<BusyInterval[]> {
    const rows: Array<{ s: string; e: string }> = await AppDataSource.getRepository(Booking).query(
      `SELECT lower(blocked_range) AS s, upper(blocked_range) AS e
         FROM chatbot_bookings
        WHERE calendar_key = $1 AND status IN ('pending','confirmed')
          AND blocked_range && tstzrange($2, $3, '[)')
          AND ($4::uuid IS NULL OR id <> $4::uuid)`,
      [calendarKey, rangeStartIso, rangeEndIso, excludeId ?? null]
    );
    return rows.map((r) => ({ start: new Date(r.s), end: new Date(r.e) }));
  }

  /**
   * Internal booking busy + (if the bot has Google connected) the owner's
   * Google calendar busy. Fails closed if Google can't be reached, so we never
   * offer a slot that might collide with a real event.
   */
  private async loadAllBusy(
    ctx: BookingContext,
    calendarKey: string,
    rangeStartIso: string,
    rangeEndIso: string,
    excludeId?: string
  ): Promise<BusyInterval[]> {
    const internal = await this.loadBusy(calendarKey, rangeStartIso, rangeEndIso, excludeId);
    let google: BusyInterval[] | null = null;
    try {
      google = await getGoogleBusyForBot(ctx.bot.id, rangeStartIso, rangeEndIso);
    } catch (err) {
      logger.warn('[Booking] Google free/busy unavailable — failing closed', {
        botId: ctx.bot.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new BookingError(
        'Calendar is temporarily unavailable, please try again shortly',
        'BOOKING_TEMPORARILY_UNAVAILABLE',
        503
      );
    }
    return google ? [...internal, ...google] : internal;
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
    //    (rules, buffers, min-notice, horizon, internal + Google busy).
    const busy = await this.loadAllBusy(
      ctx,
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

    // Mirror to the owner's Google calendar (best-effort). The booking is the
    // source of truth — if the mirror fails the booking still stands and is
    // flagged sync_pending for later reconciliation.
    const meetUrl = await this.syncGoogleCreate(ctx, bookingId, eventType.name, start, end, rule.timezone, notes);

    // Confirmation invite (non-fatal). Customer always gets the ICS (+ owner in
    // Phase 0 fallback); the Meet link rides along when present.
    await sendBookingEmail({
      method: 'REQUEST',
      uid: icsUid,
      sequence: 0,
      start,
      end,
      summary: eventType.name,
      location: meetUrl ?? (eventType.locationType === 'in_person' ? 'In person' : undefined),
      description: meetUrl ? `Join with Google Meet: ${meetUrl}` : undefined,
      timezone: rule.timezone,
      attendeeName: attendee.name,
      attendeeEmail: attendee.email,
      ownerEmail: ctx.botSettings.ai?.supportEmail ?? undefined,
    });

    await this.scheduleAndPersistReminders(bookingId, start, 0);

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

  /** Schedule reminders and persist their job ids; non-fatal on failure. */
  private async scheduleAndPersistReminders(bookingId: string, start: Date, sequence: number): Promise<void> {
    try {
      const ids = await scheduleReminders(bookingId, start, sequence);
      await AppDataSource.getRepository(Booking).query(
        `UPDATE chatbot_bookings SET reminder_job_ids=$1::jsonb, updated_at=now() WHERE id=$2`,
        [JSON.stringify(ids), bookingId]
      );
    } catch (err) {
      logger.warn('[Booking] reminder scheduling failed (non-fatal)', {
        bookingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async markSyncPending(bookingId: string): Promise<void> {
    await AppDataSource.getRepository(Booking)
      .query(`UPDATE chatbot_bookings SET sync_pending=true, updated_at=now() WHERE id=$1`, [bookingId])
      .catch(() => undefined);
  }

  /** Mirror a new booking to Google (best-effort). Returns the Meet URL if any. */
  private async syncGoogleCreate(
    ctx: BookingContext,
    bookingId: string,
    summary: string,
    start: Date,
    end: Date,
    timezone: string,
    notes?: string
  ): Promise<string | null> {
    try {
      const ev = await createCalendarEvent(ctx.bot.id, {
        startISO: start.toISOString(),
        endISO: end.toISOString(),
        timezone,
        summary,
        description: notes,
      });
      if (!ev) return null; // no Google connection
      const refRepo = AppDataSource.getRepository(BookingReference);
      await refRepo.save(
        refRepo.create({
          bookingId,
          providerType: 'google',
          externalEventId: ev.eventId,
          externalCalendarId: ev.calendarId,
          meetingUrl: ev.meetUrl,
        })
      );
      return ev.meetUrl;
    } catch (err) {
      logger.warn('[Booking] Google event create failed; booking stands (sync_pending)', {
        bookingId,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.markSyncPending(bookingId);
      return null;
    }
  }

  private async syncGoogleReschedule(
    ctx: BookingContext,
    bookingId: string,
    summary: string,
    start: Date,
    end: Date,
    timezone: string
  ): Promise<void> {
    const refRepo = AppDataSource.getRepository(BookingReference);
    const ref = await refRepo.findOne({ where: { bookingId, providerType: 'google' } });
    try {
      const input = { startISO: start.toISOString(), endISO: end.toISOString(), timezone };
      if (ref) {
        const res = await updateCalendarEvent(ctx.bot.id, ref.externalEventId, input);
        if (res === 'not_found') {
          // Owner deleted it in Google → recreate and repoint the reference.
          const ev = await createCalendarEvent(ctx.bot.id, { ...input, summary });
          if (ev) {
            ref.externalEventId = ev.eventId;
            ref.externalCalendarId = ev.calendarId;
            ref.meetingUrl = ev.meetUrl;
            await refRepo.save(ref);
          }
        }
      } else {
        // Google connected after the booking was created → create now.
        const ev = await createCalendarEvent(ctx.bot.id, { ...input, summary });
        if (ev) {
          await refRepo.save(
            refRepo.create({
              bookingId,
              providerType: 'google',
              externalEventId: ev.eventId,
              externalCalendarId: ev.calendarId,
              meetingUrl: ev.meetUrl,
            })
          );
        }
      }
    } catch (err) {
      logger.warn('[Booking] Google event reschedule sync failed (sync_pending)', {
        bookingId,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.markSyncPending(bookingId);
    }
  }

  private async syncGoogleCancel(ctx: BookingContext, bookingId: string): Promise<void> {
    const ref = await AppDataSource.getRepository(BookingReference).findOne({
      where: { bookingId, providerType: 'google' },
    });
    if (!ref) return;
    try {
      await deleteCalendarEvent(ctx.bot.id, ref.externalEventId);
    } catch (err) {
      logger.warn('[Booking] Google event cancel sync failed', {
        bookingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async listBookings(ctx: BookingContext, attendeeEmail: string): Promise<ListBookingsResult> {
    const bookings = await AppDataSource.getRepository(Booking).find({
      where: {
        tenantId: ctx.tenant.id,
        botId: ctx.bot.id,
        attendeeEmail,
        status: 'confirmed',
      },
      order: { startUtc: 'ASC' },
    });
    return {
      bookings: bookings.map((b) => ({
        id: b.id,
        startTime: b.startUtc.toISOString(),
        endTime: b.endUtc.toISOString(),
        attendee: { name: b.attendeeName ?? undefined, email: b.attendeeEmail ?? undefined },
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
    return booking;
  }

  async rescheduleBooking(ctx: BookingContext, bookingId: string, newStartTime: string): Promise<RescheduleResult> {
    const booking = await this.loadOwned(ctx, bookingId);
    if (booking.status !== 'confirmed') {
      throw new BookingError('Only confirmed bookings can be rescheduled', 'BOOKING_NOT_RESCHEDULABLE', 409);
    }
    const { eventType, rule } = await this.loadConfig(ctx.bot.id);
    const calendarKey = this.calendarKey(ctx);

    const start = new Date(newStartTime);
    if (Number.isNaN(start.getTime())) {
      throw new BookingError('Invalid start time', 'INVALID_START_TIME', 400);
    }
    const end = new Date(start.getTime() + eventType.durationMin * 60_000);
    const blockedStart = new Date(start.getTime() - eventType.bufferBeforeMin * 60_000);
    const blockedEnd = new Date(end.getTime() + eventType.bufferAfterMin * 60_000);

    // Re-validate the new slot (excluding this booking's own current range).
    const busy = await this.loadAllBusy(
      ctx,
      calendarKey,
      new Date(start.getTime() - 24 * 3600_000).toISOString(),
      new Date(end.getTime() + 24 * 3600_000).toISOString(),
      bookingId
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

    // Single atomic UPDATE under the calendar lock: frees the old slot and
    // reserves the new one in one statement; the exclusion constraint validates
    // the new range against other bookings (the row is excluded from itself).
    let sequence: number;
    try {
      sequence = await AppDataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [calendarKey]);
        const rows: Array<{ sequence: number }> = await manager.query(
          `UPDATE chatbot_bookings
              SET start_utc=$1, end_utc=$2, blocked_range=tstzrange($3,$4,'[)'),
                  sequence=sequence+1, updated_at=now()
            WHERE id=$5 AND tenant_id=$6 AND status='confirmed'
            RETURNING sequence`,
          [start.toISOString(), end.toISOString(), blockedStart.toISOString(), blockedEnd.toISOString(), bookingId, ctx.tenant.id]
        );
        if (!rows.length) {
          throw new BookingError('Booking is no longer reschedulable', 'BOOKING_NOT_RESCHEDULABLE', 409);
        }
        return rows[0].sequence;
      });
    } catch (err) {
      if (err instanceof BookingError) throw err;
      if ((err as { code?: string })?.code === '23P01') {
        throw new BookingError('This time slot is no longer available', 'SLOT_UNAVAILABLE', 409);
      }
      throw err;
    }

    await this.writeLog(ctx, 'rescheduled', booking, start, end);

    await sendBookingEmail({
      method: 'REQUEST',
      uid: booking.icsUid,
      sequence,
      start,
      end,
      summary: eventType.name,
      timezone: rule.timezone,
      attendeeName: booking.attendeeName ?? '',
      attendeeEmail: booking.attendeeEmail ?? '',
      ownerEmail: ctx.botSettings.ai?.supportEmail ?? undefined,
    });

    // Replace reminders: drop the old jobs, schedule fresh ones for the new time.
    await cancelReminders(booking.reminderJobIds).catch(() => undefined);
    await this.scheduleAndPersistReminders(bookingId, start, sequence);

    // Move the mirrored Google event (best-effort).
    await this.syncGoogleReschedule(ctx, bookingId, eventType.name, start, end, rule.timezone).catch(() => undefined);

    return { success: true, booking: { id: bookingId, startTime: start.toISOString(), endTime: end.toISOString() } };
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
    const { eventType, rule } = await this.loadConfig(ctx.bot.id);

    const rows: Array<{ sequence: number }> = await AppDataSource.getRepository(Booking).query(
      `UPDATE chatbot_bookings
          SET status='cancelled', sequence=sequence+1, notes=COALESCE($3, notes), updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND status='confirmed'
        RETURNING sequence`,
      [bookingId, ctx.tenant.id, reason ?? null]
    );
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
      summary: eventType.name,
      timezone: rule.timezone,
      attendeeName: booking.attendeeName ?? '',
      attendeeEmail: booking.attendeeEmail ?? '',
      ownerEmail: ctx.botSettings.ai?.supportEmail ?? undefined,
    });

    // Drop pending reminders (they'd no-op via sequence/status anyway).
    await cancelReminders(booking.reminderJobIds).catch(() => undefined);
    await AppDataSource.getRepository(Booking)
      .query(`UPDATE chatbot_bookings SET reminder_job_ids='[]'::jsonb WHERE id=$1`, [bookingId])
      .catch(() => undefined);

    // Delete the mirrored Google event (best-effort).
    await this.syncGoogleCancel(ctx, bookingId).catch(() => undefined);

    return { success: true, cancelled: true };
  }

  private async writeLog(
    ctx: BookingContext,
    eventType: 'rescheduled' | 'cancelled',
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
