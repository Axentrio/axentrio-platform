import { z } from 'zod';
import { dateOverride } from './scheduler.schema';
import { ORIGIN_PATTERN_RE } from '../security/widget-origin';

export const createBotSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A weekly window must run forward inside one calendar day. An `close` at or before
 * `open` is impossible, and the off-hours reader (`isOutsideBusinessHours`) treats such
 * a row as a window that never opens, so a saved 18:00→09:00 silently closes the day.
 *
 * OVERNIGHT HOURS (18:00→02:00) ARE NOT LEGAL HERE. One row holds one pair of clock
 * times with no day-crossing marker, and the reader compares both bounds inside the same
 * local day. Making them legal needs an explicit representation (a spill-over flag or a
 * second row) in the reader, the slot engine and the hours placeholder — a larger change.
 * Until then a window that wraps midnight is refused, like any other inverted window.
 *
 * A day marked `closed` keeps its stored clock text (see `availabilityToBusinessHours`),
 * so its times are irrelevant and must never block a save.
 */
export function findInvertedHoursWindow(
  schedule: ReadonlyArray<{ day: string; open: string; close: string; closed: boolean }>,
): { index: number; message: string } | null {
  const index = schedule.findIndex((d) => !d.closed && d.close <= d.open);
  if (index < 0) return null;
  const d = schedule[index]!;
  return {
    index,
    message: `${d.day}: close (${d.close}) must be after open (${d.open})`,
  };
}

// Operational, tenant-owned business hours (drives off-hours handling). Optional
// per-bot config; absent/empty schedule = always "in hours".
export const businessHoursSchema = z
  .object({
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
  })
  .superRefine((v, ctx) => {
    const bad = findInvertedHoursWindow(v.schedule);
    if (bad) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schedule', bad.index, 'close'],
        message: bad.message,
      });
    }
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
    allowedOrigins: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(ORIGIN_PATTERN_RE, 'Use a hostname like example.com or *.example.com'),
      )
      .max(50)
      .optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.assistantName !== undefined ||
      v.status !== undefined ||
      v.businessHours !== undefined ||
      v.quotedAddress !== undefined ||
      v.allowedOrigins !== undefined,
    {
      message:
        'Provide at least one of: name, assistantName, status, businessHours, quotedAddress, allowedOrigins',
    },
  );
