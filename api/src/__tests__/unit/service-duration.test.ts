/**
 * Variable-length services: parse the chosen minutes, refuse to guess, ask again.
 *
 * A "customer chooses a length" service must not auto-book a guessed duration, and it
 * must not capture a request that the model then describes as a calendar failure.
 * The create path returns DURATION_REQUIRED so the bot asks between min and max.
 */
import { describe, it, expect } from 'vitest';
import type { ServiceType } from '../../database/entities/ServiceType';
import {
  parseRequestedDuration,
  resolveDuration,
  durationUnresolved,
  effectiveDurationForAvailability,
  assertDurationChosen,
} from '../../booking/booking-providers/service-duration';
import { BookingError } from '../../booking/booking-providers/types';

const range = (over: Partial<ServiceType> = {}): ServiceType =>
  ({
    id: 'svc-1',
    durationMode: 'range',
    durationMin: 30,
    minDurationMin: 30,
    maxDurationMin: 90,
    ...over,
  }) as ServiceType;

describe('parseRequestedDuration', () => {
  it('keeps a finite number', () => {
    expect(parseRequestedDuration(60)).toBe(60);
  });

  it('parses a numeric string — tool args often arrive as strings', () => {
    expect(parseRequestedDuration('60')).toBe(60);
    expect(parseRequestedDuration(' 90 ')).toBe(90);
  });

  it('treats missing or garbage as absent, not as zero', () => {
    expect(parseRequestedDuration(undefined)).toBeUndefined();
    expect(parseRequestedDuration(null)).toBeUndefined();
    expect(parseRequestedDuration('')).toBeUndefined();
    expect(parseRequestedDuration('30-90')).toBeUndefined();
    expect(parseRequestedDuration('sixty')).toBeUndefined();
    expect(parseRequestedDuration(NaN)).toBeUndefined();
  });
});

describe('durationUnresolved', () => {
  it('is true when a range service has no chosen length', () => {
    expect(durationUnresolved(range(), undefined)).toBe(true);
  });

  it('is false once a numeric length is known, including a numeric string', () => {
    expect(durationUnresolved(range(), 60)).toBe(false);
    expect(durationUnresolved(range(), '60')).toBe(false);
  });

  it('is false for a fixed service', () => {
    expect(durationUnresolved(range({ durationMode: 'fixed' }), undefined)).toBe(false);
  });
});

describe('assertDurationChosen', () => {
  it('throws DURATION_REQUIRED when the customer has not chosen a length', () => {
    try {
      assertDurationChosen(range(), undefined);
      throw new Error('expected DURATION_REQUIRED');
    } catch (err) {
      expect(err).toBeInstanceOf(BookingError);
      expect(err).toMatchObject({ code: 'DURATION_REQUIRED', statusCode: 400 });
      expect((err as Error).message).toMatch(/30-90 min/);
      expect((err as Error).message).toMatch(/Ask the customer how long they need/i);
      expect((err as Error).message).toMatch(/Do not treat this as a calendar or technical failure/i);
    }
  });

  it('does not throw when the length is known', () => {
    expect(() => assertDurationChosen(range(), 60)).not.toThrow();
    expect(() => assertDurationChosen(range(), '45')).not.toThrow();
  });
});

describe('resolveDuration', () => {
  it('books the chosen length, including a numeric string', () => {
    expect(resolveDuration(range(), 60)).toBe(60);
    expect(resolveDuration(range(), '90')).toBe(90);
  });

  it('throws DURATION_OUT_OF_RANGE when the chosen length is outside bounds', () => {
    expect(() => resolveDuration(range(), 120)).toThrow(BookingError);
    try {
      resolveDuration(range(), 120);
    } catch (err) {
      expect(err).toMatchObject({ code: 'DURATION_OUT_OF_RANGE' });
    }
  });
});

describe('effectiveDurationForAvailability', () => {
  it('uses the chosen length when it is in bounds', () => {
    expect(effectiveDurationForAvailability(range(), 60)).toBe(60);
    expect(effectiveDurationForAvailability(range(), '90')).toBe(90);
  });

  it('falls back to min when the length is not yet known', () => {
    expect(effectiveDurationForAvailability(range(), undefined)).toBe(30);
    expect(effectiveDurationForAvailability(range(), '30-90')).toBe(30);
  });
});
