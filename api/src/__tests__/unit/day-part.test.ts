import { describe, it, expect } from 'vitest';
import { dayPartWindow, inferDayPartWindow, isDayPartClockWindow } from '../../agent/day-part';

describe('dayPartWindow', () => {
  it('maps Dutch afternoon phrases', () => {
    expect(dayPartWindow('ergens in de namiddag')).toEqual({ from: '12:00', to: '18:00' });
    expect(dayPartWindow('voormiddag')).toEqual({ from: '00:00', to: '12:00' });
    expect(dayPartWindow('vanmiddag')).toEqual({ from: '12:00', to: '18:00' });
  });

  it('maps English and French phrases', () => {
    expect(dayPartWindow('in the morning')).toEqual({ from: '00:00', to: '12:00' });
    expect(dayPartWindow("s avonds")).toEqual({ from: '17:00', to: '24:00' });
  });

  it('returns null when no day part is named', () => {
    expect(dayPartWindow('volgende week')).toBeNull();
  });
});

describe('inferDayPartWindow', () => {
  it('keeps afternoon preference across an address retry', () => {
    expect(
      inferDayPartWindow([
        'Passtraat 248B, 9100 Sint-Niklaas',
        'maandag 7 september, ergens in de namiddag',
      ]),
    ).toEqual({ from: '12:00', to: '18:00' });
  });

  it('returns null when a named clock time is newer than a day part', () => {
    expect(inferDayPartWindow(['om 10:00 graag', 'in de namiddag'])).toBeNull();
  });
});

describe('isDayPartClockWindow', () => {
  it('recognises the named day parts and the afternoon-onward schema shorthand', () => {
    expect(isDayPartClockWindow({ from: '00:00', to: '12:00' })).toBe(true);
    expect(isDayPartClockWindow({ from: '12:00', to: '18:00' })).toBe(true);
    expect(isDayPartClockWindow({ from: '17:00', to: '24:00' })).toBe(true);
    expect(isDayPartClockWindow({ from: '12:00', to: '24:00' })).toBe(true);
  });

  it('does not treat a 30-minute probe around a named clock as a day part', () => {
    expect(isDayPartClockWindow({ from: '08:30', to: '09:00' })).toBe(false);
    expect(isDayPartClockWindow({ from: '08:00', to: '09:00' })).toBe(false);
  });
});
