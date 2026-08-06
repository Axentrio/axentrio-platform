/**
 * Booking module — the first Module (.scratch/plan-entitlements-modules.md,
 * D15). Feature-gated on `bookings`: active for every entitled tenant with
 * zero tenant_modules rows; per-tenant overrides and the free/non-active deny
 * apply automatically via the entitlement resolver.
 *
 * Owns booking's agent-runtime contribution end to end:
 *   - the 6 booking tools
 *   - the bookable-services prompt section (moved out of PromptBuilder),
 *     including loading the service catalog for the bot
 */
import { DateTime } from 'luxon';
import { AppDataSource } from '../database/data-source';
import { ServiceType, type IntakeQuestion } from '../database/entities/ServiceType';
import {
  AvailabilityRule,
  effectiveEndDate,
  isRangedOverride,
  type Weekday,
  type TimeWindow,
} from '../database/entities/AvailabilityRule';
import {
  CheckAvailabilityTool,
  CreateBookingTool,
  RequestAppointmentTool,
  ListBookingsTool,
  RescheduleBookingTool,
  CancelBookingTool,
} from '../agent/tools/booking.tool';
import { BookingSettings } from '../database/entities/BookingSettings';
import { describeServiceArea, type ServiceAreaEntry } from '../contracts/service-area';
import { formatVenueLine } from '../contracts/venue-address';
import type { ModuleDefinition, ModulePromptContext } from './module-catalog';

/** Human price hint for the service catalog (prices are populated in a later slice). */
/** One-line hygiene for owner text in the prompt: collapse whitespace → drop `·`/`"` → trim. */
function sanitizeForLine(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[·"]/g, '').trim();
}

/**
 * The price as the bot should say it — INCLUDING the owner's qualifier.
 *
 * `priceNote` is where an owner writes "per hour", "per person", "excl. VAT", "per m²".
 * It was stored, it was editable, and it reached nothing: a service configured as fixed €80
 * with the note "per hour" was quoted by the bot as a flat "€80". That is not a cosmetic
 * omission — it is the assistant misquoting the price to a customer, on the business's
 * behalf, in a way that reads as a firm commitment.
 *
 * Appended ONLY when a price is actually shown. A dangling "per hour" under a service whose
 * owner chose to display no price at all would be worse than silence.
 */
function priceHint(s: ServiceType): string {
  const base = ((): string => {
    switch (s.priceDisplayType) {
      case 'fixed':
        return s.fixedPrice ? `€${s.fixedPrice}` : '';
      case 'from':
        return s.fixedPrice ? `from €${s.fixedPrice}` : '';
      case 'range':
        return s.minPrice && s.maxPrice ? `€${s.minPrice}–€${s.maxPrice}` : '';
      case 'on_request':
        return 'price on request';
      default:
        return '';
    }
  })();
  if (!base) return '';
  const note = s.priceNote?.trim() ? sanitizeForLine(s.priceNote).slice(0, 60) : '';
  return note ? `${base} ${note}` : base;
}

/** Indented `Intake questions:` sub-block for a service, in array order (≤8 short lines). */
function intakeLines(s: ServiceType): string {
  const questions = Array.isArray(s.intakeQuestions) ? s.intakeQuestions : [];
  const lines = questions
    // Defensive: skip malformed entries (legacy/hand-edited jsonb) so a non-string
    // id/label/option can never reach `.replace()` and crash prompt construction.
    .filter(
      (q): q is IntakeQuestion =>
        !!q && typeof q.id === 'string' && typeof q.label === 'string' && (q.type === 'text' || q.type === 'choice')
    )
    // A PAUSED question is not asked. It keeps its id and its stored answers, so anything
    // already collected still renders under its label — which is the entire reason an owner
    // pauses one instead of deleting it.
    .filter((q) => q.active !== false)
    .map((q) => {
      const label = sanitizeForLine(q.label);
      const req = q.required ? 'required' : 'optional';
      const validOptions =
        q.type === 'choice' && Array.isArray(q.options)
          ? q.options.filter((o): o is string => typeof o === 'string')
          : [];
      const opts = validOptions.length ? ` · options: ${validOptions.map(sanitizeForLine).join(', ')}` : '';
      // The owner's own steer and example. Capped again here even though the schema caps
      // them: this line is rebuilt into the system prompt on every turn, and a legacy or
      // hand-edited row never passed through that schema.
      const steer = q.aiInstruction?.trim()
        ? ` · how to ask: ${sanitizeForLine(q.aiInstruction).slice(0, 200)}`
        : '';
      const eg = q.exampleAnswer?.trim()
        ? ` · e.g. ${sanitizeForLine(q.exampleAnswer).slice(0, 120)}`
        : '';
      return `    - ${q.id} · "${label}" · ${q.type} · ${req}${opts}${steer}${eg}`;
    });
  if (!lines.length) return '';
  return `\n  Intake questions:\n${lines.join('\n')}`;
}

const WEEKDAY_ORDER: { key: Weekday; label: string }[] = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
];

