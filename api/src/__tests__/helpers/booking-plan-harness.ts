/**
 * Fixtures for the Axentrio AI Booking System automated functional test plan (v1.0).
 *
 * Why this exists: the plan's cases assert STATE, not prose — "one confirmed Booking row whose
 * start equals the time the customer agreed to", "the calendar mirror and the confirmation email
 * agree with that row". The existing suite is strong at tool-level guards (it mocks
 * `booking/booking.service`, see `integration/address-question-once.test.ts`) and at prompt text
 * (`unit/booking-prompt-behaviour.test.ts`), but nothing seeded a full bookable business — bot,
 * Availability Rule, Service and BookingSettings — and then read back the Booking row plus its
 * mirror. This module is that missing layer.
 *
 * Vocabulary note, because the plan and the code disagree and mixing them silently produces
 * fixtures that never book: the plan's "Agent" is the code's `Bot` (`chatbot_bots`). The `Agent`
 * ENTITY is a human handoff operator and is not involved in any booking case. Bot-level booking
 * configuration does NOT live in `Bot.settings` — capacity ceilings, business defaults, the pause
 * switch, the venue address, travel and confirmation extras all live in the separate
 * `chatbot_booking_settings` table, one row per bot.
 *
 * Time: the plan fixes Europe/Brussels. `Bot.businessTimezone` is the authoritative zone
 * (`AvailabilityRule.timezone` is a denormalized legacy copy), so `createPlanBusiness` sets both
 * and every helper below speaks local wall clock, matching how the plan is written.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW TO USE — fixtures are PER TEST, never `beforeAll`.
 *
 * `src/__tests__/setup.ts` TRUNCATEs every table that holds rows in an `afterEach`. A fixture
 * created in `beforeAll` is therefore gone by the time the second test runs, and the test fails
 * with "could not find any entity" — or, worse, passes for the wrong reason because an empty
 * diary makes a delta-of-zero assertion true. Seed inside each `it`, or in a `beforeEach`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import crypto from 'crypto';
import { DateTime } from 'luxon';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { Bot, type BotSettings } from '../../database/entities/Bot';
import { ServiceType, type IntakeQuestion } from '../../database/entities/ServiceType';
import { AvailabilityRule, type WeeklyHours } from '../../database/entities/AvailabilityRule';
import { BookingSettings } from '../../database/entities/BookingSettings';
import { Booking } from '../../database/entities/Booking';
import { CalendarCredential } from '../../database/entities/CalendarCredential';
import { EmailDelivery } from '../../database/entities/EmailDelivery';
import { ChatSession } from '../../database/entities/ChatSession';
import type { BookingContext } from '../../booking/booking-providers/types';
import type { ToolContext } from '../../agent/tool-adapter';
import type { ChatMessage } from '../../llm/llm.types';
import type {
  BusyInterval,
  CalendarEventInput,
  CalendarEventPatch,
  CalendarEventResult,
  CreateEventOpts,
} from '../../scheduler/calendar-provider';
import { createTestTenant, createTestAnchorBot } from './factories';

// ── Fixtures named by the plan (§3 Common fixtures) ──────────────────────────

export const PLAN_TZ = 'Europe/Brussels';
/** §3 Business address. Stored split, because that is how `chatbot_booking_settings` holds it. */
export const BUSINESS_ADDRESS = {
  venueStreet: 'Koningin Astridplein 27',
  venuePostalCode: '2018',
  venueCity: 'Antwerpen',
  venueCountry: 'BE',
} as const;
export const BUSINESS_ADDRESS_LINE = 'Koningin Astridplein 27, 2018 Antwerpen, BE';
/** §3 Customer address A. */
export const CUSTOMER_ADDRESS_A = 'Passtraat 248B, 9100 Sint-Niklaas, BE';
/** §3 Controlled customer email. */
export const PLAN_CUSTOMER_EMAIL = 'achraflamranim@gmail.com';

/** §3 Default availability: Mon–Fri 09:00–17:00, 30-minute grid. */
export const PLAN_WEEKLY_HOURS: WeeklyHours = {
  mon: [{ start: '09:00', end: '17:00' }],
  tue: [{ start: '09:00', end: '17:00' }],
  wed: [{ start: '09:00', end: '17:00' }],
  thu: [{ start: '09:00', end: '17:00' }],
  fri: [{ start: '09:00', end: '17:00' }],
};
export const PLAN_SLOT_GRANULARITY_MIN = 30;

