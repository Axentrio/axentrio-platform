/**
 * Where is everything else in this diary? The database half of the travel gate.
 *
 * `travel-gate.ts` decides; this loads. The split is the same one `geocoding.service.ts` and
 * `booking-place.ts` already draw, and for the same reason: the reasoning must be testable by
 * writing down two coordinates, and the loading must be testable without a routing API.
 *
 * ONE QUERY FOR A WHOLE RANGE, not one per candidate slot. A single availability call can ask
 * about a fortnight, and asking the database for neighbours forty times is how a feature with
 * a hard external dependency also becomes a database problem. The rows come back once, get a
 * location each, and the gate matches them in memory.
 *
 * SCOPED TO THE ITINERARY KEY (ADR-0016), because travel is a claim about ONE person's day.
 * Two Agents pointed at one real calendar share a key and share a driver; an Agent with its
 * own calendar has its own. `bot_id` would answer a different question — what this business
 * sold — which is what the day CEILINGS count and what the gap deliberately does not.
 *
 * THE HARD PART IS NOT THE QUERY, IT IS WHAT A ROW WITHOUT COORDINATES MEANS. "This job has no
 * location" and "we could not obtain this job's location" are opposite claims that arrive as
 * the same three null columns, and treating the second as the first is precisely the fail-open
 * ADR-0015 exists to refuse. `classify` below is the whole of that distinction.
 */
import { AppDataSource } from '../../database/data-source';
import { Booking } from '../../database/entities/Booking';
import { BookingSettings } from '../../database/entities/BookingSettings';
import type { LocationType } from '../../database/entities/ServiceType';
import { isTrustedForTravel, type GeoPoint } from '../../contracts/travel';
import { formatVenueLine, normalizeVenue } from '../../contracts/venue-address';
import { logger } from '../../utils/logger';
import type { ActiveTravelEligibility } from './travel-eligibility';
import { ensureBookingPlace, storedPlace } from './booking-place';
import { geocodeAddress, type PlacedAddress } from './geocoding.service';
import type { NeighbourLocation, TravelNeighbour } from './travel-gate';

/**
 * How far either side of the asked-about range a neighbour still matters.
 *
 * A job finishing an hour before the range opens constrains its first slot exactly as much as
 * one inside it, and there is NO DAY BOUNDARY in this feature, so the window has to be widened
 * rather than snapped to a calendar day. 24 hours is the same margin `createBooking` already
 * uses to re-validate a slot, and it is far wider than any plausible drive.
 */
const NEIGHBOUR_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * How many neighbours one availability call may geocode from scratch.
 *
 * Lazy resolution is deliberate (plan §6.10): there is no backfill job, so a diary's places
 * fill in as the diary is queried, which never geocodes history nobody will look at. The cap
 * is what stops the FIRST query over a busy fortnight from spending fifty elements in one
 * breath. Rows past it are `unresolved`, never `locationless` — the safe direction, and the
 * same answer a spent cap gives.
 */
const MAX_LAZY_GEOCODES_PER_CALL = 10;

/**
 * And how long they may take between them.
 *
 * A CUSTOMER IS WAITING BEHIND THIS. The count cap alone is not a latency bound: ten lookups
 * that each time out at six seconds is a minute of silence in a chat window, and the moment
 * that happens is precisely the moment Google is unreachable — when every one of those lookups
 * was going to fail anyway. The deadline is checked before starting each one, INCLUDING the
 * venue's, so a slow diary degrades into unresolved neighbours (which withhold slots rather
 * than clearing them) instead of into an abandoned conversation.
 *
 * It bounds when the LAST lookup may START, not when it must finish, so the real ceiling is
 * this plus one geocoder timeout (`TIMEOUT_MS`, six seconds) — about fourteen seconds, not
 * sixty. Racing an in-flight request against a timer would abandon a lookup Google has already
 * been paid for, which buys a couple of seconds at the price of an element and a cache entry.
 */
const LAZY_GEOCODE_DEADLINE_MS = 8_000;

/** One held booking, as the neighbour query returns it. */
interface NeighbourRow {
  id: string;
  blocked_start: string;
  blocked_end: string;
  customer_address: string | null;
  customer_place_id: string | null;
  customer_lat: number | null;
  customer_lng: number | null;
  customer_coords_at: string | null;
  customer_address_verified: string | null;
  geocode_precision: string | null;
  /** Null when the service was deleted — `event_type_id` is `ON DELETE SET NULL`. */
  customer_address_required: boolean | null;
  location_type: LocationType | null;
  /** False when `event_type_id` is null OR the join found nothing. Both mean "we cannot tell". */
  has_service: boolean;
}

