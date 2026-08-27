export const MEMORY_FACT_KEYS = [
  'display_name', 'email', 'phone', 'address', 'language',
  'company', 'service_interest', 'property_type', 'vehicle',
  'preferred_contact_time', 'accessibility_need',
  'recurring_issue', 'open_request', 'past_booking_summary', 'preference_note',
] as const;
export type MemoryFactKey = (typeof MEMORY_FACT_KEYS)[number];

/** Per-key bounds and whether the stored value must appear verbatim in the cited message. */
export const MEMORY_FACT_RULES: Record<MemoryFactKey, { maxLength: number; requireVerbatim: boolean }> = {
  display_name:           { maxLength: 120, requireVerbatim: false },
  email:                  { maxLength: 320, requireVerbatim: false },
  phone:                  { maxLength: 64,  requireVerbatim: false },
  address:                { maxLength: 300, requireVerbatim: true },
  language:               { maxLength: 16,  requireVerbatim: false },
  company:                { maxLength: 200, requireVerbatim: true },
  service_interest:       { maxLength: 200, requireVerbatim: true },
  property_type:          { maxLength: 120, requireVerbatim: true },
  vehicle:                { maxLength: 160, requireVerbatim: true },
  preferred_contact_time: { maxLength: 120, requireVerbatim: true },
  accessibility_need:     { maxLength: 200, requireVerbatim: true },
  recurring_issue:        { maxLength: 300, requireVerbatim: true },
  open_request:           { maxLength: 600, requireVerbatim: true },
  past_booking_summary:   { maxLength: 400, requireVerbatim: true },
  preference_note:        { maxLength: 300, requireVerbatim: true },
};

const FACT_KEY_SET: ReadonlySet<string> = new Set(MEMORY_FACT_KEYS);

export function isMemoryFactKey(value: string): value is MemoryFactKey {
  return FACT_KEY_SET.has(value);
}
