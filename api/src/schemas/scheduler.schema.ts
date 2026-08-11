import { z } from 'zod';
import { MAX_SERVICE_AREA_ENTRIES } from '../contracts/service-area';

const hhmm = z.string().regex(/^([01]?\d|2[0-4]):[0-5]\d$/, 'Expected HH:MM');

// Exported so P4 presets can build strict variants over the SAME runtime pieces.
export const weekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export const timeWindow = z.object({ start: hhmm, end: hhmm });

const weeklyHours = z.record(weekday, z.array(timeWindow));

/** The plain object shape — presets `.extend()` this, which a refined schema forbids. */
export const dateOverrideBase = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
  /** Inclusive last day. Absent = a single day, which is every pre-existing row. */
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').nullable().optional(),
  closed: z.boolean().optional(),
  windows: z.array(timeWindow).optional(),
});

export const dateOverride = dateOverrideBase
  .refine((o) => !o.endDate || o.endDate >= o.date, {
    message: 'End date must be on or after the start date',
    path: ['endDate'],
  })
  // A closure longer than a year is a mistake, not a holiday, and an unbounded range would
  // be expanded on every prompt build.
  .refine(
    (o) => {
      if (!o.endDate) return true;
      const days = (Date.parse(`${o.endDate}T00:00:00Z`) - Date.parse(`${o.date}T00:00:00Z`)) / 86_400_000;
      return Number.isFinite(days) && days <= 366;
    },
    { message: 'A single override cannot span more than a year', path: ['endDate'] }
  );

/**
 * A place the business serves. `id` is validated for shape only — an unknown province or
 * municipality id is not rejected here, because `matchServiceArea` already treats one it
 * cannot resolve as "cannot be sure" rather than "outside", and rejecting the write would
 * break an owner's saved area the day the geo table is regenerated.
 */
export const serviceAreaEntry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('province'), id: z.string().min(1).max(16), label: z.string().min(1).max(120) }),
  z.object({ kind: z.literal('municipality'), id: z.string().min(1).max(16), label: z.string().min(1).max(120) }),
  z.object({ kind: z.literal('manual'), label: z.string().min(1).max(200) }),
]);

export const serviceAreaSchema = z.array(serviceAreaEntry).max(MAX_SERVICE_AREA_ENTRIES);

/**
 * Business-level capacity ceilings. Every field is optional AND nullable, and the two mean
 * different things on the write path: `undefined` leaves the stored value alone, `null`
 * clears it back to unlimited. No `.default()` anywhere — a default here would let a client
 * that sends the object at all silently reset rules it never mentioned.
 */
/**
 * The venue customers come TO — never the VAT/legal address, which lives in the tenant's
 * onboarding record and is off limits here. Every field is nullable and optional so the
 * whole thing can be cleared back to "no venue", which is the state every tenant starts in
 * and the only state GDPR Art. 25(2) permits as a default.
 */
export const venueAddressSchema = z.object({
  street: z.string().max(200).nullable().optional(),
  postalCode: z.string().max(200).nullable().optional(),
  city: z.string().max(200).nullable().optional(),
  // ISO 3166-1 alpha-2. Anything else is a typo, not a country.
  country: z.string().regex(/^[A-Za-z]{2}$/, 'Use a 2-letter country code').nullable().optional(),
  /**
   * Google's identity for the venue, when the owner picked it from suggestions.
   *
   * Sending it is a CLAIM that these four fields came from that place, and the controller does
   * not take the claim on trust - it re-resolves the id and writes Google's own components, so a
   * stored pairing is verified by construction rather than by validation. Omitting it means the
   * owner typed the address, which is always allowed.
   */
  placeId: z.string().max(512).nullable().optional(),
});

export const bookingRulesSchema = z.object({
  maxBookingsPerDay: z.number().int().min(1).max(100).nullable().optional(),
  maxBookedMinutesPerDay: z.number().int().min(15).max(1440).nullable().optional(),
  minGapMin: z.number().int().min(0).max(480).nullable().optional(),
  // DEFAULTS, not ceilings: applied only where a service left the field null.
  defaultBufferBeforeMin: z.number().int().min(0).max(480).nullable().optional(),
  defaultBufferAfterMin: z.number().int().min(0).max(480).nullable().optional(),
  defaultMinNoticeMin: z.number().int().min(0).max(43200).nullable().optional(),
  defaultMaxHorizonDays: z.number().int().min(1).max(365).nullable().optional(),
});