/** A placed address as the gate wants it: a point, plus whether it is only a town centre. */
function locationFromPlace(place: PlacedAddress): NeighbourLocation {
  return isTrustedForTravel(place.precision)
    ? { kind: 'known', point: { lat: place.lat, lng: place.lng } }
    : { kind: 'coarse', point: { lat: place.lat, lng: place.lng } };
}

/**
 * The business's own premises as a point, resolved from the ADDRESS TEXT and never persisted.
 *
 * `venue_lat`/`venue_lng` exist on the settings row and are deliberately NOT written here.
 * They carry no precision, no place id and no timestamp, so a town-centre venue would later
 * read as a confident one, the licence's thirty-day limit on coordinates could not be
 * observed, and editing the venue address would leave a stale point behind deciding
 * appointments. Going through `geocodeAddress` instead answers all three by construction: the
 * precision arrives with the answer, the cache entry expires in a week, and the cache key IS
 * the normalised address string, so an edited address is a different key. Persisting a venue
 * point properly belongs with the screen that edits one.
 *
 * Memoised per call by the caller, so a day full of premises jobs costs one lookup at most.
 */
async function venueLocation(
  eligibility: ActiveTravelEligibility,
  botId: string,
  budget: { remaining: number; deadline: number }
): Promise<NeighbourLocation> {
  const row = await AppDataSource.getRepository(BookingSettings).findOne({ where: { botId } });
  const line = formatVenueLine(
    normalizeVenue({
      street: row?.venueStreet,
      postalCode: row?.venuePostalCode,
      city: row?.venueCity,
      country: row?.venueCountry,
    })
  );
  // An owner who never entered their premises address has not told us where their at-premises
  // jobs happen. That is a job whose location SHOULD be knowable and is not, so it is
  // `unresolved` — the Request branch — rather than "no constraint".
  if (!line) return { kind: 'unresolved' };

  // The venue lookup is a lazy lookup like any other and spends from the same two budgets. It
  // used to bypass them, which meant a diary already at its deadline could still add a
  // six-second wait for the venue — the one lookup a slow day is most likely to reach.
  if (budget.remaining <= 0 || Date.now() >= budget.deadline) return { kind: 'unresolved' };
  budget.remaining -= 1;

  const result = await geocodeAddress(eligibility, line);
  return result.status === 'placed' ? locationFromPlace(result.place) : { kind: 'unresolved' };
}

/** The in-memory row `ensureBookingPlace` needs, without loading the whole entity graph. */
function asBooking(row: NeighbourRow): Booking {
  return {
    id: row.id,
    customerAddress: row.customer_address,
    customerPlaceId: row.customer_place_id,
    customerLat: row.customer_lat,
    customerLng: row.customer_lng,
    customerCoordsAt: row.customer_coords_at ? new Date(row.customer_coords_at) : null,
    customerAddressVerified: row.customer_address_verified,
    geocodePrecision: row.geocode_precision,
  } as unknown as Booking;
}

/**
 * What one held booking contributes to a travel decision.
 *
 * EVIDENCE FIRST, SERVICE SECOND. A stored place on the row settles it without asking what the
 * service was, which matters because the service is the field that disappears: deleting one
 * sets `event_type_id` to null, taking with it the only record that this was a travel job or a
 * premises job. A row whose service is gone is therefore never `locationless` — its own durable
 * evidence is still worth a lookup, and when there is none the honest answer is that we cannot
 * tell, which is `unresolved`. Filing those as "no constraint" would let a deleted travel job
 * read as an empty diary the moment its coordinates aged out.
 */
