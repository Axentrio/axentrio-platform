/**
 * P4: business-type presets — a static, code-reviewed catalog of starter services
 * (+ a default weekly availability) a solo owner can apply in one go. NOT a DB table:
 * owners never author presets, so there is nothing to persist or admin.
 *
 * Validation is intentionally STRICTER than `serviceInputSchema` so a malformed static
 * preset fails CI loudly (the P4a test runs every seed through these schemas):
 *  - `.strict()` rejects unknown keys (a snake_case typo like `booking_mode` is an error,
 *    not silently stripped);
 *  - the price `superRefine` enforces the right numeric fields per `priceDisplayType`
 *    BOTH ways (required field present + irrelevant fields absent);
 *  - seeds omit `isActive`/`sortOrder`/`intakeQuestions` (catalog-state the apply path owns).
 */
import { z } from 'zod';
import { serviceInputSchema, timeWindow, dateOverrideBase, weekday, isValidTimezone } from '../schemas/scheduler.schema';

// ── Service seed schema ──────────────────────────────────────────────────────

/** A preset service seed: the serviceInputSchema shape minus catalog-state fields. */
export const presetServiceSchema = serviceInputSchema
  .omit({ isActive: true, sortOrder: true, intakeQuestions: true })
  .strict()
  .superRefine((s, ctx) => {
    const hasFixed = s.fixedPrice != null;
    const hasMin = s.minPrice != null;
    const hasMax = s.maxPrice != null;
    const err = (message: string, path: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
    switch (s.priceDisplayType) {
      case 'fixed':
      case 'from':
        if (!hasFixed) err(`${s.priceDisplayType} requires fixedPrice`, 'fixedPrice');
        if (hasMin || hasMax) err(`${s.priceDisplayType} must not set min/maxPrice`, 'minPrice');
        break;
      case 'range':
        if (!hasMin || !hasMax) err('range requires minPrice and maxPrice', 'minPrice');
        if (hasMin && hasMax && (s.minPrice as number) > (s.maxPrice as number))
          err('minPrice must be ≤ maxPrice', 'minPrice');
        if (hasFixed) err('range must not set fixedPrice', 'fixedPrice');
        break;
      case 'none':
      case 'on_request':
      case 'free':
        if (hasFixed || hasMin || hasMax) err(`${s.priceDisplayType} must not set a numeric price`, 'fixedPrice');
        break;
    }
  });

export type PresetService = z.input<typeof presetServiceSchema>;

// ── Availability seed schema (strict at every nesting level) ─────────────────

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
// Slot-engine-mirroring time rules: a start is a real bookable minute (00:00–23:59);
// `24:00` is allowed only as an end-of-day marker (never a start).
const START_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const END_RE = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

const strictTimeWindow = timeWindow.strict().superRefine((w, ctx) => {
  if (!START_RE.test(w.start)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid start time', path: ['start'] });
  if (!END_RE.test(w.end)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid end time', path: ['end'] });
  if (toMin(w.start) >= toMin(w.end))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'start must be before end', path: ['start'] });
});

const strictDateOverride = dateOverrideBase.extend({ windows: z.array(strictTimeWindow).optional() }).strict();

export const presetAvailabilitySchema = z
  .object({
    timezone: z.string().refine(isValidTimezone, 'invalid IANA timezone'),
    weeklyHours: z.record(weekday, z.array(strictTimeWindow)),
    dateOverrides: z.array(strictDateOverride),
    slotGranularityMin: z.number().int().min(5).max(240),
  })
  .strict();

export type PresetAvailability = z.input<typeof presetAvailabilitySchema>;

// ── Preset shape ─────────────────────────────────────────────────────────────

export interface BusinessPreset {
  key: string;
  label: string;
  description: string;
  services: PresetService[];
  availability?: PresetAvailability;
}

/** Mon–Fri 09:00–17:00, 30-min slots — the timezone the scheduler UI already defaults to. */
const DEFAULT_AVAILABILITY: PresetAvailability = {
  timezone: 'Europe/Brussels',
  weeklyHours: {
    mon: [{ start: '09:00', end: '17:00' }],
    tue: [{ start: '09:00', end: '17:00' }],
    wed: [{ start: '09:00', end: '17:00' }],
    thu: [{ start: '09:00', end: '17:00' }],
    fri: [{ start: '09:00', end: '17:00' }],
  },
  dateOverrides: [],
  slotGranularityMin: 30,
};

export const BUSINESS_PRESETS: BusinessPreset[] = [
  {
    key: 'barber',
    label: 'Barber',
    description: 'Haircuts and grooming, booked in person.',
    services: [
      { name: "Men's haircut", durationMin: 30, bookingMode: 'auto', locationType: 'in_person', priceDisplayType: 'fixed', fixedPrice: 25 },
      { name: 'Beard trim', durationMin: 15, bookingMode: 'auto', locationType: 'in_person', priceDisplayType: 'fixed', fixedPrice: 15 },
      { name: 'Haircut + beard', durationMin: 45, bookingMode: 'auto', locationType: 'in_person', priceDisplayType: 'fixed', fixedPrice: 35 },
    ],
    availability: DEFAULT_AVAILABILITY,
  },
  {
    key: 'cleaner',
    label: 'Cleaner',
    description: 'Home cleaning visits — quoted, so captured as requests.',
    services: [
      { name: 'Standard home clean', durationMin: 120, bookingMode: 'request', locationType: 'in_person', customerAddressRequired: true, priceDisplayType: 'from', fixedPrice: 80 },
      { name: 'Deep clean', durationMin: 240, bookingMode: 'request', locationType: 'in_person', customerAddressRequired: true, priceDisplayType: 'from', fixedPrice: 150 },
      { name: 'Move-out clean', durationMin: 180, bookingMode: 'request', locationType: 'in_person', customerAddressRequired: true, priceDisplayType: 'from', fixedPrice: 110 },
    ],
    availability: DEFAULT_AVAILABILITY,
  },
  {
    key: 'consultant',
    label: 'Consultant',
    description: 'Calls and sessions over video.',
    services: [
      { name: 'Free intro call', durationMin: 30, bookingMode: 'auto', locationType: 'google_meet', priceDisplayType: 'free' },
      { name: 'Strategy session', durationMin: 60, bookingMode: 'auto', locationType: 'google_meet', priceDisplayType: 'fixed', fixedPrice: 120 },
      { name: 'Project consultation', durationMin: 90, bookingMode: 'request', locationType: 'google_meet', priceDisplayType: 'on_request' },
    ],
    availability: DEFAULT_AVAILABILITY,
  },
  {
    key: 'tutor',
    label: 'Tutor',
    description: 'Lessons over video.',
    services: [
      { name: 'Trial lesson', durationMin: 30, bookingMode: 'auto', locationType: 'google_meet', priceDisplayType: 'fixed', fixedPrice: 20 },
      { name: '1-hour lesson', durationMin: 60, bookingMode: 'auto', locationType: 'google_meet', priceDisplayType: 'fixed', fixedPrice: 40 },
      { name: 'Exam-prep block', durationMin: 90, bookingMode: 'auto', locationType: 'google_meet', priceDisplayType: 'fixed', fixedPrice: 60 },
    ],
    availability: DEFAULT_AVAILABILITY,
  },
  {
    key: 'photographer',
    label: 'Photographer',
    description: 'Shoots are scoped and quoted, so captured as requests.',
    services: [
      { name: 'Portrait session', durationMin: 60, bookingMode: 'request', locationType: 'in_person', priceDisplayType: 'on_request' },
      { name: 'Event coverage', durationMin: 120, bookingMode: 'request', locationType: 'in_person', priceDisplayType: 'on_request' },
      { name: 'Discovery call', durationMin: 20, bookingMode: 'auto', locationType: 'google_meet', priceDisplayType: 'none' },
    ],
    availability: DEFAULT_AVAILABILITY,
  },
  {
    key: 'plumber',
    label: 'Plumber',
    description: 'Call-outs and repairs at the customer\'s address.',
    services: [
      { name: 'Unblocking', durationMin: 60, bookingMode: 'request', locationType: 'in_person', customerAddressRequired: true, priceDisplayType: 'from', fixedPrice: 90 },
      { name: 'Leak repair', durationMin: 60, bookingMode: 'request', locationType: 'in_person', customerAddressRequired: true, priceDisplayType: 'from', fixedPrice: 120 },
      { name: 'Boiler service', durationMin: 90, bookingMode: 'request', locationType: 'in_person', customerAddressRequired: true, priceDisplayType: 'from', fixedPrice: 150 },
    ],
    availability: DEFAULT_AVAILABILITY,
  },
  {
    key: 'electrician',
    label: 'Electrician',
    description: 'Installs and repairs at the customer\'s address.',
    services: [
      { name: 'Socket or switch', durationMin: 60, bookingMode: 'request', locationType: 'in_person', customerAddressRequired: true, priceDisplayType: 'from', fixedPrice: 80 },
      { name: 'Fuse board', durationMin: 120, bookingMode: 'request', locationType: 'in_person', customerAddressRequired: true, priceDisplayType: 'on_request' },
      { name: 'Electrical inspection', durationMin: 60, bookingMode: 'request', locationType: 'in_person', customerAddressRequired: true, priceDisplayType: 'from', fixedPrice: 120 },
    ],
    availability: DEFAULT_AVAILABILITY,
  },
  {
    key: 'beauty',
    label: 'Beauty salon',
    description: 'Treatments booked in the salon.',
    services: [
      { name: 'Facial', durationMin: 60, bookingMode: 'auto', locationType: 'in_person', priceDisplayType: 'fixed', fixedPrice: 55 },
      { name: 'Manicure', durationMin: 45, bookingMode: 'auto', locationType: 'in_person', priceDisplayType: 'fixed', fixedPrice: 35 },
      { name: 'Waxing', durationMin: 30, bookingMode: 'auto', locationType: 'in_person', priceDisplayType: 'fixed', fixedPrice: 25 },
    ],
    availability: DEFAULT_AVAILABILITY,
  },
  {
    key: 'garage',
    label: 'Car garage',
    description: 'Servicing and diagnostics at the workshop.',
    services: [
      { name: 'Oil change', durationMin: 45, bookingMode: 'request', locationType: 'in_person', priceDisplayType: 'from', fixedPrice: 80 },
      { name: 'Diagnostics', durationMin: 60, bookingMode: 'request', locationType: 'in_person', priceDisplayType: 'from', fixedPrice: 60 },
      { name: 'Inspection', durationMin: 45, bookingMode: 'request', locationType: 'in_person', priceDisplayType: 'from', fixedPrice: 50 },
    ],
    availability: DEFAULT_AVAILABILITY,
  },
  {
    key: 'tattoo',
    label: 'Tattoo artist',
    description: 'Consults and sessions in the studio.',
    services: [
      { name: 'Consultation', durationMin: 20, bookingMode: 'auto', locationType: 'in_person', priceDisplayType: 'none' },
      { name: 'Small tattoo', durationMin: 60, bookingMode: 'request', locationType: 'in_person', priceDisplayType: 'on_request' },
      { name: 'Touch-up', durationMin: 45, bookingMode: 'request', locationType: 'in_person', priceDisplayType: 'on_request' },
    ],
    availability: DEFAULT_AVAILABILITY,
  },
];

/** Picker list shape for `GET /scheduler/presets`. */
export function listPresetSummaries(): Array<{ key: string; label: string; description: string; serviceCount: number }> {
  return BUSINESS_PRESETS.map((p) => ({ key: p.key, label: p.label, description: p.description, serviceCount: p.services.length }));
}

export function findPreset(key: string): BusinessPreset | undefined {
  return BUSINESS_PRESETS.find((p) => p.key === key);
}