// ── Local wall-clock helpers ─────────────────────────────────────────────────
// The plan is written in local time ("2026-09-14 at 10:00"). Assertions must convert in exactly
// one place, or BK-06's timezone-drift regression gets tested by accident in whichever helper
// forgot to.

/** A local wall clock ("2026-09-14T10:00") to the UTC instant it denotes in Europe/Brussels. */
export function localInstant(localIso: string, zone: string = PLAN_TZ): Date {
  const dt = DateTime.fromISO(localIso, { zone });
  if (!dt.isValid) throw new Error(`not a local wall clock: ${localIso} (${dt.invalidReason})`);
  return dt.toUTC().toJSDate();
}

/** The `HH:mm` a stored instant reads as in the business zone — what the customer was told. */
export function localHHMM(instant: Date | string, zone: string = PLAN_TZ): string {
  return DateTime.fromJSDate(new Date(instant), { zone: 'utc' }).setZone(zone).toFormat('HH:mm');
}

/** The `yyyy-MM-dd` a stored instant falls on in the business zone. */
export function localDateOnly(instant: Date | string, zone: string = PLAN_TZ): string {
  return DateTime.fromJSDate(new Date(instant), { zone: 'utc' }).setZone(zone).toFormat('yyyy-MM-dd');
}

/** The business-local weekday key the Availability Rule uses ('mon'…'sun'). */
export function localWeekday(instant: Date | string, zone: string = PLAN_TZ): keyof WeeklyHours {
  return DateTime.fromJSDate(new Date(instant), { zone: 'utc' })
    .setZone(zone)
    .toFormat('ccc')
    .toLowerCase() as keyof WeeklyHours;
}

/**
 * A future business-local date that is comfortably past any minimum notice, so a case about
 * hours/boundaries is never silently decided by the notice rule instead. `daysAhead` is a lower
 * bound: the returned date is pushed to the next weekday inside Mon–Fri when it would land on a
 * weekend.
 */
export function planDate(daysAhead: number, opts: { weekdayOnly?: boolean } = {}): string {
  let dt = DateTime.now().setZone(PLAN_TZ).plus({ days: daysAhead }).startOf('day');
  if (opts.weekdayOnly !== false) {
    while (dt.weekday > 5) dt = dt.plus({ days: 1 });
  }
  return dt.toFormat('yyyy-MM-dd');
}

/** `planDate(...)` at a local clock time, as a local wall clock string. */
export function planLocalTime(daysAhead: number, hhmm: string, opts?: { weekdayOnly?: boolean }): string {
  return `${planDate(daysAhead, opts)}T${hhmm}`;
}

// ── The bookable business ────────────────────────────────────────────────────

export interface PlanBusiness {
  tenant: Tenant;
  bot: Bot;
}

/**
 * A Tenant with one anchor Bot, configured the way the plan's §3 describes: Brussels, no
 * unconfigured-booking gate, AI answers enabled. Deliberately creates NO Service and NO
 * Availability Rule — each case states its own, and a case that forgot to would otherwise pass
 * against fixtures it never asked for.
 */
export async function createPlanBusiness(
  opts: { bookingSettings?: Partial<BookingSettings>; botSettings?: Partial<BotSettings> } = {},
): Promise<PlanBusiness> {
  const tenant = await createTestTenant({ tier: 'pro' });
  const bot = await createTestAnchorBot(tenant, {
    businessTimezone: PLAN_TZ,
    settings: {
      ai: {
        enabled: true,
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'sk-test',
        language: 'en',
        brandVoice: { name: 'TestBot', tone: 'friendly' },
        guardrails: {
          topicsToAvoid: [],
          escalationKeywords: [],
          confidenceThreshold: 0.5,
          maxResponseLength: 800,
          greetingMessage: 'Hi',
          fallbackMessage: 'Let me connect you with our team.',
          offHoursMessage: 'Closed.',
        },
      },
      ...(opts.botSettings ?? {}),
    } as BotSettings,
  });

  if (opts.bookingSettings) {
    await setPlanBookingSettings(bot, opts.bookingSettings);
  }
  return { tenant, bot };
}

/** §3 default availability: Mon–Fri 09:00–17:00 on a 30-minute grid. */
export async function setPlanAvailability(
  bot: Bot,
  overrides: Partial<AvailabilityRule> = {},
): Promise<AvailabilityRule> {
  const repo = AppDataSource.getRepository(AvailabilityRule);
  return repo.save(
    repo.create({
      tenantId: bot.tenantId,
      botId: bot.id,
      timezone: PLAN_TZ,
      availabilityMode: 'business_hours',
      weeklyHours: PLAN_WEEKLY_HOURS,
      slotGranularityMin: PLAN_SLOT_GRANULARITY_MIN,
      dateOverrides: [],
      ...overrides,
    }),
  );
}

