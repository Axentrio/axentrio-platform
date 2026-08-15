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
