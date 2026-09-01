/**
 * Contact-field resolution for bookings: which of address/phone a service
 * requires, and the sanitized values to persist.
 */
import { ServiceType } from '../../database/entities/ServiceType';
import { BookingError, type BookingExtras } from './types';
import {
  serviceNeedsCustomerAddress,
  serviceNeedsCustomerPhone,
  type ServiceLocationFacts,
} from '../service-location';
import { XSSProtectionService } from '../../security/xss-protection';

// One instance for the module, not one per call: the tool layer does the same.
const emails = new XSSProtectionService();

/** `chatbot_bookings.attendee_email` column width (RFC-ish 320). */
const ATTENDEE_EMAIL_MAX = 320;

/** P5a — which contact fields a service requires. Single mapping for the column-name
 *  wart: customerLocationRequired maps to PHONE (a callback number), not address.
 *  #149: a choose-at-booking Service only needs an address when the customer picked theirs.
 *  A phone call always needs a number, even when the stored flag was never ticked. */
function requiredContactFields(
  service: ServiceType,
  extras?: BookingExtras,
): { address: boolean; phone: boolean } {
  return {
    address: serviceNeedsCustomerAddress(service, extras),
    phone: serviceNeedsCustomerPhone(service),
  };
}

/** Trim + cap a contact value to its DB column width; empty/whitespace → null. */
export function cleanContact(v: string | undefined, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function resolvePhone(
  extras?: { customerPhone?: string },
  session?: { channel?: string | null; visitorId?: string | null },
): string | null {
  let phone = cleanContact(extras?.customerPhone, 64);
  // Channel fallback: on WhatsApp the customer's own number IS the session identity
  // (visitorId = wa_id), so capture it as the contact phone when none was provided.
  // Other channels (Messenger/Instagram) use a PSID/IGSID here, not a phone — skip them.
  if (!phone && session?.channel === 'whatsapp' && session.visitorId) {
    phone = cleanContact(`+${session.visitorId.replace(/^\+/, '')}`, 64);
  }
  return phone;
}

function customerAddressShape(value: string | null | undefined): { street: boolean; postalCity: boolean } {
  if (!value) return { street: false, postalCity: false };
  const n = value.trim().replace(/\s+/g, ' ');
  if (!n) return { street: false, postalCity: false };

  const postalCity = n.match(/\b([1-9]\d{3})\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' \-]*)/);
  const city = postalCity?.[2]?.replace(/\b(belgium|belgie|belgië|be)\b/gi, '').trim() ?? '';
  const postalOk = Boolean(postalCity && /[A-Za-zÀ-ÿ]{2,}/.test(city));

  const before =
    postalCity && postalCity.index !== undefined
      ? n.slice(0, postalCity.index).replace(/[,\s]+$/, '')
      : n;
  const hasHouse = /\b\d{1,4}[A-Za-z]?\b/.test(before);
  const street = before.replace(/\b\d{1,4}[A-Za-z]?\b/g, ' ').replace(/[,.\s]+/g, ' ').trim();
  return { street: hasHouse && /[A-Za-zÀ-ÿ]{2,}/.test(street), postalCity: postalOk };
}

/**
 * Street and house number the van can be sent to. Postal code may still be
 * missing — autocomplete uses this so a chip can be a door without yet being a
 * complete booking address.
 */
export function hasStreetAndHouseNumber(value: string | null | undefined): boolean {
  return customerAddressShape(value).street;
}

/**
 * A Belgian appointment address the van can be sent to: street, house number,
 * postal code, and city. A city name, a station, or the business location is not
 * enough. The tool argument is a string, so this reads that string rather than
 * inventing fields the API does not have.
 */
export function isCompleteCustomerAddress(value: string | null | undefined): boolean {
  const shape = customerAddressShape(value);
  return shape.street && shape.postalCity;
}

const ADDRESS_REQUIRED_MESSAGE =
  "This service is carried out at the customer's address. Ask for the full appointment address (street, house number, postal code, and city) and call again with customerAddress. Do not offer the business location, a city name, or map search results as the appointment address.";

/**
 * Customer-location Auto-book must not check times until a full address exists.
 * A prompt rule alone was ignored; this is the same ADDRESS_REQUIRED the write
 * path raises, and it rejects a city-only string the same way it rejects a blank.
 */
export function assertRequiredAddress(
  service: ServiceLocationFacts,
  extras?: { customerAddress?: string | null; locationChoice?: string | null },
): void {
  if (!serviceNeedsCustomerAddress(service, extras)) return;
  if (isCompleteCustomerAddress(extras?.customerAddress)) return;
  throw new BookingError(ADDRESS_REQUIRED_MESSAGE, 'ADDRESS_REQUIRED', 400);
}

/**
 * Phone-required Auto-book must not check times, capture a request, or capture a lead
 * until the number exists. A prompt rule alone was ignored; this is the same
 * PHONE_REQUIRED the write path already raises.
 */
export function assertRequiredPhone(
  service: { locationType?: string | null; customerLocationRequired?: boolean | null },
  extras?: { customerPhone?: string },
  session?: { channel?: string | null; visitorId?: string | null },
): void {
  if (!serviceNeedsCustomerPhone(service)) return;
  if (resolvePhone(extras, session)) return;
  throw new BookingError(
    'A contact phone number is required for this service. Ask for it and call again with customerPhone. Do not tell the customer the service is unavailable, and do not capture a request or a lead.',
    'PHONE_REQUIRED',
    400,
  );
}

/**
 * Owner-facing flag: "email address required for the calendar invite". Default-on, so an
 * undefined or null value still means required; only an explicit false turns it off.
 */
export function serviceRequiresCustomerEmail(service: { customerEmailRequired?: boolean | null }): boolean {
  return service.customerEmailRequired !== false;
}

/**
 * Sanitize a customer email to the ONE stored/queried shape: lowercased, trimmed, valid, and
 * short enough for the column. Null = no usable address. Both the write gate and the
 * `listBookings` lookup read this, so a stored address and a looked-up address cannot drift.
 *
 * 320 = the `attendee_email` column width. A longer address is not truncatable (a cut address
 * is a wrong address), so it counts as unusable.
 */
export function normalizeCustomerEmail(email?: string | null): string | null {
  const clean = typeof email === 'string' ? emails.sanitizeEmail(email) : null;
  return clean && clean.length <= ATTENDEE_EMAIL_MAX ? clean : null;
}

/**
 * The ONE place a customer email is JUDGED. Normalisation is `normalizeCustomerEmail`, and its
 * output is what every downstream reader gets: the INSERT, the ICS ATTENDEE line and the
 * Resend `to`. `sanitizeEmail` accepts " Ada@Example.com ", and that raw string inside a
 * mailto: breaks the RSVP match, so the caller must never keep the value it passed in.
 * Null means "no usable address", which only a service with the flag off can reach.
 *
 * The FORMAT is checked here and not only at the tool because the gate has to hold for every
 * caller: a malformed address confirms a booking whose invite goes nowhere.
 */
export function resolveCustomerEmail(
  service: { customerEmailRequired?: boolean | null },
  email?: string | null,
): string | null {
  const clean = normalizeCustomerEmail(email);
  if (clean) return clean;
  if (!serviceRequiresCustomerEmail(service)) return null;
  throw new BookingError(
    typeof email === 'string' && email.trim()
      ? 'That email address is not valid, so the calendar invite cannot reach the customer. Ask them to repeat it and call again with attendeeEmail. Do not tell the customer the service is unavailable, and do not capture a request or a lead.'
      : 'An email address is required for this service, because the calendar invite is sent to it. Ask the customer for their email address and call again with attendeeEmail. Do not tell the customer the service is unavailable, and do not capture a request or a lead.',
    'EMAIL_REQUIRED',
    400,
  );
}

/**
 * Update-path email merge: undefined or whitespace-only means "no change"; anything
 * else must normalise or the update is refused. The tool's rejectBadEmail already
 * blocks junk on the agent path; this holds for every caller.
 */
export function resolveUpdatedCustomerEmail(
  patchValue: string | undefined,
  stored: string | null | undefined,
): string | null {
  if (patchValue === undefined || patchValue.trim() === '') return stored ?? null;
  const clean = normalizeCustomerEmail(patchValue);
  if (clean) return clean;
  throw new BookingError(
    'That email address is not valid, so the calendar invite cannot reach the customer. Ask them to repeat it and call again with attendeeEmail. Do not tell the customer the service is unavailable, and do not capture a request or a lead.',
    'EMAIL_REQUIRED',
    400,
  );
}

/**
 * P5a — resolve the address/phone to persist, enforcing the service's required-field
 * gates (recoverable errors the agent re-asks on). Whitespace-only counts as absent.
 * A city name is not an appointment address.
 */
export function resolveContactFields(
  service: ServiceType,
  extras?: BookingExtras,
  session?: { channel?: string | null; visitorId?: string | null }
): { address: string | null; phone: string | null } {
  const req = requiredContactFields(service, extras);
  const address = cleanContact(extras?.customerAddress, 512);
  const phone = resolvePhone(extras, session);
  if (req.address) {
    assertRequiredAddress(service, {
      customerAddress: address,
      locationChoice: extras?.locationChoice,
    });
  }
  if (req.phone && !phone) throw new BookingError('A contact phone number is required for this service', 'PHONE_REQUIRED', 400);
  return { address, phone };
}
