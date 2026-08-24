/**
 * The one rule both duplicate checks use to decide "same booking".
 *
 * Two gates decided this by two different rules, and that is how the first #92 fix passed its own
 * tests while the bug survived: the key learned about the address and `(session, service,
 * startUtc)` did not. These tests pin the shared rule, and each case below is a failure that has
 * either happened in production or was found in review of the fix for it.
 */
import { describe, it, expect } from 'vitest';
import { dedupIdentity } from '../../booking/booking-providers/dedup';

const call = (address?: string | null, placeId?: string | null, addressRequired = true) =>
  dedupIdentity({ addressRequired, address, placeId, placeIdIsPicked: true });
/** A row as `createRequest` leaves it: the place id was DERIVED, not chosen. */
const geocodedRow = (address: string, placeId: string) =>
  dedupIdentity({ addressRequired: true, address, placeId, placeIdIsPicked: false });

describe('dedupIdentity', () => {
  it('separates a corrected address from the one it replaced - the original bug', () => {
    expect(call('Place Saint-Lambert 1, 4000 Liege')).not.toBe(call('Turnhoutsebaan 100, 2140 Antwerpen'));
  });

  it('does NOT split a re-confirm just because the stored row was geocoded meanwhile', () => {
    // The regression review found: `createRequest` persists a place id derived from the text, so a
    // row created from typed words comes back carrying an identity the customer never gave. Read as
    // identity, it differs from the same customer's next turn and inserts a SECOND live request -
    // which is exactly what the second gate exists to prevent.
    expect(geocodedRow('Meir 78, 2000 Antwerpen', 'ChIJ_derived')).toBe(call('Meir 78, 2000 Antwerpen'));
  });

  it('still honours an identity the customer actually PICKED', () => {
    expect(call('Grote Markt 1, Antwerpen', 'ChIJ_x')).toBe(call('Grote Markt 1, 2000 Antwerpen, Belgium', 'ChIJ_x'));
    expect(call('Grote Markt 1', 'ChIJ_x')).not.toBe(call('Grote Markt 1', 'ChIJ_y'));
  });

  it('ignores an address entirely when the service does not have one', () => {
    // A phone consult can carry an address inherited from an earlier turn or simply mentioned.
    // Letting it decide identity would produce duplicates for the services that never had this bug.
    expect(call('Meir 78, 2000 Antwerpen', null, false)).toBe(call(undefined, null, false));
    expect(call('Meir 78', null, false)).toBe(call('Somewhere else entirely', null, false));
  });

  it('forgives the rewriting a model does without meaning anything by it', () => {
    expect(call('  meir 78,  2000   antwerpen ')).toBe(call('Meir 78, 2000 Antwerpen'));
  });

  it('separates two doors on one street', () => {
    expect(call('Kerkstraat 1, 2060 Antwerpen')).not.toBe(call('Kerkstraat 12, 2060 Antwerpen'));
  });

  it('cannot confuse a place id with an address that happens to read like one', () => {
    // Domain separation: without it the two kinds of claim share one input space.
    expect(call(undefined, 'ChIJ_x')).not.toBe(call('ChIJ_x'));
  });

  it('treats a blank address as no address, matching what the CHECK constraint permits', () => {
    expect(call('   ')).toBe(call(undefined));
  });
});
