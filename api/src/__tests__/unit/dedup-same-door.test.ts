/**
 * The dedup gate that swallowed the #92 fix.
 *
 * `request_appointment` and `create_booking` each have TWO duplicate checks. The first is the
 * idempotency key, which was taught about the address in 01bb3a0. The second - `(session, service,
 * startUtc)` - carries no address at all, and it runs afterwards. So the corrected address still
 * collapsed onto the original row, and production still told a customer their booking was at an
 * address the database had never held. Three tool calls, one row.
 *
 * The lesson these tests exist to enforce: the earlier fix was verified by asserting the KEY
 * differed, which is necessary and not sufficient. What matters is whether the two calls are
 * treated as the same booking, and that is decided here.
 */
import { describe, it, expect } from 'vitest';
import { dedupIsSameDoor } from '../../booking/booking-providers/internal.provider';
import type { Booking } from '../../database/entities/Booking';

const row = (address?: string | null, placeId?: string | null) =>
  ({ customerAddress: address ?? null, customerPlaceId: placeId ?? null }) as Booking;

describe('dedupIsSameDoor', () => {
  it('refuses to dedup a CORRECTED address, which is the whole bug', () => {
    expect(
      dedupIsSameDoor(row('Place Saint-Lambert 1, 4000 Liege'), {
        customerAddress: 'Turnhoutsebaan 100, 2140 Antwerpen',
      })
    ).toBe(false);
  });

  it('still dedups a genuine re-confirm, which is why the gate exists (#35)', () => {
    expect(
      dedupIsSameDoor(row('Meir 78, 2000 Antwerpen'), { customerAddress: 'Meir 78, 2000 Antwerpen' })
    ).toBe(true);
  });

  it('treats the rewriting a model does as the same door', () => {
    // If these differed, every re-confirm would insert a duplicate request and #35 would be back.
    expect(
      dedupIsSameDoor(row('Meir 78, 2000 Antwerpen'), { customerAddress: '  meir 78,  2000   antwerpen ' })
    ).toBe(true);
  });

  it('separates two doors on one street', () => {
    expect(
      dedupIsSameDoor(row('Kerkstraat 1, 2060 Antwerpen'), { customerAddress: 'Kerkstraat 12, 2060 Antwerpen' })
    ).toBe(false);
  });

  it('prefers the identity the customer picked over the words around it', () => {
    expect(dedupIsSameDoor(row('Grote Markt 1', 'ChIJ_x'), { customerAddress: 'Grote Markt 1, 2000 Antwerpen', customerPlaceId: 'ChIJ_x' })).toBe(true);
    expect(dedupIsSameDoor(row('Grote Markt 1', 'ChIJ_x'), { customerAddress: 'Grote Markt 1', customerPlaceId: 'ChIJ_y' })).toBe(false);
  });

  it('leaves address-free services deduping exactly as before', () => {
    // Both sides collapse to the same constant, so a phone consult is untouched by all of this.
    expect(dedupIsSameDoor(row(null), {})).toBe(true);
    expect(dedupIsSameDoor(row(null), undefined)).toBe(true);
  });
});
