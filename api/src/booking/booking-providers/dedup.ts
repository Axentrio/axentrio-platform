/**
 * Booking idempotency and duplicate detection: the shared identity rule for
 * "same booking", the dedup window, and the idempotent-return binding cleanup.
 */
import { Raw } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { logger } from '../../utils/logger';
import {
  AddressBindingMovedError,
  consumeAddressBinding,
} from '../travel/address-binding';
import { addressToken } from '../travel/address-for-turn';
import type { Booking } from '../../database/entities/Booking';
import type { BookingContext, BookingExtras } from './types';

/**
 * Idempotency/dedup window (#35). The booking idempotency key is stable per
 * session+service+time, so we only treat a matching row as "the same booking" when
 * it was created within this window — collapsing a rapid re-confirm ("yes go ahead"
 * seconds later) while still allowing a genuine re-booking of the same service+time
 * later in a long-lived (Messenger/WhatsApp) session.
 */
const BOOKING_DEDUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * An idempotent return has no new booking INSERT to share a transaction with: the row already
 * exists. Still consume the binding used by this retry, but never clear a newer generation that
 * arrived while the duplicate lookup was running.
 */
export async function consumeBindingAfterIdempotentReturn(
  ctx: BookingContext,
  extras?: BookingExtras
): Promise<void> {
  if (!extras?.addressBinding) return;
  try {
    await AppDataSource.transaction((manager) =>
      consumeAddressBinding(manager, ctx.session.id, extras.addressBinding)
    );
  } catch (error) {
    if (error instanceof AddressBindingMovedError) return;
    logger.warn('[Booking] could not consume address binding after idempotent return', {
      sessionId: ctx.session.id,
      error,
    });
  }
}

/**
 * The identity two calls must share to be the same booking.
 *
 * ONE function for BOTH duplicate checks, and that is the point rather than tidiness. There are two
 * gates - the idempotency key and `(session, service, startUtc)` - and the first fix for #92 taught
 * only the key about the address. The second gate then collapsed the corrected booking anyway, so
 * the bug survived a fix that its own tests said had worked. Two gates deciding "same booking" by
 * two different rules is what allowed that, and one shared rule is what stops it recurring.
 *
 * Computed AFTER the service is resolved, because two of the three inputs depend on it.
 *
 * ## The address is excluded when the service does not have one
 *
 * A phone consult can still carry an address - inherited from an earlier turn in the session, or
 * volunteered by a customer who mentioned where they live. Letting that participate would make an
 * incidental detail decide whether two calls are the same booking, and produce duplicates for the
 * services that never had this problem. `customerAddressRequired` is the question of whether the
 * address is part of the booking at all.
 *
 * ## A geocoded place id is NOT the customer's identity for the place
 *
 * `createRequest` stores a `place_id` derived from the text whenever it can, so a row created from
 * typed words comes back carrying an identity the customer never supplied. Comparing that against a
 * later turn's raw text finds them different and inserts a SECOND request - a genuine re-confirm
 * turned into two live rows for the owner to untangle, which is the failure `#35` added the second
 * gate to prevent. So a stored `place_id` only counts as identity when `location_source = 'pin'`,
 * which is the flag that records the customer actually picked it.
 */
export function dedupIdentity(input: {
  addressRequired: boolean;
  address?: string | null;
  placeId?: string | null;
  /** False for a `place_id` this system derived rather than the customer choosing it. */
  placeIdIsPicked: boolean;
}): string {
  if (!input.addressRequired) return 'noaddr';
  return addressToken({
    address: input.address ?? undefined,
    placeId: input.placeIdIsPicked ? (input.placeId ?? undefined) : undefined,
  });
}

/** The stored row's identity, read with its own provenance. */
export function rowDedupIdentity(row: Booking, addressRequired: boolean): string {
  return dedupIdentity({
    addressRequired,
    address: row.customerAddress,
    placeId: row.customerPlaceId,
    placeIdIsPicked: row.locationSource === 'pin',
  });
}

/** The incoming call's identity. Anything it supplies as a place id came from a customer pick. */
export function callDedupIdentity(addressRequired: boolean, extras?: BookingExtras): string {
  return dedupIdentity({
    addressRequired,
    address: extras?.customerAddress,
    placeId: extras?.customerPlaceId,
    placeIdIsPicked: true,
  });
}

/**
 * "Created recently enough to count as a duplicate", asked of the DATABASE rather than of us.
 *
 * `createdAt: MoreThan(new Date(Date.now() - WINDOW))` looks equivalent and is not.
 * `chatbot_bookings.created_at` is `timestamp WITHOUT time zone` - `@CreateDateColumn` carries no
 * explicit type, unlike `start_utc` which is explicitly `timestamptz` - so comparing it against a
 * timezone-aware instant is off by the client's UTC offset. On a developer machine at UTC+8 the
 * cutoff lands eight hours in the future and a row created seventeen milliseconds ago is judged
 * too old, so the lookup finds nothing and BOTH dedup gates silently stop deduping.
 *
 * It fails OPEN, into duplicate bookings, and it is invisible: no error, just a query that never
 * matches. Anyone developing outside UTC has been running without request deduplication without
 * knowing. Production runs UTC, where the two coincide, which is why this never surfaced there.
 *
 * Letting Postgres compare its own clock to its own column removes the client's timezone from the
 * question entirely. Preferred over migrating the column to `timestamptz`, which would rewrite a
 * large table under an ACCESS EXCLUSIVE lock to fix something that only bites developers.
 */
export const createdWithinDedupWindow = () =>
  Raw((alias) => `${alias} > now() - interval '${BOOKING_DEDUP_WINDOW_MS} milliseconds'`);