/**
 * Upsert the bot's booking settings row. `chatbot_booking_settings` is unique per bot, so cases
 * that tune ceilings or travel twice in one file must not trip the index.
 *
 * Note `null` vs `0` means what the code means: on the three capacity CEILINGS (`maxBookingsPerDay`,
 * `maxBookedMinutesPerDay`, `minGapMin`) `null`/`0` is UNLIMITED, never "no bookings"; on the
 * Business DEFAULTS (`defaultBuffer*`, `defaultMinNoticeMin`, `defaultMaxHorizonDays`) a number is
 * a real answer that a Service with `null` inherits.
 */
export async function setPlanBookingSettings(
  bot: Bot,
  overrides: Partial<BookingSettings> = {},
): Promise<BookingSettings> {
  const repo = AppDataSource.getRepository(BookingSettings);
  const existing = await repo.findOne({ where: { botId: bot.id } });
  const row = existing ?? repo.create({ tenantId: bot.tenantId, botId: bot.id });
  Object.assign(row, overrides);
  return repo.save(row);
}

export interface PlanServiceOverrides extends Partial<ServiceType> {
  /** Convenience: one required text intake question, as BK-04 / SRV-11 need. */
  requiredIntakeQuestion?: string;
  /** Convenience: question flags for the intake question built above. */
  intakeQuestion?: Partial<IntakeQuestion>;
}

/**
 * A Service. Defaults are the plan's §3 "default test service": Auto-book, fixed 30 minutes, no
 * price, active and online-bookable — chosen so a case only states what it is actually about.
 */
export async function createPlanService(
  bot: Bot,
  overrides: PlanServiceOverrides = {},
): Promise<ServiceType> {
  const { requiredIntakeQuestion, intakeQuestion, ...rest } = overrides;
  const repo = AppDataSource.getRepository(ServiceType);

  let intakeQuestions: IntakeQuestion[] | undefined;
  if (requiredIntakeQuestion !== undefined || intakeQuestion) {
    intakeQuestions = [
      {
        id: crypto.randomUUID(),
        label: requiredIntakeQuestion ?? 'Where is the problem?',
        type: 'text',
        required: true,
        ...(intakeQuestion ?? {}),
      },
    ];
  }

  return repo.save(
    repo.create({
      tenantId: bot.tenantId,
      botId: bot.id,
      name: 'Booking test',
      slug: `svc-${crypto.randomBytes(4).toString('hex')}`,
      bookingMode: 'auto',
      durationMode: 'fixed',
      durationMin: 30,
      priceDisplayType: 'none',
      locationType: 'custom',
      isActive: true,
      onlineBookable: true,
      ...(intakeQuestions ? { intakeQuestions } : {}),
      ...rest,
    }),
  );
}

// ── Reading back what actually happened ──────────────────────────────────────

export const bookingRepo = () => AppDataSource.getRepository(Booking);

/** Every Booking row (any status) for a Service — the plan's "booking record" assertions. */
export async function bookingsForService(serviceId: string): Promise<Booking[]> {
  return bookingRepo().find({ where: { eventTypeId: serviceId }, order: { createdAt: 'ASC' } });
}

/**
 * The plan repeatedly asserts deltas ("booking_count delta = 0 before confirmation, 1 after").
 * Counting is nicer than comparing raw arrays because it reads the same in a one-booking case.
 */
export async function bookingCount(
  serviceId: string,
  status?: Booking['status'] | Booking['status'][],
): Promise<number> {
  const rows = await bookingsForService(serviceId);
  if (status === undefined) return rows.length;
  const wanted = Array.isArray(status) ? status : [status];
  return rows.filter((r) => wanted.includes(r.status)).length;
}

/**
 * Requests are `request_created` rows. The plan's honesty rule is that customer-facing text may
 * claim a request was captured ONLY when such a row exists — so nearly every case asserts this
 * count one way or the other, and having one helper keeps those assertions comparable.
 */
export async function requestCount(serviceId: string): Promise<number> {
  return bookingCount(serviceId, 'request_created');
}