export const eventTypeInputSchema = z.object({
  name: z.string().min(1).max(255),
  durationMin: z.number().int().min(5).max(1440),
  // No .default() — null means INHERIT from the business, and a default here would make
  // "unset" unreachable, which is exactly what blocked business-level defaults before.
  bufferBeforeMin: z.number().int().min(0).max(480).nullable().optional(),
  bufferAfterMin: z.number().int().min(0).max(480).nullable().optional(),
  minNoticeMin: z.number().int().min(0).max(43200).nullable().optional(),
  maxHorizonDays: z.number().int().min(1).max(365).nullable().optional(),
  locationType: z.enum(['google_meet', 'phone', 'in_person', 'custom']).default('custom'),
});

/**
 * P3: a single intake question. `id` is accepted permissively (the controller
 * reconciliation is the real authority — any non-matching id is reminted). The
 * `preprocess` strips a stale `options` array when the type is `text` BEFORE
 * field validation, so flipping choice→text never 400s on leftover options
 * (a trailing `.transform` runs after parse and can't prevent the option rules).
 */
const intakeQuestionSchema = z.preprocess(
  (val) => {
    if (val && typeof val === 'object' && (val as { type?: unknown }).type === 'text') {
      const { options: _drop, ...rest } = val as Record<string, unknown>;
      return rest;
    }
    return val;
  },
  z
    .object({
      id: z.string().optional(),
      label: z.string().trim().min(1).max(200),
      type: z.enum(['text', 'choice']),
      required: z.boolean().default(false),
      options: z.array(z.string().trim().min(1).max(80)).optional(),
      // Capped hard: these ride into the system prompt on the question's own line, so a
      // long one costs tokens on every single turn, not just when the question is asked.
      aiInstruction: z.string().trim().max(200).optional(),
      exampleAnswer: z.string().trim().max(120).optional(),
      // Absent = true for both, which is exactly what every stored question means today.
      active: z.boolean().optional(),
      includeInCalendar: z.boolean().optional(),
    })
    .superRefine((q, ctx) => {
      if (q.type !== 'choice') return;
      const opts = q.options ?? [];
      if (opts.length < 2 || opts.length > 10) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'A choice question needs 2 to 10 options' });
      }
      // No duplicate options after trim, compared case-insensitively.
      const seen = new Set<string>();
      for (const o of opts) {
        const key = o.toLowerCase();
        if (seen.has(key)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Options must be unique' });
          break;
        }
        seen.add(key);
      }
    })
);

/**
 * Reorder the whole catalog in one write.
 *
 * The full ordered id list rather than a move-this-one-here instruction: reordering means
 * renumbering several rows, and N separate updates can half-apply and leave the catalog in
 * an order nobody chose. One list, one transaction, positions assigned from the array.
 */
export const reorderServicesSchema = z.object({
  serviceIds: z.array(z.string().uuid()).min(1).max(200),
});

/** P3: optional per-service intake questions (max 8). `[]` clears; omitted leaves unchanged. */
export const intakeQuestionsSchema = z.array(intakeQuestionSchema).max(8);

/** Full service (ServiceType) input for the multi-service CRUD (K3). */
export const serviceInputSchema = z.object({
  name: z.string().min(1).max(255),
  /**
   * NULLABLE, not merely optional — `null` is how the owner CLEARS one.
   *
   * These were optional-only, and `undefined` does not survive JSON: blanking a description
   * dropped the key, the controller's `Object.assign` left the stored value untouched, and
   * the old text kept reaching the prompt, the invite and the customer with no error
   * anywhere. Exactly the trap the duration and timing fields above were fixed for.
   */
  category: z.string().max(255).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  bookingMode: z.enum(['auto', 'request']).default('auto'),
  onlineBookable: z.boolean().default(true),
  durationMode: z.enum(['fixed', 'range', 'ai']).default('fixed'),
  durationMin: z.number().int().min(5).max(1440),
  // Nullable, not just optional: switching a service from range back to fixed must be able
  // to CLEAR the bounds. Omitting the key leaves them stored, so they silently resurrect if
  // the owner ever flips back to range — bounds they never re-entered.
  minDurationMin: z.number().int().min(5).max(1440).nullable().optional(),
  maxDurationMin: z.number().int().min(5).max(1440).nullable().optional(),
  // No .default() — null means INHERIT from the business, and a default here would make
  // "unset" unreachable, which is exactly what blocked business-level defaults before.
  bufferBeforeMin: z.number().int().min(0).max(480).nullable().optional(),
  bufferAfterMin: z.number().int().min(0).max(480).nullable().optional(),
  minNoticeMin: z.number().int().min(0).max(43200).nullable().optional(),
  maxHorizonDays: z.number().int().min(1).max(365).nullable().optional(),
  maxBookingsPerDay: z.number().int().min(1).max(100).nullable().optional(),
  priceDisplayType: z.enum(['none', 'fixed', 'from', 'range', 'on_request']).default('none'),
  fixedPrice: z.number().nonnegative().max(1_000_000).nullable().optional(),
  minPrice: z.number().nonnegative().max(1_000_000).nullable().optional(),
  maxPrice: z.number().nonnegative().max(1_000_000).nullable().optional(),
  priceNote: z.string().max(255).nullable().optional(),
  customerLocationRequired: z.boolean().default(false),
  customerAddressRequired: z.boolean().default(false),
  fileUploadAllowed: z.boolean().default(false),
  preparationInstructions: z.string().max(2000).nullable().optional(),
  locationType: z.enum(['google_meet', 'phone', 'in_person', 'custom']).default('custom'),
  sortOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
  intakeQuestions: intakeQuestionsSchema.optional(),
});

