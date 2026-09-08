/**
 * Customer-facing facts for the branded booking confirmation/cancellation email:
 * the Clerk organization logo and the Booking-settings venue line.
 *
 * Not extras (`loadConfirmationExtras` is text + files and returns null when empty,
 * which would drop the venue). Not invoice identity. Fail-open at the caller so a
 * DB/Clerk blip cannot block the invite.
 */
import { AppDataSource } from '../../database/data-source';
import { BookingSettings } from '../../database/entities/BookingSettings';
import { Tenant } from '../../database/entities/Tenant';
import { formatVenueLine, normalizeVenue } from '../../contracts/venue-address';
import { organizationImageUrl } from '../../services/clerk-sync.service';

export interface CustomerEmailBrand {
  logoUrl: string | null;
  venueLine: string | null;
}

export async function loadCustomerEmailBrand(botId: string, tenantId: string): Promise<CustomerEmailBrand> {
  const [row, tenant] = await Promise.all([
    AppDataSource.getRepository(BookingSettings).findOne({ where: { botId } }),
    AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId }, select: ['id', 'clerkOrgId'] }),
  ]);
  const venueLine = formatVenueLine(
    normalizeVenue({
      street: row?.venueStreet,
      postalCode: row?.venuePostalCode,
      city: row?.venueCity,
      country: row?.venueCountry,
    }),
  );
  const clerkOrgId = tenant?.clerkOrgId?.trim();
  const logoUrl = clerkOrgId ? await organizationImageUrl(clerkOrgId) : null;
  return { logoUrl, venueLine };
}