async function classify(
  row: NeighbourRow,
  eligibility: ActiveTravelEligibility,
  budget: { remaining: number; deadline: number },
  venue: () => Promise<NeighbourLocation>,
  /**
   * False inside a transaction, where nothing may touch the network.
   *
   * ONE CLASSIFIER, TWO CALLERS, because two would drift on what a row MEANS — and the two
   * readings are used to make the same decision moments apart, one advisory and one
   * authoritative. With lookups off, every branch that would have reached Google returns
   * `unresolved` instead: never `locationless`, which would clear a slot, and never a guess.
   */
  allowLookups: boolean
): Promise<NeighbourLocation> {
  const booking = asBooking(row);

  // Free: already on the row, inside the licence's thirty days, and usable.
  const stored = storedPlace(booking);
  if (stored) return locationFromPlace(stored);

  const isTravelJob = row.customer_address_required === true;
  const isPremisesJob =
    row.has_service && row.customer_address_required === false && row.location_type === 'in_person';
  // A live service that is neither: a phone consultation, a video call, or one the owner marked
  // as putting no location on the invite. The owner could take it from anywhere, so it
  // constrains nothing — the one case where absent coordinates really do mean absent.
  const isLocationless =
    row.has_service && row.customer_address_required === false && row.location_type !== 'in_person';
  if (isLocationless) return { kind: 'locationless' };

  if (isPremisesJob) return venue();

  // A travel job with no stored place, or a row whose service is gone but which still carries
  // its own address or place id. Both are worth one lookup.
  const worthResolving = isTravelJob || !!row.customer_place_id || !!row.customer_address?.trim();
  if (!worthResolving) return { kind: 'unresolved' };

  // Inside the lock this is where the road ends. The pre-lock pass already resolved and wrote
  // back every neighbour it could see, so a row still needing a lookup here is one that landed
  // in the last few milliseconds — a genuine race, and the honest answer is that we do not know.
  if (!allowLookups) return { kind: 'unresolved' };

  if (budget.remaining <= 0 || Date.now() >= budget.deadline) {
    logger.info('[Travel] neighbour left unresolved — lazy geocode budget spent for this call', {
      bookingId: row.id,
      tenantId: eligibility.tenantId,
      cause: budget.remaining <= 0 ? 'count' : 'deadline',
    });
    return { kind: 'unresolved' };
  }
  budget.remaining -= 1;

  const place = await ensureBookingPlace(booking, eligibility);
  return place ? locationFromPlace(place) : { kind: 'unresolved' };
}

/**
 * Every held booking near `[from, to]` on this itinerary, with a location each.
 *
 * `status IN ('pending','confirmed')` mirrors every other diary query in this provider: a
 * captured request blocks nothing and is not somewhere the owner has to be.
 *
 * External calendar events are absent on purpose (plan §6.18). They are never geocoded — we
 * cannot tell a phone job from a dentist appointment — so they go on inflating `busy` exactly
 * as they did, and contribute no location here.
 */
export async function loadTravelNeighbours(input: {
  eligibility: ActiveTravelEligibility;
  botId: string;
  from: Date;
  to: Date;
  excludeBookingId?: string;
}): Promise<{ neighbours: TravelNeighbour[]; venue: NeighbourLocation | null }> {
  const budget = {
    remaining: MAX_LAZY_GEOCODES_PER_CALL,
    deadline: Date.now() + LAZY_GEOCODE_DEADLINE_MS,
  };
  // Resolved at most once per call however many premises jobs sit in the diary, and not at all
  // when none do — an owner with no at-premises services never pays for their venue.
  let venuePromise: Promise<NeighbourLocation> | null = null;
  const venue = (): Promise<NeighbourLocation> => {
    venuePromise ??= venueLocation(input.eligibility, input.botId, budget);
    return venuePromise;
  };

  // START-FROM-BASE IS NOT ENFORCED YET, and an owner who switched it on is entitled to know
  // that rather than to discover it. It is named in the ACs of the settings screen and of its
  // own ticket; until one of them lands, this line is the only thing standing between "quietly
  // does nothing" and "nobody could have known".
  if (input.eligibility.startFromBase) {
    logger.warn('[Travel] travel_start_from_base is set but is not enforced yet', {
      botId: input.botId,
      tenantId: input.eligibility.tenantId,
    });
  }

  const neighbours = await readNeighbours(
    { query: (sql, params) => AppDataSource.getRepository(Booking).query(sql, params) },
    input,
    { budget, venue, allowLookups: true }
  );
  // The venue is handed BACK, not just used. The transactional re-read cannot place it — it may
  // not touch the network — so whoever holds the lock needs the value this pass already paid
  // for. Null when no premises job was seen, which is when nothing needed it.
  return { neighbours, venue: venuePromise ? await venuePromise : null };
}

