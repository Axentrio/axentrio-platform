import { describe, it, expect } from 'vitest';
import {
  BUSINESS_PRESETS,
  presetServiceSchema,
  presetAvailabilitySchema,
  listPresetSummaries,
  findPreset,
} from '../../scheduler/presets';
import { slugify } from '../../scheduler/scheduler.controller';

describe('BUSINESS_PRESETS — CI guard (every seed must be valid)', () => {
  it('every service seed passes presetServiceSchema', () => {
    for (const p of BUSINESS_PRESETS) {
      for (const s of p.services) {
        expect(() => presetServiceSchema.parse(s), `${p.key}: ${s.name}`).not.toThrow();
      }
    }
  });

  it('every preset availability passes presetAvailabilitySchema', () => {
    for (const p of BUSINESS_PRESETS) {
      if (p.availability) expect(() => presetAvailabilitySchema.parse(p.availability), p.key).not.toThrow();
    }
  });

  it('preset-level invariants: unique non-empty keys, ≥1 service, no intra-preset slug collisions', () => {
    const keys = new Set<string>();
    for (const p of BUSINESS_PRESETS) {
      expect(p.key.trim().length, 'key non-empty').toBeGreaterThan(0);
      expect(keys.has(p.key), `duplicate key ${p.key}`).toBe(false);
      keys.add(p.key);
      expect(p.services.length, `${p.key} has ≥1 service`).toBeGreaterThan(0);
      const slugs = p.services.map((s) => slugify(s.name));
      expect(new Set(slugs).size, `${p.key} slug collision`).toBe(slugs.length);
    }
  });

  it('listPresetSummaries / findPreset expose the picker shape', () => {
    const summaries = listPresetSummaries();
    expect(summaries.length).toBe(BUSINESS_PRESETS.length);
    expect(summaries[0]).toEqual({
      key: expect.any(String),
      label: expect.any(String),
      description: expect.any(String),
      serviceCount: expect.any(Number),
    });
    expect(findPreset('barber')?.label).toBe('Barber');
    expect(findPreset('nope')).toBeUndefined();
  });
});

describe('preset schema rejects malformed seeds (negative fixtures)', () => {
  const okService = { name: 'X', durationMin: 30, priceDisplayType: 'none' as const };

  it('rejects an unknown / snake_case key (.strict)', () => {
    expect(() => presetServiceSchema.parse({ ...okService, booking_mode: 'auto' })).toThrow();
  });

  it('rejects isActive / sortOrder / intakeQuestions in a seed', () => {
    expect(() => presetServiceSchema.parse({ ...okService, isActive: true })).toThrow();
    expect(() => presetServiceSchema.parse({ ...okService, sortOrder: 0 })).toThrow();
    expect(() => presetServiceSchema.parse({ ...okService, intakeQuestions: [] })).toThrow();
  });

  it('enforces price fields both ways', () => {
    expect(() => presetServiceSchema.parse({ name: 'a', durationMin: 30, priceDisplayType: 'fixed' })).toThrow(); // missing fixedPrice
    expect(() => presetServiceSchema.parse({ name: 'a', durationMin: 30, priceDisplayType: 'fixed', fixedPrice: 10, minPrice: 5 })).toThrow(); // stray min
    expect(() => presetServiceSchema.parse({ name: 'a', durationMin: 30, priceDisplayType: 'range', minPrice: 50, maxPrice: 10 })).toThrow(); // min>max
    expect(() => presetServiceSchema.parse({ name: 'a', durationMin: 30, priceDisplayType: 'range', minPrice: 10, maxPrice: 50, fixedPrice: 5 })).toThrow(); // stray fixed
    expect(() => presetServiceSchema.parse({ name: 'a', durationMin: 30, priceDisplayType: 'none', fixedPrice: 5 })).toThrow(); // numeric on none
    // valid forms
    expect(() => presetServiceSchema.parse({ name: 'a', durationMin: 30, priceDisplayType: 'fixed', fixedPrice: 10 })).not.toThrow();
    expect(() => presetServiceSchema.parse({ name: 'a', durationMin: 30, priceDisplayType: 'range', minPrice: 10, maxPrice: 50 })).not.toThrow();
  });

  it('rejects inverted / out-of-range availability windows and bad timezone', () => {
    const base = { timezone: 'Europe/Brussels', weeklyHours: { mon: [{ start: '09:00', end: '17:00' }] }, dateOverrides: [], slotGranularityMin: 30 };
    expect(() => presetAvailabilitySchema.parse(base)).not.toThrow();
    expect(() => presetAvailabilitySchema.parse({ ...base, weeklyHours: { mon: [{ start: '17:00', end: '09:00' }] } })).toThrow(); // inverted
    expect(() => presetAvailabilitySchema.parse({ ...base, weeklyHours: { mon: [{ start: '24:00', end: '24:30' }] } })).toThrow(); // 24:xx start
    expect(() => presetAvailabilitySchema.parse({ ...base, timezone: 'Mars/Phobos' })).toThrow(); // bad tz
    expect(() => presetAvailabilitySchema.parse({ ...base, extra: 1 })).toThrow(); // strict top-level
  });
});