/** The single confirmed Booking for a Service, failing loudly when there is not exactly one. */
export async function soleConfirmedBooking(serviceId: string): Promise<Booking> {
  const rows = (await bookingsForService(serviceId)).filter((r) => r.status === 'confirmed');
  if (rows.length !== 1) {
    throw new Error(`expected exactly 1 confirmed booking for ${serviceId}, found ${rows.length}`);
  }
  return rows[0];
}

/**
 * The half-open span a Booking occupies, as local `HH:mm` on its own local date. BK-06 exists
 * because a +1/+2 hour drift was seen once, so tests compare local clock strings rather than raw
 * instants that a timezone bug could leave looking consistent.
 */
export function localSpan(booking: Booking): { date: string; start: string; end: string; minutes: number } {
  const start = new Date(booking.startUtc);
  const end = new Date(booking.endUtc);
  return {
    date: localDateOnly(start),
    start: localHHMM(start),
    end: localHHMM(end),
    minutes: Math.round((end.getTime() - start.getTime()) / 60_000),
  };
}

/**
 * A Busy Bookings seed, written the way the engine writes them (raw SQL, because `blocked_range`
 * is a `tstzrange` guarded by an exclusion constraint, and the constraint is the point). Used to
 * occupy a diary the way a real confirmed appointment would — the plan's capacity, minimum-gap and
 * conflict cases all need busy time that participates in those rules exactly as production time
 * does.
 */
export async function seedConfirmedBooking(input: {
  bot: Bot;
  serviceId?: string | null;
  sessionId?: string | null;
  startLocal: string;
  durationMin?: number;
  customerName?: string;
}): Promise<Booking> {
  const start = localInstant(input.startLocal);
  const duration = input.durationMin ?? 30;
  const end = new Date(start.getTime() + duration * 60_000);
  const id = crypto.randomUUID();
  const range = `[${start.toISOString()},${end.toISOString()})`;

  await AppDataSource.query(
    `INSERT INTO chatbot_bookings
       (id, tenant_id, bot_id, provider, status, start_utc, end_utc, calendar_key, blocked_range,
        ics_uid, attendee_name, attendee_email, event_type_id, session_id, booked_duration_min,
        created_at, updated_at)
     VALUES ($1, $2, $3, 'internal', 'confirmed', $4, $5, $6, $7::tstzrange,
             $8, $9, $10, $11, $12, $13, now(), now())`,
    [
      id,
      input.bot.tenantId,
      input.bot.id,
      start,
      end,
      `bot:${input.bot.id}`,
      range,
      `uid-${id}`,
      input.customerName ?? 'QA Seed',
      `${input.customerName ?? 'seed'}@example.test`,
      input.serviceId ?? null,
      input.sessionId ?? null,
      duration,
    ],
  );
  return bookingRepo().findOneOrFail({ where: { id } });
}

// ── The connected calendar, as an in-memory double ───────────────────────────
//
// The plan asserts the CALENDAR MIRROR, not Google: "calendar.location = business address",
// "a conference/meeting URL exists", "the answer is not on the invite". None of that is a Google
// API question — it is what Axentrio told the provider — so the CalendarProvider port is doubled
// and its calls are recorded. That also keeps every case offline and deterministic, and it is the
// same port `calendar-sync.ts` actually writes through, so a case cannot pass against a fake the
// production path does not use.
//
// `busy` is the other half: the plan's busy-time cases (CAL-01…05, AVL-14) need external events
// that availability treats as authoritative. Seeding them here rather than as Axentrio Bookings is
// the point of those cases — busy must be busy regardless of who created it.

export interface CalendarCreateRecord {
  botId: string;
  input: CalendarEventInput;
  opts: CreateEventOpts;
  result: CalendarEventResult;
}
export interface CalendarDeleteRecord {
  botId: string;
  eventId: string;
}

export interface PlanCalendarDouble {
  /** External busy intervals `getBusy` reports. Dates, because that is the port's shape. */
  busy: BusyInterval[];
  /** When `getBusy` should throw, to model a dead/unavailable calendar (CAL-06). */
  busyError: Error | null;
  creates: CalendarCreateRecord[];
  updates: Array<{ botId: string; eventId: string; patch: CalendarEventPatch }>;
  deletes: CalendarDeleteRecord[];
  /** Booking mirrors that still exist, keyed by event id — the "was it removed" question. */
  live: Map<string, CalendarEventInput>;
  meetUrl: string | null;
  reset(): void;
  adapter: import('../../scheduler/calendar-provider').CalendarProvider;
}

let calendarEventSeq = 0;

