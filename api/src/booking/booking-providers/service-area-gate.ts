/**
 * Service-area gate: does the owner's configured area cover this address.
 *
 * Deliberately a SEPARATE GATE from the travel placement gates (see
 * travel-asserts.ts) even though both throw ADDRESS_NOT_PLACEABLE - the area
 * asks "is this town on the owner's list", which the address text answers for
 * free; travel asks "where is the door", which needs Google.
 */
import { AppDataSource } from '../../database/data-source';
import { BookingSettings } from '../../database/entities/BookingSettings';
import { ServiceType } from '../../database/entities/ServiceType';
import { logger } from '../../utils/logger';
import {
  describeServiceArea,
  isEnforceableEntry,
  matchServiceArea,
  type ServiceAreaMatch,
  type ServiceAreaEntry,
} from '../../contracts/service-area';
import { serviceNeedsCustomerAddress } from '../service-location';
import { BookingError, type BookingContext } from './types';

/**
 * What the service-area gate SAW, without acting on it.
 *
 * Split out from the assert so the REQUEST path can record the verdict while continuing not
 * to enforce it. That distinction is the whole point: refusing a captured job is the one
 * outcome the prompt forbids, but until now the only trace a job was out of area was a log
 * line — so an owner could turn work away for months and never know the area they drew was
 * costing them.
 *
 * `null` means the gate did not apply at all: the service asks for no address, or no
 * enforceable place is configured. That is different from `unknown`, which means we looked
 * and could not place it.
 */
export async function evaluateServiceArea(
  ctx: BookingContext,
  service: ServiceType,
  address: string | null
): Promise<{ match: ServiceAreaMatch | null; entries: ServiceAreaEntry[] }> {
  if (!serviceNeedsCustomerAddress(service, { customerAddress: address })) {
    return { match: null, entries: [] };
  }
  const row = await AppDataSource.getRepository(BookingSettings).findOne({
    where: { botId: ctx.bot.id },
  });
  const entries = Array.isArray(row?.serviceArea) ? row.serviceArea : [];
  if (!entries.some(isEnforceableEntry)) return { match: null, entries };
  return { match: matchServiceArea(address, entries), entries };
}

export async function assertInServiceArea(
  ctx: BookingContext,
  service: ServiceType,
  address: string | null
): Promise<void> {
  if (!serviceNeedsCustomerAddress(service, { customerAddress: address })) return;
  const row = await AppDataSource.getRepository(BookingSettings).findOne({
    where: { botId: ctx.bot.id },
  });
  const entries = Array.isArray(row?.serviceArea) ? row.serviceArea : [];
  // Typed notes are shown to the assistant but are not rules, so an area made only of them
  // has nothing to enforce. Without this check it would hold back EVERY booking — the same
  // footgun as before, wearing a different hat.
  if (!entries.some(isEnforceableEntry)) return;

  const verdict = matchServiceArea(address, entries);
  if (verdict === 'inside') return;

  // The only place this gate is observable. Without it there is no way to answer
  // "has it ever fired in production", which is the first thing anyone will ask.
  logger.info('[Booking] out of service area — capturing as a request', {
    tenantId: ctx.tenant.id,
    botId: ctx.bot.id,
    serviceId: service.id,
    verdict,
    hasAddress: !!address,
  });
  // Two DIFFERENT failures, and conflating them cost real bookings. "Outside" is a decision
  // the owner must make, so it becomes a request. "Could not be placed" usually just means
  // the customer said "Kerkstraat 12" with no town — an in-area customer who would book
  // happily if asked one more question. Distinct codes let the prompt ask instead of giving
  // up, without ever letting it retry a genuine out-of-area address.
  throw new BookingError(
    verdict === 'outside'
      ? `That address is outside the area this business serves (${describeServiceArea(entries)}).`
      : `This business only travels to ${describeServiceArea(entries)}, and that address could not be placed. Ask for a postcode or town.`,
    verdict === 'outside' ? 'OUT_OF_SERVICE_AREA' : 'ADDRESS_NOT_PLACEABLE',
    400,
    undefined,
    // The out-of-area half is safe to show as-is - it names the area and blames nobody. The
    // unplaceable half ends in an instruction to the bot, so it gets its own wording.
    verdict === 'outside'
      ? `That address is outside the area this business serves (${describeServiceArea(entries)}).`
      : 'We could not find that address. Please contact the business directly to move this appointment.'
  );
}
