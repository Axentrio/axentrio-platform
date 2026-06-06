import { z } from 'zod';

const hhmm = z.string().regex(/^([01]?\d|2[0-4]):[0-5]\d$/, 'Expected HH:MM');

const timeWindow = z.object({ start: hhmm, end: hhmm });

const weeklyHours = z.record(
  z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  z.array(timeWindow)
);

const dateOverride = z.object({
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

export const availabilityInputSchema = z.object({
  timezone: z.string().min(1).max(64),
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
  scope: z.enum(['upcoming', 'past']).default('upcoming'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const availabilityQuerySchema = z.object({
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
});

export const cancelBookingBodySchema = z.object({
  reason: z.string().max(500).optional(),
});

export const rescheduleBookingBodySchema = z.object({
  newStartTime: z.string().datetime(),
});