const fmtWindows = (wins: TimeWindow[]): string =>
  wins.map((w) => `${w.start}–${w.end}`).join(', ');

/**
 * The OPENING HOURS prompt block, so the bot answers "when are you open?" from
 * the configured hours instead of guessing or relying on the knowledge base.
 * Returns null when there's nothing reliable to state (business-hours mode with
 * no days enabled) — the bot then falls back to kb_search for hours. These hours
 * tell the bot WHEN the business is open; they never block it from helping or
 * capturing an out-of-hours request (see the fallback rule in SERVICES).
 */
/** Bounded so a business with a year of holidays can't crowd out the rest of the prompt. */
const MAX_OVERRIDE_LINES = 8;

/**
 * Upcoming date overrides — holiday closures and one-off hours — as prompt lines.
 *
 * The slot engine has always honoured these (a closure wins in EVERY mode, including
 * always-open), but they never reached the prompt. So a customer asking "are you open on
 * 25 December?" got a confident yes read off the weekly grid, contradicting the closure the
 * engine was about to enforce. Past dates are dropped; the list is capped and says when it
 * has been cut, because a silent truncation reads as "that's all of them".
 */
function upcomingOverrideLines(rule: AvailabilityRule, now: Date): string[] {
  const overrides = Array.isArray(rule.dateOverrides) ? rule.dateOverrides : [];
  const today = DateTime.fromJSDate(now).setZone(rule.timezone || 'UTC').toFormat('yyyy-MM-dd');
  const upcoming = overrides
    // A RANGE stays relevant until its last day: a fortnight's closure that started
    // yesterday must still be stated, or the bot books the remaining thirteen days.
    .filter((o) => {
      if (!o || typeof o.date !== 'string') return false;
      const end = effectiveEndDate(o) ?? o.date;
      return end >= today;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!upcoming.length) return [];

  const fmtDay = (iso: string): string => {
    const d = DateTime.fromISO(iso, { zone: rule.timezone || 'UTC' });
    return d.isValid ? d.toFormat('cccc d LLLL') : iso;
  };

  const lines = upcoming.slice(0, MAX_OVERRIDE_LINES).map((o) => {
    const end = isRangedOverride(o) ? effectiveEndDate(o) : null;
    // One line for the whole span. Enumerating a fortnight day by day would consume the
    // entire line budget and push every later closure out of the prompt — which is exactly
    // how a long holiday used to go unmentioned from its ninth day onwards.
    const when = end
      ? `${o.date} to ${end} (${fmtDay(o.date)} — ${fmtDay(end)}, inclusive)`
      : `${o.date} (${fmtDay(o.date)})`;
    const windows = Array.isArray(o.windows) ? o.windows : [];
    if (o.closed || !windows.length) return `- ${when}: CLOSED`;
    return `- ${when}: open ${fmtWindows(windows)} only`;
  });
  if (upcoming.length > MAX_OVERRIDE_LINES) {
    lines.push(`- …and ${upcoming.length - MAX_OVERRIDE_LINES} more later in the year — check before promising a date beyond these.`);
  }
  return lines;
}

export function buildHoursSection(rule: AvailabilityRule | null, now: Date = new Date()): string | null {
  if (!rule) return null;
  const overrides = upcomingOverrideLines(rule, now);
  const exceptions = overrides.length
    ? `\nThese specific dates OVERRIDE the hours above — they win even for a 24/7 business. Never tell a customer you are open on one of these closed dates:\n${overrides.join('\n')}`
    : '';

  if (rule.availabilityMode === 'always_open') {
    return `\n## OPENING HOURS\nThis business takes bookings 24/7 — there are no fixed opening hours. If a customer asks when you are open, tell them you're available around the clock.${exceptions}`;
  }
  const lines = WEEKDAY_ORDER.flatMap(({ key, label }) => {
    const wins = rule.weeklyHours?.[key];
    return wins && wins.length ? [`- ${label}: ${fmtWindows(wins)}`] : [];
  });
  // Nothing reliable to state at all — no weekly hours AND no exceptions.
  if (!lines.length && !exceptions) return null;
  const weekly = lines.length
    ? `The business is open at these times (${rule.timezone}). State these when the customer asks about opening hours; days not listed are closed.\n${lines.join('\n')}`
    : `No weekly opening hours are configured (${rule.timezone}).`;
  return `\n## OPENING HOURS\n${weekly}${exceptions}`;
}

/**
 * Concise, customer-facing service list for the `{services}` placeholder — names,
 * duration and price only. Deliberately omits internal ids, booking modes and
 * intake rules: those belong in the SERVICES block the agent reads, not in a line
 * a template author drops into prose. Pure. Empty list → ''.
 */
export function formatServicesForPlaceholder(services: ServiceType[]): string {
  return services
    .map((s) => {
      const price = priceHint(s);
      const isRange =
        (s.durationMode === 'range' || s.durationMode === 'ai') &&
        typeof s.minDurationMin === 'number' &&
        typeof s.maxDurationMin === 'number' &&
        s.minDurationMin > 0 &&
        s.maxDurationMin >= s.minDurationMin;
      const duration = isRange ? `${s.minDurationMin}-${s.maxDurationMin} min` : `${s.durationMin} min`;
      return `${s.name} (${duration}${price ? `, ${price}` : ''})`;
    })
    .join(', ');
}

/**
 * Concise opening hours for the `{openingHours}` placeholder, e.g.
 * "Mon 09:00-17:00, Tue 09:00-17:00". Pure. No rule / no windows → ''.
 *
 * CLOSURES ARE PART OF THE ANSWER. This rendered the weekly grid alone, while the booking
 * module's own OPENING HOURS block has stated upcoming date overrides since they were added
 * — so a template using this placeholder, or any bot without a bookable catalog (where the
 * block is suppressed entirely), would tell a customer the business is open on a day the
 * owner had marked closed. A closure the owner took the trouble to enter is the single most
 * important thing this string can carry.
 *
 * Kept SHORT deliberately: this is an inline value inside somebody's prose, not a section.
 * Only closures are summarised — a date with one-off hours still resolves correctly at
 * booking time, and spelling every variation out here would swamp the sentence it sits in.
 */
export function formatHoursForPlaceholder(rule: AvailabilityRule | null, now: Date = new Date()): string {
  if (!rule) return '';
  const base =
    rule.availabilityMode === 'always_open'
      ? 'open 24/7'
      : WEEKDAY_ORDER.flatMap(({ key, label }) => {
          const wins = rule.weeklyHours?.[key];
          return wins && wins.length ? [`${label} ${fmtWindows(wins)}`] : [];
        }).join(', ');

  const today = DateTime.fromJSDate(now).setZone(rule.timezone || 'UTC').toFormat('yyyy-MM-dd');
  const closures = (Array.isArray(rule.dateOverrides) ? rule.dateOverrides : [])
    .filter((o) => {
      if (!o || typeof o.date !== 'string' || !o.closed) return false;
      // A RANGE stays relevant until its LAST day — a fortnight's closure that began
      // yesterday still has thirteen days to go.
      const end = effectiveEndDate(o) ?? o.date;
      return end >= today;
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 3)
    .map((o) => {
      const end = isRangedOverride(o) ? effectiveEndDate(o) : null;
      return end ? `${o.date} to ${end}` : o.date;
    });

  if (!closures.length) return base;
  const closed = `closed ${closures.join(', ')}`;
  return base ? `${base} · ${closed}` : closed;
}

/**
 * WHERE the business is, for the bot to say out loud.
 *
 * The venue was shipped as an invite-only field: it reaches the calendar event and the
 * confirmation email, and nothing else. So an owner would fill in their address, and the
 * assistant — asked "where are you based?" — answered that no location was specified. From
 * the owner's side the setting simply appeared not to work.
 *
 * Distinct from the SERVICE AREA block, and both can be present: the area is where the
 * business will TRAVEL TO, this is where customers COME TO. A business can have one, the
 * other, or both.
 */
export function buildVenueSection(venue: {
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
} | null | undefined,
/**
 * True when at least one bookable service is carried out at the CUSTOMER's address. The block
 * used to be built from the four venue columns alone, so it told the bot to give this address
 * for "where an appointment will take place" — including for travel jobs, whose invite says
 * the opposite. A business with real premises AND one mobile service hits that with no
 * misconfiguration at all; it just fills in the venue exactly as the field asks.
 */
hasTravelServices = false): string | null {
  const line = formatVenueLine(venue);
  if (!line) return null;
  const whereToSay = hasTravelServices
    ? `Give this address when a customer asks where you are or how to find you. Do NOT assume
their appointment happens here: some services are carried out at the customer's own address,
and each service says which it is. If it is one of those, the appointment is where they are.`
    : `Give this address when a customer asks where you are, how to find you, or where an
appointment will take place.`;
  return `\n## OUR ADDRESS
Customers come to us at: ${sanitizeForLine(line)}.
${whereToSay} Do not invent directions, parking or opening arrangements
that are not stated elsewhere.`;
}

/**
 * How to get a locatable address, and what to do when one still cannot be placed.
 *
 * ONE COPY, because two different gates now throw the same code and neither owns the
 * wording. The service area throws it when the Belgian municipality table cannot match the
 * text; travel time throws it when Google cannot place the door. To the model these are one
 * situation with one right answer, and two wordings of one rule is how the two wordings
 * drift apart. The recovery sentence is kept verbatim from the version the service-area
 * block shipped with, which is the version that was tested against real conversations.
 *
 * Only ever emitted once per prompt: `buildServiceAreaSection` carries it when an area is
 * drawn, and `buildCustomerAddressSection` covers the case where nothing else would.
 */
export const ADDRESS_LOCATABILITY_COACHING = `When you need the customer's address for a job, ask for one that can actually be located: a postcode or a town name as well as the street. A street and house number alone are not enough.
If create_booking returns ADDRESS_NOT_PLACEABLE, the address was simply too vague to locate — this is NOT a refusal. Ask for the postcode or town, then retry create_booking ONCE with the fuller address. Only if it fails again should you capture the job with request_appointment.`;

/**
 * The CUSTOMER ADDRESS block, for a business with travel time on and no service area drawn.
 *
 * Null in every other case, and the second condition is the point of the function rather
 * than an optimisation: the coaching already sits inside the SERVICE AREA block, so a
 * business with both would be told the same thing twice in one prompt. This closes the hole
 * where an Agent could throw ADDRESS_NOT_PLACEABLE with nothing anywhere in its prompt
 * telling it what that means, which is how a recoverable error becomes a dead end.
 */
export function buildCustomerAddressSection(input: {
  travelTimeEnabled: boolean;
  hasServiceArea: boolean;
}): string | null {
  if (!input.travelTimeEnabled || input.hasServiceArea) return null;
  return `\n## CUSTOMER ADDRESS
${ADDRESS_LOCATABILITY_COACHING}`;
}

/**
 * The SERVICE AREA prompt block — where this business works.
 *
 * The tool-error rule alone is not enough, and an earlier draft proved it: telling the bot
 * only that "somewhere not listed is not covered" meant a customer who ASKED ("do you come
 * to Bruges?") got a polite no and left. The conversation ended before any tool ran, so the
 * capture path — the whole point — was unreachable in exactly the exchange it was written
 * for. Capturing the lead is therefore stated as the primary behaviour, and the tool error
 * is just the second route to the same place.
 *
 * Null when no area is configured, so a bot without one gains no prompt text at all.
 */
export function buildServiceAreaSection(entries: ServiceAreaEntry[]): string | null {
  const area = describeServiceArea(Array.isArray(entries) ? entries : []);
  if (!area) return null;
  return `\n## SERVICE AREA
This business serves: ${sanitizeForLine(area)}.
Answer questions about where you work from that list, and never widen it.
If a customer is somewhere else, do NOT just turn them away and do NOT promise them a visit. Tell them it is outside the usual area, then still take their details and capture the job with request_appointment, saying plainly that it is a request the business owner will review and come back on. Ending the conversation at "no" is the one outcome to avoid — whether a job further out is worth doing is the owner's decision, not yours.
${ADDRESS_LOCATABILITY_COACHING}
If create_booking returns OUT_OF_SERVICE_AREA, do NOT retry it: capture the job with request_appointment exactly as above, and never present it as a confirmed appointment.`;
}

/** The SERVICES (bookable) prompt section for a service catalog. Exported for tests. */
export function buildServicesSection(services: ServiceType[], businessCapacity = false): string | null {
  if (!services.length) return null;
  const lines = services
    .map((s) => {
      const price = priceHint(s);
      const mode = s.bookingMode === 'request' ? 'request-only' : 'auto-book';
      // P5a: customerLocationRequired maps to PHONE (callback number), not address.
      const contact = [
        s.customerAddressRequired ? 'needs address' : '',
        s.customerLocationRequired ? 'needs phone' : '',
        s.fileUploadAllowed ? 'accepts files' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      // P5c: show the duration RANGE for range/ai services (the agent passes durationMin).
      const isRange =
        (s.durationMode === 'range' || s.durationMode === 'ai') &&
        typeof s.minDurationMin === 'number' &&
        typeof s.maxDurationMin === 'number' &&
        s.minDurationMin > 0 &&
        s.maxDurationMin >= s.minDurationMin;
      const durationLabel = isRange
        ? `${s.minDurationMin}-${s.maxDurationMin} min (${s.durationMode === 'ai' ? 'AI-estimated' : 'choose length'})`
        : `${s.durationMin} min`;
      const head = `- ${s.id} · ${s.name}${s.category ? ` (${s.category})` : ''} · ${durationLabel} · ${mode}${price ? ` · ${price}` : ''}${contact ? ` · ${contact}` : ''}`;
      // The owner's own description of the service — the single most useful field a
      // client fills that the bot otherwise never sees. Sanitised + capped so a long
      // description can't bloat the prompt or break the line-oriented catalog.
      const desc = s.description?.trim() ? `\n  ${sanitizeForLine(s.description).slice(0, 200)}` : '';
      return `${head}${desc}${intakeLines(s)}`;
    })
    .join('\n');
  // Only inject the ask-intake rule when a service actually renders questions
  // (a service whose questions are all malformed produces no lines → no dangling rule).
  const hasIntake = services.some((s) => intakeLines(s) !== '');
  const hasContact = services.some((s) => s.customerAddressRequired || s.customerLocationRequired);
  // Business-level ceilings raise CAPACITY_REACHED too, so the recovery rule has to be
  // emitted for them as well — keyed on per-service caps alone, a bot with only a business
  // cap got the error with no instruction and would tell the customer it was fully booked.
  const hasCapacity =
    businessCapacity || services.some((s) => typeof s.maxBookingsPerDay === 'number' && s.maxBookingsPerDay > 0);
  const hasDuration = services.some((s) => s.durationMode === 'range' || s.durationMode === 'ai');
  const hasOnRequestPrice = services.some((s) => s.priceDisplayType === 'on_request');
  const hasFileUpload = services.some((s) => s.fileUploadAllowed);
  return `\n## SERVICES (bookable)
When the customer wants to book, identify which service they mean and pass its id as serviceId (use the SAME service whose availability you checked). Before you call create_booking or request_appointment, collect the following — and never invent any of it:
- NAME: if it's already known from their profile (see above), confirm it rather than asking from scratch; otherwise ask for it.
- DATE/TIME: their chosen available time for an auto-book, or their preferred date/time for a request. Pass exactly what they gave you and confirm that same time back — never state a time you didn't capture.
- EMAIL (optional): ask once so we can send a calendar invite, but if they have none or decline, proceed without it — don't insist, re-ask, or block the booking on it.
- SUMMARY (optional, never asked for): if the conversation told you something the business owner would want to know before this appointment — what the customer actually needs, a constraint, an urgency, something they mentioned in passing — pass it as aiSummary, one plain line written for the owner. It goes on their calendar entry and the customer never sees it. Do NOT invent one, and skip it entirely when nothing was said beyond the booking itself.
RESULT: a booking tool may answer with "requested": true. That means it was NOT confirmed — it was captured as a request for the business owner to review, which happens when the service is request-only, when the calendar cannot be reached, or when a variable-length job's length was never established. Say so plainly: it is a request the owner will come back on. Never describe such a result as booked or confirmed, and never read a time back as confirmed from one.
CRITICAL: the moment you tell the customer you are booking or requesting their appointment (or that you'll "go ahead" / "proceed now"), you MUST call create_booking or request_appointment in that SAME reply. Never say it's done, or that you'll do it now, without actually calling the tool — announcing a booking you didn't record leaves the customer thinking they're booked when nothing exists. If you still need a required detail, ask for it instead of announcing.
TIME: when a booking or reschedule tool returns success, state the appointment time using the result's booking.displayTime field EXACTLY as given — never re-compute, convert, or reformat the time from startTime (it is UTC and WILL drift to the wrong local time).
Then follow these rules IN ORDER:
1. If their request matches NO service in the catalog below, tell them you don't offer that and briefly say what you DO offer — do not ask them to specify a service you don't have. If the request is ambiguous between two or more services you DO offer, ask a disambiguating question first. Either way, do not confirm or capture a booking until you know which listed service they mean. Never guess.
2. Once the service is known: use create_booking (auto-confirm) ONLY for an "auto-book" service when the customer has chosen an available time you checked.
3. Otherwise use request_appointment (and tell the customer it is a request the business owner will review — not a confirmation): when the service is "request-only", the scope/duration is unclear, the job sounds complex/urgent/risky, or you are otherwise not confident you can safely confirm. Never invent a confirmation. For a request-only service, do NOT call check_availability or present specific bookable time slots — instead ask the customer for their preferred date/time in their own words and pass it as preferredTime. Availability checks and tappable slots are only for auto-book services.${
    hasIntake
      ? `
4. If the chosen service lists "Intake questions", ask any required question the customer hasn't already answered before calling the booking tool (you may ask optional ones too, but never block the booking on them). If they've already described the answer in their own words, treat that as the answer — do NOT pose the question again or echo it back to them. Pass every answer you have in the tool's intakeAnswers object, keyed by the question id shown before each question. If a booking tool returns INTAKE_REQUIRED, ask the customer for the missing answer(s) and re-call the tool, re-including the answers you already collected.`
      : ''
  }${
    hasContact
      ? `
5. If the chosen service is flagged "needs address" and/or "needs phone", ask for it before booking or capturing the request, and pass it as customerAddress / customerPhone. If a booking tool returns ADDRESS_REQUIRED or PHONE_REQUIRED, ask for the missing detail and re-call the tool with it.`
      : ''
  }${
    hasCapacity
      ? `
6. If create_booking returns CAPACITY_REACHED, that time cannot be taken — the day is full, the business has no working time left that day, or the slot sits too close to another appointment. Read the message, offer a different time or the next available day, and do NOT retry the same one. Never tell the customer the business is closed.`
      : ''
  }${
    hasDuration
      ? `
7. For a service shown with a duration RANGE (e.g. "30-90 min"), establish the length FIRST — ask the customer how long they need ("choose length"), or estimate it from what they have described ("AI-estimated") — then pass that as durationMin to check_availability AND the booking tool (same value). Never call create_booking for one of these without a durationMin: an unestablished length is captured as a REQUEST for the owner to scope, not confirmed at the shortest option, because guessing short books the wrong appointment rather than a cautious one. If you genuinely cannot tell, say so and capture it with request_appointment. If a tool returns DURATION_OUT_OF_RANGE, pick a length within the shown range. If create_booking returns SLOT_UNAVAILABLE for a range service, the chosen length didn't fit that start — offer a different start or a shorter length within range; don't retry the same start+length.`
      : ''
  }
- Availability: if check_availability returns no available times, or the customer wants a time outside the opening hours, do NOT tell them you are closed or fully booked, and do NOT hand off to the team. Instead capture their preferred date/time with request_appointment, and make clear it is a REQUEST the business will confirm — never imply it is a booked, confirmed appointment. This is the correct path for out-of-hours, after-hours, and emergency requests. The opening hours guide which times you can auto-confirm; they never stop you from helping or capturing a request.
- Calendar errors: if check_availability FAILS with a temporary or technical error (e.g. BOOKING_TEMPORARILY_UNAVAILABLE — the calendar could not be reached), this is NOT the same as having no free times. Do NOT tell the customer there are no slots or that you are fully booked — that would be untrue. Briefly say you're having trouble checking live availability right now, then capture their preferred date/time with request_appointment as a request the business will confirm shortly. Never present a captured request as a confirmed booking.
- No connected calendar: if check_availability or create_booking returns CALENDAR_NOT_CONNECTED, this business has not connected a calendar yet, so you CANNOT auto-confirm. Do NOT offer specific time slots — ask the customer for their preferred date/time and capture it with request_appointment as a request the business will confirm. Never tell the customer it is booked or confirmed.
- Price: if asked, you may state the price shown on a service line (e.g. "€25", "from €80"); NEVER invent or guess a number. A service whose price is not shown has no fixed price to quote.${
    hasOnRequestPrice
      ? ' For a service priced "on request", do not quote a number — capture the job via request_appointment so the owner can quote.'
      : ''
  }${
    hasFileUpload
      ? `
- Files: once you have identified a service flagged "accepts files", you may invite the customer to attach a relevant file (e.g. a photo of the room). Pass the uploaded file ids in fileSessionIds when booking/requesting. Do not invite a file before the service is resolved, or for a service that doesn't accept files. If a booking tool returns FILE_UPLOAD_NOT_ALLOWED, FILE_NOT_READY, or TOO_MANY_FILES, tell the customer plainly and proceed without the attachment if needed.`
      : ''
  }
${lines}`;
}

export const bookingModule: ModuleDefinition = {
  id: 'booking',
  displayName: 'Bookings',
  description: 'Lets the bot check availability and book, reschedule, or cancel appointments for the customer.',
  readinessHint: 'Ready once the bot has at least one online-bookable service and business hours set.',
  defaultProse: 'Help the customer book, reschedule, or cancel an appointment. Understand which service they need, offer the soonest suitable time, and confirm the service, date, and time back to them before booking.',
  provides: ['check_availability', 'create_booking', 'request_appointment', 'reschedule_booking', 'cancel_booking'],
  gate: { kind: 'feature', feature: 'bookings' },
  tools: [
    new CheckAvailabilityTool(),
    new CreateBookingTool(),
    new RequestAppointmentTool(),
    new ListBookingsTool(),
    new RescheduleBookingTool(),
    new CancelBookingTool(),
  ],
  async buildPromptSection(ctx: ModulePromptContext): Promise<string | null> {
    const [services, rule, bookingSettings] = await Promise.all([
      AppDataSource.getRepository(ServiceType).find({
        // `onlineBookable` too, NOT just `isActive` — this is the only consumer that used
        // to omit it. `resolveService` requires both, so an offline service was advertised
        // to the bot, offered to the customer, and then thrown out as SERVICE_NOT_FOUND at
        // book time: the catalog the model reads has to be the catalog it can actually book.
        where: { botId: ctx.botId, isActive: true, onlineBookable: true },
        // createdAt breaks the tie. Without it every service a business has ever created
        // shares sortOrder 0, so the order the bot lists them in is whatever Postgres
        // returns — arbitrary, and free to differ between runs. The portal's own query has
        // always had this tiebreak, so the owner saw one order and the customer heard another.
        order: { sortOrder: 'ASC', createdAt: 'ASC' },
      }),
      AppDataSource.getRepository(AvailabilityRule).findOne({ where: { botId: ctx.botId } }),
      AppDataSource.getRepository(BookingSettings).findOne({ where: { botId: ctx.botId } }),
    ]);
    const areaSection = buildServiceAreaSection(
      Array.isArray(bookingSettings?.serviceArea) ? bookingSettings.serviceArea : [],
    );
    const venueSection = buildVenueSection(
      {
        street: bookingSettings?.venueStreet,
        postalCode: bookingSettings?.venuePostalCode,
        city: bookingSettings?.venueCity,
        country: bookingSettings?.venueCountry,
      },
      services.some((s) => s.customerAddressRequired),
    );
    const businessCapacity = !!(
      bookingSettings?.maxBookingsPerDay ||
      bookingSettings?.maxBookedMinutesPerDay ||
      bookingSettings?.minGapMin
    );
    const servicesSection = buildServicesSection(services, businessCapacity);
    // Only reachable when travel time is on and no area is drawn, so it is null for every
    // Agent on the platform today. It carries no business data — just how to recover from
    // ADDRESS_NOT_PLACEABLE, which the travel gate can now throw where the area gate never did.
    const customerAddressSection = buildCustomerAddressSection({
      travelTimeEnabled: bookingSettings?.travelTimeEnabled === true,
      hasServiceArea: !!areaSection,
    });
    // No bookable catalog → the services and hours blocks stay suppressed exactly as
    // before, but a configured service area is still worth stating on its own.
    // An address is worth stating even for a bot with no bookable catalog — "where are you?"
    // is not a booking question.
    if (!servicesSection) return [venueSection, areaSection].filter(Boolean).join('') || null;
    const hoursSection = buildHoursSection(rule);
    return [servicesSection, hoursSection, venueSection, areaSection, customerAddressSection]
      .filter(Boolean)
      .join('');
  },
};
