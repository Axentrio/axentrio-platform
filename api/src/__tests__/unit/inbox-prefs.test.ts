import { describe, expect, it } from 'vitest';
import { parseDefaultTakeoverHours, resolveDefaultTakeoverHours } from '../../services/inbox-prefs.service';

describe('resolveDefaultTakeoverHours', () => {
  it('defaults an absent value to indefinite', () => {
    expect(resolveDefaultTakeoverHours(undefined)).toBe('indefinite');
    expect(resolveDefaultTakeoverHours(null)).toBe('indefinite');
  });

  it('keeps a stored 1–24 hour default', () => {
    expect(resolveDefaultTakeoverHours(4)).toBe(4);
    expect(resolveDefaultTakeoverHours(24)).toBe(24);
  });

  it('rejects out-of-range or fractional hours as indefinite', () => {
    expect(resolveDefaultTakeoverHours(0)).toBe('indefinite');
    expect(resolveDefaultTakeoverHours(25)).toBe('indefinite');
    expect(resolveDefaultTakeoverHours(1.5)).toBe('indefinite');
    expect(resolveDefaultTakeoverHours('4')).toBe('indefinite');
  });
});

describe('parseDefaultTakeoverHours', () => {
  it('accepts indefinite and 1–24', () => {
    expect(parseDefaultTakeoverHours('indefinite')).toBe('indefinite');
    expect(parseDefaultTakeoverHours(8)).toBe(8);
  });

  it('refuses anything else so a write cannot store a broken default', () => {
    expect(parseDefaultTakeoverHours(0)).toBeNull();
    expect(parseDefaultTakeoverHours(25)).toBeNull();
    expect(parseDefaultTakeoverHours('timed')).toBeNull();
  });
});
