/**
 * Who a booking email is sent AS.
 *
 * Google's Calendar API guidance is explicit on this: "we recommend using a unique and
 * static email address for each organizer", and "don't use a generic email address ...
 * because any abuse might impact all users that send invitations from this address". A
 * single platform-wide `bookings@` is precisely the shared address that guidance warns
 * about — one tenant's spam complaint lands on everyone's deliverability.
 *
 * So each tenant gets its own local part on the SAME already-verified sending domain. No
 * new DNS, no per-tenant domain verification: Resend verifies a domain, and every local
 * part on a verified domain is permitted.
 *
 * Two rules do the real work here:
 *
 *  1. The local part derives from the tenant's immutable ID, not its NAME. "Static" is the
 *     load-bearing word in Google's advice — reputation accrues per address, so an address
 *     that changed when an owner renamed their business would reset it. The business name
 *     rides in the DISPLAY name instead, which is what an inbox actually shows.
 *
 *  2. `From:` is derived from the booking's FROZEN organizer, never recomputed — but only
 *     when that address is on the verified domain. Migration 1788900000000 backfilled older
 *     rows with the tenant's own `ai.supportEmail`, which is somebody else's domain
 *     entirely; sending as that would be rejected outright, and would break DMARC alignment
 *     if it weren't. Those rows fall back to the platform address.
 */
import { config } from '../../config/environment';

/** Split "Name <email>" or a bare address into its parts. */
export function parseAddress(addr: string): { email: string; name?: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(addr ?? '');
  if (m) {
    const name = m[1].replace(/^"|"$/g, '').trim();
    return { email: m[2].trim(), name: name || undefined };
  }
  return { email: (addr ?? '').trim() };
}

/** The domain we are actually allowed to send from — by definition the verified one. */
export function verifiedSendingDomain(): string {
  const { email } = parseAddress(config.email.fromAddress);
  return email.split('@')[1]?.toLowerCase() ?? '';
}

export function isOnVerifiedDomain(email: string | null | undefined): boolean {
  if (!email) return false;
  const domain = verifiedSendingDomain();
  if (!domain) return false;
  return parseAddress(email).email.toLowerCase().endsWith(`@${domain}`);
}

/**
 * The stable per-tenant sending address. Uses the first segment of the tenant UUID: short
 * enough to stay readable in a header, and drawn from a value that never changes.
 */
export function organizerAddressForTenant(tenantId: string): string {
  const domain = verifiedSendingDomain();
  const token = (tenantId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase();
  // No domain configured (tests, a misconfigured env) — fall back rather than mint an
  // address with a dangling @.
  if (!domain || !token) return parseAddress(config.email.fromAddress).email;
  return `bookings-${token}@${domain}`;
}

/**
 * What to put in `From:` for a booking whose organizer was frozen at creation.
 *
 * Always aligned with the ICS ORGANIZER when it legally can be, which keeps the
 * (undocumented, see the research doc) Gmail/Outlook RSVP claim satisfied either way.
 */
export function senderFor(organizerEmail: string | null | undefined, displayName?: string | null): string {
  const email = isOnVerifiedDomain(organizerEmail)
    ? parseAddress(organizerEmail as string).email
    : parseAddress(config.email.fromAddress).email;
  const name = (displayName ?? '').replace(/["\\<>\r\n]/g, '').trim();
  return name ? `${name} <${email}>` : email;
}
