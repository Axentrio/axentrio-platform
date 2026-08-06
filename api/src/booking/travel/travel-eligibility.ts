/**
 * May travel time run for this booking at all?
 *
 * FOUR GATES, CHEAPEST FIRST, and the order is a requirement rather than tidiness. This
 * question is asked on the booking hot path, in front of a paid external dependency, and
 * the answer is "no" for almost every tenant on the platform. So the first gate is a
 * string already in memory, and a platform with no Maps key never resolves an entitlement,
 * never reads a settings row, and never queries for sibling bots.
 *
 *   1. No `GOOGLE_MAPS_API_KEY`   → inert platform-wide. The emergency stop.
 *   2. `travelTime` not entitled  → inert for that tenant. The commercial grant.
 *   3. Bot toggle off             → inert for that bot. The owner's switch, default off.
 *   4. Another bot shares the key → inert, and the toggle refuses to be switched on.
 *
 * GATE 4 IS NOT A SAFETY CATCH, IT IS THE FEATURE'S ONE HARMFUL STATE. Under a shared
 * itinerary key two bots' bookings read as one person's day, so a two-plumber business
 * would find slots stripped for journeys neither of them makes — worse off than before the
 * feature existed. It is re-checked here, at runtime, and not only when the owner flips the
 * switch, because connecting or switching a calendar can create the shared state months
 * after travel was legitimately enabled. Holding the verdict here rather than writing
 * `travel_time_enabled = false` on rekey means the owner's stored preference is never
 * silently rewritten, and travel simply returns when the diaries separate again.
 *
 * WHAT IS DELIBERATELY NOT HERE: the spend cap. Exhausting it is not inertness — it is
 * ADR-0015's degraded branch, where the haversine proofs still refuse the impossible slots
 * and still confirm the certain ones. Folding it in would turn a graceful degradation into
 * a silent fail-open. See `isTravelSpendExhausted`.
 */
import { AppDataSource } from '../../database/data-source';
import { BookingSettings } from '../../database/entities/BookingSettings';
import { getEntitlements } from '../../billing/entitlements';
import { config } from '../../config/environment';
import { logger } from '../../utils/logger';
import { itineraryKeyIsShared, type ItineraryKey } from '../../scheduler/itinerary-key';

export type TravelInactiveReason = 'no_api_key' | 'not_entitled' | 'bot_disabled' | 'shared_itinerary';

export type TravelEligibility =
  | { active: false; reason: TravelInactiveReason }
  | {
      active: true;
      /** The diary travel is a claim about (ADR-0016). */
      itineraryKey: ItineraryKey;
      /** The owner's margin on top of the drive. Never applied without a drive to pad. */
      slackMin: number;
      /** Gate the day's first job against the venue. */
      startFromBase: boolean;
    };

/**
 * The itinerary key is passed IN, never re-resolved here.
 *
 * ADR-0016's discipline is that availability, create, request, accept and reschedule each
 * resolve the key exactly once and hand it down, so no helper derives a diary identity of
 * its own. Taking it as a parameter is what makes that checkable at the type level.
 */
export async function resolveTravelEligibility(input: {
  tenantId: string;
  botId: string;
  itineraryKey: ItineraryKey;
}): Promise<TravelEligibility> {
  if (!config.travel.googleMapsApiKey) return { active: false, reason: 'no_api_key' };

  let entitled = false;
  try {
    entitled = (await getEntitlements(input.tenantId)).features.travelTime;
  } catch (error) {
    // Fail closed, like the calendar-sync gate: an unresolvable entitlement means today's
    // behaviour, which is the flat gap. Never a paid call on a tenant we cannot price.
    logger.warn('[Travel] entitlement resolution failed — treating travel as inactive', {
      tenantId: input.tenantId,
      error,
    });
  }
  if (!entitled) return { active: false, reason: 'not_entitled' };

  const settings = await AppDataSource.getRepository(BookingSettings).findOne({
    where: { botId: input.botId },
  });
  // No settings row is the state every bot starts in, and it reads as off.
  if (settings?.travelTimeEnabled !== true) return { active: false, reason: 'bot_disabled' };

  if (await itineraryKeyIsShared(input.tenantId, input.botId, input.itineraryKey)) {
    return { active: false, reason: 'shared_itinerary' };
  }

  return {
    active: true,
    itineraryKey: input.itineraryKey,
    slackMin: Math.max(0, settings.travelSlackMin ?? 0),
    startFromBase: settings.travelStartFromBase === true,
  };
}

/**
 * A bot's diary identity just changed — say so if that has quietly stranded its travel
 * setting.
 *
 * Connecting, switching or disconnecting a calendar re-keys a bot's whole diary, and it can
 * land the bot on a key another bot already holds. The enable-time refusal cannot see that
 * coming: the shared state is created afterwards, by a settings change on a different
 * screen. Gate 4 in `resolveTravelEligibility` means the feature is already inert by then,
 * so nothing unsafe happens — but nothing VISIBLE happens either, and an owner whose travel
 * gating silently stopped applying has no way to find out.
 *
 * Deliberately does not write `travel_time_enabled = false`. Rekey is best-effort and its
 * callers swallow failures, so a mutation here would sometimes not happen, and the stored
 * preference would then disagree with what the owner last chose. Leaving it alone also
 * means travel simply resumes when the diaries separate again.
 *
 * Never throws: a rekey must not fail because a warning could not be produced. Turning this
 * into something the owner actually sees is the remaining half, and belongs with the rest
 * of the degradation surfacing.
 */
export async function warnIfTravelItineraryNowShared(botId: string, newKey: ItineraryKey): Promise<void> {
  try {
    // The settings row carries the tenant too, so the common case — a bot with travel off,
    // which is every bot by default — costs exactly one indexed read.
    const settings = await AppDataSource.getRepository(BookingSettings).findOne({ where: { botId } });
    if (settings?.travelTimeEnabled !== true) return;
    if (!(await itineraryKeyIsShared(settings.tenantId, botId, newKey))) return;
    logger.warn(
      '[Travel] TRAVEL_SHARED_ITINERARY — travel time is enabled on a bot that now shares a diary, and is inert until they are separated',
      { botId, tenantId: settings.tenantId, itineraryKey: newKey }
    );
  } catch (error) {
    logger.warn('[Travel] shared-itinerary re-check failed after a rekey', { botId, error });
  }
}
