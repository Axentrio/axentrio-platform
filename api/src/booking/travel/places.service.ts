/**
 * Address SUGGESTIONS. The half of address entry that happens before anybody commits to anything.
 *
 * `geocoding.service` answers "where is this string?" - one paid, cached, trust-weighed question
 * asked once a customer has finished typing. This answers a different one: "what might you mean?",
 * asked while they are still typing, and it is deliberately NOT allowed to place anything.
 *
 * THIS MODULE NEVER CALLS PLACE DETAILS, and that is the design rather than an omission. A place
 * only becomes usable by going through `resolvePlaceId`, which is Geocoding v3, because
 * `isUsablePlace` weighs a `precision` that `precisionFromLocationType` derives from v3's
 * `location_type`. Places API (New) does not return that field, so a place sourced from Details
 * could not be judged by the gate that decides whether a slot may be cleared - it would arrive
 * carrying no precision at all and be refused, or worse, be waved through by a second, weaker
 * check written to accommodate it. Suggestions here, placement there, one trust boundary.
 *
 * COST. This is a per-request SKU on a path that costs nothing today, and it fires while a
 * customer types. Session tokens are not the answer: with no Details call there is no session to
 * complete, and Google bills the autocomplete requests anyway when a session is incomplete or
 * expires. What actually bounds the spend is the minimum query length here, the debounce in the
 * two clients, and the rate limiter on the routes - so all three are load-bearing, not polish.
 */
import axios from 'axios';
import { config } from '../../config/environment';
import { logger } from '../../utils/logger';
import { hasStreetAndHouseNumber } from '../booking-providers/contact';
import { recordCause } from './degradation-monitor';
import { reserveTravelElements } from './travel-usage.service';

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';

/**
 * Belgium, matching `geocoding.service`'s hard country filter.
 *
 * `includedRegionCodes` is the Autocomplete (New) spelling and takes lowercase CLDR codes; the
 * `components=country:BE` form belongs to Geocoding v3. Passing one where the other is expected
 * is silently ignored rather than rejected, which is exactly how a suggestion list ends up
 * spanning continents while looking like it worked.
 */
const REGION_CODES = ['be'];

/**
 * Street-level Places only. Autocomplete (New) `includedPrimaryTypes` takes Table A
 * or Table B types. `street_address` alone misses houses tagged `premise`. `(cities)`
 * is the opposite collection and must never be sent. The API filter is not enough:
 * a city query still returns locality and station hits, so `isStreetAddressSuggestion`
 * drops those after the response.
 */
const PRIMARY_TYPES = ['street_address', 'premise', 'subpremise'];

/**
 * Place types that are a city, station, or other map hit - never a customer's door.
 * `establishment` / `point_of_interest` are omitted: Google often tags a house
 * with only those, and a street + house number is still a door.
 */
const NOT_A_STREET = new Set([
  'locality',
  'sublocality',
  'administrative_area_level_1',
  'administrative_area_level_2',
  'administrative_area_level_3',
  'country',
  'colloquial_area',
  'natural_feature',
  'plus_code',
  'transit_station',
  'train_station',
  'bus_station',
  'subway_station',
  'light_rail_station',
  'airport',
]);

const STREET_TYPES = new Set(['street_address', 'premise', 'subpremise', 'street_number', 'route']);

/**
 * A suggestion the van can be sent to: a street with a house number, not a city or station.
 *
 * Google still returns "Antwerp, Belgium" and "Antwerpen-Centraal" for a city query even
 * when `includedPrimaryTypes` asks for streets. Those rows used to ship as booking options.
 * A house tagged only `establishment` is kept when the text is a street with a house number.
 */
export function isStreetAddressSuggestion(text: string, types: string[] = []): boolean {
  if (/centraal|\bstation\b|luchthaven|\bairport\b/i.test(text)) return false;
  if (!hasStreetAndHouseNumber(text)) return false;
  if (types.some((type) => STREET_TYPES.has(type))) {
    return !types.some((type) => type === 'transit_station' || type === 'train_station' || type === 'bus_station');
  }
  if (types.some((type) => NOT_A_STREET.has(type))) return false;
  return true;
}