function makePlanCalendarDouble(): PlanCalendarDouble {
  const double: PlanCalendarDouble = {
    busy: [],
    busyError: null,
    creates: [],
    updates: [],
    deletes: [],
    live: new Map(),
    meetUrl: 'https://meet.google.com/qa-plan-fixture',
    reset() {
      double.busy = [];
      double.busyError = null;
      double.creates = [];
      double.updates = [];
      double.deletes = [];
      double.live.clear();
      double.meetUrl = 'https://meet.google.com/qa-plan-fixture';
      calendarEventSeq = 0;
    },
    adapter: null as never,
  };

  // Typed as the REAL port (not cast) so the double cannot silently drift from the interface
  // `calendar-sync.ts` writes through: if a method changes shape, this file stops compiling.
  const adapter: import('../../scheduler/calendar-provider').CalendarProvider = {
    providerType: 'google',
    async getBusy() {
      if (double.busyError) throw double.busyError;
      return double.busy;
    },
    async createEvent(botId: string, input: CalendarEventInput, opts: CreateEventOpts = {}) {
      const eventId = opts.eventId ?? `qaevent-${++calendarEventSeq}`;
      const result: CalendarEventResult = {
        eventId,
        // Conferencing is a Google-side decision, so the double honours the flag the caller
        // sets: a case asserting "no link on a phone booking" must fail if Axentrio asked for
        // one, which it only can if the double answers faithfully.
        meetUrl: input.conferencing ? double.meetUrl : null,
        calendarId: opts.calendarId ?? 'primary',
      };
      double.creates.push({ botId, input, opts, result });
      double.live.set(eventId, input);
      return result;
    },
    async updateEvent(botId: string, eventId: string, patch: CalendarEventPatch) {
      double.updates.push({ botId, eventId, patch });
      const existing = double.live.get(eventId);
      if (existing) double.live.set(eventId, { ...existing, ...patch });
      return { status: 'ok', meetUrl: patch.conferencing ? double.meetUrl : null };
    },
    async deleteEvent(botId: string, eventId: string) {
      double.deletes.push({ botId, eventId });
      double.live.delete(eventId);
      return 'ok';
    },
    async resolveIdentity(botId: string) {
      return `qacal:${botId}`;
    },
    async getEvent(_botId: string, eventId: string) {
      const found = double.live.get(eventId);
      if (!found) return { kind: 'not_found' };
      return { kind: 'found', startISO: found.startISO, endISO: found.endISO, cancelled: false };
    },
    async listChanges() {
      return { eventIds: [], cursor: 'qa-cursor', bootstrapped: true };
    },
  };
  double.adapter = adapter;

  return double;
}

/**
 * The single calendar double for this test file. Reset it in `beforeEach` — a double is module
 * state, so it outlives the DB truncation that clears everything else.
 */
export const PLAN_CALENDAR: PlanCalendarDouble = makePlanCalendarDouble();

/**
 * The `scheduler/calendar-provider` module shape, for a test file to spread over the real one.
 *
 * Usage:
 * ```ts
 * vi.mock('../../scheduler/calendar-provider', async (importOriginal) => ({
 *   ...(await importOriginal<typeof import('../../scheduler/calendar-provider')>()),
 *   ...(await import('../helpers/booking-plan-harness')).planCalendarMockModule(),
 * }));
 * ```
 * The dynamic import matters: a `vi.mock` factory is hoisted above this file's imports, so a
 * captured top-level binding would be uninitialised when the factory ran.
 */
export function planCalendarMockModule() {
  return {
    resolveCalendarProvider: async () => PLAN_CALENDAR.adapter,
    providerFor: () => PLAN_CALENDAR.adapter,
    hasHealthyCalendarConnection: async () => PLAN_CALENDAR.busyError === null,
    isCalendarSyncAllowed: async () => true,
    resolveStoredCalendarIdentity: async (botId: string) => ({
      identity: `qacal:${botId}`,
      providerType: 'google' as const,
    }),
  };
}

/**
 * A connected Google calendar. Without a credential the write path downgrades an Auto-book
 * Service to a Request (`CALENDAR_NOT_CONNECTED`), so every case that expects a CONFIRMED booking
 * needs this — and a case that expects a Request instead should simply omit it.
 */
export async function seedPlanCalendarCredential(bot: Bot): Promise<CalendarCredential> {
  const repo = AppDataSource.getRepository(CalendarCredential);
  return repo.save(
    repo.create({
      tenantId: bot.tenantId,
      botId: bot.id,
      provider: 'google',
      status: 'active',
      accountEmail: `owner+${bot.id.slice(0, 6)}@example.test`,
      accessTokenEnc: 'enc:test',
      refreshTokenEnc: 'enc:test',
      calendarId: 'primary',
      tokenExpiry: new Date(Date.now() + 3_600_000),
    }),
  );
}

