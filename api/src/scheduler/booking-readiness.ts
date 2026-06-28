/**
 * Booking readiness — the SHARED config predicate behind the runtime booking
 * gate AND the capability-readiness endpoint (the anti-lying guarantee:
 * readiness must mirror what the runtime actually does).
 *
 * `isBookingConfigured` is the pure extraction of the inline expression the
 * agent runtime computes at `agent.service.ts` (the `bookingConfigured` signal):
 * request-only service present, OR (auto service present AND a rule exists). It
 * consumes only data the agent already fetches — services + rule existence — so
 * the runtime hot path gains zero queries.
 *
 * The differing error policy lives at the two call sites, not here: the runtime
 * fails OPEN on a lookup error (a transient blip must never falsely decline a
 * configured tenant); the readiness endpoint fails CLOSED (5xx) so it never
 * paints a misleading "all set." This helper itself is pure and total.
 */

/** The minimal service shape the gate decision needs (the runtime selects only
 *  `bookingMode`; readiness selects the same). */
export interface BookingServiceGate {
  bookingMode: string;
}

/**
 * The booking-config gate predicate (verbatim semantics of the former inline
 * `agent.service.ts` expression): bookable iff a request-mode service is
 * present, OR an auto-mode service is present AND an availability rule exists.
 *
 * `services` MUST already be filtered to the runtime GATE set
 * (`isActive && onlineBookable`) by the caller — this helper does not filter.
 */
export function isBookingConfigured(services: BookingServiceGate[], hasRule: boolean): boolean {
  const hasRequestService = services.some((s) => s.bookingMode === 'request');
  const hasAutoService = services.some((s) => s.bookingMode !== 'request');
  return hasRequestService || (hasAutoService && hasRule);
}
