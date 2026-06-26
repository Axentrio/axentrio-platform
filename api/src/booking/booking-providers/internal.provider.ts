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
import { MoreThan } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { notificationService } from '../../services/notification.service';
import { ServiceType } from '../../database/entities/ServiceType';
import { AvailabilityRule } from '../../database/entities/AvailabilityRule';
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
  CreateBookingResult,
  RescheduleResult,
  CancelResult,
} from './types';
import { computeSlots, BusyInterval } from './slot-engine';
import { buildBookingEventContent } from './booking-content';
import { sendBookingEmail, sendRequestNotificationEmail } from './booking-email';
import { scheduleReminders, cancelReminders } from './reminders';
import {
  resolveCalendarProvider,
  providerFor,
  isCalendarSyncAllowed,
  resolveStoredCalendarIdentity,
} from '../../scheduler/calendar-provider';
import { BookingReference } from '../../database/entities/BookingReference';
import { ChatSession } from '../../database/entities/ChatSession';
import { buildManageUrl } from '../../scheduler/booking-token';
import { returningRows } from '../../utils/raw-sql';
import { conflictKeyFor } from '../../scheduler/calendar-rekey';
import { getActiveCredential } from '../../integrations/google/google-calendar.service';
import { emitWebhookEvent, buildEventBase } from '../../webhooks/webhook.emitter';
import type { BookingRequestCreatedEvent } from '../../webhooks/webhook.types';

/**
 * Idempotency/dedup window (#35). The booking idempotency key is stable per
 * session+service+time, so we only treat a matching row as "the same booking" when
 * it was created within this window — collapsing a rapid re-confirm ("yes go ahead"
 * seconds later) while still allowing a genuine re-booking of the same service+time
 * later in a long-lived (Messenger/WhatsApp) session.
 */
const BOOKING_DEDUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * P3: normalize an LLM-supplied intake-answers object against a RESOLVED service's
 * questions — the single place answers are sanitized before persistence. Keeps only
 * entries whose key matches a current question id, coerces the value to a trimmed
 * non-empty string (string→trim; number/boolean→String; null/undefined/array/object
 * dropped — never `"[object Object]"`), caps at 2000 chars. Returns a flat
 * `{ id: string }` map or `null` if nothing remains. A malformed/non-array
 * `intakeQuestions` (legacy/hand-edited) degrades to "no questions" → null.
 */
function normalizeIntakeAnswers(service: ServiceType, raw: unknown): Record<string, string> | null {
  const questions = Array.isArray(service.intakeQuestions) ? service.intakeQuestions : [];
  if (!questions.length) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const validIds = new Set(
    questions.map((q) => q?.id).filter((id): id is string => typeof id === 'string')
  );
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!validIds.has(key)) continue;
    let str: string;
    if (typeof value === 'string') str = value;
    else if (typeof value === 'number' || typeof value === 'boolean') str = String(value);
    else continue; // null/undefined/array/object → dropped
    const trimmed = str.trim();
    if (!trimmed) continue;
    out[key] = trimmed.slice(0, 2000);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Coerce a possibly-loose date range into a UTC [start, end) window. The LLM
 * usually passes date-only strings ("2026-06-08", sometimes start === end); a
 * date-only value is anchored to the BUSINESS timezone's calendar day — NOT UTC
 * (`new Date("2026-06-08")` is UTC midnight, which offsets the window by the
 * zone's UTC offset and makes the slot engine clip real evening slots in
 * negative-offset zones / leak next-day slots in positive-offset zones, drifting
 * with DST). A date-only end includes that whole local day; a zero/negative
 * window becomes a single day. Datetime strings with an explicit offset/Z keep
 * their instant; zoneless datetimes are read as business-local. Output is RFC3339
 * UTC (Google events.list 400s on date-only values).
 */
export function normalizeDateRange(
  startDate: string,
  endDate: string,
  timezone: string,
): { rangeStart: string; rangeEnd: string } {
  const start = DateTime.fromISO(startDate, { zone: timezone });
  if (!start.isValid) {
    throw new BookingError('Invalid start date', 'INVALID_RANGE', 400);
  }
  const endDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(endDate);
  let end = DateTime.fromISO(endDate, { zone: timezone });
  if (endDateOnly && end.isValid) end = end.plus({ days: 1 }); // include the whole end day (local)
  if (!end.isValid || end <= start) end = start.plus({ days: 1 });
  return { rangeStart: start.toUTC().toISO()!, rangeEnd: end.toUTC().toISO()! };
}

/**
 * Parse an appointment time string into a UTC instant, anchored to the business
 * timezone. A string carrying an explicit offset/Z (e.g. a slot returned by
 * check_availability) keeps its instant; a ZONELESS string (e.g.
 * "2026-06-19T14:00:00" — what the model emits for the customer's "2 PM") is read
 * as business-local wall-clock. Without this, a zoneless/UTC time round-trips
 * through `new Date()` on a UTC server as UTC, landing the booking at the wrong
 * local hour in any non-UTC zone. A loose space-separated form ("2026-06-19
 * 14:00") is also anchored to the business timezone via fromSQL — NEVER the
 * server's, which `new Date()` would do (re-introducing the wrong-hour bug).
 * Returns null when unparseable. Same rule as {@link normalizeDateRange}.
 */
export function parseBookingStart(input: string, timezone: string): Date | null {
  const iso = DateTime.fromISO(input, { zone: timezone });
  if (iso.isValid) return iso.toJSDate();
  // Loose "YYYY-MM-DD HH:mm[:ss]" (space, not 'T') — still business-local.
  const sql = DateTime.fromSQL(input, { zone: timezone });
  if (sql.isValid) return sql.toJSDate();
  return null;
}

