/**
 * The address the Agent quotes in conversation (#153).
 *
 * Per-bot address is optional and DEFAULT OFF: an online shop must not have a
 * physical address forced on. When the field is off, or on but blank, fall
 * back to the account's invoice / business address from #148 so the bot
 * always has a correct address when one exists.
 */
import { formatVenueLine, type VenueAddress } from '../contracts/venue-address';

export interface QuotedAddressInput {
  botAddressEnabled: boolean;
  botAddress?: Partial<VenueAddress> | null;
  accountAddress?: Partial<VenueAddress> | null;
}

export function resolveQuotedAddress(input: QuotedAddressInput): string | null {
  if (input.botAddressEnabled) {
    const bot = formatVenueLine(input.botAddress);
    if (bot) return bot;
  }
  return formatVenueLine(input.accountAddress);
}
