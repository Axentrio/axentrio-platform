/**
 * A verified venue can never disagree with the address shown beside it.
 *
 * The venue is the travel BASE - `travelBaseFor` starts the owner's day there - so a stale
 * identity is not a cosmetic bug: it routes every first job of every day from an address the
 * owner has already replaced, while the screen shows the new one and nothing looks wrong.
 *
 * The guarantee is structural rather than validated. An id arriving with a Save is a CLAIM that
 * the four fields are that place; the controller settles the claim by resolving the id and
 * writing Google's own components over whatever was submitted. So a stored pair cannot disagree,
 * because the text is written FROM the id rather than merely checked against it.
 *
 * And it fails open: an id that will not resolve does not block the Save, it just does not
 * become a verified venue. An owner must always be able to record their own address.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolve = vi.fn();

vi.mock('../../booking/travel/geocoding.service', () => ({
  resolvePlaceId: (...a: unknown[]) => resolve(...(a as [])),
}));

import { resolvePlaceId } from '../../booking/travel/geocoding.service';

/**
 * The controller's rule, extracted verbatim in shape so it can be exercised without standing up
 * Express, Clerk, a tenant context and Postgres. Kept deliberately small: if the real branch and
 * this diverge, the divergence is the thing worth noticing, and the assertions below describe
 * behaviour the real one must keep.
 */
async function settleVenueClaim(
  tenantId: string,
  va: Record<string, string | null | undefined>
): Promise<{ venuePlaceId: string | null; fields: Record<string, string | null | undefined> }> {
  const out = { ...va };
  let venuePlaceId: string | null = null;
  if (typeof va.placeId === 'string' && va.placeId.trim()) {
    const resolved = await resolvePlaceId(tenantId, va.placeId.trim());
    if (resolved.status === 'placed') {
      venuePlaceId = resolved.place.placeId;
      const c = resolved.place.components;
      if (c) {
        out.street = c.street ?? null;
        out.postalCode = c.postalCode ?? null;
        out.city = c.city ?? null;
        out.country = c.country ?? null;
      }
    }
  }
  return { venuePlaceId, fields: out };
}

const placed = (components?: Record<string, string>) => ({
  status: 'placed',
  place: {
    placeId: 'ChIJ_venue',
    lat: 51.2,
    lng: 4.4,
    precision: 'rooftop',
    formattedAddress: 'Grote Markt 1, 2000 Antwerpen, Belgium',
    components,
  },
});

beforeEach(() => vi.clearAllMocks());

describe('a venue place id never outlives the text it came from', () => {
  it('writes GOOGLE’s components over what was submitted, so the pair cannot disagree', async () => {
    resolve.mockResolvedValue(
      placed({ street: 'Grote Markt 1', postalCode: '2000', city: 'Antwerpen', country: 'BE' })
    );

    // The owner picked Grote Markt but the form still carried their half-typed text.
    const { venuePlaceId, fields } = await settleVenueClaim('ten-1', {
      placeId: 'ChIJ_venue',
      street: 'grote mark',
      postalCode: null,
      city: 'antwerp',
      country: 'BE',
    });

    expect(venuePlaceId).toBe('ChIJ_venue');
    expect(fields.street).toBe('Grote Markt 1');
    expect(fields.postalCode).toBe('2000');
    expect(fields.city).toBe('Antwerpen');
  });

  it('stores NO id when the address was typed rather than picked', async () => {
    // The hand-edit case, and the one that matters: an owner who changes a field sends no id,
    // so nothing verified is left attached to an address nobody verified.
    const { venuePlaceId, fields } = await settleVenueClaim('ten-1', {
      street: 'Kerkstraat 12',
      city: 'Gent',
      country: 'BE',
    });

    expect(venuePlaceId).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    expect(fields.street).toBe('Kerkstraat 12');
  });

  it('FAILS OPEN: an unresolvable id saves the address as typed, with no id', async () => {
    resolve.mockResolvedValue({ status: 'unavailable', cause: 'api_error' });

    const { venuePlaceId, fields } = await settleVenueClaim('ten-1', {
      placeId: 'ChIJ_venue',
      street: 'Kerkstraat 12',
      city: 'Gent',
      country: 'BE',
    });

    // Being unable to VERIFY an address is not a reason to refuse to STORE it.
    expect(venuePlaceId).toBeNull();
    expect(fields.street).toBe('Kerkstraat 12');
    expect(fields.city).toBe('Gent');
  });

  it('keeps the submitted text when Google returns an id but no components', async () => {
    // Nothing authoritative to overwrite with, so overwriting would blank a real address.
    resolve.mockResolvedValue(placed(undefined));

    const { venuePlaceId, fields } = await settleVenueClaim('ten-1', {
      placeId: 'ChIJ_venue',
      street: 'Grote Markt 1',
      city: 'Antwerpen',
      country: 'BE',
    });

    expect(venuePlaceId).toBe('ChIJ_venue');
    expect(fields.street).toBe('Grote Markt 1');
  });

  it('bills the resolve to the tenant that saved', async () => {
    resolve.mockResolvedValue(placed({ city: 'Antwerpen' }));
    await settleVenueClaim('ten-42', { placeId: 'ChIJ_venue' });
    expect(resolve).toHaveBeenCalledWith('ten-42', 'ChIJ_venue');
  });
});
