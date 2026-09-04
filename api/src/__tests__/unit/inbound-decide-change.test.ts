/**
 * Edge cases for decideInboundChange — pure decision logic for inbound calendar edits.
 */
import { describe, it, expect } from 'vitest';
import { decideInboundChange } from '../../scheduler/inbound-calendar-sync';

const BOOKING = {
  startUtc: new Date('2026-06-15T08:00:00Z'),
  endUtc: new Date('2026-06-15T09:00:00Z'),
};

describe('decideInboundChange', () => {
  it('cancels when the external event vanished', () => {
    expect(decideInboundChange(BOOKING, { kind: 'not_found' })).toEqual({ action: 'cancel' });
  });

  it('defers when access or connection is missing', () => {
    expect(decideInboundChange(BOOKING, { kind: 'no_access' })).toEqual({ action: 'defer' });
    expect(decideInboundChange(BOOKING, { kind: 'no_connection' })).toEqual({ action: 'defer' });
  });

  it('cancels when the provider marks the event cancelled', () => {
    expect(
      decideInboundChange(BOOKING, {
        kind: 'found',
        cancelled: true,
        startISO: '2026-06-15T08:00:00Z',
        endISO: '2026-06-15T09:00:00Z',
      }),
    ).toEqual({ action: 'cancel' });
  });

  it('restores all-day events (null start/end)', () => {
    expect(
      decideInboundChange(BOOKING, {
        kind: 'found',
        cancelled: false,
        startISO: null,
        endISO: null,
      }),
    ).toEqual({ action: 'restore', reasonKey: 'owner.reason_all_day' });
  });

  it('restores invalid ISO timestamps', () => {
    expect(
      decideInboundChange(BOOKING, {
        kind: 'found',
        cancelled: false,
        startISO: 'not-a-date',
        endISO: '2026-06-15T09:00:00Z',
      }),
    ).toEqual({ action: 'restore', reasonKey: 'owner.reason_end_before_start' });
  });

  it('restores when end is not after start', () => {
    expect(
      decideInboundChange(BOOKING, {
        kind: 'found',
        cancelled: false,
        startISO: '2026-06-15T09:00:00Z',
        endISO: '2026-06-15T08:00:00Z',
      }),
    ).toEqual({ action: 'restore', reasonKey: 'owner.reason_end_before_start' });
  });

  it('ignores sub-second drift when times match at second precision', () => {
    expect(
      decideInboundChange(BOOKING, {
        kind: 'found',
        cancelled: false,
        startISO: '2026-06-15T08:00:00.500Z',
        endISO: '2026-06-15T09:00:00.500Z',
      }),
    ).toEqual({ action: 'none' });
  });

  it('moves when start or end differs', () => {
    expect(
      decideInboundChange(BOOKING, {
        kind: 'found',
        cancelled: false,
        startISO: '2026-06-15T10:00:00Z',
        endISO: '2026-06-15T11:00:00Z',
      }),
    ).toEqual({
      action: 'move',
      startISO: '2026-06-15T10:00:00Z',
      durationMin: 60,
    });
  });
});
