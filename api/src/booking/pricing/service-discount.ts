/**
 * Service discount — the single source of truth for the discounted final price.
 *
 * A discount is a separate layer ON TOP of the configured price (fixed / from / range).
 * `isDiscountActive` decides whether the layer applies right now (enabled, valid type +
 * value, and within the optional calendar-day window in the business timezone). `applyDiscount`
 * computes the reduced amount. Both the prompt (`priceHint`) and any other consumer resolve the
 * final price through here so a number is never re-derived — and never diverges — at a callsite.
 *
 * Pure: no DB, no clock of its own. `now` and `tz` are passed in so the same "today" the rest
 * of the booking prompt uses (bot business timezone) decides whether a window is open.
 */
import { DateTime } from 'luxon';
import type { DiscountType } from '../../database/entities/ServiceType';

/** The discount-shaped fields of a ServiceType — kept structural so tests need no full row. */
export interface DiscountConfig {
  discountEnabled?: boolean | null;
  discountType?: DiscountType | null;
  discountValue?: number | null;
  discountStartOn?: string | null;
  discountEndOn?: string | null;
}

/** Round to 2 decimals, avoiding binary-float drift (e.g. 79.995 → 80.00, not 79.99). */
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Whether a value is a usable discount amount (a positive, finite number). */
function hasUsableValue(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * The final amount after the discount. Percentage is clamped to 0–100; a fixed amount that
 * exceeds the base clamps the result to 0 rather than going negative. Callers apply this ONLY
 * when `isDiscountActive` is true.
 */
export function applyDiscount(amount: number, type: DiscountType, value: number): number {
  if (type === 'percentage') {
    const pct = Math.min(Math.max(value, 0), 100);
    return round2(amount * (1 - pct / 100));
  }
  // fixed amount
  return Math.max(0, round2(amount - Math.max(0, value)));
}

/**
 * Is the discount active for `now` (in `tz`)? Requires the switch on, a valid type, a positive
 * value, and — when set — today inside the inclusive `[start, end]` calendar-day window. Dates
 * are `yyyy-MM-dd`, so a lexical compare is a correct date compare.
 */
export function isDiscountActive(c: DiscountConfig, tz: string, now: Date): boolean {
  if (!c.discountEnabled) return false;
  if (c.discountType !== 'percentage' && c.discountType !== 'fixed') return false;
  if (!hasUsableValue(c.discountValue)) return false;
  const today = DateTime.fromJSDate(now).setZone(tz || 'UTC').toFormat('yyyy-MM-dd');
  if (c.discountStartOn && today < c.discountStartOn) return false;
  if (c.discountEndOn && today > c.discountEndOn) return false;
  return true;
}

/**
 * Validate a discount configuration as a WHOLE ROW (after any partial update is merged), not
 * just a payload. Returns a human message on the first problem, or null when valid. The
 * controller turns a message into a 400 so a half-configured discount can never persist.
 */
export function validateDiscountConfig(c: DiscountConfig): string | null {
  if (!c.discountEnabled) return null;
  if (c.discountType !== 'percentage' && c.discountType !== 'fixed') {
    return 'An enabled discount needs a discount type (percentage or fixed).';
  }
  if (!hasUsableValue(c.discountValue)) {
    return 'An enabled discount needs a discount value greater than 0.';
  }
  if (c.discountType === 'percentage' && c.discountValue > 100) {
    return 'A percentage discount cannot be more than 100.';
  }
  if (c.discountStartOn && c.discountEndOn && c.discountStartOn > c.discountEndOn) {
    return 'The discount start date must be on or before the end date.';
  }
  return null;
}
