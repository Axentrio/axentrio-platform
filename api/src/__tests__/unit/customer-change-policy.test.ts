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
  spokenChangeCutoff,
  customerChangeNotAllowedError,
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

  it('demotes auto reschedule 30 minutes before a 1 hour cutoff', () => {
    const start = new Date('2026-06-10T20:00:00.000Z');
    expect(resolveCustomerChange('auto', start, 60, new Date('2026-06-10T19:30:00.000Z'))).toBe(
      'not_allowed',
    );
    expect(resolveCustomerChange('auto', start, 60, new Date('2026-06-10T18:59:00.000Z'))).toBe('auto');
  });

  it('still applies cutoff when startUtc arrives as an ISO string', () => {
    const start = '2026-06-10T20:00:00.000Z' as unknown as Date;
    expect(resolveCustomerChange('auto', start, 60, new Date('2026-06-10T19:30:00.000Z'))).toBe(
      'not_allowed',
    );
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

describe('spokenChangeCutoff', () => {
  it('names hours, days, minutes, and a zero cutoff', () => {
    expect(spokenChangeCutoff(null)).toBeNull();
    expect(spokenChangeCutoff(0)).toBe('after the appointment has started');
    expect(spokenChangeCutoff(60)).toBe('1 hour before the appointment');
    expect(spokenChangeCutoff(120)).toBe('2 hours before the appointment');
    expect(spokenChangeCutoff(1440)).toBe('1 day before the appointment');
    expect(spokenChangeCutoff(90)).toBe('90 minutes before the appointment');
  });
});

describe('customerChangeNotAllowedError', () => {
  it('names the cutoff duration and forbids a first-refusal handoff', () => {
    const err = customerChangeNotAllowedError(undefined, 'cancel', 60);
    expect(err.code).toBe('CHANGE_NOT_ALLOWED');
    expect(err.message).toMatch(/1 hour before the appointment/);
    expect(err.message).toMatch(/it is not possible to cancel 1 hour before the appointment/);
    expect(err.message).toMatch(/do not tell them to contact the business/i);
    expect(err.message).toMatch(/do not call escalate_to_human on this first refusal/);
    expect(err.message).toMatch(/keep insisting after you have explained the cutoff/);
    expect(err.details).toEqual({ action: 'cancel', reason: 'cutoff', untilMin: 60 });
    expect(err.customerMessage).toMatch(/1 hour before the appointment/);
    expect(err.customerMessage).not.toMatch(/escalate_to_human|request_appointment/);
  });

  it('keeps the generic refusal when the Service forbids the action outright', () => {
    const err = customerChangeNotAllowedError(undefined, 'cancel');
    expect(err.message).toMatch(/cannot cancel this appointment here/);
    expect(err.message).toMatch(/Do not invent a deadline/);
    expect(err.message).not.toMatch(/the cutoff is/);
    expect(err.details).toEqual({ action: 'cancel' });
  });

  it('treats untilMin 0 as a cutoff after the start', () => {
    const err = customerChangeNotAllowedError(undefined, 'reschedule', 0);
    expect(err.message).toMatch(/after the appointment has started/);
    expect(err.details).toEqual({ action: 'reschedule', reason: 'cutoff', untilMin: 0 });
  });
});
