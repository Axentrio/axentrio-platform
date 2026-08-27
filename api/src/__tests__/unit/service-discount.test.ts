import { describe, it, expect } from 'vitest';
import {
  applyDiscount,
  isDiscountActive,
  validateDiscountConfig,
} from '../../booking/pricing/service-discount';

describe('applyDiscount', () => {
  it('takes a percentage off and rounds to 2 decimals', () => {
    expect(applyDiscount(100, 'percentage', 20)).toBe(80);
    expect(applyDiscount(99.99, 'percentage', 10)).toBe(89.99);
    expect(applyDiscount(33.33, 'percentage', 33)).toBe(22.33);
  });

  it('takes a fixed amount off', () => {
    expect(applyDiscount(100, 'fixed', 20)).toBe(80);
    expect(applyDiscount(80.5, 'fixed', 0.5)).toBe(80);
  });

  it('clamps a fixed amount that exceeds the base to 0, never negative', () => {
    expect(applyDiscount(50, 'fixed', 80)).toBe(0);
  });

  it('clamps a percentage to 0–100', () => {
    // A percentage over 100 cannot make the price negative.
    expect(applyDiscount(100, 'percentage', 150)).toBe(0);
    // 100% off is €0, a real configured final price.
    expect(applyDiscount(100, 'percentage', 100)).toBe(0);
  });

  it('preserves order so discounted range bounds never invert', () => {
    // Monotonic for both types: applyDiscount(min) ≤ applyDiscount(max) whenever min ≤ max.
    expect(applyDiscount(30, 'fixed', 50)).toBeLessThanOrEqual(applyDiscount(120, 'fixed', 50));
    expect(applyDiscount(30, 'percentage', 25)).toBeLessThanOrEqual(applyDiscount(120, 'percentage', 25));
  });
});

describe('isDiscountActive', () => {
  const NOW = new Date('2026-06-15T12:00:00Z');
  const base = { discountEnabled: true, discountType: 'percentage' as const, discountValue: 20 };

  it('is inactive when the switch is off', () => {
    expect(isDiscountActive({ ...base, discountEnabled: false }, 'Europe/Brussels', NOW)).toBe(false);
  });

  it('is inactive without a valid type or a positive value', () => {
    expect(isDiscountActive({ ...base, discountType: null }, 'Europe/Brussels', NOW)).toBe(false);
    expect(isDiscountActive({ ...base, discountValue: 0 }, 'Europe/Brussels', NOW)).toBe(false);
    expect(isDiscountActive({ ...base, discountValue: null }, 'Europe/Brussels', NOW)).toBe(false);
  });

  it('is active with no window (open-ended both sides)', () => {
    expect(isDiscountActive(base, 'Europe/Brussels', NOW)).toBe(true);
  });

  it('honours an inclusive window in the business timezone', () => {
    expect(isDiscountActive({ ...base, discountStartOn: '2026-06-15', discountEndOn: '2026-06-15' }, 'Europe/Brussels', NOW)).toBe(true);
    expect(isDiscountActive({ ...base, discountStartOn: '2026-06-16' }, 'Europe/Brussels', NOW)).toBe(false);
    expect(isDiscountActive({ ...base, discountEndOn: '2026-06-14' }, 'Europe/Brussels', NOW)).toBe(false);
  });

  it('judges "today" by the business timezone, not UTC', () => {
    // 23:30 UTC on the 15th is already the 16th in Brussels (UTC+2 in summer).
    const lateUtc = new Date('2026-06-15T23:30:00Z');
    expect(isDiscountActive({ ...base, discountStartOn: '2026-06-16' }, 'Europe/Brussels', lateUtc)).toBe(true);
    expect(isDiscountActive({ ...base, discountStartOn: '2026-06-16' }, 'UTC', lateUtc)).toBe(false);
  });
});

describe('validateDiscountConfig', () => {
  it('passes a disabled discount regardless of the other fields', () => {
    expect(validateDiscountConfig({ discountEnabled: false })).toBeNull();
    expect(validateDiscountConfig({})).toBeNull();
  });

  it('requires a type and a positive value when enabled', () => {
    expect(validateDiscountConfig({ discountEnabled: true })).toMatch(/type/i);
    expect(validateDiscountConfig({ discountEnabled: true, discountType: 'fixed' })).toMatch(/value/i);
    expect(validateDiscountConfig({ discountEnabled: true, discountType: 'fixed', discountValue: 0 })).toMatch(/value/i);
  });

  it('rejects a percentage over 100', () => {
    expect(validateDiscountConfig({ discountEnabled: true, discountType: 'percentage', discountValue: 120 })).toMatch(/100/);
  });

  it('rejects an inverted date window', () => {
    expect(
      validateDiscountConfig({
        discountEnabled: true,
        discountType: 'percentage',
        discountValue: 10,
        discountStartOn: '2026-06-16',
        discountEndOn: '2026-06-15',
      })
    ).toMatch(/on or before/i);
  });

  it('accepts a fully configured discount', () => {
    expect(
      validateDiscountConfig({
        discountEnabled: true,
        discountType: 'percentage',
        discountValue: 20,
        discountStartOn: '2026-06-01',
        discountEndOn: '2026-06-30',
      })
    ).toBeNull();
  });
});
