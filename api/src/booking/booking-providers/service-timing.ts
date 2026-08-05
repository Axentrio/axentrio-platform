/**
 * Service timing inheritance — pure, no DB.
 *
 * A service may leave its buffers, minimum notice and horizon unset, in which case it
 * inherits them from the business, and failing that from the platform. Kept in its own
 * module precisely because it is pure: importing it from `internal.provider` dragged the
 * entire entity graph (and a live DB connection) into any test that wanted to check the
 * arithmetic.
 */
import type { VenueAddress } from '../../contracts/venue-address';
import type { ServiceType } from '../../database/entities/ServiceType';

/** Business-level knobs. CEILINGS always apply; DEFAULTS apply only where a service is null. */
export interface BusinessRules {
  maxBookingsPerDay: number;
  maxBookedMinutesPerDay: number;
  minGapMin: number;
  defaultBufferBeforeMin: number | null;
  defaultBufferAfterMin: number | null;
  defaultMinNoticeMin: number | null;
  defaultMaxHorizonDays: number | null;
  /**
   * The business's premises. Not a timing value, but it rides along because it comes off
   * the same `chatbot_booking_settings` row — and the booking path reads that row once,
   * inside the transaction. Fetching it separately would mean a second query for a fact
   * the caller already has in hand.
   */
  venue: VenueAddress;
}

/**
 * A service whose four inheritable timing fields are guaranteed filled.
 *
 * A distinct type rather than `?? 0` at each use: the slot engine and the three
 * `blocked_range` computations must agree, and the compiler now refuses to let an
 * unresolved service reach either of them.
 */
export type ResolvedService = ServiceType & {
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  maxHorizonDays: number;
};

/** Where a service says nothing and the business says nothing either. */
export const PLATFORM_TIMING = {
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  minNoticeMin: 0,
  maxHorizonDays: 60,
} as const;

/**
 * Fill a service's null timing fields from the business defaults, then the platform
 * fallback. Returns a COPY, so every downstream consumer — the slot engine and all three
 * `blocked_range` computations — reads resolved numbers without knowing inheritance exists.
 *
 * `typeof === 'number'` rather than `??` or `||` on purpose: an explicit 0 is a real
 * answer. A service that genuinely wants zero notice must not silently inherit two hours,
 * and that distinction is the entire reason these columns became nullable.
 */
export function resolveServiceTiming(service: ServiceType, rules: BusinessRules): ResolvedService {
  const pick = (svc: number | null | undefined, biz: number | null, platform: number): number =>
    typeof svc === 'number' ? svc : typeof biz === 'number' ? biz : platform;
  return Object.assign(Object.create(Object.getPrototypeOf(service)), service, {
    bufferBeforeMin: pick(service.bufferBeforeMin, rules.defaultBufferBeforeMin, PLATFORM_TIMING.bufferBeforeMin),
    bufferAfterMin: pick(service.bufferAfterMin, rules.defaultBufferAfterMin, PLATFORM_TIMING.bufferAfterMin),
    minNoticeMin: pick(service.minNoticeMin, rules.defaultMinNoticeMin, PLATFORM_TIMING.minNoticeMin),
    maxHorizonDays: pick(service.maxHorizonDays, rules.defaultMaxHorizonDays, PLATFORM_TIMING.maxHorizonDays),
  }) as ResolvedService;
}
