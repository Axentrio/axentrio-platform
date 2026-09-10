import { describe, expect, it } from 'vitest';
import { businessHoursSchema, updateBotSchema } from '../../schemas/bot.schema';

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

describe('businessHoursSchema — window direction', () => {
  const day = (open: string, close: string, closed = false) => ({
    enabled: true,
    schedule: [{ day: 'wednesday' as const, open, close, closed }],
  });

  it('accepts a window that runs forward', () => {
    expect(businessHoursSchema.safeParse(day('09:00', '17:00')).success).toBe(true);
  });

  it('refuses equal open and close, and names the day', () => {
    const r = businessHoursSchema.safeParse(day('09:00', '09:00'));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe('wednesday: close (09:00) must be after open (09:00)');
      expect(r.error.issues[0]!.path).toEqual(['schedule', 0, 'close']);
    }
  });

  it('refuses a close before the open (an overnight window is not representable)', () => {
    const r = businessHoursSchema.safeParse(day('18:00', '02:00'));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe('wednesday: close (02:00) must be after open (18:00)');
    }
  });

  it('ignores the times of a day marked closed', () => {
    expect(businessHoursSchema.safeParse(day('18:00', '09:00', true)).success).toBe(true);
    expect(businessHoursSchema.safeParse(day('00:00', '00:00', true)).success).toBe(true);
  });
});

describe('updateBotSchema — quotedAddress', () => {
  it('accepts optional streetNumber / boxNumber and uppercases the country', () => {
    const r = updateBotSchema.safeParse({
      quotedAddress: {
        enabled: true,
        street: 'Grote Markt',
        streetNumber: '1',
        boxNumber: '2',
        postalCode: '9300',
        city: 'Aalst',
        country: 'be',
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.quotedAddress).toMatchObject({
        enabled: true,
        street: 'Grote Markt',
        streetNumber: '1',
        boxNumber: '2',
        country: 'BE',
      });
    }
  });

  it('rejects a country that is not ISO alpha-2', () => {
    expect(
      updateBotSchema.safeParse({
        quotedAddress: { enabled: true, street: 'Grote Markt', country: 'België' },
      }).success,
    ).toBe(false);
  });
});
