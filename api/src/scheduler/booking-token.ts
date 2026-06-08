/**
 * Signed tokens for customer self-service booking links. The token carries only
 * the booking id; it's the bearer's authorization to view/cancel/reschedule that
 * one booking (the link is emailed only to the attendee). Reused across the
 * booking lifetime so the same "manage" link keeps working after a reschedule.
 */
import jwt from 'jsonwebtoken';
import { config } from '../config/environment';

const TOKEN_TYPE = 'booking_manage';

// Server-only secret, shared with the OAuth-state signer (same trust domain).
// Read at call time (not import time) and fail closed — no dev fallback, so a
// missing secret can never be forged with a public default. See security audit #E.
function getSecret(): string {
  const secret = config.google.stateJwtSecret;
  if (!secret) {
    throw new Error('Booking token secret is not configured (META_OAUTH_JWT_SECRET)');
  }
  return secret;
}

export function signBookingToken(bookingId: string): string {
  return jwt.sign({ bookingId, t: TOKEN_TYPE }, getSecret(), { expiresIn: '120d' });
}

export function verifyBookingToken(token: string): { bookingId: string } {
  const decoded = jwt.verify(token, getSecret()) as { bookingId?: string; t?: string };
  if (decoded.t !== TOKEN_TYPE || !decoded.bookingId) {
    throw new Error('Invalid booking token');
  }
  return { bookingId: decoded.bookingId };
}

/** Absolute URL to the self-service manage page (used in emails). */
export function buildManageUrl(bookingId: string): string {
  return `${config.api.url}/api/v1/bookings/manage?token=${encodeURIComponent(signBookingToken(bookingId))}`;
}
