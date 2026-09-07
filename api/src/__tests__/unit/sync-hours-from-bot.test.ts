import { describe, it, expect } from 'vitest';
import { availabilityToBusinessHours, businessHoursToAvailability, type SpokenHours } from '../../booking/sync-hours-from-bot';

const open = (day: string, open = '09:00', close = '17:00') => ({
  day,
  open,
  close,
  closed: false,
});
const shut = (day: string) => ({ day, open: '00:00', close: '00:00', closed: true });

describe('businessHoursToAvailability — weeklyHours', () => {
  it('maps full weekday names to mon/tue/… keys with one window', () => {
    const { weeklyHours } = businessHoursToAvailability({
      schedule: [
        open('monday', '09:00', '17:00'),
        open('tuesday', '10:00', '14:00'),
        open('wednesday', '08:30', '12:00'),
        open('thursday', '09:00', '18:00'),
        open('friday', '09:00', '16:00'),
        open('saturday', '10:00', '13:00'),
        open('sunday', '11:00', '15:00'),
      ],
    });

    expect(weeklyHours).toEqual({
      mon: [{ start: '09:00', end: '17:00' }],
      tue: [{ start: '10:00', end: '14:00' }],
      wed: [{ start: '08:30', end: '12:00' }],
      thu: [{ start: '09:00', end: '18:00' }],
      fri: [{ start: '09:00', end: '16:00' }],
      sat: [{ start: '10:00', end: '13:00' }],
      sun: [{ start: '11:00', end: '15:00' }],
    });
  });

  it('omits a day marked closed (no window that weekday)', () => {
    const { weeklyHours } = businessHoursToAvailability({
      schedule: [open('monday'), shut('thursday'), open('friday')],
    });

    expect(weeklyHours).toEqual({
      mon: [{ start: '09:00', end: '17:00' }],
      fri: [{ start: '09:00', end: '17:00' }],
    });
    expect(weeklyHours).not.toHaveProperty('thu');
  });

  it('treats a missing weekday as closed', () => {
    const { weeklyHours } = businessHoursToAvailability({
      schedule: [open('monday'), open('wednesday')],
    });

    expect(Object.keys(weeklyHours).sort()).toEqual(['mon', 'wed']);
    expect(weeklyHours.thu).toBeUndefined();
    expect(weeklyHours.tue).toBeUndefined();
  });

  it('skips abbreviated or unknown day keys rather than inventing a window', () => {
    const { weeklyHours } = businessHoursToAvailability({
      schedule: [open('mon'), open('Thursday'), open('monday', '08:00', '12:00')],
    });

    expect(weeklyHours).toEqual({ mon: [{ start: '08:00', end: '12:00' }] });
  });

  it('maps an empty or absent schedule to no weekly windows', () => {
    expect(businessHoursToAvailability({ schedule: [] }).weeklyHours).toEqual({});
    expect(businessHoursToAvailability({}).weeklyHours).toEqual({});
    expect(businessHoursToAvailability(null).weeklyHours).toEqual({});
    expect(businessHoursToAvailability(undefined).weeklyHours).toEqual({});
  });
});

describe('businessHoursToAvailability — dateOverrides', () => {
  it('maps a closed dateOverride to a closed rule row and drops windows', () => {
    const { dateOverrides } = businessHoursToAvailability({
      schedule: [open('thursday')],
      dateOverrides: [
        {
          date: '2026-08-20',
          closed: true,
          windows: [{ start: '09:00', end: '17:00' }],
        },
      ],
    });

    expect(dateOverrides).toEqual([{ date: '2026-08-20', closed: true }]);
  });

  it('maps one-off hours as replacement windows (not closed)', () => {
    const { dateOverrides } = businessHoursToAvailability({
      dateOverrides: [{ date: '2026-12-24', windows: [{ start: '10:00', end: '14:00' }] }],
    });

    expect(dateOverrides).toEqual([
      { date: '2026-12-24', windows: [{ start: '10:00', end: '14:00' }] },
    ]);
  });

  it('preserves an inclusive endDate on a ranged closure', () => {
    const { dateOverrides } = businessHoursToAvailability({
      dateOverrides: [{ date: '2026-08-03', endDate: '2026-08-16', closed: true }],
    });

    expect(dateOverrides).toEqual([{ date: '2026-08-03', endDate: '2026-08-16', closed: true }]);
  });

  it('treats a row with neither closed nor windows as closed', () => {
    const { dateOverrides } = businessHoursToAvailability({
      dateOverrides: [{ date: '2026-12-25' }],
    });

    expect(dateOverrides).toEqual([{ date: '2026-12-25', closed: true }]);
  });

  it('drops a null endDate and a row with no date', () => {
    const { dateOverrides } = businessHoursToAvailability({
      dateOverrides: [
        { date: '2026-01-01', endDate: null as unknown as string, closed: true },
        { date: '', closed: true },
      ],
    });

    expect(dateOverrides).toEqual([{ date: '2026-01-01', closed: true }]);
  });

  it('replaces dateOverrides with [] when the spoken hours omit them', () => {
    const spoken: SpokenHours = { schedule: [open('monday')] };
    expect(businessHoursToAvailability(spoken).dateOverrides).toEqual([]);
  });
});

describe('availabilityToBusinessHours — weeklyHours', () => {
  it('emits all seven days; open days take the window, missing days shut', () => {
    const { schedule } = availabilityToBusinessHours({
      weeklyHours: {
        mon: [{ start: '09:00', end: '17:00' }],
        tue: [{ start: '12:00', end: '18:00' }],
      },
    });

    expect(schedule).toHaveLength(7);
    expect(schedule.map((d) => d.day)).toEqual([
      'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    ]);
    expect(schedule.find((d) => d.day === 'monday')).toEqual({
      day: 'monday', open: '09:00', close: '17:00', closed: false,
    });
    expect(schedule.find((d) => d.day === 'tuesday')).toEqual({
      day: 'tuesday', open: '12:00', close: '18:00', closed: false,
    });
    for (const day of ['wednesday', 'thursday', 'friday', 'saturday', 'sunday']) {
      expect(schedule.find((d) => d.day === day)).toEqual({
        day, open: '09:00', close: '17:00', closed: true,
      });
    }
  });

  it('collapses a split shift to the earliest start and latest end', () => {
    const { schedule } = availabilityToBusinessHours({
      weeklyHours: {
        mon: [
          { start: '09:00', end: '12:00' },
          { start: '14:00', end: '18:00' },
        ],
      },
    });

    expect(schedule.find((d) => d.day === 'monday')).toEqual({
      day: 'monday', open: '09:00', close: '18:00', closed: false,
    });
  });

  it('keeps stored clock text on a day that the rule shuts', () => {
    const { schedule } = availabilityToBusinessHours(
      { weeklyHours: { mon: [{ start: '09:00', end: '17:00' }] } },
      [{ day: 'wednesday', open: '08:00', close: '16:00', closed: false }],
    );

    expect(schedule.find((d) => d.day === 'wednesday')).toEqual({
      day: 'wednesday', open: '08:00', close: '16:00', closed: true,
    });
  });
});

describe('availabilityToBusinessHours — dateOverrides', () => {
  it('copies dateOverrides verbatim', () => {
    const dateOverrides = [{ date: '2026-12-25', closed: true }];
    expect(availabilityToBusinessHours({ dateOverrides }).dateOverrides).toEqual(dateOverrides);
  });
});