/**
 * The same diary, read INSIDE a transaction, where nothing may touch the network.
 *
 * WHY A SECOND ENTRY POINT AND NOT A FLAG ON THE FIRST. Holding a database transaction open
 * across a network call is the pool-exhaustion pattern this codebase already warns about, and
 * the pre-lock read both geocodes and writes back. Rather than trusting a caller to pass the
 * right flag under a lock, the two are separate functions over one query and one classifier: the
 * shape below cannot reach Google because it is never given the means to.
 *
 * `venue` is placed by the CALLER, outside the lock, and handed in. Absent ⇒ premises neighbours
 * are `unresolved`, which withholds a slot rather than clearing one.
 *
 * A neighbour that would have needed a lookup reads `unresolved` here. The pre-lock pass already
 * resolved and wrote back everything it could see, so such a row landed in the last few
 * milliseconds — which is exactly the race this read exists to catch.
 */
export async function loadStoredNeighbours(
  manager: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  input: {
    eligibility: ActiveTravelEligibility;
    from: Date;
    to: Date;
    excludeBookingId?: string;
    venue: NeighbourLocation | null;
  }
): Promise<TravelNeighbour[]> {
  const venue = input.venue ?? { kind: 'unresolved' as const };
  return readNeighbours(manager, input, {
    // Unreachable with lookups off, but the shape is shared, so it is given a spent one rather
    // than a live one — belt as well as braces.
    budget: { remaining: 0, deadline: 0 },
    venue: async () => venue,
    allowLookups: false,
  });
}

/** The one query and the one loop, so the advisory and the authoritative read cannot drift. */
async function readNeighbours(
  runner: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  input: {
    eligibility: ActiveTravelEligibility;
    from: Date;
    to: Date;
    excludeBookingId?: string;
  },
  opts: {
    budget: { remaining: number; deadline: number };
    venue: () => Promise<NeighbourLocation>;
    allowLookups: boolean;
  }
): Promise<TravelNeighbour[]> {
  const windowStart = new Date(input.from.getTime() - NEIGHBOUR_MARGIN_MS);
  const windowEnd = new Date(input.to.getTime() + NEIGHBOUR_MARGIN_MS);

  const rows = (await runner.query(
    // LEFT JOIN, not INNER: `event_type_id` is nullable and service deletion sets it null, so
    // an inner join would drop held bookings out of the diary entirely — the exact rows whose
    // location is hardest to establish would become invisible instead of uncertain.
    `SELECT b.id,
            lower(b.blocked_range) AS blocked_start,
            upper(b.blocked_range) AS blocked_end,
            b.customer_address, b.customer_place_id, b.customer_lat, b.customer_lng,
            b.customer_coords_at, b.customer_address_verified, b.geocode_precision,
            s.customer_address_required, s.location_type,
            (s.id IS NOT NULL) AS has_service
       FROM chatbot_bookings b
       LEFT JOIN chatbot_service_types s ON s.id = b.event_type_id
      WHERE b.calendar_key = $1 AND b.tenant_id = $2 AND b.status IN ('pending','confirmed')
        AND b.blocked_range && tstzrange($3, $4, '[)')
        AND ($5::uuid IS NULL OR b.id <> $5::uuid)`,
    [
      input.eligibility.itineraryKey,
      // TENANT TOO, and not because the key is ambiguous within a tenant — it is not. Two
      // different businesses that happen to connect the same Google account normalise to one
      // key, and this query returns customer addresses and coordinates and may WRITE resolved
      // ones back. Reading another tenant's customers' home addresses is a worse failure than
      // any scheduling one, and the gate that governs this whole feature already asks its
      // shared-diary question per tenant (`itineraryKeyIsShared(tenantId, …)`), so this is the
      // scope the design already assumes.
      input.eligibility.tenantId,
      windowStart.toISOString(),
      windowEnd.toISOString(),
      input.excludeBookingId ?? null,
    ]
  )) as NeighbourRow[];

  const neighbours: TravelNeighbour[] = [];
  for (const row of rows) {
    // Sequential rather than concurrent, because the lazy-geocode budget is a running total
    // and resolving in parallel would let every row read the same remaining count.
    neighbours.push({
      blockedStart: new Date(row.blocked_start),
      blockedEnd: new Date(row.blocked_end),
      location: await classify(row, input.eligibility, opts.budget, opts.venue, opts.allowLookups),
    });
  }
  return neighbours;
}

/** The margin, exported so the caller can widen its own query window to match. */
export { NEIGHBOUR_MARGIN_MS, MAX_LAZY_GEOCODES_PER_CALL, LAZY_GEOCODE_DEADLINE_MS };

/** Re-exported so a caller needs one import for "the diary" rather than two. */
export type { TravelNeighbour, NeighbourLocation, GeoPoint };
