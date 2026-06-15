import { z } from 'zod';

const hhmm = z.string().regex(/^([01]?\d|2[0-4]):[0-5]\d$/, 'Expected HH:MM');

// Exported so P4 presets can build strict variants over the SAME runtime pieces.
export const weekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export const timeWindow = z.object({ start: hhmm, end: hhmm });

const weeklyHours = z.record(weekday, z.array(timeWindow));

export const dateOverride = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
  closed: z.boolean().optional(),
  windows: z.array(timeWindow).optional(),
});

export const eventTypeInputSchema = z.object({
  name: z.string().min(1).max(255),
  durationMin: z.number().int().min(5).max(1440),
  bufferBeforeMin: z.number().int().min(0).max(480).default(0),
  bufferAfterMin: z.number().int().min(0).max(480).default(0),
  minNoticeMin: z.number().int().min(0).max(43200).default(0),
  maxHorizonDays: z.number().int().min(1).max(365).default(60),
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

/** P3: optional per-service intake questions (max 8). `[]` clears; omitted leaves unchanged. */
export const intakeQuestionsSchema = z.array(intakeQuestionSchema).max(8);

/** Full service (ServiceType) input for the multi-service CRUD (K3). */
export const serviceInputSchema = z.object({
  name: z.string().min(1).max(255),
  category: z.string().max(255).optional(),
  description: z.string().max(2000).optional(),
  bookingMode: z.enum(['auto', 'request']).default('auto'),
  onlineBookable: z.boolean().default(true),
  durationMode: z.enum(['fixed', 'range', 'ai']).default('fixed'),
  durationMin: z.number().int().min(5).max(1440),
  minDurationMin: z.number().int().min(5).max(1440).optional(),
  maxDurationMin: z.number().int().min(5).max(1440).optional(),
  bufferBeforeMin: z.number().int().min(0).max(480).default(0),
  bufferAfterMin: z.number().int().min(0).max(480).default(0),
  minNoticeMin: z.number().int().min(0).max(43200).default(0),
  maxHorizonDays: z.number().int().min(1).max(365).default(60),
  maxBookingsPerDay: z.number().int().min(1).max(100).optional(),
  priceDisplayType: z.enum(['none', 'fixed', 'from', 'range', 'on_request']).default('none'),
  fixedPrice: z.number().nonnegative().max(1_000_000).optional(),
  minPrice: z.number().nonnegative().max(1_000_000).optional(),
  maxPrice: z.number().nonnegative().max(1_000_000).optional(),
  priceNote: z.string().max(255).optional(),
  customerLocationRequired: z.boolean().default(false),
  customerAddressRequired: z.boolean().default(false),
  fileUploadAllowed: z.boolean().default(false),
  preparationInstructions: z.string().max(2000).optional(),
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
  s: { durationMode?: string; minDurationMin?: number; maxDurationMin?: number },
  ctx: z.RefinementCtx
) => {
  if (s.durationMode !== 'range' && s.durationMode !== 'ai') return;
  if (s.minDurationMin == null || s.maxDurationMin == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['minDurationMin'], message: 'range/ai duration needs minDurationMin and maxDurationMin' });
  } else if (s.minDurationMin > s.maxDurationMin) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['minDurationMin'], message: 'minDurationMin must be ≤ maxDurationMin' });
  }
};

/** Create payload (full object) with the duration cross-field check. */
export const serviceCreateSchema = serviceInputSchema.superRefine(durationRangeRefine);

/** Partial for PUT — any subset of fields, with the same duration check. */
export const serviceUpdateSchema = serviceInputSchema.partial().superRefine(durationRangeRefine);

export const availabilityInputSchema = z.object({
  timezone: z.string().min(1).max(64),
  // 'always_open' → bookable 24/7 (weekly hours ignored); 'business_hours' → gated by weeklyHours.
  availabilityMode: z.enum(['always_open', 'business_hours']).default('business_hours'),
  weeklyHours: weeklyHours.default({}),
  dateOverrides: z.array(dateOverride).default([]),
  slotGranularityMin: z.number().int().min(5).max(240).default(30),
});

export const updateSchedulerSchema = z
  .object({
    provider: z.enum(['calcom', 'internal']).optional(),
    eventType: eventTypeInputSchema.optional(),
    availability: availabilityInputSchema.optional(),
  })
  .refine((d) => d.provider || d.eventType || d.availability, {
    message: 'At least one of provider, eventType, availability is required',
  });

export type UpdateSchedulerInput = z.infer<typeof updateSchedulerSchema>;

// --- Admin bookings management (portal) ---

export const listBookingsQuerySchema = z.object({
  scope: z.enum(['upcoming', 'past', 'requests']).default('upcoming'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const availabilityQuerySchema = z.object({
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  // Reschedule picker passes the booking's service + frozen length so the right
  // service is resolved (no SERVICE_REQUIRED with multiple active services).
  serviceId: z.string().uuid().optional(),
  durationMin: z.coerce.number().int().positive().optional(),
});

export const cancelBookingBodySchema = z.object({
  reason: z.string().max(500).optional(),
});

export const rescheduleBookingBodySchema = z.object({
  newStartTime: z.string().datetime(),
});
