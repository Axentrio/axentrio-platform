/**
 * Loading the diary a travel decision is made against.
 *
 * The query is the easy half. The half worth testing is what a row WITHOUT coordinates means,
 * because "this job has no location" and "we could not obtain this job's location" arrive as
 * the same three null columns and mean opposite things — and reading the second as the first
 * is how this feature would silently confirm a drive nobody checked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const query = vi.fn();
const findOne = vi.fn();
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: () => ({
      query: (...a: unknown[]) => query(...(a as [])),
      findOne: (...a: unknown[]) => findOne(...(a as [])),
      update: vi.fn(async () => ({ affected: 1 })),
    }),
  },
}));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const geocode = vi.fn();
const byPlaceId = vi.fn();
vi.mock('../../booking/travel/geocoding.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../booking/travel/geocoding.service')>();
  return {
    ...actual,
    geocodeAddress: (...a: unknown[]) => geocode(...(a as [])),
    resolvePlaceId: (...a: unknown[]) => byPlaceId(...(a as [])),
  };
});

import type { ActiveTravelEligibility } from '../../booking/travel/travel-eligibility';
import {
  loadTravelNeighbours,
  MAX_LAZY_GEOCODES_PER_CALL,
  LAZY_GEOCODE_DEADLINE_MS,
} from '../../booking/travel/travel-neighbours';

const ACTIVE: ActiveTravelEligibility = {
  active: true,
  tenantId: 'ten-1',
  itineraryKey: 'cal:abc' as ActiveTravelEligibility['itineraryKey'],
  slackMin: 5,
  startFromBase: false, maxDetourMin: null, baseDepartOffsetMin: 0, groupingPeriod: 'none' as const,
};

const PLACE = {
  placeId: 'ChIJ_place',
  lat: 51.05,
  lng: 3.72,
  precision: 'rooftop' as const,
  formattedAddress: 'Kerkstraat 12, 9000 Gent, Belgium',
};

/** A row as the neighbour query returns it, defaulting to a travel job with fresh coordinates. */
const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '11111111-1111-4111-8111-111111111111',
  blocked_start: '2026-09-01T09:00:00.000Z',
  blocked_end: '2026-09-01T10:00:00.000Z',
  customer_address: 'Kerkstraat 12, 9000 Gent',
  customer_place_id: 'ChIJ_place',
  customer_lat: 51.05,
  customer_lng: 3.72,
  customer_coords_at: new Date().toISOString(),
  customer_address_verified: 'Kerkstraat 12, 9000 Gent, Belgium',
  geocode_precision: 'rooftop',
  customer_address_required: true,
  location_type: 'custom',
  has_service: true,
  ...over,
});

const load = (): ReturnType<typeof loadTravelNeighbours> =>
  loadTravelNeighbours({
    eligibility: ACTIVE,
    botId: 'bot-1',
    from: new Date('2026-09-01T00:00:00Z'),
    to: new Date('2026-09-02T00:00:00Z'),
  });

beforeEach(() => {
  vi.clearAllMocks();
  findOne.mockResolvedValue(null);
  geocode.mockResolvedValue({ status: 'unavailable', cause: 'api_error' });
  byPlaceId.mockResolvedValue({ status: 'unavailable', cause: 'api_error' });
});

describe('the query', () => {
  it('scopes to the itinerary key and to held bookings only', async () => {
    query.mockResolvedValue([]);
    await load();
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('calendar_key = $1');
    expect(sql).toContain("status IN ('pending','confirmed')");
    expect(params[0]).toBe('cal:abc');
  });

  it('scopes to the TENANT as well, so one key cannot read another business s customers', async () => {
    // Two businesses that happen to connect the same Google account normalise to one key.
    // This query returns home addresses and coordinates and can write resolved ones back.
    query.mockResolvedValue([]);
    await load();
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('tenant_id = $2');
    expect(params[1]).toBe('ten-1');
  });

  it('LEFT JOINs the service, so a deleted one does not delete the booking from the diary', async () => {
    // `event_type_id` is ON DELETE SET NULL. An inner join would make exactly the rows whose
    // location is hardest to establish vanish instead of becoming uncertain.
    query.mockResolvedValue([]);
    await load();
    expect(query.mock.calls[0][0]).toContain('LEFT JOIN');
  });

  it('widens the window past the asked-about range, because there is no day boundary', async () => {
    query.mockResolvedValue([]);
    await load();
    const params = query.mock.calls[0][1] as string[];
    expect(new Date(params[2]).getTime()).toBeLessThan(new Date('2026-09-01T00:00:00Z').getTime());
    expect(new Date(params[3]).getTime()).toBeGreaterThan(new Date('2026-09-02T00:00:00Z').getTime());
  });
});

