/**
 * Contact-field resolution for bookings: which of address/phone a service
 * requires, and the sanitized values to persist.
 */
import { ServiceType } from '../../database/entities/ServiceType';
import { BookingError, type BookingExtras } from './types';
import { serviceNeedsCustomerAddress } from '../service-location';

/** P5a — which contact fields a service requires. Single mapping for the column-name
 *  wart: customerLocationRequired maps to PHONE (a callback number), not address.
 *  #149: a choose-at-booking Service only needs an address when the customer picked theirs. */
function requiredContactFields(
  service: ServiceType,
  extras?: BookingExtras,
): { address: boolean; phone: boolean } {
  return {
    address: serviceNeedsCustomerAddress(service, extras),
    phone: !!service.customerLocationRequired,
  };
}

/** Trim + cap a contact value to its DB column width; empty/whitespace → null. */
function cleanContact(v: string | undefined, max: number): string | null {
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

/**
 * Phone-required Auto-book must not check times, capture a request, or capture a lead
 * until the number exists. A prompt rule alone was ignored; this is the same
 * PHONE_REQUIRED the write path already raises.
 */
export function assertRequiredPhone(
  service: Pick<ServiceType, 'customerLocationRequired'>,
  extras?: { customerPhone?: string },
  session?: { channel?: string | null; visitorId?: string | null },
): void {
  if (!service.customerLocationRequired) return;
  if (resolvePhone(extras, session)) return;
  throw new BookingError(
    'A contact phone number is required for this service. Ask for it and call again with customerPhone. Do not tell the customer the service is unavailable, and do not capture a request or a lead.',
    'PHONE_REQUIRED',
    400,
  );
}

/**
 * P5a — resolve the address/phone to persist, enforcing the service's required-field
 * gates (recoverable errors the agent re-asks on). Whitespace-only counts as absent.
 */
export function resolveContactFields(
  service: ServiceType,
  extras?: BookingExtras,
  session?: { channel?: string | null; visitorId?: string | null }
): { address: string | null; phone: string | null } {
  const req = requiredContactFields(service, extras);
  const address = cleanContact(extras?.customerAddress, 512);
  const phone = resolvePhone(extras, session);
  if (req.address && !address) throw new BookingError('Address is required for this service', 'ADDRESS_REQUIRED', 400);
  if (req.phone && !phone) throw new BookingError('A contact phone number is required for this service', 'PHONE_REQUIRED', 400);
  return { address, phone };
}
