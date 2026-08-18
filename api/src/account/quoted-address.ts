/**
 * The address the Agent quotes in conversation (#153).
 *
 * Per-Agent address is ON by default and inherits the Tenant's invoice /
 * business address from #148 when blank. Turning it off suppresses the
 * quoted address entirely, for example for an online-only business.
 */
import { formatVenueLine, type VenueAddress } from '../contracts/venue-address';

export interface QuotedAddressInput {
  botAddressEnabled: boolean;
  botAddress?: Partial<VenueAddress> | null;
  accountAddress?: Partial<VenueAddress> | null;
}

export function resolveQuotedAddress(input: QuotedAddressInput): string | null {
  if (!input.botAddressEnabled) return null;
  return formatVenueLine(input.botAddress) ?? formatVenueLine(input.accountAddress);
}
