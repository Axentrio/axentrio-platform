/**
 * Business-timezone clock: 12-hour with AM/PM, or 24-hour.
 *
 * Shared by the API (slot chips, confirmation copy, emails) and the portal
 * (opening-hours pickers, bookings page). Portal already imports this directory
 * as `@contracts`. The hour-cycle rule is a product contract: the same timezone
 * must not show 14:30 in one surface and 2:30 PM in another.
 *
 * 12-hour countries: United States, Canada, Australia, New Zealand,
 * Philippines, India, Pakistan, Bangladesh, Malaysia.
 * UK and Ireland are mixed in the wild; this product treats all of Europe
 * (including Europe/London and Europe/Dublin) as 24-hour.
 * Every other timezone, and a missing/invalid zone, is 24-hour. The live
 * product is Belgium-only (Europe/Brussels).
 */

const HOUR12_PREFIXES = [
  'Australia/',
  'America/Indiana/',
  'America/Kentucky/',
  'America/North_Dakota/',
] as const;

/** Canonical IANA names after `Intl` resolves aliases such as `US/Eastern`. */
const HOUR12_ZONES = new Set<string>([
  // United States
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'America/Adak',
  'America/Phoenix',
  'America/Boise',
  'America/Detroit',
  'America/Menominee',
  'America/Juneau',
  'America/Sitka',
  'America/Yakutat',
  'America/Nome',
  'America/Metlakatla',
  'Pacific/Honolulu',
  // Canada
  'America/Toronto',
  'America/Vancouver',
  'America/Edmonton',
  'America/Winnipeg',
  'America/Halifax',
  'America/St_Johns',
  'America/Regina',
  'America/Whitehorse',
  'America/Yellowknife',
  'America/Iqaluit',
  'America/Rankin_Inlet',
  'America/Cambridge_Bay',
  'America/Dawson',
  'America/Glace_Bay',
  'America/Goose_Bay',
  'America/Moncton',
  'America/Pangnirtung',
  'America/Resolute',
  'America/Swift_Current',
  'America/Thunder_Bay',
  'America/Atikokan',
  'America/Blanc-Sablon',
  'America/Creston',
  'America/Dawson_Creek',
  'America/Fort_Nelson',
  'America/Inuvik',
  'America/Coral_Harbour',
  // New Zealand
  'Pacific/Auckland',
  'Pacific/Chatham',
  // Philippines, India, Pakistan, Bangladesh, Malaysia
  'Asia/Manila',
  'Asia/Kolkata',
  'Asia/Calcutta',
  'Asia/Karachi',
  'Asia/Dhaka',
  'Asia/Kuala_Lumpur',
  'Asia/Kuching',
]);

/** Resolve aliases (`US/Eastern` → `America/New_York`). Invalid zones → null. */
function canonicalTimeZone(timezone: string | null | undefined): string | null {
  if (!timezone) return null;
  const trimmed = timezone.trim();
  if (!trimmed) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** True when this IANA timezone displays a 12-hour clock with AM/PM. */
export function usesHour12(timezone: string | null | undefined): boolean {
  const canonical = canonicalTimeZone(timezone);
  if (!canonical) return false;
  if (HOUR12_PREFIXES.some((prefix) => canonical.startsWith(prefix))) return true;
  return HOUR12_ZONES.has(canonical);
}

/** Luxon wall-clock token: `h:mm a` or `HH:mm`. */
export function luxonTimeFormat(timezone: string | null | undefined): 'h:mm a' | 'HH:mm' {
  return usesHour12(timezone) ? 'h:mm a' : 'HH:mm';
}

/** Luxon slot-chip title: `Tue 9:00 AM` or `Tue 09:00`. */
export function luxonChipTitleFormat(timezone: string | null | undefined): 'ccc h:mm a' | 'ccc HH:mm' {
  return usesHour12(timezone) ? 'ccc h:mm a' : 'ccc HH:mm';
}

/** Luxon confirmation string the model must quote verbatim. */
export function luxonBookingDisplayFormat(timezone: string | null | undefined): string {
  return usesHour12(timezone)
    ? "cccc, d LLLL yyyy 'at' h:mm a"
    : "cccc, d LLLL yyyy 'at' HH:mm";
}

/** Luxon email/public-page "when" line, without the trailing zone name. */
export function luxonEmailWhenFormat(timezone: string | null | undefined): string {
  return usesHour12(timezone) ? 'cccc d LLLL yyyy, h:mm a' : 'cccc d LLLL yyyy, HH:mm';
}

/** `Intl` time options for a business timezone. Caller still passes `timeZone`. */
export function intlClockTimeOptions(timezone: string): Intl.DateTimeFormatOptions {
  const hour12 = usesHour12(timezone);
  return {
    timeZone: timezone,
    hour: hour12 ? 'numeric' : '2-digit',
    minute: '2-digit',
    hour12,
  };
}

/** One wall-clock string for an instant in the business timezone. */
export function formatClockTime(isoOrDate: string | Date, timezone: string): string {
  const date = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  return new Intl.DateTimeFormat('en-GB', intlClockTimeOptions(timezone)).format(date);
}

/** 12-hour label for stored `24:00`. The value stays `24:00`, never `00:00`. */
export const END_OF_DAY_HOUR12_LABEL = '12:00 AM (end of day)';

/** Picker label for a stored `HH:mm` value. Storage stays 24-hour either way. */
export function clockSelectLabel(hhmm: string, timezone: string | null | undefined): string {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm)) return hhmm;
  const [hourStr, minute] = hhmm.split(':');
  const hour = Number(hourStr);
  if (hour === 24 && minute === '00') {
    return usesHour12(timezone) ? END_OF_DAY_HOUR12_LABEL : '24:00';
  }
  if (!usesHour12(timezone)) return hhmm;
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return hhmm;
  const suffix = hour < 12 ? 'AM' : 'PM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${minute} ${suffix}`;
}

/** Stored `HH:mm` range for prompt/placeholder copy. Storage stays 24-hour. */
export function formatClockRange(
  start: string,
  end: string,
  timezone: string | null | undefined,
): string {
  return `${clockSelectLabel(start, timezone)}–${clockSelectLabel(end, timezone)}`;
}
