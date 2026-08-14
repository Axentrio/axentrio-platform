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

/**
 * Is the business currently OUTSIDE its configured hours?
 *
 * The single source of truth for "closed right now", used by BOTH the off-hours
 * gate and the `## AVAILABILITY` prompt fact, so the two can never disagree. It
 * reproduces the gate's original math: the local day + time in the business
 * timezone versus the day's schedule.
 *
 * `timezone` is EXPLICIT and required: callers pass the bot's canonical
 * `businessTimezone` (server-owned, geography-derived). The legacy
 * `bh.timezone` is deliberately ignored — it was written from the
 * configurator's browser clock, which is exactly the authority this predicate
 * must not consult.
 *
 * Returns FALSE — treat as OPEN, never announce "closed" — whenever hours are
 * disabled, the schedule is empty, the timezone is missing/invalid (Intl
 * throws), or a day's open/close is malformed. Failing safe toward engaging
 * the customer is always better than a wrong "we are closed".
 */
export function isOutsideBusinessHours(
  bh: BusinessHours | null | undefined,
  timezone: string,
  now: Date = new Date(),
): boolean {
  if (!bh?.enabled || !Array.isArray(bh.schedule) || bh.schedule.length === 0) return false;
  if (!timezone) return false; // no trustworthy timezone → treat as open
  try {
    const tz = timezone;
    const dayName = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now).toLowerCase();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = parts.find((p) => p.type === 'hour')?.value;
    const minute = parts.find((p) => p.type === 'minute')?.value;
    if (!hour || !minute) return false;
    const timeStr = `${hour}:${minute}`;
    const daySchedule = bh.schedule.find(
      (s) => s && typeof s.day === 'string' && s.day.toLowerCase() === dayName,
    );
    if (!daySchedule || daySchedule.closed) return true; // no entry for today, or explicitly closed
    if (typeof daySchedule.open !== 'string' || typeof daySchedule.close !== 'string') return false; // malformed → open
    return timeStr < daySchedule.open || timeStr >= daySchedule.close;
  } catch {
    return false; // invalid timezone or any unexpected shape → treat as open
  }
}
