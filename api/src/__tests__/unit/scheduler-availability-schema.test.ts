import { describe, it, expect } from 'vitest';
import { availabilityInputSchema, isValidTimezone } from '../../schemas/scheduler.schema';

/**
 * The availability contract, asserted on the API side.
 *
 * The setup wizard shipped broken for weeks because its only test mocked the transport and
 * asserted the payload it already produced (`monday`), so nothing ever compared it against
 * the schema that actually receives it. These cases are that comparison.
 */
const base = { timezone: 'Europe/Brussels', dateOverrides: [], slotGranularityMin: 30 };
const nineToFive = [{ start: '09:00', end: '17:00' }];

describe('availabilityInputSchema — weekday keys', () => {
  it('accepts the seven short keys the API defines', () => {
    const weeklyHours = Object.fromEntries(
      ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, nineToFive]),
    );
    expect(availabilityInputSchema.safeParse({ ...base, weeklyHours }).success).toBe(true);
  });

  it('REJECTS long weekday names — the exact payload the wizard used to send', () => {
    const r = availabilityInputSchema.safeParse({
      ...base,
      weeklyHours: { monday: nineToFive, saturday: [] },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.'))).toContain('weeklyHours.monday');
    }
  });
});

describe('availabilityInputSchema — split shifts', () => {
  it('accepts MORE THAN ONE window per day, which is how a lunch break is expressed', () => {
    const r = availabilityInputSchema.safeParse({
      ...base,
      weeklyHours: { mon: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '17:00' }] },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.weeklyHours.mon).toHaveLength(2);
  });

  it('accepts multiple windows on a date override too', () => {
    const r = availabilityInputSchema.safeParse({
      ...base,
      weeklyHours: {},
      dateOverrides: [
        { date: '2026-12-24', windows: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '16:00' }] },
      ],
    });
    expect(r.success).toBe(true);
  });
});

describe('availabilityInputSchema — window direction', () => {
  it('refuses an inverted weekly window and names the day', () => {
    const r = availabilityInputSchema.safeParse({
      ...base,
      weeklyHours: { tue: [{ start: '09:00', end: '12:00' }, { start: '18:00', end: '09:00' }] },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe('tue: close (09:00) must be after open (18:00)');
      expect(r.error.issues[0]!.path).toEqual(['weeklyHours', 'tue', 1, 'end']);
    }
  });

  it('refuses equal start and end', () => {
    const r = availabilityInputSchema.safeParse({ ...base, weeklyHours: { mon: [{ start: '09:00', end: '09:00' }] } });
    expect(r.success).toBe(false);
  });

  it('compares clock minutes, so an unpadded hour and a 24:00 end stay valid', () => {
    const r = availabilityInputSchema.safeParse({
      ...base,
      weeklyHours: { mon: [{ start: '9:00', end: '17:00' }], sat: [{ start: '00:00', end: '24:00' }] },
    });
    expect(r.success).toBe(true);
  });

  it('refuses an inverted window on a date override', () => {
    const r = availabilityInputSchema.safeParse({
      ...base,
      weeklyHours: {},
      dateOverrides: [{ date: '2026-12-24', windows: [{ start: '18:00', end: '09:00' }] }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.path).toEqual(['dateOverrides', 0, 'windows', 0, 'end']);
    }
  });

  it('ignores the windows of a closed date override', () => {
    const r = availabilityInputSchema.safeParse({
      ...base,
      weeklyHours: {},
      dateOverrides: [{ date: '2026-12-25', closed: true, windows: [{ start: '18:00', end: '09:00' }] }],
    });
    expect(r.success).toBe(true);
  });
});

describe('availabilityInputSchema — timezone', () => {
  it('accepts a missing timezone for new clients', () => {
    const r = availabilityInputSchema.safeParse({ weeklyHours: {} });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).not.toHaveProperty('timezone');
      expect(r.data.weeklyHours).toEqual({});
    }
  });

  it('strips a stray timezone of any shape without validating it', () => {
    const r = availabilityInputSchema.safeParse({
      ...base,
      timezone: { not: 'an IANA timezone' },
      weeklyHours: { wed: nineToFive },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).not.toHaveProperty('timezone');
      expect(r.data.weeklyHours).toEqual({ wed: nineToFive });
    }
  });

  it('isValidTimezone is the shared judge for owner input and preset seeds alike', () => {
    expect(isValidTimezone('Europe/Brussels')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Europe/Brusselz')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});