/**
 * #6: server-format the booking time in the BUSINESS timezone, so the AI can quote
 * it verbatim instead of re-deriving a local time from the UTC instant (which drifts).
 * e.g. "Monday, 23 June 2026 at 12:00 PM (CEST)".
 */
export function formatBookingDisplayTime(startUtc: Date, timezone: string): string {
  return DateTime.fromJSDate(startUtc).setZone(timezone).toFormat("cccc, d LLLL yyyy 'at' h:mm a (ZZZZ)");
}

/** P5a — which contact fields a service requires. Single mapping for the column-name
 *  wart: customerLocationRequired maps to PHONE (a callback number), not address. */
function requiredContactFields(service: ServiceType): { address: boolean; phone: boolean } {
  return { address: !!service.customerAddressRequired, phone: !!service.customerLocationRequired };
}

/** Trim + cap a contact value to its DB column width; empty/whitespace → null. */
function cleanContact(v: string | undefined, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * P5a — resolve the address/phone to persist, enforcing the service's required-field
 * gates (recoverable errors the agent re-asks on). Whitespace-only counts as absent.
 */
function resolveContactFields(
  service: ServiceType,
  extras?: BookingExtras,
  session?: { channel?: string | null; visitorId?: string | null }
): { address: string | null; phone: string | null } {
  const req = requiredContactFields(service);
  const address = cleanContact(extras?.customerAddress, 512);
  let phone = cleanContact(extras?.customerPhone, 64);
  // Channel fallback: on WhatsApp the customer's own number IS the session identity
  // (visitorId = wa_id), so capture it as the contact phone when none was provided.
  // Other channels (Messenger/Instagram) use a PSID/IGSID here, not a phone — skip them.
  if (!phone && session?.channel === 'whatsapp' && session.visitorId) {
    phone = cleanContact(`+${session.visitorId.replace(/^\+/, '')}`, 64);
  }
  if (req.address && !address) throw new BookingError('Address is required for this service', 'ADDRESS_REQUIRED', 400);
  if (req.phone && !phone) throw new BookingError('A contact phone number is required for this service', 'PHONE_REQUIRED', 400);
  return { address, phone };
}

/**
 * P5a — server-side gate for REQUIRED intake questions, mirroring the
 * ADDRESS_REQUIRED / PHONE_REQUIRED contact gate. The LLM is told to ask them, but
 * a model slip must not silently persist a booking missing a required answer.
 * `normalized` is the output of normalizeIntakeAnswers (keyed by question id).
 * Recoverable (INTAKE_REQUIRED, 400): the agent re-asks and re-calls the tool.
 */
function assertRequiredIntake(service: ServiceType, normalized: Record<string, string> | null): void {
  const questions = Array.isArray(service.intakeQuestions) ? service.intakeQuestions : [];
  const required = questions.filter((q) => q && q.required && typeof q.id === 'string');
  if (!required.length) return;
  const answers = normalized ?? {};
  const missing = required.filter((q) => !String(answers[q.id] ?? '').trim());
  if (missing.length) {
    throw new BookingError(
      `Please provide the required intake answer(s): ${missing.map((q) => q.label).join(', ')}`,
      'INTAKE_REQUIRED',
      400
    );
  }
}

/**
 * P5b — enforce `maxBookingsPerDay` for a service on the slot's local calendar day.
 * Counts only HELD rows (`status IN ('pending','confirmed')`) for the same service,
 * by `start_utc` in the half-open `[dayStart, nextDay)` window of `timezone` (Luxon,
 * DST-exact). `null`/`≤0` cap = unlimited (a malformed/legacy row degrades to "no
 * limit", never "no bookings"). Runs inside the caller's advisory-lock transaction so
 * the count-then-write is atomic. `excludeBookingId` skips the row being rescheduled.
 */
async function enforceServiceDayCapacity(
  manager: EntityManager,
  service: ServiceType,
  start: Date,
  timezone: string,
  excludeBookingId?: string
): Promise<void> {
  const max = service.maxBookingsPerDay;
  if (!max || max <= 0) return; // unlimited
  const local = DateTime.fromJSDate(start).setZone(timezone);
  const dayStart = local.startOf('day').toUTC().toISO();
  const nextDay = local.startOf('day').plus({ days: 1 }).toUTC().toISO();
  const params: unknown[] = [service.id, dayStart, nextDay];
  let sql = `SELECT count(*)::int AS n FROM chatbot_bookings
             WHERE event_type_id = $1 AND status IN ('pending','confirmed')
               AND start_utc >= $2 AND start_utc < $3`;
  if (excludeBookingId) {
    sql += ` AND id <> $4`;
    params.push(excludeBookingId);
  }
  const rows: Array<{ n: number }> = await manager.query(sql, params);
  if ((rows[0]?.n ?? 0) >= max) {
    throw new BookingError('No more openings for this service that day', 'CAPACITY_REACHED', 409);
  }
}

/** True only when the service is configured for a variable duration with a valid range. */
function hasValidRange(service: ServiceType): boolean {
  if (service.durationMode !== 'range' && service.durationMode !== 'ai') return false;
  const { minDurationMin: min, maxDurationMin: max } = service;
  return !!min && !!max && min > 0 && max > 0 && min <= max;
}

/**
 * P5c — resolve the effective booked length (create authority, THROWS on violation).
 * 'fixed' (or an invalid range config) → service.durationMin. 'range'/'ai' → the
 * agent-supplied minutes, defaulting to minDurationMin when absent; out of
 * [min,max] → DURATION_OUT_OF_RANGE (recoverable, never silently clamped).
 */
function resolveDuration(service: ServiceType, requestedDurationMin?: number): number {
  if (!hasValidRange(service)) {
    if (service.durationMode === 'range' || service.durationMode === 'ai') {
      logger.warn('[Booking] invalid duration range config — treating as fixed', {
        serviceId: service.id,
        min: service.minDurationMin,
        max: service.maxDurationMin,
      });
    }
    return service.durationMin;
  }
  const min = service.minDurationMin as number;
  const max = service.maxDurationMin as number;
  const effective = requestedDurationMin ?? min; // absent → conservative shortest job
  if (effective < min || effective > max) {
    throw new BookingError("Requested duration is outside this service's allowed range", 'DURATION_OUT_OF_RANGE', 400);
  }
  return effective;
}

/**
 * P5c — lenient duration for AVAILABILITY (never throws): a within-bounds requested
 * value when known, else minDurationMin (shortest plausible job). The create path is
 * the authority that rejects an out-of-range request.
 */
function effectiveDurationForAvailability(service: ServiceType, requestedDurationMin?: number): number {
  if (!hasValidRange(service)) return service.durationMin;
  const min = service.minDurationMin as number;
  const max = service.maxDurationMin as number;
  if (typeof requestedDurationMin === 'number' && requestedDurationMin >= min && requestedDurationMin <= max) {
    return requestedDurationMin;
  }
  return min;
}

export class InternalProvider implements BookingProvider {
  /** Business availability for the bot (shared by all services). */
  private async loadRule(botId: string): Promise<AvailabilityRule> {
    const rule = await AppDataSource.getRepository(AvailabilityRule).findOne({ where: { botId } });
    if (!rule) {
      throw new BookingError('Booking not configured for this bot', 'BOOKING_NOT_CONFIGURED', 400);
    }
    return rule;
  }

  /**
   * Resolve the service to book against. `serviceId` selects it explicitly (must
   * be active + belong to this bot). When omitted: the sole active service is
   * used; zero active → `BOOKING_NOT_CONFIGURED`; ≥2 active → `SERVICE_REQUIRED`
   * (so a slot chip / pre-multi-service payload without a serviceId can never
   * silently book the wrong service — the caller must disambiguate).
   */
  private async resolveService(botId: string, serviceId?: string): Promise<ServiceType> {
    const repo = AppDataSource.getRepository(ServiceType);
    if (serviceId) {
      const svc = await repo.findOne({ where: { id: serviceId, botId, isActive: true } });
      if (!svc) throw new BookingError('That service is unavailable', 'SERVICE_NOT_FOUND', 404);
      return svc;
    }
    const active = await repo.find({ where: { botId, isActive: true }, order: { sortOrder: 'ASC' } });
    if (active.length === 0) {
      throw new BookingError('Booking not configured for this bot', 'BOOKING_NOT_CONFIGURED', 400);
    }
    if (active.length > 1) {
      throw new BookingError('Please specify which service to book', 'SERVICE_REQUIRED', 400);
    }
    return active[0];
  }

  /**
   * The service an existing booking was made against (by stored `event_type_id`),
   * for reschedule/cancel — uses the original service's duration/buffers even if
   * it was later deactivated. Falls back to the sole active service for legacy
   * rows with no service id.
   */
  private async serviceForBooking(booking: Booking): Promise<ServiceType> {
    if (booking.eventTypeId) {
      const svc = await AppDataSource.getRepository(ServiceType).findOne({ where: { id: booking.eventTypeId } });
      if (svc) return svc;
    }
    return this.resolveService(booking.botId);
  }

  /**
   * Deterministic Google event id for a booking: the booking uuid with hyphens
   * stripped (32 hex chars = valid Google base32hex). Makes the Google create
   * idempotent — a reconciler retry after a partial failure re-uses this id
   * instead of producing a duplicate event.
   */
  private googleEventId(bookingId: string): string {
    return bookingId.replace(/-/g, '');
  }

  /**
   * Conflict key for a bot. Normalized to the connected calendar's account-unique
   * identity (`gcal:<email-or-calendarId>`) so bots sharing one real calendar
   * share one key (the EXCLUDE constraint then blocks cross-bot double-booking).
   * Falls back to `bot:<id>` when the calendar identity is unknown (no/legacy
   * connection) — never `gcal:primary`, which would collide globally.
   */
  private async calendarKey(ctx: BookingContext): Promise<string> {
    // DB-only stored identity (plan D9): conflict keys keep the connected
    // calendar's identity even when external sync is entitlement-disabled, so
    // existing conflict records never silently weaken to bot-scoped keys.
    const stored = await resolveStoredCalendarIdentity(ctx.bot.id);
    if (!stored) return conflictKeyFor(ctx.bot.id, null);
    return conflictKeyFor(ctx.bot.id, stored.identity, stored.providerType);
  }

  /** Auto-confirmation requires a live calendar the owner actually sees — without one
   *  a "confirmed" booking would be invisible to them (no sync) and risk a no-show. So
   *  auto services degrade to request-mode when there is no healthy connected calendar. */
  private async hasConnectedCalendar(botId: string): Promise<boolean> {
    const cred = await getActiveCredential(botId);
    return !!cred && !cred.reauthRequired;
  }

  async checkAvailability(
    ctx: BookingContext,
    startDate: string,
    endDate: string,
    serviceId?: string,
    durationMin?: number
  ): Promise<AvailabilityResult> {
    const rule = await this.loadRule(ctx.bot.id);
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
    if (!(await this.hasConnectedCalendar(ctx.bot.id))) {
      throw new BookingError(
        `Online appointments can't be auto-confirmed because this business has no connected calendar. Do not offer specific times — ask the customer for their preferred date/time in their own words and capture it with request_appointment as a request the business will confirm.`,
        'CALENDAR_NOT_CONNECTED',
        409
      );
    }
    const { rangeStart, rangeEnd } = normalizeDateRange(startDate, endDate, rule.timezone);
    const busy = await this.loadAllBusy(ctx, await this.calendarKey(ctx), rangeStart, rangeEnd, rule.timezone);
    // P5c: for a range/ai service, fit slots to the chosen length when known, else the
    // shortest (minDurationMin) so no fittable start is hidden. Create re-validates length.
    const availDuration = effectiveDurationForAvailability(service, durationMin);
    const slots = computeSlots({
      rule,
      eventType: { ...service, durationMin: availDuration },
      rangeStart,
      rangeEnd,
      now: new Date(),
      busy,
    });
    return { slots, timezone: rule.timezone, serviceId: service.id, serviceName: service.name };
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
    timezone?: string,
    excludeId?: string,
    excludeExternalInterval?: { start: Date; end: Date }
  ): Promise<BusyInterval[]> {
    const internal = await this.loadBusy(calendarKey, rangeStartIso, rangeEndIso, excludeId);
    let external: BusyInterval[] | null = null;
    try {
      const provider = await resolveCalendarProvider(ctx.bot.id);
      // Pass the rule timezone so the provider anchors all-day events to the
      // business's local day rather than UTC midnight.
      external = provider ? await provider.getBusy(ctx.bot.id, rangeStartIso, rangeEndIso, timezone) : null;
    } catch (err) {
      logger.warn('[Booking] external calendar free/busy unavailable — failing closed', {
        botId: ctx.bot.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new BookingError(
        'Calendar is temporarily unavailable, please try again shortly',
        'BOOKING_TEMPORARILY_UNAVAILABLE',
        503
      );
    }
    // On reschedule the booking's OWN mirrored external event sits at its old time;
    // drop it (exact raw start/end match — the mirror carries no buffer) so a nearby
    // move doesn't conflict with itself. excludeId only covers the internal copy.
    if (external && excludeExternalInterval) {
      const xs = excludeExternalInterval.start.getTime();
      const xe = excludeExternalInterval.end.getTime();
      external = external.filter((iv) => !(iv.start.getTime() === xs && iv.end.getTime() === xe));
    }
    return external ? [...internal, ...external] : internal;
  }

  private toResult(booking: Booking, idempotent: boolean, timezone?: string, serviceName?: string): CreateBookingResult {
    return {
      success: true,
      idempotent: idempotent || undefined,
      requested: booking.status === 'request_created' || undefined,
      timezone,
      serviceName,
      booking: {
        id: booking.id,
        startTime: booking.startUtc.toISOString(),
        endTime: booking.endUtc.toISOString(),
        displayTime: timezone ? formatBookingDisplayTime(booking.startUtc, timezone) : undefined,
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
    attendee: { name: string; email?: string },
    notes?: string,
    serviceId?: string,
    intakeAnswers?: unknown,
    extras?: BookingExtras
  ): Promise<CreateBookingResult> {
    const rule = await this.loadRule(ctx.bot.id);
    // Create-time revalidation: the service must still exist, belong to this bot,
    // and be active (a slot chip / multi-turn gap can go stale).
    const service = await this.resolveService(ctx.bot.id, serviceId);
    const calendarKey = await this.calendarKey(ctx);
    const bookingRepo = AppDataSource.getRepository(Booking);

    // 1. Idempotency: a live (non-failed) booking with this key → return it.
    const existing = await bookingRepo.findOne({
      where: { tenantId: ctx.tenant.id, botId: ctx.bot.id, idempotencyKey, createdAt: MoreThan(new Date(Date.now() - BOOKING_DEDUP_WINDOW_MS)) },
    });
    if (existing && existing.status !== 'failed') {
      return this.toResult(existing, true, rule.timezone, service.name);
    }

    // 2. Compute times. P5c: effective length depends on durationMode (range/ai use
    //    the agent-supplied minutes; fixed ignores it). Throws DURATION_OUT_OF_RANGE.
    const start = parseBookingStart(startTime, rule.timezone);
    if (!start) {
      throw new BookingError('Invalid start time', 'INVALID_START_TIME', 400);
    }
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
        createdAt: MoreThan(new Date(Date.now() - BOOKING_DEDUP_WINDOW_MS)),
      },
      order: { createdAt: 'DESC' },
    });
    if (recentDup && !['failed', 'cancelled', 'declined'].includes(recentDup.status)) {
      return this.toResult(recentDup, true, rule.timezone, service.name);
    }

    // P3: normalize intake answers against THIS resolved service (the row's real service).
    const intakeJson = normalizeIntakeAnswers(service, intakeAnswers);
    assertRequiredIntake(service, intakeJson);

    // Request-only service → capture a request/lead. No confirmed appointment,
    // no calendar event, no email/reminders. (Owner notification UX is P2.)
    const calendarConnected = await this.hasConnectedCalendar(ctx.bot.id);
    // Request-only OR no connected calendar → capture a request, not a confirmed booking.
    if (service.bookingMode === 'request' || !calendarConnected) {
      return this.createRequest(ctx, idempotencyKey, service, calendarKey, start, end, attendee, notes, undefined, intakeAnswers, extras, effectiveDuration);
    }

    // P5a: required address/phone gate (recoverable; the agent re-asks). Auto path.
    const contact = resolveContactFields(service, extras, ctx.session);
    // P5e: validate + snapshot attached files (service-disallow / readiness / ownership).
    const fileSessionIds = await this.resolveFileSessionIds(ctx, service, extras?.fileSessionIds);
    const uploadedFiles = await this.validateUploadedFiles(ctx, service, fileSessionIds);

    const blockedStart = new Date(start.getTime() - service.bufferBeforeMin * 60_000);
    const blockedEnd = new Date(end.getTime() + service.bufferAfterMin * 60_000);

    // 3. Re-validate: the requested start must be an actually-offered slot
    //    (rules, buffers, min-notice, horizon, internal + Google busy).
    const busy = await this.loadAllBusy(
      ctx,
      calendarKey,
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
      throw new BookingError('Selected time is not available', 'SLOT_UNAVAILABLE', 409);
    }

    // 4. Reserve + insert under a per-calendar advisory lock. The exclusion
    //    constraint is the last-line guard: a racing create gets 23P01.
    const icsUid = `${uuidv4()}@axentrio`;
    let bookingId: string;
    try {
      bookingId = await AppDataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [calendarKey]);
        // P5b: capacity gate — count held bookings for this service on the slot's local
        // day, inside the same lock so the count-then-insert is atomic.
        await enforceServiceDayCapacity(manager, service, start, rule.timezone);
        const rows: Array<{ id: string }> = await manager.query(
          `INSERT INTO chatbot_bookings
             (tenant_id, bot_id, provider, event_type_id, booking_mode, session_id, status,
              start_utc, end_utc, blocked_range, calendar_key,
              attendee_name, attendee_email, notes, ics_uid, idempotency_key, intake_answers,
              customer_address, customer_phone, booked_duration_min, uploaded_files, source_channel)
           VALUES ($1,$2,'internal',$3,'auto',$4,'confirmed',$5,$6, tstzrange($7,$8,'[)'),$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19::jsonb,$20)
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
            calendarKey,
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
          where: { tenantId: ctx.tenant.id, botId: ctx.bot.id, idempotencyKey, createdAt: MoreThan(new Date(Date.now() - BOOKING_DEDUP_WINDOW_MS)) },
        });
        if (dup && dup.status !== 'failed') return this.toResult(dup, true, rule.timezone, service.name);
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
    // flagged sync_pending for later reconciliation. The rich event body comes
    // from the single P6a builder (ai_summary stays null on the auto path — no
    // value flows in here yet, the builder simply omits that line).
    const eventContent = buildBookingEventContent(
      {
        attendeeName: attendee.name,
        attendeeEmail: attendee.email,
        customerPhone: contact.phone,
        customerAddress: contact.address,
        aiSummary: null,
        notes,
        intakeAnswers: intakeJson,
      },
      service,
      buildManageUrl(bookingId),
    );
    const meetUrl = await this.syncCalendarCreate(ctx, bookingId, eventContent, start, end, rule.timezone);

    // Confirmation invite (non-fatal). Customer always gets the ICS (+ owner in
    // Phase 0 fallback); the Meet link rides along when present.
    await sendBookingEmail({
      method: 'REQUEST',
      uid: icsUid,
      sequence: 0,
      start,
      end,
      summary: service.name,
      location: meetUrl ?? (service.locationType === 'in_person' ? 'In person' : undefined),
      description: meetUrl ? `Join the meeting: ${meetUrl}` : undefined,
      timezone: rule.timezone,
      attendeeName: attendee.name,
      attendeeEmail: attendee.email,
      ownerEmail: ctx.botSettings.ai?.supportEmail ?? undefined,
      manageUrl: buildManageUrl(bookingId),
    });

    await this.scheduleAndPersistReminders(bookingId, start, 0);

    return {
      success: true,
      timezone: rule.timezone,
      serviceName: service.name,
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
    calendarKey: string,
    start: Date,
    end: Date,
    attendee: { name: string; email?: string },
    notes?: string,
    aiSummary?: string,
    intakeAnswers?: unknown,
    extras?: BookingExtras,
    bookedDurationMin?: number
  ): Promise<CreateBookingResult> {
    const bookingRepo = AppDataSource.getRepository(Booking);
    const icsUid = `${uuidv4()}@axentrio`;
    const sourceChannel = ctx.session?.channel ?? null;
    // P3: normalize intake answers against this resolved (request-mode) service.
    const intakeJson = normalizeIntakeAnswers(service, intakeAnswers);
    assertRequiredIntake(service, intakeJson);
    // P5a: required address/phone gate (request path).
    const contact = resolveContactFields(service, extras, ctx.session);
    // P5e: validate + snapshot attached files for the request row too.
    const fileSessionIds = await this.resolveFileSessionIds(ctx, service, extras?.fileSessionIds);
    const uploadedFiles = await this.validateUploadedFiles(ctx, service, fileSessionIds);
    let bookingId: string;
    try {
      const rows: Array<{ id: string }> = await bookingRepo.query(
        `INSERT INTO chatbot_bookings
           (tenant_id, bot_id, provider, event_type_id, booking_mode, session_id, status,
            start_utc, end_utc, blocked_range, calendar_key,
            attendee_name, attendee_email, notes, ics_uid, idempotency_key,
            source_channel, ai_summary, intake_answers, customer_address, customer_phone, booked_duration_min, uploaded_files)
         VALUES ($1,$2,'internal',$3,'request',$4,'request_created',$5,$6, tstzrange($5,$6,'[)'),$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19::jsonb)
         RETURNING id`,
        [
          ctx.tenant.id,
          ctx.bot.id,
          service.id,
          ctx.session.id,
          start.toISOString(),
          end.toISOString(),
          calendarKey,
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
        ]
      );
      bookingId = rows[0].id;
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        const dup = await bookingRepo.findOne({
          where: { tenantId: ctx.tenant.id, botId: ctx.bot.id, idempotencyKey, createdAt: MoreThan(new Date(Date.now() - BOOKING_DEDUP_WINDOW_MS)) },
        });
        if (dup && dup.status !== 'failed') return this.toResult(dup, true);
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
      where: { tenantId: ctx.tenant.id, botId: ctx.bot.id, idempotencyKey, createdAt: MoreThan(new Date(Date.now() - BOOKING_DEDUP_WINDOW_MS)) },
    });
    if (existing && existing.status !== 'failed') {
      return this.toResult(existing, true);
    }

    // Resolve the service (sole-active default / SERVICE_REQUIRED / SERVICE_NOT_FOUND).
    const rule = await this.loadRule(ctx.bot.id);
    const service = await this.resolveService(ctx.bot.id, serviceId);
    const calendarKey = await this.calendarKey(ctx);

    const start = parseBookingStart(preferredTime, rule.timezone);
    if (!start) {
      throw new BookingError('Invalid preferred time', 'INVALID_START_TIME', 400);
    }
    // P5c: requests validate the duration BOUNDS (DURATION_OUT_OF_RANGE) but not slot-fit;
    // the end + persisted length are purely informational for the owner.
    const effectiveDuration = resolveDuration(service, extras?.durationMin);
    const end = new Date(start.getTime() + effectiveDuration * 60_000);

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
        createdAt: MoreThan(new Date(Date.now() - BOOKING_DEDUP_WINDOW_MS)),
      },
      order: { createdAt: 'DESC' },
    });
    if (recentDup && !['failed', 'cancelled', 'declined'].includes(recentDup.status)) {
      return this.toResult(recentDup, true);
    }

    return this.createRequest(ctx, idempotencyKey, service, calendarKey, start, end, attendee, notes, aiSummary, intakeAnswers, extras, effectiveDuration);
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
      let timezone = 'UTC';
      try {
        const rule = await AppDataSource.getRepository(AvailabilityRule).findOne({ where: { botId: ctx.bot.id } });
        if (rule?.timezone) timezone = rule.timezone;
      } catch {
        // non-fatal — fall back to UTC
      }
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
   * P5e — validate the customer's attached files against the RESOLVED service and snapshot
   * them for `Booking.uploaded_files`. Ordered checks (security-first):
   * 1. service-disallow FIRST (before any session load → no existence/timing oracle);
   * 2. dedupe by id, then cap ≤5;
   * 3. per id: status='ready' (scanned clean) AND tenant match AND chatSession match AND
   *    well-formed snapshot fields — else FILE_NOT_READY.
   * Returns the JSON array (immutable snapshot) or null when no files were attached.
   */
  /**
   * Resolve which file-session ids to attach. If the tool passed explicit ids, use
   * them (strict-validated below). Otherwise, for a file-accepting service,
   * auto-collect the chat session's ready uploads — the agent never surfaces
   * upload ids to the LLM, so this is how a customer's uploaded file actually
   * reaches the booking. A no-file service auto-collects nothing, so a stray
   * upload elsewhere in the chat can't block a booking with FILE_UPLOAD_NOT_ALLOWED.
   */
  private async resolveFileSessionIds(
    ctx: BookingContext,
    service: ServiceType,
    explicit?: string[]
  ): Promise<string[] | undefined> {
    if (Array.isArray(explicit) && explicit.length) return explicit;
    if (!service.fileUploadAllowed) return undefined;
    const { getUploadService } = await import('../../file-handling/upload.service');
    const ids = await getUploadService().getReadySessionFileIds(ctx.session.id, ctx.tenant.id);
    return ids.length ? ids : undefined;
  }

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
        throw new BookingError('Attached file is not available', 'FILE_NOT_READY', 400);
      }
      out.push({
        fileSessionId: id,
        fileName: session!.originalName,
        mimeType: session!.mimeType,
        fileSize: session!.fileSize,
        fileKey: session!.fileKey,
      });
    }
    return out;
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
      .query(
        // Reset the retry budget: a re-flag (reschedule/cancel/create) is a NEW sync
        // episode and must not inherit a prior episode's attempt count (else it can go
        // terminal after only a couple of fresh failures).
        `UPDATE chatbot_bookings SET sync_pending=true, sync_attempts=0, sync_next_attempt_at=null, updated_at=now() WHERE id=$1`,
        [bookingId]
      )
      .catch(() => undefined);
  }

  /**
   * The ref to operate on for reschedule/cancel. Normally exactly one; if a rare
   * switch/create race left more than one, prefer the ref matching the bot's
   * current active provider, else the earliest-created — deterministic, so the
   * chosen provider is never arbitrary.
   */
  private async canonicalRef(botId: string, bookingId: string): Promise<BookingReference | null> {
    const refs = await AppDataSource.getRepository(BookingReference).find({
      where: { bookingId },
      order: { createdAt: 'ASC' },
    });
    if (refs.length <= 1) return refs[0] ?? null;
    const provider = await resolveCalendarProvider(botId);
    if (provider) {
      const match = refs.find((r) => r.providerType === provider.providerType);
      if (match) return match;
    }
    return refs[0];
  }

  /** Mirror a new booking to the bot's connected calendar (best-effort). Returns
   *  the meeting join URL if any. `content` is the P6a builder output; the join
   *  URL rides the provider's native conference fields, not the text body. */
  private async syncCalendarCreate(
    ctx: BookingContext,
    bookingId: string,
    content: { summary: string; description: string },
    start: Date,
    end: Date,
    timezone: string
  ): Promise<string | null> {
    const provider = await resolveCalendarProvider(ctx.bot.id);
    if (!provider) return null; // no calendar connection
    try {
      const ev = await provider.createEvent(
        ctx.bot.id,
        {
          startISO: start.toISOString(),
          endISO: end.toISOString(),
          timezone,
          summary: content.summary,
          description: content.description,
        },
        { eventId: this.googleEventId(bookingId) }
      );
      if (!ev) return null;
      const refRepo = AppDataSource.getRepository(BookingReference);
      await refRepo.save(
        refRepo.create({
          bookingId,
          providerType: provider.providerType,
          externalEventId: ev.eventId,
          externalCalendarId: ev.calendarId,
          meetingUrl: ev.meetUrl,
        })
      );
      return ev.meetUrl;
    } catch (err) {
      logger.warn('[Booking] calendar event create failed; booking stands (sync_pending)', {
        bookingId,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.markSyncPending(bookingId);
      return null;
    }
  }

  private async syncCalendarReschedule(
    ctx: BookingContext,
    bookingId: string,
    summary: string,
    start: Date,
    end: Date,
    timezone: string
  ): Promise<void> {
    // Plan D9: no external calendar calls when sync is entitlement-disabled.
    // The booking itself is already updated internally; the mirror is
    // intentionally suspended (re-enables with the entitlement).
    if (!(await isCalendarSyncAllowed(ctx.tenant.id))) return;
    const refRepo = AppDataSource.getRepository(BookingReference);
    const ref = await this.canonicalRef(ctx.bot.id, bookingId);
    try {
      const input = { startISO: start.toISOString(), endISO: end.toISOString(), timezone };
      if (ref) {
        // Route by the REF's provider — the event lives there. After a provider
        // switch, rescheduling an OLD event targets its original provider, which
        // returns no_connection (cred gone) → sync_pending for manual attention.
        const provider = providerFor(ref.providerType as 'google' | 'microsoft');
        const res = await provider.updateEvent(ctx.bot.id, ref.externalEventId, input, ref.externalCalendarId);
        if (res === 'not_found') {
          // Owner deleted it in the calendar → recreate (deterministic id) on its home.
          const ev = await provider.createEvent(
            ctx.bot.id,
            { ...input, summary },
            { eventId: this.googleEventId(bookingId), calendarId: ref.externalCalendarId }
          );
          if (ev) {
            ref.externalEventId = ev.eventId;
            ref.externalCalendarId = ev.calendarId;
            ref.meetingUrl = ev.meetUrl;
            await refRepo.save(ref);
          }
        } else if (res === 'no_access' || res === 'no_connection') {
          // Event lives on a now-inaccessible / disconnected account.
          await this.markSyncPending(bookingId);
        }
      } else {
        // Calendar connected after the booking was created → create on the bot's
        // current active provider now.
        const provider = await resolveCalendarProvider(ctx.bot.id);
        if (!provider) return;
        const ev = await provider.createEvent(
          ctx.bot.id,
          { ...input, summary },
          { eventId: this.googleEventId(bookingId) }
        );
        if (ev) {
          await refRepo.save(
            refRepo.create({
              bookingId,
              providerType: provider.providerType,
              externalEventId: ev.eventId,
              externalCalendarId: ev.calendarId,
              meetingUrl: ev.meetUrl,
            })
          );
        }
      }
    } catch (err) {
      logger.warn('[Booking] calendar event reschedule sync failed (sync_pending)', {
        bookingId,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.markSyncPending(bookingId);
    }
  }

  private async syncCalendarCancel(ctx: BookingContext, bookingId: string): Promise<void> {
    // Plan D9: no external calendar calls when sync is entitlement-disabled.
    if (!(await isCalendarSyncAllowed(ctx.tenant.id))) return;
    const ref = await this.canonicalRef(ctx.bot.id, bookingId);
    if (!ref) return;
    try {
      await providerFor(ref.providerType as 'google' | 'microsoft').deleteEvent(
        ctx.bot.id,
        ref.externalEventId,
        ref.externalCalendarId
      );
    } catch (err) {
      logger.warn('[Booking] calendar event cancel sync failed', {
        bookingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Owner accepts a `request_created` lead → confirm it. Uses the request's FROZEN
   * start/end + booked duration; refreshes the conflict key + buffer-expanded range
   * to current; re-checks availability + capacity under the per-calendar lock; then
   * creates the calendar event, sends the confirmation, and schedules reminders. The
   * request's already-snapshotted uploaded_files ride along unchanged.
   */
  async acceptRequest(ctx: BookingContext, bookingId: string): Promise<CreateBookingResult> {
    const booking = await this.loadOwned(ctx, bookingId);
    if (booking.provider !== 'internal' || booking.status !== 'request_created') {
      throw new BookingError('This booking is not a pending request', 'NOT_A_REQUEST', 409);
    }
    const start = booking.startUtc;
    const end = booking.endUtc;
    if (start.getTime() <= Date.now()) {
      throw new BookingError('This request is for a time in the past', 'REQUEST_EXPIRED', 409);
    }
    const rule = await this.loadRule(ctx.bot.id);
    const service = await this.serviceForBooking(booking);
    // Frozen length (stored span for legacy rows; never recompute from the service).
    const effectiveDuration = booking.bookedDurationMin ?? Math.round((end.getTime() - start.getTime()) / 60_000);
    // Refresh the conflict key (owner may have connected/switched/disconnected since)
    // and the buffer-expanded range (request rows store the RAW start/end).
    const calendarKey = await this.calendarKey(ctx);
    const blockedStart = new Date(start.getTime() - service.bufferBeforeMin * 60_000);
    const blockedEnd = new Date(end.getTime() + service.bufferAfterMin * 60_000);

    // Re-validate the stored slot at the frozen duration (the lead may be days old).
    const busy = await this.loadAllBusy(
      ctx,
      calendarKey,
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
      throw new BookingError('That time is no longer available', 'SLOT_UNAVAILABLE', 409);
    }

    // Flip request → confirmed under the lock (capacity + exclusion guard).
    let updatedRows: Array<{ id: string }>;
    try {
      // UPDATE…RETURNING via .query() yields [rows, count] — normalize (raw-sql.ts).
      updatedRows = returningRows<{ id: string }>(await AppDataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [calendarKey]);
        await enforceServiceDayCapacity(manager, service, start, rule.timezone, bookingId);
        return manager.query(
          `UPDATE chatbot_bookings
              SET status='confirmed', calendar_key=$2, blocked_range=tstzrange($3,$4,'[)'), updated_at=now()
            WHERE id=$1 AND tenant_id=$5 AND status='request_created'
            RETURNING id`,
          [bookingId, calendarKey, blockedStart.toISOString(), blockedEnd.toISOString(), ctx.tenant.id]
        );
      }));
    } catch (err) {
      if ((err as { code?: string })?.code === '23P01') {
        throw new BookingError('That time is no longer available', 'SLOT_UNAVAILABLE', 409);
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
      },
      service,
      buildManageUrl(bookingId)
    );
    const meetUrl = await this.syncCalendarCreate(ctx, bookingId, eventContent, start, end, rule.timezone);

    await sendBookingEmail({
      method: 'REQUEST',
      uid: confirmed.icsUid,
      sequence: 0,
      start,
      end,
      summary: service.name,
      location: meetUrl ?? (service.locationType === 'in_person' ? 'In person' : undefined),
      description: meetUrl ? `Join the meeting: ${meetUrl}` : undefined,
      timezone: rule.timezone,
      attendeeName: confirmed.attendeeName ?? '',
      attendeeEmail: confirmed.attendeeEmail ?? '',
      ownerEmail: ctx.botSettings.ai?.supportEmail ?? undefined,
      manageUrl: buildManageUrl(bookingId),
    });

    await this.scheduleAndPersistReminders(bookingId, start, 0);

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
    const rule = await this.loadRule(ctx.bot.id);
    const service = await this.serviceForBooking(booking);
    const calendarKey = await this.calendarKey(ctx);

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
    const busy = await this.loadAllBusy(
      ctx,
      calendarKey,
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
      throw new BookingError('Selected time is not available', 'SLOT_UNAVAILABLE', 409);
    }

    // Single atomic UPDATE under the calendar lock: frees the old slot and
    // reserves the new one in one statement; the exclusion constraint validates
    // the new range against other bookings (the row is excluded from itself).
    let sequence: number;
    try {
      sequence = await AppDataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [calendarKey]);
        // P5b: a reschedule into a DIFFERENT local day consumes capacity on the target
        // day — gate it (excluding this booking's own row). Same-day time moves don't.
        const oldDay = DateTime.fromJSDate(booking.startUtc).setZone(rule.timezone).toISODate();
        const newDay = DateTime.fromJSDate(start).setZone(rule.timezone).toISODate();
        if (oldDay !== newDay) {
          await enforceServiceDayCapacity(manager, service, start, rule.timezone, bookingId);
        }
        const rows = returningRows<{ sequence: number }>(await manager.query(
          `UPDATE chatbot_bookings
              SET start_utc=$1, end_utc=$2, blocked_range=tstzrange($3,$4,'[)'),
                  sequence=sequence+1, updated_at=now()
            WHERE id=$5 AND tenant_id=$6 AND status='confirmed'
            RETURNING sequence`,
          [start.toISOString(), end.toISOString(), blockedStart.toISOString(), blockedEnd.toISOString(), bookingId, ctx.tenant.id]
        ));
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

    // Carry the meeting join URL onto the rescheduled invite. The ICS reuses the
    // same UID with a bumped SEQUENCE (an in-place UPDATE), so omitting LOCATION/
    // DESCRIPTION here would BLANK the join link on the attendee's calendar event.
    // The mirrored event is updated (not recreated) on reschedule, so the stored
    // meetingUrl is still valid. Mirror the create path's location/description.
    const ref = await this.canonicalRef(ctx.bot.id, bookingId);
    const meetUrl = ref?.meetingUrl ?? null;
    await sendBookingEmail({
      method: 'REQUEST',
      uid: booking.icsUid,
      sequence,
      start,
      end,
      summary: service.name,
      location: meetUrl ?? (service.locationType === 'in_person' ? 'In person' : undefined),
      description: meetUrl ? `Join the meeting: ${meetUrl}` : undefined,
      timezone: rule.timezone,
      attendeeName: booking.attendeeName ?? '',
      attendeeEmail: booking.attendeeEmail ?? '',
      ownerEmail: ctx.botSettings.ai?.supportEmail ?? undefined,
      manageUrl: buildManageUrl(bookingId),
    });

    // Replace reminders: drop the old jobs, schedule fresh ones for the new time.
    await cancelReminders(booking.reminderJobIds).catch(() => undefined);
    await this.scheduleAndPersistReminders(bookingId, start, sequence);

    // Move the mirrored Google event (best-effort).
    await this.syncCalendarReschedule(ctx, bookingId, service.name, start, end, rule.timezone).catch(() => undefined);

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
    const rule = await this.loadRule(ctx.bot.id);
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
    });

    // Drop pending reminders (they'd no-op via sequence/status anyway).
    await cancelReminders(booking.reminderJobIds).catch(() => undefined);
    await AppDataSource.getRepository(Booking)
      .query(`UPDATE chatbot_bookings SET reminder_job_ids='[]'::jsonb WHERE id=$1`, [bookingId])
      .catch(() => undefined);

    // Delete the mirrored Google event (best-effort).
    await this.syncCalendarCancel(ctx, bookingId).catch(() => undefined);

    return { success: true, cancelled: true };
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