describe('classifying a row', () => {
  it('uses coordinates already on the row, free', async () => {
    query.mockResolvedValue([row()]);
    const [n] = (await load()).neighbours;
    expect(n.location).toEqual({ kind: 'known', point: { lat: 51.05, lng: 3.72 } });
    expect(geocode).not.toHaveBeenCalled();
    expect(byPlaceId).not.toHaveBeenCalled();
  });

  it('marks a town-centre placement coarse rather than known', async () => {
    query.mockResolvedValue([row({ geocode_precision: 'approximate' })]);
    const [n] = (await load()).neighbours;
    expect(n.location.kind).toBe('coarse');
  });

  it('treats a phone or video job as no constraint at all', async () => {
    query.mockResolvedValue([
      row({ customer_address_required: false, location_type: 'phone', customer_address: null, customer_lat: null, customer_lng: null, customer_place_id: null, customer_coords_at: null }),
    ]);
    const [n] = (await load()).neighbours;
    expect(n.location).toEqual({ kind: 'locationless' });
  });

  it('re-resolves a travel job whose coordinates aged past the licence window', async () => {
    // Thirty-one days old. The place id is the durable handle the refresh goes through — never
    // the customer's typed words, which can resolve somewhere else months later.
    byPlaceId.mockResolvedValue({ status: 'placed', place: PLACE });
    query.mockResolvedValue([
      row({ customer_coords_at: new Date(Date.now() - 31 * 24 * 3600_000).toISOString() }),
    ]);
    const [n] = (await load()).neighbours;
    expect(byPlaceId).toHaveBeenCalledWith(ACTIVE.tenantId, 'ChIJ_place');
    expect(n.location.kind).toBe('known');
  });

  it('leaves an aged-out job whose identity will not re-resolve UNRESOLVED', async () => {
    // The other half of the expiry story, and the half that decides a booking. Once the
    // sweep has taken the coordinates, a neighbour whose place id cannot be re-resolved is
    // a job we no longer know the position of — so it withholds the slot rather than
    // clearing it, and the candidate becomes a Request instead of confirming at the flat gap.
    byPlaceId.mockResolvedValue({ status: 'unavailable', cause: 'api_error' });
    query.mockResolvedValue([
      row({ customer_lat: null, customer_lng: null, customer_coords_at: null }),
    ]);
    const [n] = (await load()).neighbours;
    expect(byPlaceId).toHaveBeenCalledWith(ACTIVE.tenantId, 'ChIJ_place');
    expect(n.location).toEqual({ kind: 'unresolved' });
  });

  it('leaves a travel job we could not place UNRESOLVED, never locationless', async () => {
    // The whole point of four classes rather than two: an outage must not read as an empty
    // diary. Unresolved never clears a slot; locationless always would.
    query.mockResolvedValue([
      row({ customer_coords_at: null, customer_lat: null, customer_lng: null }),
    ]);
    const [n] = (await load()).neighbours;
    expect(n.location).toEqual({ kind: 'unresolved' });
  });
});

