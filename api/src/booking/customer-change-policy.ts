/**
 * Per-service customer reschedule / cancel policy.
 *
 * Distinct from `BookingMode` (`auto` | `request`), which only governs NEW bookings.
 * A Service that auto-books does not, by that fact, allow the Booking Customer to
 * move or cancel what was booked.
 *
 * `untilMin`: minutes before `startUtc` after which the action is not allowed.
 * `null`/`undefined` = no extra cutoff. `0` = until the start instant (a real
 * cutoff, not an absent one). Cutoff only tightens: it never promotes
 * `not_allowed` to `request` or `auto`.
 */
import type { CustomerChangeMode } from '../database/entities/ServiceType';

export type { CustomerChangeMode };

export const CUSTOMER_CHANGE_MODES = ['auto', 'request', 'not_allowed'] as const;

export type BookingRequestKind = 'new' | 'reschedule' | 'cancel';
export type BookingRequestResolution = 'accepted' | 'declined';

/**
 * Two-int advisory-lock classid, disjoint from `WIDGET_IDENTITY_LOCK_CLASS`
 * (0x42505234) and from every bigint `hashtext` lock in this codebase.
 * 0x43585251 = ASCII 'CXRQ'. Fits signed int4.
 */
export const CHANGE_REQUEST_LOCK_CLASS = 0x43585251;

/** Structural so this module never imports `booking.service` (cycle). */
export type CustomerChangeCaller =
  | 'agent'
  | 'internal-n8n'
  | 'scheduler-admin'
  | { kind: 'public-manage'; verifiedBookingId?: string };

export function resolveCustomerChange(
  policy: CustomerChangeMode,
  startUtc: Date,
  untilMin: number | null | undefined,
  now: Date = new Date(),
): CustomerChangeMode {
  if (policy === 'not_allowed') return 'not_allowed';
  if (untilMin == null) return policy;
  const cutoffMs = startUtc.getTime() - untilMin * 60_000;
  if (now.getTime() > cutoffMs) return 'not_allowed';
  return policy;
}

/**
 * Who the Service's customer change policy binds.
 *
 * Not `isAdmin`: the signed manage link and the owner's portal both set that
 * flag. Owner portal (`scheduler-admin`) and inbound calendar sync skip this.
 */
export function subjectToCustomerChangePolicy(caller: CustomerChangeCaller): boolean {
  if (caller === 'agent' || caller === 'internal-n8n') return true;
  return typeof caller === 'object' && caller.kind === 'public-manage';
}

export function formatChangeCutoff(untilMin: number | null | undefined): string | null {
  if (untilMin == null) return null;
  if (untilMin === 0) return 'until start';
  if (untilMin % 1440 === 0) {
    const days = untilMin / 1440;
    return `until ${days}d before`;
  }
  if (untilMin % 60 === 0) {
    const hours = untilMin / 60;
    return `until ${hours}h before`;
  }
  return `until ${untilMin}min before`;
}

export function catalogChangeClause(
  label: 'reschedule' | 'cancel',
  mode: CustomerChangeMode | null | undefined,
  untilMin: number | null | undefined,
): string {
  const resolved = mode ?? 'auto';
  const cutoff = resolved === 'not_allowed' ? null : formatChangeCutoff(untilMin);
  return cutoff ? `${label}: ${resolved} ${cutoff}` : `${label}: ${resolved}`;
}
