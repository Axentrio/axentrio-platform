/**
 * Variable-duration policy for services configured with durationMode
 * 'range' or 'ai'. The create path is the authority that throws; the
 * availability path is lenient by design.
 */
import { ServiceType } from '../../database/entities/ServiceType';
import { logger } from '../../utils/logger';
import { BookingError } from './types';

/** True only when the service is configured for a variable duration with a valid range. */
function hasValidRange(service: ServiceType): boolean {
  if (service.durationMode !== 'range' && service.durationMode !== 'ai') return false;
  const { minDurationMin: min, maxDurationMin: max } = service;
  return !!min && !!max && min > 0 && max > 0 && min <= max;
}

/**
 * Tool args often arrive as strings. A numeric string is a chosen length;
 * garbage ("30-90", "sixty") is absent so the bot asks again.
 */
export function parseRequestedDuration(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * P5c — resolve the effective booked length (create authority, THROWS on violation).
 * 'fixed' (or an invalid range config) → service.durationMin. 'range'/'ai' → the
 * agent-supplied minutes, defaulting to minDurationMin when absent; out of
 * [min,max] → DURATION_OUT_OF_RANGE (recoverable, never silently clamped).
 */
export function resolveDuration(service: ServiceType, requestedDurationMin?: unknown): number {
  if (!hasValidRange(service)) {
    if (service.durationMode === 'range' || service.durationMode === 'ai') {
      logger.warn('[Booking] invalid duration range config — treating as fixed', {
        serviceId: service.id,
        min: service.minDurationMin,
        max: service.maxDurationMin,
      });
    }
    return service.durationMin;
  }
  const min = service.minDurationMin as number;
  const max = service.maxDurationMin as number;
  const requested = parseRequestedDuration(requestedDurationMin);
  const effective = requested ?? min; // absent → conservative shortest job
  if (effective < min || effective > max) {
    throw new BookingError("Requested duration is outside this service's allowed range", 'DURATION_OUT_OF_RANGE', 400);
  }
  return effective;
}

/**
 * True when a variable-length service's length was never established.
 *
 * The epic's rule is that the assistant must not auto-book a duration it had to guess.
 * `resolveDuration` falls back to the SHORTEST job when the model supplies nothing, which
 * is a safe number to hold but a silent guess to confirm: a two-hour repair booked as a
 * thirty-minute one is a wrong appointment, not a conservative one.
 */
export function durationUnresolved(service: ServiceType, requestedDurationMin?: unknown): boolean {
  return hasValidRange(service) && parseRequestedDuration(requestedDurationMin) === undefined;
}

/**
 * Auto-book must not guess a length, and it must not capture a request instead.
 * A request with no length is what the model then describes as a calendar failure.
 * Throw DURATION_REQUIRED so the bot asks between min and max, then retries.
 */
export function assertDurationChosen(service: ServiceType, requestedDurationMin?: unknown): void {
  if (!durationUnresolved(service, requestedDurationMin)) return;
  const min = service.minDurationMin as number;
  const max = service.maxDurationMin as number;
  throw new BookingError(
    `This service has a duration range of ${min}-${max} min. Ask the customer how long they need (a number in that range), then re-call create_booking with durationMin. Do not treat this as a calendar or technical failure, and do not capture a request yet.`,
    'DURATION_REQUIRED',
    400,
  );
}

/**
 * P5c — lenient duration for AVAILABILITY (never throws): a within-bounds requested
 * value when known, else minDurationMin (shortest plausible job). The create path is
 * the authority that rejects an out-of-range request.
 */
export function effectiveDurationForAvailability(service: ServiceType, requestedDurationMin?: unknown): number {
  if (!hasValidRange(service)) return service.durationMin;
  const min = service.minDurationMin as number;
  const max = service.maxDurationMin as number;
  const requested = parseRequestedDuration(requestedDurationMin);
  if (typeof requested === 'number' && requested >= min && requested <= max) {
    return requested;
  }
  return min;
}