/** An external (non-Axentrio) busy interval, as the provider port reports them. */
export function planBusy(localStart: string, minutes: number): BusyInterval {
  const start = localInstant(localStart);
  return { start, end: new Date(start.getTime() + minutes * 60_000) };
}

// ── The confirmation email, read from the durable ledger ─────────────────────
//
// Asserting on `email_deliveries` rather than a mail transport is deliberate: it is the row the
// platform commits before it ever calls Resend, so it proves the COPY the customer was promised
// without depending on a live provider — and it is where an attachment or a price would have to
// appear for the customer to actually receive it.

export async function emailDeliveriesFor(bookingId: string) {
  return AppDataSource.getRepository(EmailDelivery).find({
    where: { relatedId: bookingId, kind: 'booking_email' },
    order: { createdAt: 'ASC' },
  });
}

/** The customer-facing confirmation, found by recipient rather than by order. */
export async function customerEmailFor(bookingId: string, recipientEmail: string) {
  const rows = await emailDeliveriesFor(bookingId);
  return rows.find((r) => r.recipientEmail.toLowerCase() === recipientEmail.toLowerCase());
}

/** Everything the customer was actually sent, as one searchable string (subject + body). */
export function emailText(delivery: { subject: string; payload?: { body?: string } | null }): string {
  return `${delivery.subject}\n${delivery.payload?.body ?? ''}`;
}

// ── Driving the booking path ─────────────────────────────────────────────────
//
// Two entry points, and which one a case uses is the case's whole point:
//
//  * `planBookingContext` + `new InternalProvider()` reaches the WRITE PATH directly. Use it when
//    the question is about what the platform persists or writes to the calendar — a Request row,
//    an INSERT, a mirror call.
//  * `planToolContext` + a tool from `agent/tools/booking.tool` reaches the same path through the
//    AGENT-FACING GATE (`CONFIRMATION_REQUIRED`, preconditions, required-field refusals). Use it
//    when the question is about what the model is allowed to do, because those gates live in the
//    tool and the provider never sees them.
//
// Neither needs a real LLM: the tools and the provider are deterministic. Only an assertion about
// what the MODEL chose to say needs a model, and those belong in the live eval suite.

/** A ChatSession bound to this bot — the session every booking call resolves its context from. */
export async function planSession(bot: Bot, overrides: Partial<ChatSession> = {}): Promise<ChatSession> {
  const repo = AppDataSource.getRepository(ChatSession);
  return repo.save(
    repo.create({
      tenantId: bot.tenantId,
      botId: bot.id,
      visitorId: `visitor-${crypto.randomBytes(4).toString('hex')}`,
      status: 'active',
      source: 'widget',
      channel: 'widget',
      messageCount: 0,
      unreadCount: 0,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      ...overrides,
    }),
  );
}

/** The context `InternalProvider`'s methods take, for cases that drive the write path directly. */
export function planBookingContext(
  tenant: Tenant,
  bot: Bot,
  session: ChatSession,
  overrides: Partial<BookingContext> = {},
): BookingContext {
  return { session, tenant, bot, botSettings: bot.settings, ...overrides };
}

/**
 * A `ToolContext` for calling a booking tool directly.
 *
 * `toolsCalledThisTurn` is load-bearing rather than bookkeeping: `create_booking` declares a
 * precondition on `check_availability`, so a case that omits it is testing the precondition
 * refusal rather than the behaviour it meant to. Pass `['check_availability']` to reach the write.
 */
export function planToolContext(input: {
  bot: Bot;
  sessionId: string;
  runId: string;
  toolsCalledThisTurn?: string[];
  channel?: ToolContext['channel'];
  conversationHistory?: ChatMessage[];
  namedTimeRefused?: boolean;
}): ToolContext {
  return {
    tenantId: input.bot.tenantId,
    sessionId: input.sessionId,
    runId: input.runId,
    channel: input.channel ?? 'widget',
    toolsCalledThisTurn: input.toolsCalledThisTurn ?? [],
    dataSource: AppDataSource,
    conversationHistory: input.conversationHistory ?? [],
    ...(input.namedTimeRefused !== undefined ? { namedTimeRefused: input.namedTimeRefused } : {}),
  };
}