describe('a row whose service has been deleted', () => {
  const orphan = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    row({
      has_service: false,
      customer_address_required: null,
      location_type: null,
      customer_lat: null,
      customer_lng: null,
      customer_coords_at: null,
      ...over,
    });

  it('still tries the place id the row carries', async () => {
    byPlaceId.mockResolvedValue({ status: 'placed', place: PLACE });
    query.mockResolvedValue([orphan()]);
    const [n] = (await load()).neighbours;
    expect(n.location.kind).toBe('known');
  });

  it('falls back to the address when there is no place id', async () => {
    geocode.mockResolvedValue({ status: 'placed', place: PLACE });
    query.mockResolvedValue([orphan({ customer_place_id: null })]);
    const [n] = (await load()).neighbours;
    expect(geocode).toHaveBeenCalled();
    expect(n.location.kind).toBe('known');
  });

  it('is UNRESOLVED, not locationless, when nothing on it says where it was', async () => {
    // The field that said "this was a travel job" or "this was at the premises" is exactly the
    // field deletion removes. Calling that "no constraint" would let a deleted travel job read
    // as an empty diary the moment its coordinates expired.
    query.mockResolvedValue([orphan({ customer_place_id: null, customer_address: null })]);
    const [n] = (await load()).neighbours;
    expect(n.location).toEqual({ kind: 'unresolved' });
  });
});

describe('an at-premises job', () => {
  const premises = row({
    customer_address_required: false,
    location_type: 'in_person',
    customer_address: null,
    customer_place_id: null,
    customer_lat: null,
    customer_lng: null,
    customer_coords_at: null,
  });

  it('is the VENUE, which is a known location and not an unknown one', async () => {
    findOne.mockResolvedValue({ venueStreet: 'Grote Markt 1', venuePostalCode: '9000', venueCity: 'Gent', venueCountry: 'BE' });
    geocode.mockResolvedValue({ status: 'placed', place: PLACE });
    query.mockResolvedValue([premises]);
    const [n] = (await load()).neighbours;
    expect(n.location).toEqual({ kind: 'known', point: { lat: 51.05, lng: 3.72 } });
  });

  it('costs ONE lookup however many premises jobs sit in the diary', async () => {
    findOne.mockResolvedValue({ venueStreet: 'Grote Markt 1', venueCity: 'Gent', venueCountry: 'BE' });
    geocode.mockResolvedValue({ status: 'placed', place: PLACE });
    query.mockResolvedValue([premises, premises, premises]);
    await load();
    expect(geocode).toHaveBeenCalledTimes(1);
  });

  it('spends from the same budget as everything else, and stops at the deadline', async () => {
    // The venue used to bypass both caps, so a diary already at its deadline could still add
    // a six-second wait for the one lookup a slow day is most likely to reach.
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    findOne.mockResolvedValue({ venueStreet: 'Grote Markt 1', venueCity: 'Gent' });
    byPlaceId.mockImplementation(async () => {
      now += LAZY_GEOCODE_DEADLINE_MS;
      return { status: 'unavailable', cause: 'api_error' };
    });
    query.mockResolvedValue([
      row({ id: 'id-0', customer_lat: null, customer_lng: null, customer_coords_at: null }),
      { ...premises, id: 'id-1' },
    ]);
    const loaded = (await load()).neighbours;
    expect(geocode).not.toHaveBeenCalled();
    expect(loaded[1].location).toEqual({ kind: 'unresolved' });
    vi.mocked(Date.now).mockRestore();
  });

  it('is unresolved when the owner never entered their premises address', async () => {
    findOne.mockResolvedValue({});
    query.mockResolvedValue([premises]);
    const [n] = (await load()).neighbours;
    expect(n.location).toEqual({ kind: 'unresolved' });
    // Nothing to place, so nothing is spent trying.
    expect(geocode).not.toHaveBeenCalled();
  });

  it('never persists the venue point it resolved', async () => {
    // `venue_lat`/`venue_lng` carry no precision, no place id and no timestamp, so a value
    // written there could not observe the licence's thirty-day limit and an edited venue
    // address would leave a stale point deciding appointments.
    findOne.mockResolvedValue({ venueStreet: 'Grote Markt 1', venueCity: 'Gent' });
    geocode.mockResolvedValue({ status: 'placed', place: PLACE });
    query.mockResolvedValue([premises]);
    await load();
    const writes = query.mock.calls.filter(([sql]) => String(sql).toUpperCase().includes('UPDATE'));
    expect(writes).toHaveLength(0);
  });
});

