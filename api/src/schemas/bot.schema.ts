import { z } from 'zod';
import { dateOverride } from './scheduler.schema';

export const createBotSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Operational, tenant-owned business hours (drives off-hours handling). Optional
// per-bot config; absent/empty schedule = always "in hours".
export const businessHoursSchema = z.object({
  enabled: z.boolean(),
  schedule: z
    .array(
      z.object({
        // Full lowercase weekday name — must match Intl `weekday: 'long'` output
        // (e.g. "monday"), which is how the off-hours check matches the day.
        day: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']),
        open: z.string().regex(TIME_RE, 'open must be HH:MM'),
        close: z.string().regex(TIME_RE, 'close must be HH:MM'),
        closed: z.boolean(),
      }),
    )
    .max(7),
  // Same Date Override shape the booking Availability Rule already stores:
  // a named closure, or different hours, on a specific date (or inclusive range).
  dateOverrides: z.array(dateOverride).optional(),
});

export const updateBotSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    /**
     * The name the bot introduces itself by — `settings.ai.brandVoice.name`,
     * which feeds "You are <name>" and every template's {botName}. Distinct from
     * `name` above: that one is operator-facing (the bots list), this one is what
     * customers hear. A bot legitimately called "test account" internally still
     * needs to greet people as "Luc".
     *
     * Patched here rather than through PUT /ai-settings because that endpoint
     * full-replaces the ai slice — a rename dialog sending only a name would
     * silently drop tone, guardrails and channel overrides.
     */
    assistantName: z.string().min(1).max(255).optional(),
    status: z.enum(['active', 'paused']).optional(),
    businessHours: businessHoursSchema.optional(),
    quotedAddress: z
      .object({
        enabled: z.boolean(),
        street: z.string().trim().max(255).nullable().optional(),
        streetNumber: z.string().trim().max(16).nullable().optional(),
        boxNumber: z.string().trim().max(16).nullable().optional(),
        postalCode: z.string().trim().max(16).nullable().optional(),
        city: z.string().trim().max(120).nullable().optional(),
        country: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{2}$/, 'Use a 2-letter country code')
          .nullable()
          .optional(),
      })
      .optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.assistantName !== undefined ||
      v.status !== undefined ||
      v.businessHours !== undefined ||
      v.quotedAddress !== undefined,
    { message: 'Provide at least one of: name, assistantName, status, businessHours, quotedAddress' },
  );
