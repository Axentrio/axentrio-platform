import { describe, expect, it } from 'vitest';
import { businessHoursSchema } from '../../schemas/bot.schema';

const schedule = [{ day: 'monday' as const, open: '09:00', close: '17:00', closed: false }];

describe('businessHoursSchema — timezone', () => {
  it('strips a stray timezone without rejecting the rest of the payload', () => {
    const r = businessHoursSchema.safeParse({
      enabled: true,
      timezone: 'Europe/Brusselz',
      schedule,
    });

    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).not.toHaveProperty('timezone');
      expect(r.data.enabled).toBe(true);
      expect(r.data.schedule).toEqual(schedule);
    }
  });

  it('accepts a payload without timezone', () => {
    const r = businessHoursSchema.safeParse({ enabled: false, schedule: [] });

    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual({ enabled: false, schedule: [] });
    }
  });
});

describe('businessHoursSchema — dateOverrides', () => {
  it('accepts a closed date and one-off hours', () => {
    const r = businessHoursSchema.safeParse({
      enabled: true,
      schedule,
      dateOverrides: [
        { date: '2026-12-25', closed: true },
        { date: '2026-12-24', windows: [{ start: '10:00', end: '14:00' }] },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.dateOverrides).toEqual([
        { date: '2026-12-25', closed: true },
        { date: '2026-12-24', windows: [{ start: '10:00', end: '14:00' }] },
      ]);
    }
  });

  it('rejects a backwards range', () => {
    const r = businessHoursSchema.safeParse({
      enabled: true,
      schedule,
      dateOverrides: [{ date: '2026-12-26', endDate: '2026-12-25', closed: true }],
    });
    expect(r.success).toBe(false);
  });

  it('treats a missing dateOverrides as empty (weekly schedule only)', () => {
    const r = businessHoursSchema.safeParse({ enabled: true, schedule });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.dateOverrides).toBeUndefined();
  });
});
