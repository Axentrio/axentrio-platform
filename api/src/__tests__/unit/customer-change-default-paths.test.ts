import { describe, it, expect } from 'vitest';
import { BUSINESS_PRESETS, presetServiceSchema } from '../../scheduler/presets';
import { serviceCreateSchema } from '../../schemas/scheduler.schema';

describe('edge: every business preset seed defaults to request approval', () => {
  it('no preset seed declares a mode, and every parsed seed comes out request/request', () => {
    expect(BUSINESS_PRESETS.length).toBeGreaterThan(0);
    let seeds = 0;
    for (const preset of BUSINESS_PRESETS) {
      for (const seed of preset.services) {
        const parsed = presetServiceSchema.parse(seed);
        expect(parsed.rescheduleMode, preset.key).toBe('request');
        expect(parsed.cancelMode, preset.key).toBe('request');
        seeds += 1;
      }
    }
    expect(seeds).toBeGreaterThan(5);
  });

  it('a cutoff of 0 survives create as a real cutoff, not as absent', () => {
    const r = serviceCreateSchema.parse({ name: 'X', durationMin: 30, rescheduleUntilMin: 0, cancelUntilMin: null });
    expect(r.rescheduleUntilMin).toBe(0);
    expect(r.cancelUntilMin).toBeNull();
  });
});
