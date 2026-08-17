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
import { In, MoreThan, Raw } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { notificationService } from '../../services/notification.service';
import { ServiceType } from '../../database/entities/ServiceType';
import type { Bot } from '../../database/entities/Bot';
import { AvailabilityRule } from '../../database/entities/AvailabilityRule';
import { BookingSettings } from '../../database/entities/BookingSettings';
import { normalizeVenue } from '../../contracts/venue-address';
import { resolveEventLocation } from './event-location';
import { buildCustomerEventDescription } from './booking-content';
import { organizerAddressForTenant } from './organizer-address';
import { describeServiceArea, isEnforceableEntry, matchServiceArea , type ServiceAreaMatch, type ServiceAreaEntry } from '../../contracts/service-area';
import {
  resolveServiceTiming,
  type BusinessRules,
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
import { computeSlots, BusyInterval } from './slot-engine';
import { buildBookingEventContent } from './booking-content';
import { sendBookingEmail, sendRequestNotificationEmail } from './booking-email';
import { scheduleReminders, cancelReminders } from './reminders';
import {
  resolveCalendarProvider,
  providerFor,
  isCalendarSyncAllowed,
  hasHealthyCalendarConnection,
} from '../../scheduler/calendar-provider';
import { BookingReference } from '../../database/entities/BookingReference';
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
  blocksAutoConfirm,
  placementIsCoarse,
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
import { addressToken } from '../travel/address-for-turn';
import {
  AddressBindingMovedError,
  consumeAddressBinding,
} from '../travel/address-binding';
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
 * An idempotent return has no new booking INSERT to share a transaction with: the row already
 * exists. Still consume the binding used by this retry, but never clear a newer generation that
 * arrived while the duplicate lookup was running.
 */
async function consumeBindingAfterIdempotentReturn(
  ctx: BookingContext,
  extras?: BookingExtras
): Promise<void> {
  if (!extras?.addressBinding) return;
  try {
    await AppDataSource.transaction((manager) =>
      consumeAddressBinding(manager, ctx.session.id, extras.addressBinding)
    );
  } catch (error) {
    if (error instanceof AddressBindingMovedError) return;
    logger.warn('[Booking] could not consume address binding after idempotent return', {
      sessionId: ctx.session.id,
      error,
    });
  }
}

/**
 * P3: normalize an LLM-supplied intake-answers object against a RESOLVED service's
 * questions — the single place answers are sanitized before persistence. Keeps only
 * entries whose key matches a current question id, coerces the value to a trimmed
 * non-empty string (string→trim; number/boolean→String; null/undefined/array/object
 * dropped — never `"[object Object]"`), caps at 2000 chars. Returns a flat
 * `{ id: string }` map or `null` if nothing remains. A malformed/non-array
 * `intakeQuestions` (legacy/hand-edited) degrades to "no questions" → null.
 */
export function normalizeIntakeAnswers(service: ServiceType, raw: unknown): Record<string, string> | null {
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
    else if (Array.isArray(value)) {
      // An ARRAY is what a multi-answer looks like, and dropping it silently lost the
      // customer's answer entirely — the owner saw a question with no reply rather than
      // one with several. Flattened to a readable list; the scalar members are kept and
      // anything nested is discarded rather than rendered as "[object Object]".
      const parts = value
        .filter((v): v is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof v))
        .map((v) => String(v).trim())
        .filter(Boolean);
      if (!parts.length) continue;
      str = parts.join(', ');
    } else continue; // null/undefined/object → dropped
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
/**
 * What to tell the model when the time it asked for has gone.
 *
 * THE MESSAGE CARRIES THE NEXT STEP, because a bare statement of fact does not survive contact
 * with the model. Observed in production: two customers raced for one slot, and the loser's tool
 * returned `This time slot is no longer available` - correct, safe to show, and useless. The model
 * answered an English customer with the tenant's Dutch handoff string and gave up, on a race it
 * could have recovered from in one turn by re-checking the day.
 *
 * Every booking error in this file that produces a good reply says what to do next. These did not.
 * The two forbidden moves are named explicitly because both were what it actually did.
 */
export const SLOT_TAKEN_ON_CREATE =
  'That time is no longer available. Tell the customer plainly that it has just gone, apologise ' +
  'briefly, then call check_availability again for the same day and offer what is left. Do NOT ' +
  'hand the conversation to a human and do NOT use the fallback message: a taken slot is an ' +
  'ordinary thing that happens and you can fix it yourself.';

/**
 * The time was never offerable, which is NOT the same as taken.
 *
 * `SLOT_TAKEN_*` says somebody got there first, and for a slot the engine would never have
 * offered - outside opening hours, on a closed day, sooner than the notice the owner needs,
 * further ahead than they take bookings, or past the day's cap - that is simply false. Told "no
 * longer available", a customer reads it as bad luck and asks for a Request; told "too soon",
 * they pick a later time and book themselves. Observed on a min-notice refusal, where the second
 * outcome was available and the first is what happened.
 *
 * The reason is not enumerated here because the engine does not hand one back - it returns a slot
 * list, and a time is either in it or not. Re-offering is the honest recovery: it shows what IS
 * possible rather than guessing why this was not.
 */
export const SLOT_NOT_OFFERABLE =
  'That time is not one this business can take. It may be outside their opening hours, on a day ' +
  'they are closed, sooner than the notice they need, further ahead than they book, or the day ' +
  'may already be full. Do NOT say it was just taken and do NOT say it is unavailable without ' +
  'explanation. Call check_availability for that day and the days around it, then offer the ' +
  'customer the times that actually exist. Do not hand the conversation to a human and do not ' +
  'use the fallback message.';

/** `SLOT_NOT_OFFERABLE` for a move: same distinction, and the appointment still stands. */
export const SLOT_NOT_OFFERABLE_ON_RESCHEDULE =
  'That time is not one this business can take, and the existing appointment has NOT been ' +
  'changed. It may be outside their opening hours, on a day they are closed, sooner than the ' +
  'notice they need, further ahead than they book, or the day may already be full. Do NOT say it ' +
  'was just taken. Say both of those things, call check_availability for that day, and offer the ' +
  'times that actually exist. Do not hand the conversation to a human and do not use the ' +
  'fallback message.';

/** The same, for a move. The customer keeps their existing appointment until one succeeds. */
export const SLOT_TAKEN_ON_RESCHEDULE =
  'That time is no longer available, and the existing appointment has NOT been changed. Say both ' +
  'of those things, then call check_availability again for the day the customer wants and offer ' +
  'what is left. Do NOT hand the conversation to a human and do NOT use the fallback message.';

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
 *  wart: customerLocationRequired maps to PHONE (a callback number), not address.
 *  #149: a choose-at-booking Service only needs an address when the customer picked theirs. */
function requiredContactFields(
  service: ServiceType,
  extras?: BookingExtras,
): { address: boolean; phone: boolean } {
  return {
    address: serviceNeedsCustomerAddress(service, extras),
    phone: !!service.customerLocationRequired,
  };
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
  const req = requiredContactFields(service, extras);
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
  // `active !== false` is load-bearing, not defensive. A paused question is removed from the
  // prompt, so the bot never asks it — but this gate demanded an answer anyway, which
  // deadlocked EVERY booking for that service: the model cannot supply an answer to a
  // question it was never shown, and the error names a label it has no other knowledge of.
  // Pausing a required question must switch the requirement off with it.
  const required = questions.filter(
    (q) => q && q.required && q.active !== false && typeof q.id === 'string'
  );
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
 * P6 — don't AUTO-CONFIRM a job the business may not be willing to travel to.
 *
 * Scope is two explicit owner decisions, both required: an area is configured, AND the
 * service asks for the customer's address (which is what makes it a travel job at all — an
 * online consultation is never gated).
 *
 * Within that scope this is deliberately NOT fail-open. The tempting rule is "only block a
 * confident `outside`", but the two errors are nowhere near equal: a wrong `outside` costs
 * the owner one glance at a request they can accept with a click, while a wrong `inside`
 * costs them a confirmed row, a calendar event, an invite the customer is now holding,
 * reminders — and then either a drive or a cancellation on someone who has a confirmation
 * email. So an address we cannot place is captured as a request too. Nobody is turned away
 * either way; the only question is whether the owner gets to decide.
 *
 * Recoverable (400): the agent captures the job with `request_appointment`.
 */
/**
 * What the service-area gate SAW, without acting on it.
 *
 * Split out from the assert so the REQUEST path can record the verdict while continuing not
 * to enforce it. That distinction is the whole point: refusing a captured job is the one
 * outcome the prompt forbids, but until now the only trace a job was out of area was a log
 * line — so an owner could turn work away for months and never know the area they drew was
 * costing them.
 *
 * `null` means the gate did not apply at all: the service asks for no address, or no
 * enforceable place is configured. That is different from `unknown`, which means we looked
 * and could not place it.
 */
async function evaluateServiceArea(
  ctx: BookingContext,
  service: ServiceType,
  address: string | null
): Promise<{ match: ServiceAreaMatch | null; entries: ServiceAreaEntry[] }> {
  if (!serviceNeedsCustomerAddress(service, { customerAddress: address })) {
    return { match: null, entries: [] };
  }
  const row = await AppDataSource.getRepository(BookingSettings).findOne({
    where: { botId: ctx.bot.id },
  });
  const entries = Array.isArray(row?.serviceArea) ? row.serviceArea : [];
  if (!entries.some(isEnforceableEntry)) return { match: null, entries };
  return { match: matchServiceArea(address, entries), entries };
}

async function assertInServiceArea(
  ctx: BookingContext,
  service: ServiceType,
  address: string | null
): Promise<void> {
  if (!serviceNeedsCustomerAddress(service, { customerAddress: address })) return;
  const row = await AppDataSource.getRepository(BookingSettings).findOne({
    where: { botId: ctx.bot.id },
  });
  const entries = Array.isArray(row?.serviceArea) ? row.serviceArea : [];
  // Typed notes are shown to the assistant but are not rules, so an area made only of them
  // has nothing to enforce. Without this check it would hold back EVERY booking — the same
  // footgun as before, wearing a different hat.
  if (!entries.some(isEnforceableEntry)) return;

  const verdict = matchServiceArea(address, entries);
  if (verdict === 'inside') return;

  // The only place this gate is observable. Without it there is no way to answer
  // "has it ever fired in production", which is the first thing anyone will ask.
  logger.info('[Booking] out of service area — capturing as a request', {
    tenantId: ctx.tenant.id,
    botId: ctx.bot.id,
    serviceId: service.id,
    verdict,
    hasAddress: !!address,
  });
  // Two DIFFERENT failures, and conflating them cost real bookings. "Outside" is a decision
  // the owner must make, so it becomes a request. "Could not be placed" usually just means
  // the customer said "Kerkstraat 12" with no town — an in-area customer who would book
  // happily if asked one more question. Distinct codes let the prompt ask instead of giving
  // up, without ever letting it retry a genuine out-of-area address.
  throw new BookingError(
    verdict === 'outside'
      ? `That address is outside the area this business serves (${describeServiceArea(entries)}).`
      : `This business only travels to ${describeServiceArea(entries)}, and that address could not be placed. Ask for a postcode or town.`,
    verdict === 'outside' ? 'OUT_OF_SERVICE_AREA' : 'ADDRESS_NOT_PLACEABLE',
    400,
    undefined,
    // The out-of-area half is safe to show as-is - it names the area and blames nobody. The
    // unplaceable half ends in an instruction to the bot, so it gets its own wording.
    verdict === 'outside'
      ? `That address is outside the area this business serves (${describeServiceArea(entries)}).`
      : 'We could not find that address. Please contact the business directly to move this appointment.'
  );
}

/**
 * Travel time: don't AUTO-CONFIRM a job we cannot locate well enough to plan the drive to.
 *
 * A SEPARATE GATE FROM THE SERVICE AREA, and the difference is worth stating because the two
 * throw the same code. The area asks "is this town on the owner's list", which the Belgian
 * municipality table answers for free from the address text. This asks "where is the door",
 * which only Google can answer, so a street the area gate matched to Sint-Niklaas can still
 * be unplaceable here, and a business with no area configured at all is still gated once
 * travel is on.
 *
 * Recoverable (400), and deliberately the SAME code the service area already uses: the
 * prompt's recovery, which asks for a postcode, retries once and then captures with
 * request_appointment, is exactly the right handling, and a second code would need the model
 * taught a second time. WHICH placements block is `blocksAutoConfirm`, kept beside the other
 * readings of a placement rather than restated here.
 */
function assertPlaceableForTravel(placement: BookingPlacement): void {
  if (!blocksAutoConfirm(placement)) return;
  throw new BookingError(
    'That address could not be located precisely enough to plan the journey. Ask for a postcode or town.',
    'ADDRESS_NOT_PLACEABLE',
    400,
    undefined,
    // "Ask for a postcode" is an instruction to the bot. A customer on the manage page cannot
    // change the address on their existing booking, so they are told who can.
    'We could not work out the journey to your address. Please contact the business directly to move this appointment.'
  );
}

/**
 * Travel time: we could not find out where anything is, so nothing here may be confirmed.
 *
 * NOT the customer's fault and NOT recoverable by them — Google was unreachable, or the
 * tenant's element cap is spent. Asking for a postcode would be friction that could not
 * possibly help, so this reuses the code the calendar outage already raises: the prompt's
 * coaching for it is exactly right ("do not say there are no slots, capture their preferred
 * time as a request"), and inventing a second code would mean teaching the model the same
 * lesson twice. Which failure it was is in the logs, where a sustained run of it belongs.
 */
function throwTravelUnavailable(): never {
  throw new BookingError(
    'The journey could not be checked right now, so times cannot be confirmed. Ask the customer for their preferred date and time and capture it with request_appointment.',
    'BOOKING_TEMPORARILY_UNAVAILABLE',
    503
  );
}

/**
 * A placement turned into the point the gate reasons over, or a refusal.
 *
 * THE THREE OUTCOMES OF #62 BECOME THE THREE BRANCHES OF ADR-0015 HERE, and this is the only
 * place that mapping exists. An address we could not place at all has a recovery the customer
 * can act on. An address placed only to a town centre is a usable point that may refuse and may
 * never clear. An outage is neither, and refuses to confirm anything without pretending the
 * customer typed something wrong.
 */
function travelCandidatePoint(placement: BookingPlacement): { point: GeoPoint; coarse: boolean } {
  assertPlaceableForTravel(placement);
  if (!placement.applies || placement.outcome !== 'placed') throwTravelUnavailable();
  return {
    point: { lat: placement.place.lat, lng: placement.place.lng },
    coarse: placementIsCoarse(placement),
  };
}

/**
 * P5b — enforce `maxBookingsPerDay` for a service on the slot's local calendar day.
 * Counts only HELD rows (`status IN ('pending','confirmed')`) for the same service,
 * by `start_utc` in the half-open `[dayStart, nextDay)` window of `timezone` (Luxon,
 * DST-exact). `null`/`≤0` cap = unlimited (a malformed/legacy row degrades to "no
 * limit", never "no bookings"). Runs inside the caller's advisory-lock transaction so
 * the count-then-write is atomic. `excludeBookingId` skips the row being rescheduled.
 */
export async function enforceServiceDayCapacity(
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
  // plus THEN startOf: in a zone whose DST transition lands at midnight, adding 24h to the
  // start of the day gives 23:00 or 01:00 of the next day, not its start — so the window
  // clipped or double-counted an hour and the gate disagreed with the ledger.
  const nextDay = local.plus({ days: 1 }).startOf('day').toUTC().toISO();
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

/** Business-level ceilings, normalised so null/negative/0 all read as "unlimited". */
/**
 * `manager` matters when this is called from INSIDE a booking transaction: without it the
 * read takes a SECOND connection from the pool while the first is mid-transaction holding
 * an advisory lock, which is a pool-exhaustion deadlock waiting for load.
 */
export async function loadBusinessRules(botId: string, manager?: EntityManager): Promise<BusinessRules> {
  const row = await (manager ?? AppDataSource.manager).getRepository(BookingSettings).findOne({ where: { botId } });
  const n = (v: number | null | undefined): number => (typeof v === 'number' && v > 0 ? v : 0);
  // Ceilings normalise 0/negative to "unlimited"; DEFAULTS must keep a real 0 (a business
  // that genuinely wants zero notice is saying something different from "unset").
  const d = (v: number | null | undefined): number | null => (typeof v === 'number' ? v : null);
  return {
    maxBookingsPerDay: n(row?.maxBookingsPerDay),
    maxBookedMinutesPerDay: n(row?.maxBookedMinutesPerDay),
    minGapMin: n(row?.minGapMin),
    defaultBufferBeforeMin: d(row?.defaultBufferBeforeMin),
    defaultBufferAfterMin: d(row?.defaultBufferAfterMin),
    defaultMinNoticeMin: d(row?.defaultMinNoticeMin),
    defaultMaxHorizonDays: d(row?.defaultMaxHorizonDays),
    // Absent settings row ⇒ not paused, which is every existing bot's behaviour.
    bookingsPaused: !!row?.bookingsPaused,
    venue: normalizeVenue({
      street: row?.venueStreet,
      postalCode: row?.venuePostalCode,
      city: row?.venueCity,
      country: row?.venueCountry,
    }),
  };
}

/**
 * Business-level capacity, enforced across EVERY service rather than per service.
 *
 * Mirrors `enforceServiceDayCapacity` deliberately — same `manager` (so count-then-write is
 * atomic inside the caller's advisory lock), same half-open local-day window, same
 * `status IN ('pending','confirmed')` so a captured request never consumes capacity, same
 * `excludeBookingId` for reschedule/accept. It differs in scoping to `bot_id` rather than
 * one service, which is the entire point: five services capped at 2/day still allowed ten
 * jobs in a day.
 *
 * The gap check is the race-safe twin of the busy-inflation the slot engine sees. It has to
 * exist separately because the `EXCLUDE USING gist` constraint only understands overlap of
 * `blocked_range` — it cannot see a required gap, so two concurrent bookers would otherwise
 * both pass the pre-lock re-validation and land back to back.
 *
 * THE TWO HALVES SCOPE DIFFERENTLY, deliberately. The day ceilings ask "how much has this
 * BUSINESS sold today", a question about the bot's own catalogue, so they count by `bot_id`.
 * The gap asks "is anything parked too close to this in the DIARY", a question about one
 * person's day — so it scopes to the ITINERARY KEY (ADR-0016), and two bots pointed at one
 * real calendar share one. A bot-scoped gap query could not see the neighbour that the
 * advisory lock and `loadBusy` both already count: it passed, and the two bookings landed
 * back to back on a calendar that had room for only one of them. Scoping the gap to the key
 * also lets it use the `(calendar_key, blocked_range)` exclusion index rather than filtering
 * on `bot_id`. Travel feasibility will land on this same half, for the same reason.
 */
export async function enforceBusinessCapacity(
  manager: EntityManager,
  botId: string,
  itineraryKey: ItineraryKey,
  rules: BusinessRules,
  window: { start: Date; end: Date; blockedStart: Date; blockedEnd: Date },
  timezone: string,
  excludeBookingId?: string
): Promise<void> {
  const { maxBookingsPerDay, maxBookedMinutesPerDay, minGapMin } = rules;
  if (!maxBookingsPerDay && !maxBookedMinutesPerDay && !minGapMin) return;

  if (maxBookingsPerDay || maxBookedMinutesPerDay) {
    const local = DateTime.fromJSDate(window.start).setZone(timezone);
    const dayStart = local.startOf('day').toUTC().toISO();
    // plus THEN startOf: in a zone whose DST transition lands at midnight, adding 24h to the
    // start of the day gives 23:00 or 01:00 of the next day, not its start — so the window
    // clipped or double-counted an hour and the gate disagreed with the ledger.
    const nextDay = local.plus({ days: 1 }).startOf('day').toUTC().toISO();
    const params: unknown[] = [botId, dayStart, nextDay];
    // Minutes come from the stored span, not booked_duration_min — that column is null for
    // legacy rows and for requests, and a null would silently bill the job as zero minutes.
    let sql = `SELECT count(*)::int AS n,
                      COALESCE(SUM(EXTRACT(EPOCH FROM (end_utc - start_utc)) / 60), 0)::int AS mins
                 FROM chatbot_bookings
                WHERE bot_id = $1 AND status IN ('pending','confirmed')
                  AND start_utc >= $2 AND start_utc < $3`;
    if (excludeBookingId) {
      sql += ` AND id <> $4`;
      params.push(excludeBookingId);
    }
    const rows: Array<{ n: number; mins: number }> = await manager.query(sql, params);
    const used = rows[0] ?? { n: 0, mins: 0 };

    if (maxBookingsPerDay && (used.n ?? 0) >= maxBookingsPerDay) {
      throw new BookingError('This business is fully booked that day', 'CAPACITY_REACHED', 409);
    }
    if (maxBookedMinutesPerDay) {
      const newMins = Math.max(0, (window.end.getTime() - window.start.getTime()) / 60_000);
      if ((used.mins ?? 0) + newMins > maxBookedMinutesPerDay) {
        throw new BookingError('This business has no working time left that day', 'CAPACITY_REACHED', 409);
      }
    }
  }

  if (minGapMin) {
    const gapMs = minGapMin * 60_000;
    const params: unknown[] = [
      itineraryKey,
      new Date(window.blockedStart.getTime() - gapMs).toISOString(),
      new Date(window.blockedEnd.getTime() + gapMs).toISOString(),
    ];
    let sql = `SELECT 1 FROM chatbot_bookings
                WHERE calendar_key = $1 AND status IN ('pending','confirmed')
                  AND blocked_range && tstzrange($2, $3, '[)')`;
    if (excludeBookingId) {
      sql += ` AND id <> $4`;
      params.push(excludeBookingId);
    }
    sql += ' LIMIT 1';
    const clash: unknown[] = await manager.query(sql, params);
    if (clash.length) {
      throw new BookingError('That time is too close to another appointment', 'CAPACITY_REACHED', 409);
    }
  }
}

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
/**
 * True when a variable-length service's length was never established.
 *
 * The epic's rule is that the assistant must not auto-book a duration it had to guess.
 * `resolveDuration` falls back to the SHORTEST job when the model supplies nothing, which
 * is a safe number to hold but a silent guess to confirm: a two-hour repair booked as a
 * thirty-minute one is a wrong appointment, not a conservative one. The auto path treats
 * this as a reason to capture a request; the request path doesn't care, because a request
 * carries a preferred time rather than a committed length.
 */
function durationUnresolved(service: ServiceType, requestedDurationMin?: number): boolean {
  return hasValidRange(service) && typeof requestedDurationMin !== 'number';
}

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

/**
 * The identity two calls must share to be the same booking.
 *
 * ONE function for BOTH duplicate checks, and that is the point rather than tidiness. There are two
 * gates - the idempotency key and `(session, service, startUtc)` - and the first fix for #92 taught
 * only the key about the address. The second gate then collapsed the corrected booking anyway, so
 * the bug survived a fix that its own tests said had worked. Two gates deciding "same booking" by
 * two different rules is what allowed that, and one shared rule is what stops it recurring.
 *
 * Computed AFTER the service is resolved, because two of the three inputs depend on it.
 *
 * ## The address is excluded when the service does not have one
 *
 * A phone consult can still carry an address - inherited from an earlier turn in the session, or
 * volunteered by a customer who mentioned where they live. Letting that participate would make an
 * incidental detail decide whether two calls are the same booking, and produce duplicates for the
 * services that never had this problem. `customerAddressRequired` is the question of whether the
 * address is part of the booking at all.
 *
 * ## A geocoded place id is NOT the customer's identity for the place
 *
 * `createRequest` stores a `place_id` derived from the text whenever it can, so a row created from
 * typed words comes back carrying an identity the customer never supplied. Comparing that against a
 * later turn's raw text finds them different and inserts a SECOND request - a genuine re-confirm
 * turned into two live rows for the owner to untangle, which is the failure `#35` added the second
 * gate to prevent. So a stored `place_id` only counts as identity when `location_source = 'pin'`,
 * which is the flag that records the customer actually picked it.
 */
export function dedupIdentity(input: {
  addressRequired: boolean;
  address?: string | null;
  placeId?: string | null;
  /** False for a `place_id` this system derived rather than the customer choosing it. */
  placeIdIsPicked: boolean;
}): string {
  if (!input.addressRequired) return 'noaddr';
  return addressToken({
    address: input.address ?? undefined,
    placeId: input.placeIdIsPicked ? (input.placeId ?? undefined) : undefined,
  });
}

/** The stored row's identity, read with its own provenance. */
function rowDedupIdentity(row: Booking, addressRequired: boolean): string {
  return dedupIdentity({
    addressRequired,
    address: row.customerAddress,
    placeId: row.customerPlaceId,
    placeIdIsPicked: row.locationSource === 'pin',
  });
}

/** The incoming call's identity. Anything it supplies as a place id came from a customer pick. */
function callDedupIdentity(addressRequired: boolean, extras?: BookingExtras): string {
  return dedupIdentity({
    addressRequired,
    address: extras?.customerAddress,
    placeId: extras?.customerPlaceId,
    placeIdIsPicked: true,
  });
}

/**
 * "Created recently enough to count as a duplicate", asked of the DATABASE rather than of us.
 *
 * `createdAt: MoreThan(new Date(Date.now() - WINDOW))` looks equivalent and is not.
 * `chatbot_bookings.created_at` is `timestamp WITHOUT time zone` - `@CreateDateColumn` carries no
 * explicit type, unlike `start_utc` which is explicitly `timestamptz` - so comparing it against a
 * timezone-aware instant is off by the client's UTC offset. On a developer machine at UTC+8 the
 * cutoff lands eight hours in the future and a row created seventeen milliseconds ago is judged
 * too old, so the lookup finds nothing and BOTH dedup gates silently stop deduping.
 *
 * It fails OPEN, into duplicate bookings, and it is invisible: no error, just a query that never
 * matches. Anyone developing outside UTC has been running without request deduplication without
 * knowing. Production runs UTC, where the two coincide, which is why this never surfaced there.
 *
 * Letting Postgres compare its own clock to its own column removes the client's timezone from the
 * question entirely. Preferred over migrating the column to `timestamptz`, which would rewrite a
 * large table under an ACCESS EXCLUSIVE lock to fix something that only bites developers.
 */
const createdWithinDedupWindow = () =>
  Raw((alias) => `${alias} > now() - interval '${BOOKING_DEDUP_WINDOW_MS} milliseconds'`);

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
      throw new BookingError('Booking not configured for this bot', 'BOOKING_NOT_CONFIGURED', 400);
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
      if (!svc) throw new BookingError('That service is unavailable', 'SERVICE_NOT_FOUND', 404);
      return resolveServiceTiming(svc, rules);
    }
    const active = await repo.find({ where: { botId, isActive: true, onlineBookable: true }, order: { sortOrder: 'ASC', createdAt: 'ASC' } });
    if (active.length === 0) {
      throw new BookingError('Booking not configured for this bot', 'BOOKING_NOT_CONFIGURED', 400);
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

  /**
   * Deterministic Google event id for a booking: the booking uuid with hyphens
   * stripped (32 hex chars = valid Google base32hex). Makes the Google create
   * idempotent — a reconciler retry after a partial failure re-uses this id
   * instead of producing a duplicate event.
   */
  private googleEventId(bookingId: string): string {
    return bookingId.replace(/-/g, '');
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
    const busy = await this.loadAllBusy(
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
    // Day-level ceilings are applied HERE, not only at create: the per-service cap has
    // always been create-time-only, which is why the prompt has to coach the model through
    // CAPACITY_REACHED. Offering a slot and then refusing it is the behaviour to avoid.
    const business = await loadBusinessRules(ctx.bot.id);
    const dayLedger =
      business.maxBookingsPerDay || business.maxBookedMinutesPerDay
        ? await this.loadDayLedger(ctx.bot.id, rangeStart, rangeEnd, excludeBookingId)
        : undefined;
    const slots = computeSlots({
      rule,
      eventType: { ...service, durationMin: availDuration },
      rangeStart,
      rangeEnd,
      now: new Date(),
      busy,
      business,
      dayLedger,
    });
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
    for (const slot of input.slots) {
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

  /**
   * Existing pending/confirmed bookings' blocked ranges overlapping [start,end).
   * `excludeId` omits a booking from the result (used on reschedule so a booking
   * never conflicts with its own current slot).
   */
  private async loadBusy(
    itineraryKey: ItineraryKey,
    rangeStartIso: string,
    rangeEndIso: string,
    excludeId?: string
  ): Promise<BusyInterval[]> {
    const rows: Array<{ s: string; e: string }> = await AppDataSource.getRepository(Booking).query(
      // `calendar_key` is the stored column; the itinerary key is what it means here.
      `SELECT lower(blocked_range) AS s, upper(blocked_range) AS e
         FROM chatbot_bookings
        WHERE calendar_key = $1 AND status IN ('pending','confirmed')
          AND blocked_range && tstzrange($2, $3, '[)')
          AND ($4::uuid IS NULL OR id <> $4::uuid)`,
      [itineraryKey, rangeStartIso, rangeEndIso, excludeId ?? null]
    );
    return rows.map((r) => ({ start: new Date(r.s), end: new Date(r.e) }));
  }

  /**
   * This bot's HELD bookings at their RAW start/end, for business day totals.
   *
   * Deliberately not derived from `loadAllBusy`: that merges the owner's external calendar
   * events and returns buffer-expanded bounds, so counting it would refuse slots because of
   * a personal appointment and would bill buffers as sold working time.
   */
  private async loadDayLedger(
    botId: string,
    rangeStartIso: string,
    rangeEndIso: string,
    excludeId?: string
  ): Promise<BusyInterval[]> {
    const rows: Array<{ s: string; e: string }> = await AppDataSource.getRepository(Booking).query(
      `SELECT start_utc AS s, end_utc AS e
         FROM chatbot_bookings
        WHERE bot_id = $1 AND status IN ('pending','confirmed')
          AND start_utc >= $2 AND start_utc < $3
          AND ($4::uuid IS NULL OR id <> $4::uuid)`,
      [botId, rangeStartIso, rangeEndIso, excludeId ?? null]
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
    itineraryKey: ItineraryKey,
    rangeStartIso: string,
    rangeEndIso: string,
    timezone?: string,
    excludeId?: string,
    excludeExternalInterval?: { start: Date; end: Date }
  ): Promise<BusyInterval[]> {
    let internal = await this.loadBusy(itineraryKey, rangeStartIso, rangeEndIso, excludeId);
    // Business minimum gap: pad OUR bookings only. Padding the owner's personal calendar
    // events too would quietly refuse slots around their dentist appointment, which is not
    // what "minimum time between bookings" asks for. Applied on this side ONLY — the engine
    // already expands the candidate by its own buffers, and doing both would double it.
    const { minGapMin } = await loadBusinessRules(ctx.bot.id);
    if (minGapMin > 0) {
      const gapMs = minGapMin * 60_000;
      internal = internal.map((iv) => ({
        start: new Date(iv.start.getTime() - gapMs),
        end: new Date(iv.end.getTime() + gapMs),
      }));
    }
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
      return this.toResult(recentDup, true, rule.timezone, service.name);
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
    // capture a request, not a confirmed booking. Mirrors readiness willAutoConfirm.
    // Request-only, no healthy calendar, OR a variable-length job whose length nobody
    // established — all three mean "do not confirm this, capture it".
    if (service.bookingMode === 'request' || !canAuto || durationUnresolved(service, extras?.durationMin)) {
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
    // P5e: validate + snapshot attached files (service-disallow / readiness / ownership).
    const fileSessionIds = await this.resolveFileSessionIds(ctx, service, extras?.fileSessionIds);
    const uploadedFiles = await this.validateUploadedFiles(ctx, service, fileSessionIds);

    const blockedStart = new Date(start.getTime() - service.bufferBeforeMin * 60_000);
    const blockedEnd = new Date(end.getTime() + service.bufferAfterMin * 60_000);

    // 3. Re-validate: the requested start must be an actually-offered slot
    //    (rules, buffers, min-notice, horizon, internal + Google busy).
    const busy = await this.loadAllBusy(
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
          return this.toResult(dup, true, rule.timezone, service.name);
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
    const eventLocation = resolveEventLocation({
      locationType: service.locationType,
      customerAddressRequired: service.customerAddressRequired,
      // Explicitly null: the Meet URL is a RESULT of creating this event, so it cannot be
      // an input to it. The physical venue is what the mirror carries; Google renders the
      // Meet link itself from conferenceData.
      meetUrl: null,
      customerAddress: contact.address,
      venue,
    });
    const meetUrl = await this.syncCalendarCreate(
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
      location: resolveEventLocation({
        locationType: service.locationType,
        customerAddressRequired: service.customerAddressRequired,
        meetUrl,
        customerAddress: contact.address,
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
      attendeeName: attendee.name,
      attendeeEmail: attendee.email,
      ownerEmail: ctx.botSettings.ai?.supportEmail ?? undefined,
      organizerEmail: frozenOrganizerFor(ctx.tenant.id),
      organizerName: ctx.botSettings.ai?.brandVoice?.businessName || ctx.tenant.name,
      manageUrl: buildManageUrl(bookingId),
      durationMin: effectiveDuration,
      preparationInstructions: service.preparationInstructions,
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
    // P5e: validate + snapshot attached files for the request row too.
    const fileSessionIds = await this.resolveFileSessionIds(ctx, service, extras?.fileSessionIds);
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
    timezone: string,
    location?: string,
    conferencing?: boolean
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
          ...(location ? { location } : {}),
          ...(conferencing ? { conferencing } : {}),
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
    /**
     * Full event content, not a bare title. An owner who deletes the event and triggers the
     * recreate branch below used to get a title with a COMPLETELY EMPTY body — losing the
     * customer, the phone, the address and the manage link in one step.
     */
    content: { summary: string; description: string },
    start: Date,
    end: Date,
    timezone: string,
    /**
     * What a RECREATE needs, and an update does not.
     *
     * Grouped rather than trailing positionally, because the difference is the whole point and
     * a signature should not need a paragraph to say which arguments apply when. A plain update
     * deliberately PATCHes times alone so the owner's own edits to the event survive. A recreate
     * builds the event from nothing, so anything omitted here is gone for good: the recreate
     * SUCCEEDS, so `markSyncPending` never fires and the reconciler - which claims
     * `sync_pending` rows only - never revisits it. Omitting them cost the venue AND nulled the
     * stored Meet URL, which then blanked the join link on every later reschedule and in the
     * portal's booking list.
     */
    recreate?: { location?: string; conferencing?: boolean }
  ): Promise<void> {
    const { location, conferencing } = recreate ?? {};
    // Plan D9: no external calendar calls when sync is entitlement-disabled.
    // The booking itself is already updated internally; the mirror is
    // intentionally suspended (re-enables with the entitlement).
    if (!(await isCalendarSyncAllowed(ctx.tenant.id))) return;
    const refRepo = AppDataSource.getRepository(BookingReference);
    const ref = await this.canonicalRef(ctx.bot.id, bookingId);
    try {
      const input = { startISO: start.toISOString(), endISO: end.toISOString(), timezone };
      const recreateInput = {
        ...input,
        summary: content.summary,
        description: content.description,
        ...(location ? { location } : {}),
        ...(conferencing ? { conferencing } : {}),
      };
      if (ref) {
        // Route by the REF's provider — the event lives there. After a provider
        // switch, rescheduling an OLD event targets its original provider, which
        // returns no_connection (cred gone) → sync_pending for manual attention.
        const provider = providerFor(ref.providerType as 'google' | 'microsoft');
        const res = await provider.updateEvent(ctx.bot.id, ref.externalEventId, input, ref.externalCalendarId);
        if (res === 'not_found') {
          // Owner deleted it in the calendar → recreate (deterministic id) on its home.
          const ev = await provider.createEvent(ctx.bot.id, recreateInput, {
            eventId: this.googleEventId(bookingId),
            calendarId: ref.externalCalendarId,
          });
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
        const ev = await provider.createEvent(ctx.bot.id, recreateInput, {
          eventId: this.googleEventId(bookingId),
        });
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
    const busy = await this.loadAllBusy(
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
    const eventLocation = resolveEventLocation({
      locationType: service.locationType,
      customerAddressRequired: service.customerAddressRequired,
      // Explicitly null: the Meet URL is a RESULT of creating this event, so it cannot be
      // an input to it. The physical venue is what the mirror carries; Google renders the
      // Meet link itself from conferenceData.
      meetUrl: null,
      customerAddress: confirmed.customerAddress,
      venue,
    });
    const meetUrl = await this.syncCalendarCreate(
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
      location: resolveEventLocation({
        locationType: service.locationType,
        customerAddressRequired: service.customerAddressRequired,
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
    const busy = await this.loadAllBusy(
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
    const ref = await this.canonicalRef(ctx.bot.id, bookingId);
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
      location: resolveEventLocation({
        locationType: service.locationType,
        customerAddressRequired: service.customerAddressRequired,
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
    await this.scheduleAndPersistReminders(bookingId, start, sequence);

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
    await this.syncCalendarReschedule(
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
        location: resolveEventLocation({
          locationType: service.locationType,
          customerAddressRequired: service.customerAddressRequired,
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
    await this.syncCalendarCancel(ctx, bookingId).catch(() => undefined);

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
