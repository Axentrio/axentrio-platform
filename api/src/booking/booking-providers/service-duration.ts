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
 * P5c — resolve the effective booked length (create authority, THROWS on violation).
 * 'fixed' (or an invalid range config) → service.durationMin. 'range'/'ai' → the
 * agent-supplied minutes, defaulting to minDurationMin when absent; out of
 * [min,max] → DURATION_OUT_OF_RANGE (recoverable, never silently clamped).
 */
export function resolveDuration(service: ServiceType, requestedDurationMin?: number): number {
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
  const effective = requestedDurationMin ?? min; // absent → conservative shortest job
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
 * thirty-minute one is a wrong appointment, not a conservative one. The auto path treats
 * this as a reason to capture a request; the request path doesn't care, because a request
 * carries a preferred time rather than a committed length.
 */
export function durationUnresolved(service: ServiceType, requestedDurationMin?: number): boolean {
  return hasValidRange(service) && typeof requestedDurationMin !== 'number';
}

/**
 * P5c — lenient duration for AVAILABILITY (never throws): a within-bounds requested
 * value when known, else minDurationMin (shortest plausible job). The create path is
 * the authority that rejects an out-of-range request.
 */
export function effectiveDurationForAvailability(service: ServiceType, requestedDurationMin?: number): number {
  if (!hasValidRange(service)) return service.durationMin;
  const min = service.minDurationMin as number;
  const max = service.maxDurationMin as number;
  if (typeof requestedDurationMin === 'number' && requestedDurationMin >= min && requestedDurationMin <= max) {
    return requestedDurationMin;
  }
  return min;
}
