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
import { BookingError } from './booking-providers/types';

export type { CustomerChangeMode };

export const CUSTOMER_CHANGE_MODES = ['auto', 'request', 'not_allowed'] as const;

/**
 * What a Service means when it carries no explicit mode: ask the owner.
 *
 * It is the `.default()` a create payload gets, the entity/DB column default, and the
 * fallback every reader uses for a row (or a partial `select`) that has no value. The
 * fail-safe direction is deliberate: an unset policy must never let the Agent move or
 * cancel a confirmed appointment by itself.
 */
export const DEFAULT_CUSTOMER_CHANGE_MODE: CustomerChangeMode = 'request';

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
  const startMs = startUtc instanceof Date ? startUtc.getTime() : new Date(startUtc).getTime();
  if (!Number.isFinite(startMs)) return policy;
  const cutoffMs = startMs - untilMin * 60_000;
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

/** What the model should say out loud for a cutoff duration. */
export function spokenChangeCutoff(untilMin: number | null | undefined): string | null {
  if (untilMin == null) return null;
  if (untilMin === 0) return 'after the appointment has started';
  if (untilMin % 1440 === 0) {
    const days = untilMin / 1440;
    return days === 1 ? '1 day before the appointment' : `${days} days before the appointment`;
  }
  if (untilMin % 60 === 0) {
    const hours = untilMin / 60;
    return hours === 1 ? '1 hour before the appointment' : `${hours} hours before the appointment`;
  }
  return `${untilMin} minutes before the appointment`;
}

/**
 * Effective customer-change answer plus the Service's own mode and cutoff, so a
 * refusal can name the duration instead of sounding like the action is forbidden outright.
 */
export type CustomerChangePeek = {
  mode: CustomerChangeMode;
  policy: CustomerChangeMode;
  untilMin: number | null;
};

export function catalogChangeClause(
  label: 'reschedule' | 'cancel',
  mode: CustomerChangeMode | null | undefined,
  untilMin: number | null | undefined,
): string {
  const resolved = mode ?? DEFAULT_CUSTOMER_CHANGE_MODE;
  const cutoff = resolved === 'not_allowed' ? null : formatChangeCutoff(untilMin);
  return cutoff ? `${label}: ${resolved} ${cutoff}` : `${label}: ${resolved}`;
}

export function policyChangeNotAllowedGuidance(action: 'reschedule' | 'cancel'): string {
  const verb = action === 'reschedule' ? 'reschedule' : 'cancel';
  return `This appointment does not allow customers to ${verb} through the booking system. There is no cutoff and no number of days. Do not invent a deadline. Do not modify or cancel the appointment, do not call request_appointment, and do not tell the customer that a request was submitted. Politely explain they cannot ${verb} this appointment here. Do not tell them to contact the business and do not call escalate_to_human. Do not offer to connect them with the team and do not ask whether they want a human. This policy is final — do not imply the team may still change the appointment. If they separately ask to speak with a person, follow ESCALATION; insisting on the ${verb} is not a request for a person.`;
}

/** Tail from policyChangeNotAllowedGuidance for context-specific lead-ins that already carry refuse/no-request clauses. */
export function policyChangeNotAllowedNoHandoffTail(action: 'reschedule' | 'cancel'): string {
  const marker = 'Do not tell them to contact the business';
  const guidance = policyChangeNotAllowedGuidance(action);
  const idx = guidance.indexOf(marker);
  return idx >= 0 ? guidance.slice(idx) : guidance;
}

/** Same refusal the write path and the agent confirmation gate must raise. */
export function customerChangeNotAllowedError(
  serviceName: string | undefined,
  action: 'reschedule' | 'cancel',
  untilMin?: number | null,
): BookingError {
  const verb = action === 'reschedule' ? 'reschedule' : 'cancel';
  const past = action === 'reschedule' ? 'rescheduled' : 'cancelled';
  const who = serviceName ? `"${serviceName}"` : 'This appointment';
  const spoken = spokenChangeCutoff(untilMin);
  if (spoken) {
    return new BookingError(
      `${who} cannot be ${past} this close to the start — the cutoff is ${spoken}. Tell the customer plainly it is not possible to ${verb} ${spoken}. Do not modify or cancel the appointment, do not call request_appointment, and do not tell the customer that a request was submitted. Do not tell them to contact the business and do not call escalate_to_human on this first refusal. If they keep insisting after you have explained the cutoff, ask whether they would like you to connect them with a human; only if they say yes, call escalate_to_human.`,
      'CHANGE_NOT_ALLOWED',
      403,
      { action, reason: 'cutoff', untilMin },
      `This appointment cannot be ${past} online this close to the start (${spoken}). Please contact the business directly.`,
    );
  }
  const tail = policyChangeNotAllowedGuidance(action).replace(
    /^This appointment does not allow customers to \w+ through the booking system\. /,
    '',
  );
  return new BookingError(
    `${who} does not allow customers to ${verb} through the booking system. ${tail}`,
    'CHANGE_NOT_ALLOWED',
    403,
    { action },
    action === 'reschedule'
      ? 'This appointment cannot be rescheduled online.'
      : 'This appointment cannot be cancelled online.',
  );
}