/**
 * Below this, suggestions are noise and every keystroke is billable.
 *
 * Three characters is roughly where a Belgian street name starts to discriminate. It is also the
 * cheapest of the three spend controls, because it rejects without a network call at all.
 */
const MIN_QUERY_CHARS = 3;

/** A customer is typing. A suggestion that arrives after they have finished is worth nothing. */
const TIMEOUT_MS = 3_000;

/** One row in the list. Deliberately not a place - it cannot be routed from or booked against. */
export interface AddressSuggestion {
  /** Feed this to `resolvePlaceId` to turn a suggestion into a placement. */
  placeId: string;
  /** What the customer reads. Google's own formatting of the prediction. */
  text: string;
}

export type AutocompleteResult =
  | { status: 'ok'; suggestions: AddressSuggestion[] }
  /** Too short, no key, cap spent, or Google unreachable. The caller shows nothing and moves on. */
  | { status: 'unavailable'; cause: 'too_short' | 'no_api_key' | 'cap_exhausted' | 'api_error' };

interface AutocompleteResponse {
  suggestions?: Array<{
    placePrediction?: { placeId?: string; text?: { text?: string }; types?: string[] };
  }>;
}

/**
 * Suggestions for a partial address.
 *
 * FAILS OPEN, like every other travel gate: an unavailable Google means the customer types their
 * address by hand exactly as they do today, never that they cannot book. So every failure path
 * returns `unavailable` and none of them throw.
 *
 * The tenant is charged an element per request. Suggestions are not free, and billing them to
 * nobody would leave the one path that spends money while a customer types outside the cap that
 * exists to bound exactly that.
 */
export async function autocompleteAddress(tenantId: string, query: string): Promise<AutocompleteResult> {
  const input = query.trim();
  if (input.length < MIN_QUERY_CHARS) return { status: 'unavailable', cause: 'too_short' };

  const apiKey = config.travel.googleMapsApiKey;
  if (!apiKey) return { status: 'unavailable', cause: 'no_api_key' };

  // Claimed BEFORE the call, for the reason `geocoding.service` claims before its own: Google
  // bills the request rather than the answer, so a timeout costs what a hit costs.
  if (!(await reserveTravelElements(tenantId, 1))) {
    await recordCause('places_cap_exhausted', { tenantId });
    return { status: 'unavailable', cause: 'cap_exhausted' };
  }

  try {
    const { data } = await axios.post<AutocompleteResponse>(
      AUTOCOMPLETE_URL,
      { input, includedRegionCodes: REGION_CODES, includedPrimaryTypes: PRIMARY_TYPES },
      {
        timeout: TIMEOUT_MS,
        headers: {
          'X-Goog-Api-Key': apiKey,
          // Without a mask the API refuses the request outright, and a WIDE mask is what turns a
          // cheap autocomplete into an expensive one. Id, label, and types so cities can be dropped.
          'X-Goog-FieldMask':
            'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.types',
          'Content-Type': 'application/json',
        },
      }
    );

    const suggestions: AddressSuggestion[] = [];
    for (const entry of data?.suggestions ?? []) {
      const placeId = entry.placePrediction?.placeId?.trim();
      const text = entry.placePrediction?.text?.text?.trim();
      // Both or neither. A row without an id cannot be selected, and one without text cannot be
      // read, so a half-formed prediction is dropped rather than rendered as a dead entry.
      if (!placeId || !text) continue;
      if (!isStreetAddressSuggestion(text, entry.placePrediction?.types ?? [])) continue;
      suggestions.push({ placeId, text });
    }
    return { status: 'ok', suggestions };
  } catch (error) {
    // The QUERY IS NEVER LOGGED. It is a partial home address, and this is the one call in the
    // system that fires on every keystroke - logging it would write a customer's address into the
    // logs character by character, which is the disclosure `RedactingQueryLogger` exists to stop.
    logger.warn('[Travel] address autocomplete failed', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    await recordCause('places_api_error', { tenantId });
    return { status: 'unavailable', cause: 'api_error' };
  }
}
