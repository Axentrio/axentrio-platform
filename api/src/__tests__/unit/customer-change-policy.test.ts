/**
 * Per-service customer reschedule/cancel policy.
 *
 * Cutoff only tightens. `untilMin` 0 is a real cutoff (until the start instant).
 * `null`/`undefined` means no extra cutoff. Auto-book of the original booking is
 * not an input — callers must pass the Service's change mode, never bookingMode.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveCustomerChange,
  subjectToCustomerChangePolicy,
  catalogChangeClause,
  formatChangeCutoff,
} from '../../booking/customer-change-policy';

const START = new Date('2026-06-10T08:00:00.000Z');

describe('resolveCustomerChange', () => {
  it('returns not_allowed regardless of cutoff', () => {
    expect(resolveCustomerChange('not_allowed', START, null, new Date('2026-06-01T00:00:00.000Z'))).toBe(
      'not_allowed',
    );
    expect(resolveCustomerChange('not_allowed', START, 0, new Date('2026-06-01T00:00:00.000Z'))).toBe(
      'not_allowed',
    );
  });

  it('keeps auto and request when there is no extra cutoff', () => {
    const now = new Date('2026-06-10T07:59:00.000Z');
    expect(resolveCustomerChange('auto', START, null, now)).toBe('auto');
    expect(resolveCustomerChange('request', START, undefined, now)).toBe('request');
  });

  it('treats untilMin 0 as a cutoff at the start instant, not as absent', () => {
    expect(resolveCustomerChange('auto', START, 0, new Date('2026-06-10T07:59:59.000Z'))).toBe('auto');
    expect(resolveCustomerChange('auto', START, 0, new Date('2026-06-10T08:00:00.001Z'))).toBe(
      'not_allowed',
    );
  });

  it('demotes auto and request to not_allowed once inside the cutoff window', () => {
    const untilMin = 24 * 60;
    const inside = new Date('2026-06-09T08:00:01.000Z');
    const outside = new Date('2026-06-09T07:59:59.000Z');
    expect(resolveCustomerChange('auto', START, untilMin, outside)).toBe('auto');
    expect(resolveCustomerChange('request', START, untilMin, inside)).toBe('not_allowed');
    expect(resolveCustomerChange('auto', START, untilMin, inside)).toBe('not_allowed');
  });
});

describe('subjectToCustomerChangePolicy', () => {
  it('binds the Booking Customer paths and not the owner or inbound sync', () => {
    expect(subjectToCustomerChangePolicy('agent')).toBe(true);
    expect(subjectToCustomerChangePolicy('internal-n8n')).toBe(true);
    expect(subjectToCustomerChangePolicy({ kind: 'public-manage', verifiedBookingId: 'bk-1' })).toBe(
      true,
    );
    expect(subjectToCustomerChangePolicy('scheduler-admin')).toBe(false);
  });
});

describe('catalogChangeClause', () => {
  it('defaults a missing mode to request, never to auto', () => {
    expect(catalogChangeClause('reschedule', undefined, null)).toBe('reschedule: request');
    expect(catalogChangeClause('cancel', null, undefined)).toBe('cancel: request');
  });

  it('names a cutoff only when the action is still allowed', () => {
    expect(catalogChangeClause('reschedule', 'auto', 1440)).toBe('reschedule: auto until 1d before');
    expect(catalogChangeClause('cancel', 'request', 120)).toBe('cancel: request until 2h before');
    expect(catalogChangeClause('cancel', 'not_allowed', 120)).toBe('cancel: not_allowed');
  });
});

describe('formatChangeCutoff', () => {
  it('treats 0 as until start and null as absent', () => {
    expect(formatChangeCutoff(null)).toBeNull();
    expect(formatChangeCutoff(0)).toBe('until start');
    expect(formatChangeCutoff(90)).toBe('until 90min before');
  });
});