describe('the lazy geocode budget', () => {
  it('stops spending after the cap and leaves the rest unresolved', async () => {
    geocode.mockResolvedValue({ status: 'placed', place: PLACE });
    byPlaceId.mockResolvedValue({ status: 'placed', place: PLACE });
    const unplaced = row({ customer_lat: null, customer_lng: null, customer_coords_at: null });
    query.mockResolvedValue(
      Array.from({ length: MAX_LAZY_GEOCODES_PER_CALL + 3 }, (_, i) => ({ ...unplaced, id: `id-${i}` }))
    );
    const loaded = (await load()).neighbours;
    expect(byPlaceId).toHaveBeenCalledTimes(MAX_LAZY_GEOCODES_PER_CALL);
    // Past the cap they are unresolved, which withholds a slot rather than clearing one — the
    // same answer a spent element cap gives.
    expect(loaded.slice(MAX_LAZY_GEOCODES_PER_CALL).every((n) => n.location.kind === 'unresolved')).toBe(true);
  });

  it('stops on the CLOCK too, so an outage cannot hold a customer for a minute', async () => {
    // The count cap is not a latency bound: ten lookups that each time out is a minute of
    // silence in a chat window, and that is exactly when Google is unreachable anyway.
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    byPlaceId.mockImplementation(async () => {
      now += LAZY_GEOCODE_DEADLINE_MS; // one slow lookup exhausts the window
      return { status: 'unavailable', cause: 'api_error' };
    });
    const unplaced = row({ customer_lat: null, customer_lng: null, customer_coords_at: null });
    query.mockResolvedValue([
      { ...unplaced, id: 'id-0' }, { ...unplaced, id: 'id-1' }, { ...unplaced, id: 'id-2' },
    ]);
    const loaded = (await load()).neighbours;
    expect(byPlaceId).toHaveBeenCalledTimes(1);
    expect(loaded.every((n) => n.location.kind === 'unresolved')).toBe(true);
    vi.mocked(Date.now).mockRestore();
  });
});

/**
 * Start from base (#76) forces the venue.
 *
 * The venue is otherwise placed through a memo invoked only when a neighbour classifies as an
 * at-premises job. An EMPTY morning classifies none — and an empty morning is precisely the case
 * the base exists for, since any constraining predecessor suppresses it. So the lazy path
 * returned `venue: null` exactly when the base needed one, and the whole rule would have done
 * nothing in production while passing every test that seeded a premises job.
 */
describe('the venue when start-from-base is on', () => {
  const withBase = (): ReturnType<typeof loadTravelNeighbours> =>
    loadTravelNeighbours({
      eligibility: { ...ACTIVE, startFromBase: true },
      botId: 'bot-1',
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-09-02T00:00:00Z'),
    });

  it('places the venue on an EMPTY day, where nothing else would ask for it', async () => {
    findOne.mockResolvedValue({ venueStreet: 'Grote Markt 1', venuePostalCode: '9000', venueCity: 'Gent', venueCountry: 'BE' });
    geocode.mockResolvedValue({ status: 'placed', place: PLACE });
    query.mockResolvedValue([]);

    const { venue } = await withBase();
    expect(venue).toEqual({ kind: 'known', point: { lat: PLACE.lat, lng: PLACE.lng } });
  });

  it('reports a venue it could not place as UNRESOLVED, never as absent', async () => {
    // `null` means "no constraint" and clears; `unresolved` means "we could not evaluate" and
    // never clears. A base exists to constrain, so its failure has to fall to the safe side.
    findOne.mockResolvedValue({ venueStreet: 'Grote Markt 1', venueCity: 'Gent' });
    geocode.mockResolvedValue({ status: 'unavailable', cause: 'api_error' });
    query.mockResolvedValue([]);

    const { venue } = await withBase();
    expect(venue).toEqual({ kind: 'unresolved' });
  });

  it('does NOT place the venue when the setting is off and nothing needs one', async () => {
    // The guarantee that turning this on is the only thing that can change anybody's bill.
    findOne.mockResolvedValue({ venueStreet: 'Grote Markt 1', venueCity: 'Gent' });
    query.mockResolvedValue([]);

    const { venue } = await load();
    expect(venue).toBeNull();
    expect(geocode).not.toHaveBeenCalled();
  });
});