/**
 * P5c — a range/ai duration must carry a valid min ≤ max (the schema validates each
 * bound independently; this adds the cross-field + presence check). On a partial
 * update it only fires when `durationMode` is in the payload.
 */
const durationRangeRefine = (
  s: { durationMode?: string; minDurationMin?: number | null; maxDurationMin?: number | null },
  ctx: z.RefinementCtx
) => {
  const bad = (message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['minDurationMin'], message });

  if (s.durationMode === 'range' || s.durationMode === 'ai') {
    if (s.minDurationMin == null || s.maxDurationMin == null) {
      return bad('range/ai duration needs minDurationMin and maxDurationMin');
    }
    if (s.minDurationMin > s.maxDurationMin) return bad('minDurationMin must be ≤ maxDurationMin');
    return;
  }

  // durationMode absent (a partial PUT that touches only the bounds) still has to hold the
  // cross-field rule. It used to early-return here, so `PUT { minDurationMin: 300 }` on a
  // 30–120 service persisted min > max — after which hasValidRange() fails and the service
  // silently degrades to its fixed duration with nothing but a logger.warn.
  if (s.durationMode === undefined && s.minDurationMin != null && s.maxDurationMin != null) {
    if (s.minDurationMin > s.maxDurationMin) bad('minDurationMin must be ≤ maxDurationMin');
  }
};

/** Create payload (full object) with the duration cross-field check. */
export const serviceCreateSchema = serviceInputSchema.superRefine(durationRangeRefine);

/** Partial for PUT — any subset of fields, with the same duration check. */
export const serviceUpdateSchema = serviceInputSchema.partial().superRefine(durationRangeRefine);

/**
 * Environment-robust IANA check (works whether or not Intl.supportedValuesOf exists).
 * Exported so the preset seeds validate through the SAME function as owner input — they
 * used to have separate copies, and only the preset side actually checked.
 */
