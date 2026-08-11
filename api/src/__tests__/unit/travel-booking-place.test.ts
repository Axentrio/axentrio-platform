/**
 * Placing a booking's address. Two things matter here and neither is about geocoding: WHO is
 * allowed to spend an element, and what a placement becomes once it reaches a row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const update = vi.fn(async () => ({ affected: 1 }));
vi.mock('../../database/data-source', () => ({
  AppDataSource: { getRepository: () => ({ update: (...a: unknown[]) => update(...(a as [])) }) },
}));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const eligibility = vi.fn();
vi.mock('../../booking/travel/travel-eligibility', () => ({
  resolveTravelEligibility: (...a: unknown[]) => eligibility(...(a as [])),
}));

const geocode = vi.fn();
const byPlaceId = vi.fn();
// Only the two calls that reach the network are replaced. `isUsablePlace` stays REAL, because
// it is the boundary a stored row has to cross and stubbing it would test nothing.
vi.mock('../../booking/travel/geocoding.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../booking/travel/geocoding.service')>();
  return {
    ...actual,
    geocodeAddress: (...a: unknown[]) => geocode(...(a as [])),
    resolvePlaceId: (...a: unknown[]) => byPlaceId(...(a as [])),
  };
});

import type { Booking } from '../../database/entities/Booking';
import type { ServiceType } from '../../database/entities/ServiceType';
import type { ActiveTravelEligibility } from '../../booking/travel/travel-eligibility';
import {
  placeBookingAddress,
  placeAddressFor,
  bookingPlaceColumns,
  placementIsTrusted,
  placementIsCoarse,
  blocksAutoConfirm,
  requestTravelCheck,
  ensureBookingPlace,
  placeExistingBooking,
  type BookingPlacement,
} from '../../booking/travel/booking-place';

const ACTIVE: ActiveTravelEligibility = {
  active: true,
  tenantId: 'ten-1',
  itineraryKey: 'cal:abc' as ActiveTravelEligibility['itineraryKey'],
  slackMin: 5,
  startFromBase: false, maxDetourMin: null, baseDepartOffsetMin: 0, preferClusters: false,
};
const PLACE = {
  placeId: 'ChIJ_place',
  lat: 51.05,
  lng: 3.72,
  precision: 'rooftop' as const,
  formattedAddress: 'Kerkstraat 12, 9000 Gent, Belgium',
};

const addressService = { customerAddressRequired: true } as ServiceType;
const call = (over: Partial<Parameters<typeof placeBookingAddress>[0]> = {}) =>
  placeBookingAddress({
    tenantId: 'ten-1',
    botId: 'bot-1',
    itineraryKey: 'cal:abc' as never,
    service: addressService,
    address: 'Kerkstraat 12, 9000 Gent',
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  eligibility.mockResolvedValue(ACTIVE);
  geocode.mockResolvedValue({ status: 'placed', place: PLACE });
  byPlaceId.mockResolvedValue({ status: 'placed', place: PLACE });
});

describe('placeBookingAddress - who is allowed to spend', () => {
  it('places an address for an address-required service on an eligible Agent', async () => {
    expect(await call()).toEqual({ applies: true, outcome: 'placed', place: PLACE });
  });

  it('never asks about a service that needs no address, not even the gates', async () => {
    // A phone consultation is not a travel job however the Agent is configured, so this
    // short-circuits before the entitlement resolve rather than after it.
    expect(await call({ service: { customerAddressRequired: false } as ServiceType })).toEqual({
      applies: false,
    });
    expect(eligibility).not.toHaveBeenCalled();
    expect(geocode).not.toHaveBeenCalled();
  });

  it.each([null, '', '   '])('does nothing with an address of %p', async (address) => {
    expect(await call({ address })).toEqual({ applies: false });
    expect(geocode).not.toHaveBeenCalled();
  });

  it.each(['no_api_key', 'not_entitled', 'bot_disabled', 'shared_itinerary'])(
    'spends nothing when the gates answer %s',
    async (reason) => {
      eligibility.mockResolvedValue({ active: false, reason });
      expect(await call()).toEqual({ applies: false });
      expect(geocode).not.toHaveBeenCalled();
    }
  );

  it('hands the itinerary key down rather than letting anything re-derive one', async () => {
    await call({ itineraryKey: 'cal:handed-down' as never });
    // ADR-0016: availability, create, request, accept and reschedule each resolve the key
    // once. A helper that resolved its own could scope to a different diary than the lock.
    expect(eligibility).toHaveBeenCalledWith(
      expect.objectContaining({ itineraryKey: 'cal:handed-down' })
    );
  });

  it('returns an approximate placement in full, and calls it untrusted', async () => {
    geocode.mockResolvedValue({ status: 'placed', place: { ...PLACE, precision: 'approximate' } });
    const placement = await call();
    expect(placement).toMatchObject({ outcome: 'placed' });
    expect(placementIsTrusted(placement)).toBe(false);
  });

  it.each(['not_placeable', 'unavailable'] as const)('passes %s through unchanged', async (status) => {
    geocode.mockResolvedValue({ status, cause: 'whatever' });
    expect(await call()).toEqual({ applies: true, outcome: status });
  });

  it('hands the gate proof to the geocoder rather than a bare tenant id', async () => {
    await call();
    // The one thing standing between a runaway caller and a Google bill is that this
    // argument cannot be produced without passing all four gates.
    expect(geocode).toHaveBeenCalledWith(ACTIVE, 'Kerkstraat 12, 9000 Gent');
  });
});

describe('placing by identity when the customer picked one', () => {
  it('resolves the place id instead of geocoding the words again', async () => {
    // The headline criterion of this whole feature: the slot that was checked and the booking
    // that was made are about ONE place by construction, rather than about two strings that
    // happen to agree. Forward-geocoding a string Google itself produced gets the same answer at
    // best - resolving the identity is exact, and one element cheaper.
    byPlaceId.mockResolvedValue({ status: 'placed', place: PLACE });
    await placeAddressFor(ACTIVE, 'Kerkstraat 12, 9000 Gent', 'ChIJ_picked');

    expect(byPlaceId).toHaveBeenCalledWith(ACTIVE.tenantId, 'ChIJ_picked');
    expect(geocode).not.toHaveBeenCalled();
  });

  it('still geocodes the text when nothing was picked', async () => {
    // Every booking on the platform today, and the path that must not change.
    await placeAddressFor(ACTIVE, 'Kerkstraat 12, 9000 Gent');
    expect(geocode).toHaveBeenCalledWith(ACTIVE, 'Kerkstraat 12, 9000 Gent');
    expect(byPlaceId).not.toHaveBeenCalled();
  });
});

describe('the three readings of a placement', () => {
  const placed = (precision: string): BookingPlacement =>
    ({ applies: true, outcome: 'placed', place: { ...PLACE, precision } }) as BookingPlacement;

  it('trusts a rooftop placement and nothing else about it', () => {
    expect(placementIsTrusted(placed('rooftop'))).toBe(true);
    expect(placementIsTrusted(placed('geometric_center'))).toBe(true);
    // A town centre collapses a whole municipality onto one dot.
    expect(placementIsTrusted(placed('approximate'))).toBe(false);
    expect(placementIsTrusted({ applies: false })).toBe(false);
  });

  it('marks a town-centre placement coarse, and nothing else', () => {
    expect(placementIsCoarse(placed('approximate'))).toBe(true);
    expect(placementIsCoarse(placed('rooftop'))).toBe(false);
    expect(placementIsCoarse({ applies: true, outcome: 'not_placeable' })).toBe(false);
    expect(placementIsCoarse({ applies: false })).toBe(false);
  });

  it('blocks an auto-confirm ONLY for an address the customer can fix', () => {
    expect(blocksAutoConfirm({ applies: true, outcome: 'not_placeable' })).toBe(true);
    // A town centre no longer stops the booking dead. It is a real point that can prove a
    // drive impossible and can never clear one, so the travel gate takes it from here — which
    // leaves the customer with times to request instead of a dead end.
    expect(blocksAutoConfirm(placed('approximate'))).toBe(false);
    // Google being unreachable is not a vague address. Refusing a booking over someone
    // else's downtime is the failure ADR-0015 exists to prevent.
    expect(blocksAutoConfirm({ applies: true, outcome: 'unavailable' })).toBe(false);
    expect(blocksAutoConfirm(placed('rooftop'))).toBe(false);
    expect(blocksAutoConfirm({ applies: false })).toBe(false);
  });

  it('captures a request for everything the gate could not clear, including a coarse one', () => {
    // Wider than `blocksAutoConfirm` on purpose: a request row records that nothing vouched
    // for the drive, which is true of a vague address AND of one placed only to a town.
    expect(requestTravelCheck(placed('approximate'))).toBe('captured');
    expect(requestTravelCheck({ applies: true, outcome: 'not_placeable' })).toBe('captured');
    expect(requestTravelCheck(placed('rooftop'))).toBeNull();
    expect(requestTravelCheck({ applies: false })).toBeNull();
  });

  it('never blocks a confirm for something a request would not have flagged', () => {
    // The direction that matters: anything the auto path refuses must also be visible on a
    // request row. The reverse does not hold — a coarse address is captured, not refused.
    for (const p of [placed('rooftop'), placed('approximate'), { applies: false } as BookingPlacement,
      { applies: true, outcome: 'not_placeable' } as BookingPlacement]) {
      if (blocksAutoConfirm(p)) expect(requestTravelCheck(p)).toBe('captured');
    }
  });
});

describe('bookingPlaceColumns', () => {
  it('writes the full placement, coordinates stamped for the deletion job', async () => {
    const columns = bookingPlaceColumns({ applies: true, outcome: 'placed', place: PLACE });
    expect(columns).toMatchObject({
      placeId: 'ChIJ_place',
      lat: 51.05,
      lng: 3.72,
      addressVerified: 'Kerkstraat 12, 9000 Gent, Belgium',
      precision: 'rooftop',
      locationSource: 'geocoded',
    });
    expect(columns.coordsAt).toBeInstanceOf(Date);
  });

  it('stores an UNTRUSTED placement in full', () => {
    // Dropping it would leave no record of what the gate had to work with, and a town
    // centre can still prove a drive impossible.
    expect(
      bookingPlaceColumns({ applies: true, outcome: 'placed', place: { ...PLACE, precision: 'approximate' } })
    ).toMatchObject({ precision: 'approximate', lat: 51.05 });
  });

  it.each<BookingPlacement>([
    { applies: false },
    { applies: true, outcome: 'not_placeable' },
    { applies: true, outcome: 'unavailable' },
  ])('writes nothing at all for %j', (placement) => {
    expect(bookingPlaceColumns(placement)).toEqual({
      placeId: null,
      lat: null,
      lng: null,
      coordsAt: null,
      addressVerified: null,
      precision: null,
      locationSource: null,
    });
  });
});

describe('requestTravelCheck', () => {
  it('is null when travel never applied - not a fifth verdict', () => {
    expect(requestTravelCheck({ applies: false })).toBeNull();
  });

  it('is null for a request whose address placed cleanly', () => {
    // Nothing has checked the DRIVE yet. `ok` would claim a gate that does not run here.
    expect(requestTravelCheck({ applies: true, outcome: 'placed', place: PLACE })).toBeNull();
  });

  it.each<BookingPlacement>([
    { applies: true, outcome: 'not_placeable' },
    { applies: true, outcome: 'unavailable' },
    { applies: true, outcome: 'placed', place: { ...PLACE, precision: 'approximate' } },
  ])('is captured when there was nothing to reason over (%j)', (placement) => {
    // A vague address and a Google outage both land here. The column says what the gate DID,
    // and it did nothing either way; which of the two it was lives in the log line.
    expect(requestTravelCheck(placement)).toBe('captured');
  });
});

describe('ensureBookingPlace - lazy, on read, with write-back', () => {
  const row = (over: Partial<Booking> = {}): Booking =>
    ({
      id: 'bk-1',
      tenantId: 'ten-1',
      customerAddress: 'Kerkstraat 12, 9000 Gent',
      customerPlaceId: null,
      customerLat: null,
      customerLng: null,
      geocodePrecision: null,
      ...over,
    }) as Booking;

  const resolved = (over: Partial<Booking> = {}) =>
    row({
      customerPlaceId: 'ChIJ_place',
      customerLat: 51.05,
      customerLng: 3.72,
      geocodePrecision: 'rooftop',
      customerAddressVerified: 'Kerkstraat 12, 9000 Gent, Belgium',
      customerCoordsAt: new Date('2026-08-01T00:00:00Z'),
      ...over,
    });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-06T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('returns what is already on the row without spending anything', async () => {
    expect(await ensureBookingPlace(resolved(), ACTIVE)).toEqual(PLACE);
    expect(geocode).not.toHaveBeenCalled();
  });

  it.each([
    ['older than the 30-day licence', new Date('2026-07-01T00:00:00Z')],
    ['carrying no stamp at all', null],
    // Clock skew or a hand-edited row would otherwise keep one set permanently fresh.
    ['stamped in the future', new Date('2026-09-01T00:00:00Z')],
  ])('re-resolves coordinates %s', async (_label, customerCoordsAt) => {
    // ADR-0014 permits lat/lng for 30 consecutive days and no longer, so age is a licence
    // boundary rather than a freshness preference. With a 60-day booking horizon this branch
    // is the NORMAL path for a far-future appointment.
    expect(await ensureBookingPlace(resolved({ customerCoordsAt }), ACTIVE)).toEqual(PLACE);
    // BY IDENTITY, never by re-reading the customer's typed address: the same words can
    // resolve somewhere else months later, silently moving a confirmed appointment.
    expect(byPlaceId).toHaveBeenCalledWith(ACTIVE.tenantId, 'ChIJ_place');
    expect(geocode).not.toHaveBeenCalled();
  });

  it('falls back to the address only for a row that never had a place id', async () => {
    // Every row written before this feature existed is in that state.
    expect(await ensureBookingPlace(row(), ACTIVE)).toEqual(PLACE);
    expect(geocode).toHaveBeenCalledWith(ACTIVE, 'Kerkstraat 12, 9000 Gent');
    expect(byPlaceId).not.toHaveBeenCalled();
  });

  it('still trusts coordinates on the last day of the window', async () => {
    const stamped = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
    expect(await ensureBookingPlace(resolved({ customerCoordsAt: stamped }), ACTIVE)).toEqual(PLACE);
    expect(geocode).not.toHaveBeenCalled();
  });

  it('re-places a row holding coordinates but no durable identity', async () => {
    // That combination cannot come from this code, only from imported or hand-edited data,
    // and the place id is what #66 re-resolves expired coordinates from. Re-placing heals it;
    // treating it as complete would leave a row that can never be refreshed.
    expect(await ensureBookingPlace(resolved({ customerPlaceId: null }), ACTIVE)).toEqual(PLACE);
    expect(geocode).toHaveBeenCalled();
  });

  it('geocodes a pre-existing booking once and writes it back', async () => {
    const booking = row();
    expect(await ensureBookingPlace(booking, ACTIVE)).toEqual(PLACE);
    expect(update).toHaveBeenCalledWith(
      'bk-1',
      expect.objectContaining({
        customerPlaceId: 'ChIJ_place',
        customerLat: 51.05,
        customerLng: 3.72,
        geocodePrecision: 'rooftop',
        locationSource: 'geocoded',
      })
    );
    // Kept in step, so a caller holding this row does not pay for it twice in one pass.
    expect(booking.customerLat).toBe(51.05);
    expect(await ensureBookingPlace(booking, ACTIVE)).toEqual(PLACE);
    expect(geocode).toHaveBeenCalledOnce();
  });

  it('cannot reach Google without the gate proof', async () => {
    await ensureBookingPlace(row(), ACTIVE);
    // The neighbour scan resolves eligibility once for the whole diary (ADR-0016) and hands
    // it down. Taking it as an argument is what stops that shortcut becoming a hole.
    expect(geocode).toHaveBeenCalledWith(ACTIVE, 'Kerkstraat 12, 9000 Gent');
  });

  it('has nothing to resolve without an address', async () => {
    expect(await ensureBookingPlace(row({ customerAddress: null }), ACTIVE)).toBeNull();
    expect(geocode).not.toHaveBeenCalled();
  });

  it.each(['not_placeable', 'unavailable'] as const)('is null, and writes nothing, on %s', async (status) => {
    geocode.mockResolvedValue({ status, cause: 'whatever' });
    expect(await ensureBookingPlace(row(), ACTIVE)).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  describe('placeExistingBooking - the same refresh, without the collapse', () => {
    // `ensureBookingPlace` folds every failure into null because its one caller treats them
    // alike. Reschedule does not: a vague address is worth correcting on the booking and an
    // outage is not, and the owner's picker shows the two differently. So the distinction
    // has to survive here, and these are the cases that prove it does.
    it('answers placed, from the durable identity, when coordinates have aged out', async () => {
      byPlaceId.mockResolvedValue({ status: 'placed', place: PLACE });
      const expired = resolved({ customerCoordsAt: new Date('2026-06-01T00:00:00Z') });

      expect(await placeExistingBooking(expired, ACTIVE)).toEqual({
        applies: true,
        outcome: 'placed',
        place: PLACE,
      });
      expect(byPlaceId).toHaveBeenCalledWith(ACTIVE.tenantId, 'ChIJ_place');
      expect(geocode).not.toHaveBeenCalled();
    });

    it.each(['not_placeable', 'unavailable'] as const)('reports %s rather than nothing', async (status) => {
      byPlaceId.mockResolvedValue({ status });
      const expired = resolved({ customerCoordsAt: new Date('2026-06-01T00:00:00Z') });

      expect(await placeExistingBooking(expired, ACTIVE)).toEqual({ applies: true, outcome: status });
      expect(update).not.toHaveBeenCalled();
    });

    it('does not apply at all to a row with neither an identity nor an address', async () => {
      // Not `unavailable`: there was nothing to look up, so blaming Google would be a lie
      // that an owner-facing reason string would then repeat back to them.
      expect(await placeExistingBooking(row({ customerAddress: null }), ACTIVE)).toEqual({
        applies: false,
      });
      expect(geocode).not.toHaveBeenCalled();
    });
  });

  it('still answers when the write-back fails', async () => {
    update.mockRejectedValue(new Error('deadlock'));
    // Losing the write-back costs the next read a lookup. Throwing would cost a booking.
    expect(await ensureBookingPlace(row(), ACTIVE)).toEqual(PLACE);
  });
});
