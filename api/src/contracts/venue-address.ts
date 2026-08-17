/**
 * The venue address — where a business receives customers.
 *
 * DELIBERATELY NOT the VAT/legal address. That one lives in the tenant's onboarding record
 * (`OnboardingCompany.street/postalCode/city`), is write-once, unvalidated, and for a sole
 * trader is very often their HOME. GDPR Art. 25(2) requires that personal data is not made
 * accessible to an indefinite number of people *by default*, and silently printing that
 * address onto every outbound invite is exactly the default it prohibits. So this is a
 * separate field, empty until the owner fills it in, and it is never prefilled from the
 * registered address — a prefill someone clicks past is not the individual's intervention.
 *
 * Stored as components rather than one string because Microsoft Graph accepts structure
 * (`location.address`) while ICS and Google take free text: flattening later is free,
 * parsing a free-text address back into components later is not.
 */

export interface VenueAddress {
  street: string | null;
  /** House / street number, kept separate so existing `street` values stay valid. */
  streetNumber: string | null;
  /** Box / bus / apartment, when the building has one. */
  boxNumber: string | null;
  postalCode: string | null;
  city: string | null;
  /** ISO 3166-1 alpha-2, uppercased. Null means "same country as the business". */
  country: string | null;
}

export const EMPTY_VENUE: VenueAddress = {
  street: null,
  streetNumber: null,
  boxNumber: null,
  postalCode: null,
  city: null,
  country: null,
};

/** Longest value we will store per component — a venue address, not an essay. */
export const VENUE_FIELD_MAX = 200;

const clean = (v: string | null | undefined): string | null => {
  if (typeof v !== 'string') return null;
  // Collapse every whitespace run, and the three MANDATORY line breaks `\s` does not
  // cover (U+0085, U+2028, U+2029) — any of them would let a venue forge an extra
  // property line inside an ICS body.
  const t = v.replace(/[\s\u0085\u2028\u2029]+/g, ' ').trim();
  return t.length ? t.slice(0, VENUE_FIELD_MAX) : null;
};

/** Normalise a venue from arbitrary input, dropping blanks to null. */
export function normalizeVenue(input: Partial<VenueAddress> | null | undefined): VenueAddress {
  return {
    street: clean(input?.street),
    streetNumber: clean(input?.streetNumber),
    boxNumber: clean(input?.boxNumber),
    postalCode: clean(input?.postalCode),
    city: clean(input?.city),
    country: clean(input?.country)?.toUpperCase().slice(0, 2) ?? null,
  };
}

/** True when the owner has entered anything at all. */
export function hasVenue(v: Partial<VenueAddress> | null | undefined): boolean {
  const n = normalizeVenue(v);
  return !!(n.street || n.postalCode || n.city);
}

/**
 * Flatten to the single line RFC 5545 `LOCATION` and Google's `location` both want.
 *
 * Belgian convention — "Street 1, 9300 Aalst" — postcode before city, no comma between
 * them. Country is appended only when set, since a domestic address reading "…, BE" is
 * noise to the customer standing in front of the building.
 *
 * Returns null when there is nothing worth printing: the caller must then OMIT the
 * property rather than send an empty one. RFC 5546 lists `LOCATION` as `0 or 1`, so
 * omission is conformant, whereas an empty value is a venue named "".
 */
export function formatVenueLine(v: Partial<VenueAddress> | null | undefined): string | null {
  const n = normalizeVenue(v);
  if (!hasVenue(n)) return null;
  // Belgian line: "Street 12 bus 3". Number/box stay off when absent so legacy
  // rows that already baked the number into `street` keep printing as they did.
  const street = [n.street, n.streetNumber].filter(Boolean).join(' ');
  const streetWithBox = n.boxNumber
    ? (street ? `${street} bus ${n.boxNumber}` : `bus ${n.boxNumber}`)
    : street || null;
  const locality = [n.postalCode, n.city].filter(Boolean).join(' ');
  const parts = [streetWithBox, locality || null, n.country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}
