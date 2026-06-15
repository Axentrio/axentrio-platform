import { z } from 'zod';

export const createBotSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Operational, tenant-owned business hours (drives off-hours handling). Optional
// per-bot config; absent/empty schedule = always "in hours".
export const businessHoursSchema = z.object({
  enabled: z.boolean(),
  timezone: z.string().min(1).max(100),
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
});

export const updateBotSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    status: z.enum(['active', 'paused']).optional(),
    businessHours: businessHoursSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.status !== undefined || v.businessHours !== undefined, {
    message: 'Provide at least one of: name, status, businessHours',
  });
