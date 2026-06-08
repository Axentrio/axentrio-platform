import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable mocked config so getSecret() (read at call time) reflects changes.
// vi.hoisted so `cfg` exists before the hoisted vi.mock factory runs.
const cfg = vi.hoisted(() => ({ google: { stateJwtSecret: '' as string } }));
vi.mock('../../config/environment', () => ({ config: cfg }));

import { signBookingToken, verifyBookingToken } from '../../scheduler/booking-token';

describe('booking-token fail-closed secret (#E)', () => {
  beforeEach(() => { cfg.google.stateJwtSecret = ''; });

  it('throws when the secret is not configured (no dev fallback)', () => {
    expect(() => signBookingToken('booking-1')).toThrow(/not configured/i);
    expect(() => verifyBookingToken('whatever')).toThrow();
  });

  it('round-trips when the secret is set', () => {
    cfg.google.stateJwtSecret = 'a'.repeat(40);
    const token = signBookingToken('booking-42');
    expect(verifyBookingToken(token)).toEqual({ bookingId: 'booking-42' });
  });

  it('a token signed with the old hardcoded dev fallback is rejected', () => {
    cfg.google.stateJwtSecret = 'a'.repeat(40);
    // forge with the removed literal fallback secret → must not verify
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ bookingId: 'x', t: 'booking_manage' }, 'booking-manage-dev-secret');
    expect(() => verifyBookingToken(forged)).toThrow();
  });
});
