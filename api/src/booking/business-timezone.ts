/**
 * Server-owned Business Time (plan: pilot-operations-timezone-routing, PR 1a).
 *
 * One bot has ONE business timezone, derived from the business's geography —
 * the bot's venue country when a venue exists, else the tenant's admitted
 * operating country — and NEVER from a browser clock or a client payload.
 * `Bot.businessTimezone` is the canonical stored value; every reader of
 * business-local time goes through it. `AvailabilityRule.timezone` survives
 * only as a denormalized compatibility column: every write sets it equal to
 * the bot value, and reads treat the bot as authoritative.
 *
 * Belgium-only today: the resolver's single valid answer is Europe/Brussels.
 * That is still location-derived — it comes from the platform's admitted
 * business geography (company lookup, Places and Geocoding are all restricted
 * to Belgium) — so an unsupported country is REJECTED at the business-location
 * boundary rather than guessed at. Admitting a second country later means
 * adding one entry here, never calling Google Time Zone in the booking hot
 * path and never deriving from short-lived licensed coordinates.
 */
import type { EntityManager } from 'typeorm';
import { In } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { Bot } from '../database/entities/Bot';

/** The default admitted operating country for every tenant today. */
export const DEFAULT_OPERATING_COUNTRY = 'BE';

/** The only valid business timezone while the product is Belgium-only. */
export const DEFAULT_BUSINESS_TIMEZONE = 'Europe/Brussels';

/** ISO 3166-1 alpha-2 → IANA. Growing this map is how a country is admitted. */
const COUNTRY_TIMEZONES: Record<string, string> = {
  BE: 'Europe/Brussels',
};

/**
 * A business location outside the admitted countries. Thrown, not guessed:
 * a wrong-but-plausible timezone corrupts every booking silently, while a
 * clear refusal is visible the moment the address is typed.
 */
export class UnsupportedBusinessCountryError extends Error {
  constructor(readonly country: string) {
    super(
      `Business locations in "${country}" are not supported yet — bookings currently operate in Belgium (BE) only.`
    );
    this.name = 'UnsupportedBusinessCountryError';
  }
}

const normalizeCountry = (raw: string | null | undefined): string | null => {
  const c = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return c ? c : null;
};

/**
 * Pure resolver: business geography → IANA timezone.
 *
 * Provenance order (locked decision, codex round 2): the VENUE's country when a
 * venue states one, else the tenant's operating country, else the platform
 * default (`BE`). A venue without a country component means "same country as
 * the business" (see `contracts/venue-address.ts`), so it falls through rather
 * than rejecting. Unsupported countries throw `UnsupportedBusinessCountryError`.
 */
export function resolveBusinessTimezone(input: {
  country?: string | null;
  venue?: { country?: string | null } | null;
}): string {
  const country =
    normalizeCountry(input.venue?.country) ??
    normalizeCountry(input.country) ??
    DEFAULT_OPERATING_COUNTRY;
  const timezone = COUNTRY_TIMEZONES[country];
  if (!timezone) throw new UnsupportedBusinessCountryError(country);
  return timezone;
}

/**
 * The canonical business timezone for a bot, for readers that hold only a
 * botId. One indexed lookup. Falls back to the platform default rather than
 * UTC: a missing row degrades to the only timezone the product operates in,
 * never to a timezone no Belgian business has.
 */
export async function getBotBusinessTimezone(
  botId: string,
  manager?: EntityManager
): Promise<string> {
  const repo = (manager ?? AppDataSource).getRepository(Bot);
  const bot = await repo.findOne({
    where: { id: botId },
    select: { id: true, businessTimezone: true },
  });
  return bot?.businessTimezone || DEFAULT_BUSINESS_TIMEZONE;
}

/**
 * Overwrite each rule's denormalized `timezone` with its bot's canonical
 * value, in place. For readers that load `AvailabilityRule` rows in bulk
 * (analytics bucketing) and feed them to pure helpers that read
 * `rule.timezone`: the bot is authoritative on read, so the compatibility
 * column is never allowed to answer. Rules whose bot row is missing keep
 * their stored value (fail towards the previous behaviour, not towards UTC).
 */
export async function applyBotBusinessTimezones<
  T extends { botId: string; timezone: string },
>(rules: T[]): Promise<T[]> {
  const botIds = [...new Set(rules.map((r) => r.botId).filter(Boolean))];
  if (botIds.length === 0) return rules;
  const bots = await AppDataSource.getRepository(Bot).find({
    where: { id: In(botIds) },
    select: { id: true, businessTimezone: true },
  });
  const byId = new Map(bots.map((b) => [b.id, b.businessTimezone]));
  for (const rule of rules) {
    const tz = byId.get(rule.botId);
    if (tz) rule.timezone = tz;
  }
  return rules;
}
