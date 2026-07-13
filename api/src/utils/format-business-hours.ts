/**
 * Renders `Bot.settings.businessHours` for the `{openingHours}` placeholder.
 *
 * Until now businessHours only drove the pre-AI off-hours gate — it never reached
 * the prompt — so a bot WITHOUT the booking skill had no idea when the business was
 * open. `{openingHours}` prefers the booking AvailabilityRule when one exists (the
 * authoritative source for a booking bot) and falls back to this. Keeping ONE
 * placeholder fed by one source per bot means the two can never contradict.
 *
 * Pure. Disabled / empty / all-closed → '' (fail-closed, never a literal {key}).
 */

export interface BusinessHoursDay {
  day: string;
  open: string;
  close: string;
  closed: boolean;
}

export interface BusinessHours {
  enabled: boolean;
  timezone?: string;
  schedule: BusinessHoursDay[];
}

const DAY_LABEL: Record<string, string> = {
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
  sunday: 'Sun',
};

/** e.g. "Mon 09:00–17:00, Wed 10:00–14:00". Matches the booking hours formatting. */
export function formatBusinessHoursForPlaceholder(bh?: BusinessHours | null): string {
  if (!bh?.enabled || !Array.isArray(bh.schedule)) return '';
  return bh.schedule
    .filter((d) => d && !d.closed && typeof d.open === 'string' && typeof d.close === 'string' && d.open && d.close)
    .map((d) => {
      const key = typeof d.day === 'string' ? d.day.toLowerCase() : '';
      return `${DAY_LABEL[key] ?? d.day} ${d.open}–${d.close}`;
    })
    .join(', ');
}
