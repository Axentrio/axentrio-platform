import { describe, it, expect } from 'vitest';
import { parseBookingStart } from '../../n8n/booking-providers/internal.provider';

describe('parseBookingStart', () => {
  it('reads a ZONELESS time as business-local wall-clock (the "2 PM" fix)', () => {
    // 14:00 in Brussels (UTC+2 in June) → 12:00 UTC. Before the fix this stored
    // 14:00 UTC (= 16:00 Brussels) on a UTC server.
    const d = parseBookingStart('2026-06-19T14:00:00', 'Europe/Brussels');
    expect(d?.toISOString()).toBe('2026-06-19T12:00:00.000Z');
  });

  it('honors an explicit Z (a check_availability slot keeps its instant)', () => {
    const d = parseBookingStart('2026-06-19T14:00:00Z', 'Europe/Brussels');
    expect(d?.toISOString()).toBe('2026-06-19T14:00:00.000Z');
  });

  it('honors an explicit offset', () => {
    const d = parseBookingStart('2026-06-19T14:00:00+02:00', 'Europe/Brussels');
    expect(d?.toISOString()).toBe('2026-06-19T12:00:00.000Z');
  });

  it('is timezone-correct in a negative-offset zone too', () => {
    // 09:00 New York (UTC-4 in June) → 13:00 UTC.
    const d = parseBookingStart('2026-06-19T09:00:00', 'America/New_York');
    expect(d?.toISOString()).toBe('2026-06-19T13:00:00.000Z');
  });

  it('reads a loose space-separated time as business-local (not server-local)', () => {
    // "2026-06-19 14:00" (space, not 'T') — a common model output. fromISO rejects
    // it, so it must go through fromSQL anchored to Brussels (14:00 → 12:00 UTC),
    // NOT new Date() which would read it as server-local (UTC) → wrong hour.
    const d = parseBookingStart('2026-06-19 14:00:00', 'Europe/Brussels');
    expect(d?.toISOString()).toBe('2026-06-19T12:00:00.000Z');
  });

  it('returns null for an unparseable string', () => {
    expect(parseBookingStart('not a time', 'Europe/Brussels')).toBeNull();
    expect(parseBookingStart('June 19 2026 2pm', 'Europe/Brussels')).toBeNull();
  });
});
