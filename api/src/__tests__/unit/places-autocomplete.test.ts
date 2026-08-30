/**
 * Address suggestions: what they cost, what they refuse, and what they must never write down.
 *
 * Three properties here are load-bearing rather than incidental. Suggestions are billable, so a
 * request that skipped the cap would put the one call that fires on every keystroke outside the
 * limit that exists to bound it. Every failure must fail OPEN, because a customer who cannot get
 * suggestions must still be able to type an address and book. And the query is a partial home
 * address arriving one character at a time, so it can never reach the logs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const post = vi.fn();
const reserve = vi.fn();
const warn = vi.fn();

vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => post(...(a as [])) } }));
vi.mock('../../booking/travel/travel-usage.service', () => ({
  reserveTravelElements: (...a: unknown[]) => reserve(...(a as [])),
}));
vi.mock('../../booking/travel/degradation-monitor', () => ({ recordCause: vi.fn(async () => {}) }));
vi.mock('../../utils/logger', () => ({ logger: { warn: (...a: unknown[]) => warn(...(a as [])), info: vi.fn() } }));
vi.mock('../../config/environment', () => ({
  config: { travel: { googleMapsApiKey: 'test-key', monthlyElementCapPerTenant: 5000 } },
}));

import { autocompleteAddress, isStreetAddressSuggestion } from '../../booking/travel/places.service';
import { config } from '../../config/environment';

const ok = (rows: Array<{ id: string; text: string }>) => ({
  data: {
    suggestions: rows.map((r) => ({ placePrediction: { placeId: r.id, text: { text: r.text } } })),
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  reserve.mockResolvedValue(true);
  (config as { travel: { googleMapsApiKey?: string } }).travel.googleMapsApiKey = 'test-key';
});

describe('isStreetAddressSuggestion', () => {
  it('keeps a house Google tagged only as establishment', () => {
    expect(
      isStreetAddressSuggestion('Kerkstraat 12, 2060 Antwerpen, Belgium', ['establishment']),
    ).toBe(true);
  });

  it('keeps a street with a house number even when the postal is still missing', () => {
    expect(isStreetAddressSuggestion('Grote Markt 1, Antwerpen', ['establishment'])).toBe(true);
  });

  it('drops a landmark whose digits are a postal code, not a house number', () => {
    expect(isStreetAddressSuggestion('Atomium, 1020 Brussel', ['point_of_interest', 'establishment'])).toBe(
      false,
    );
  });

  it('still drops cities and stations', () => {
    expect(isStreetAddressSuggestion('Antwerp, Belgium', ['locality', 'political'])).toBe(false);
    expect(
      isStreetAddressSuggestion('Antwerpen-Centraal, Koningin Astridplein, Antwerp, Belgium', [
        'train_station',
        'transit_station',
        'establishment',
      ]),
    ).toBe(false);
  });
});

describe('autocompleteAddress', () => {
  it('returns the id and the text a row needs, and drops half-formed predictions', async () => {
    post.mockResolvedValue({
      data: {
        suggestions: [
          { placePrediction: { placeId: 'ChIJ_1', text: { text: 'Grote Markt 1, Antwerpen' } } },
          // No id: it could be rendered but never selected, so it is a dead row.
          { placePrediction: { text: { text: 'Somewhere' } } },
          // No text: nothing to read.
          { placePrediction: { placeId: 'ChIJ_3' } },
        ],
      },
    });

    const result = await autocompleteAddress('ten-1', 'Grote Markt');
    expect(result).toEqual({
      status: 'ok',
      suggestions: [{ placeId: 'ChIJ_1', text: 'Grote Markt 1, Antwerpen' }],
    });
  });

  it('refuses a query under three characters WITHOUT calling Google', async () => {
    // The cheapest of the three spend controls: it rejects before the network, so a customer
    // typing "G" cannot cost anything at all.
    const result = await autocompleteAddress('ten-1', 'Gr');
    expect(result).toEqual({ status: 'unavailable', cause: 'too_short' });
    expect(post).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('claims an element BEFORE calling, and does not call when the cap is spent', async () => {
    reserve.mockResolvedValue(false);
    const result = await autocompleteAddress('ten-1', 'Grote Markt');
    expect(result).toEqual({ status: 'unavailable', cause: 'cap_exhausted' });
    expect(post).not.toHaveBeenCalled();
  });

  it('bills the element to the tenant that asked', async () => {
    post.mockResolvedValue(ok([{ id: 'ChIJ_1', text: 'x' }]));
    await autocompleteAddress('ten-42', 'Grote Markt');
    expect(reserve).toHaveBeenCalledWith('ten-42', 1);
  });

  it('sends the Belgium filter in the Autocomplete (New) spelling, and a NARROW field mask', async () => {
    post.mockResolvedValue(ok([]));
    await autocompleteAddress('ten-1', 'Grote Markt');

    const [, body, opts] = post.mock.calls[0] as [
      string,
      { input: string; includedRegionCodes: string[]; includedPrimaryTypes: string[] },
      { headers: Record<string, string> },
    ];
    // `components=country:BE` is the Geocoding-v3 spelling and is IGNORED here rather than
    // rejected, which is how a suggestion list silently spans continents.
    // Without street_address, Autocomplete (New) returns cities and stations.
    expect(body).toEqual({
      input: 'Grote Markt',
      includedRegionCodes: ['be'],
      includedPrimaryTypes: ['street_address', 'premise', 'subpremise'],
    });
    // A wide mask is what turns a cheap autocomplete into an expensive one.
    expect(opts.headers['X-Goog-FieldMask']).toBe(
      'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.types'
    );
  });

  it('drops cities and stations so they cannot ship as booking location options', async () => {
    post.mockResolvedValue({
      data: {
        suggestions: [
          { placePrediction: { placeId: 'ChIJ_city', text: { text: 'Antwerp, Belgium' }, types: ['locality', 'political'] } },
          {
            placePrediction: {
              placeId: 'ChIJ_station',
              text: { text: 'Antwerpen-Centraal, Koningin Astridplein, Antwerp, Belgium' },
              types: ['train_station', 'transit_station', 'establishment'],
            },
          },
          { placePrediction: { placeId: 'ChIJ_dup', text: { text: 'Antwerpen, Antwerp, Belgium' }, types: ['locality'] } },
          {
            placePrediction: {
              placeId: 'ChIJ_street',
              text: { text: 'Kerkstraat 12, 2060 Antwerpen, Belgium' },
              types: ['street_address', 'geocode'],
            },
          },
          {
            placePrediction: {
              placeId: 'ChIJ_house',
              text: { text: 'Kerkstraat 12A, 2060 Antwerpen, Belgium' },
              types: ['establishment'],
            },
          },
          {
            placePrediction: {
              placeId: 'ChIJ_atomium',
              text: { text: 'Atomium, 1020 Brussel' },
              types: ['point_of_interest', 'establishment'],
            },
          },
        ],
      },
    });

    const result = await autocompleteAddress('ten-1', 'Antwerp');
    expect(result).toEqual({
      status: 'ok',
      suggestions: [
        { placeId: 'ChIJ_street', text: 'Kerkstraat 12, 2060 Antwerpen, Belgium' },
        { placeId: 'ChIJ_house', text: 'Kerkstraat 12A, 2060 Antwerpen, Belgium' },
      ],
    });
  });

  it('FAILS OPEN when Google errors — never throws', async () => {
    post.mockRejectedValue(new Error('ECONNRESET'));
    await expect(autocompleteAddress('ten-1', 'Grote Markt')).resolves.toEqual({
      status: 'unavailable',
      cause: 'api_error',
    });
  });

  it('NEVER writes the query to the logs', async () => {
    // The one call in the system that fires per keystroke. Logging its input would write a
    // customer's home address into the logs character by character.
    post.mockRejectedValue(new Error('boom'));
    await autocompleteAddress('ten-1', 'Kerkstraat 12, Antwerpen');

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('Kerkstraat');
    expect(logged).not.toContain('Antwerpen');
  });

  it('is unavailable, not broken, with no API key', async () => {
    (config as { travel: { googleMapsApiKey?: string } }).travel.googleMapsApiKey = undefined;
    const result = await autocompleteAddress('ten-1', 'Grote Markt');
    expect(result).toEqual({ status: 'unavailable', cause: 'no_api_key' });
    expect(reserve).not.toHaveBeenCalled();
  });
});