export function isValidTimezone(tz: string): boolean {
  if (tz === 'UTC') return true;
  const supported = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  if (typeof supported === 'function') return supported('timeZone').includes(tz);
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const availabilityInputSchema = z.object({
  // A typo here is silent and total: luxon returns an invalid DateTime and the slot engine
  // skips every window, so the owner sees zero availability with no error anywhere.
  timezone: z.string().min(1).max(64).refine(isValidTimezone, 'Not a recognised IANA timezone'),
  // 'always_open' → bookable 24/7 (weekly hours ignored); 'business_hours' → gated by weeklyHours.
  availabilityMode: z.enum(['always_open', 'business_hours']).default('business_hours'),
  weeklyHours: weeklyHours.default({}),
  dateOverrides: z.array(dateOverride).default([]),
  slotGranularityMin: z.number().int().min(5).max(240).default(30),
});

/**
 * Travel-time settings, in their own object rather than inside `bookingRules`.
 *
 * `bookingRules` has a single consistent contract — every member is an optional nullable
 * int where undefined leaves alone and null clears — and both switches here are two-state
 * booleans with a NOT NULL column behind them, which that contract has no use for. It is
 * also the reason `bookingsPaused` sits at the top level rather than in the rules.
 *
 * `venueLat`/`venueLng` are deliberately absent: they are geocoded from the venue address,
 * not typed by an owner, so there is nothing here for a client to send.
 */
export const travelSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  // Slack pads the drive, so an hour is already generous and 480 would let it swallow a
  // working day. Nullable so an owner can clear it back to "no margin".
  slackMin: z.number().int().min(0).max(120).nullable().optional(),
  startFromBase: z.boolean().optional(),
  // #91: how early the van leaves the premises, in minutes before the day's first opening.
  // Capped at four hours because past that the owner is describing a different working day
  // rather than a head start, and 0 is both the default and "the van leaves at opening".
  // NOT nullable: the column is NOT NULL and zero already expresses "no head start".
  baseDepartOffsetMin: z.number().int().min(0).max(240).optional(),
  // #82 (LP5): may grouping reorder what a customer is offered. Off unless the owner opts in.
  preferClusters: z.boolean().optional(),
  /**
   * The most extra driving one appointment may ADD before it stops being preferred.
   *
   * The reader has existed since #81 (`travel-eligibility` -> `insertion-scorer`) with nothing
   * able to write it, so every business has run on "no threshold" whether or not that suited them.
   *
   * It bounds the MARGINAL minutes a candidate adds - not the length of the drive - so a plumber
   * whose customers are all forty minutes away is not left with an empty calendar. Two hours is
   * the ceiling because beyond that an owner is describing a different business rather than a
   * detour. Nullable and zero both mean "no threshold": a value that silently marked every slot
   * unpreferred would be indistinguishable from the feature being off, and the second is
   * overwhelmingly what an owner who typed 0 meant.
   */
  maxDetourMin: z.number().int().min(0).max(120).nullable().optional(),
});

export const updateSchedulerSchema = z
  .object({
    provider: z.enum(['calcom', 'internal']).optional(),
    eventType: eventTypeInputSchema.optional(),
    availability: availabilityInputSchema.optional(),
    // Sent by the same Save as availability; an empty array is a real value (clear the area),
    // which is why presence is tested with `!== undefined` rather than truthiness.
    serviceArea: serviceAreaSchema.optional(),
    bookingRules: bookingRulesSchema.optional(),
    venueAddress: venueAddressSchema.nullable().optional(),
    // Top-level, NOT inside bookingRules: that object's contract is "optional AND nullable —
    // undefined leaves alone, null clears", which a two-state switch has no use for.
    bookingsPaused: z.boolean().optional(),
    travel: travelSettingsSchema.optional(),
  })
  .refine(
    (d) =>
      d.provider ||
      d.eventType ||
      d.availability ||
      d.serviceArea !== undefined ||
      d.bookingRules ||
      d.venueAddress !== undefined ||
      d.bookingsPaused !== undefined ||
      d.travel !== undefined,
    {
      message:
        'At least one of provider, eventType, availability, serviceArea, bookingRules, ' +
        'venueAddress, bookingsPaused or travel is required',
    }
  );

export type UpdateSchedulerInput = z.infer<typeof updateSchedulerSchema>;

// --- Admin bookings management (portal) ---

export const listBookingsQuerySchema = z.object({
  scope: z.enum(['upcoming', 'past', 'requests']).default('upcoming'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  /**
   * Narrow the list to ONE Agent. Absent means every Agent the tenant has, which is the
   * default because the owner's question is "what is in my diary" - #87 was this endpoint
   * answering it for the default Agent only, so a second Agent's appointments were invisible.
   */
  botId: z.string().uuid().optional(),
});

export const availabilityQuerySchema = z.object({
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  // Reschedule picker passes the booking's service + frozen length so the right
  // service is resolved (no SERVICE_REQUIRED with multiple active services).
  serviceId: z.string().uuid().optional(),
  durationMin: z.coerce.number().int().positive().optional(),
  /** Reschedule picker: the booking being moved, so it isn't counted against itself. */
  excludeBookingId: z.string().uuid().optional(),
  /**
   * Whose availability. Usually redundant with `excludeBookingId` - the route resolves the
   * Agent from the booking being moved, which is more reliable than trusting the caller to
   * send a matching pair - and present for the case with no booking in hand.
   */
  botId: z.string().uuid().optional(),
});

export const cancelBookingBodySchema = z.object({
  reason: z.string().max(500).optional(),
});

export const rescheduleBookingBodySchema = z.object({
  newStartTime: z.string().datetime(),
});

/** What a customer or an owner has typed so far. Bounded because a query is not a document. */
export const placesQuerySchema = z.object({
  query: z.string().min(1).max(200),
});

/** A place id from our own suggestion list. */
export const placesSelectSchema = z.object({
  placeId: z.string().min(1).max(512),
});
