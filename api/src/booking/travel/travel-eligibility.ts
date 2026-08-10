/**
 * May travel time run for this booking at all?
 *
 * FOUR GATES, CHEAPEST FIRST, and the order is a requirement rather than tidiness. This
 * question is asked on the booking hot path, in front of a paid external dependency, and
 * the answer is "no" for almost every tenant on the platform. So the first gate is a
 * string already in memory, and a platform with no Maps key never resolves an entitlement,
 * never reads a settings row, and never queries for sibling Agents.
 *
 *   1. No `GOOGLE_MAPS_API_KEY`     → inert platform-wide. The emergency stop.
 *   2. `travelTime` not entitled    → inert for that Tenant. The commercial grant.
 *   3. Agent toggle off             → inert for that Agent. The owner's switch, default off.
 *   4. Another Agent shares the key → inert, and the toggle refuses to be switched on.
 *
 * GATE 4 IS NOT A SAFETY CATCH, IT IS THE FEATURE'S ONE HARMFUL STATE. Under a shared
 * itinerary key two Agents' bookings read as one person's day, so a two-plumber business
 * would find slots stripped for journeys neither of them makes — worse off than before the
 * feature existed. It is re-checked here, at runtime, and not only when the owner flips the
 * switch, because connecting or switching a calendar can create the shared state months
 * after travel was legitimately enabled. Holding the verdict here rather than writing
 * `travel_time_enabled = false` on rekey means the owner's stored preference is never
 * silently rewritten, and travel simply returns when the diaries separate again.
 *
 * WHAT IS DELIBERATELY NOT HERE: the spend cap. Exhausting it is not inertness — it is
 * ADR-0015's degraded branch, where the haversine bounds still refuse the impossible slots
 * and still confirm the certain ones. Folding it in would turn a graceful degradation into
 * a silent fail-open. See `isTravelSpendExhausted`.
 */
import { AppDataSource } from '../../database/data-source';
import { BookingSettings } from '../../database/entities/BookingSettings';
import { getEntitlements } from '../../billing/entitlements';
import { config } from '../../config/environment';
import { logger } from '../../utils/logger';
import { itineraryKeyIsShared, type ItineraryKey } from '../../scheduler/itinerary-key';
import { Bot } from '../../database/entities/Bot';
import { notifyItinerarySharedInert } from './degradation-notify';
import { recordCause } from './degradation-monitor';

export type TravelInactiveReason = 'no_api_key' | 'not_entitled' | 'bot_disabled' | 'shared_itinerary';

export type TravelEligibility =
  | { active: false; reason: TravelInactiveReason }
  | ActiveTravelEligibility;

/**
 * Proof that all four gates passed, as a value.
 *
 * Anything that can spend a billable element takes one of these rather than a tenant id, so
 * "only ever for an entitled Tenant on an enabled Agent" is checked by the compiler instead
 * of by a comment. The same discipline ADR-0016 applies to the itinerary key: resolve once,
 * hand it down, and give no helper the option of deciding for itself.
 */
export interface ActiveTravelEligibility {
  active: true;
  /** The Tenant whose month the element is billed to. */
  tenantId: string;
  /** The diary travel is a claim about (ADR-0016). */
  itineraryKey: ItineraryKey;
  /** The owner's margin on top of the drive. Never applied without a drive to pad. */
  slackMin: number;
  /** Gate the day's first job against the venue. */
  startFromBase: boolean;
  /**
   * Minutes of detour the owner is willing to call good (#81), or null for no threshold.
   *
   * A PREFERENCE, and it never refuses anything. It reads a slot the gate has already cleared and
   * says only whether grouping likes it, so nothing here can turn a confirmable time into a
   * Request - which is ADR-0017's rule.
   */
  maxDetourMin: number | null;
}

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
  // No settings row is the state every Agent starts in, and it reads as off.
  if (settings?.travelTimeEnabled !== true) return { active: false, reason: 'bot_disabled' };

  if (await itineraryKeyIsShared(input.tenantId, input.botId, input.itineraryKey)) {
    return { active: false, reason: 'shared_itinerary' };
  }

  return {
    active: true,
    tenantId: input.tenantId,
    itineraryKey: input.itineraryKey,
    slackMin: Math.max(0, settings.travelSlackMin ?? 0),
    startFromBase: settings.travelStartFromBase === true,
    // Zero and negative are read as "no threshold" rather than "nothing qualifies": a preference
    // that silently marks every slot unpreferred is indistinguishable from one that is off, and
    // the second is overwhelmingly what an owner who typed 0 meant.
    maxDetourMin: (settings.travelMaxDetourMin ?? 0) > 0 ? (settings.travelMaxDetourMin as number) : null,
  };
}

/**
 * An Agent's diary identity just changed — say so if that has quietly stranded its travel
 * setting.
 *
 * Connecting, switching or disconnecting a calendar re-keys an Agent's whole diary, and it
 * can land it on a key another Agent already holds. The enable-time refusal cannot see that
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
    // The settings row carries the tenant too, so the common case — an Agent with travel
    // off, which is every Agent by default — costs exactly one indexed read.
    const settings = await AppDataSource.getRepository(BookingSettings).findOne({ where: { botId } });
    if (settings?.travelTimeEnabled !== true) return;
    if (!(await itineraryKeyIsShared(settings.tenantId, botId, newKey))) return;
    logger.warn(
      '[Travel] TRAVEL_SHARED_ITINERARY — travel time is enabled on an Agent that now shares a diary, and is inert until they are separated',
      { botId, tenantId: settings.tenantId, itineraryKey: newKey }
    );
    // #68: the detector existed; the half that reaches a person did not. The owner is the only
    // one who can act - nobody pays anyone here, they give each Agent its own calendar - so this
    // goes to the tenant rather than to the operator's outage inbox.
    const bot = await AppDataSource.getRepository(Bot).findOne({ where: { id: botId } });
    await notifyItinerarySharedInert({
      tenantId: settings.tenantId,
      botId,
      botName: bot?.name,
    });
    // And the operator half: how many DISTINCT Agents are in this state. One tenant reconnecting
    // a calendar repeatedly must not look like a platform-wide misconfiguration, so the aggregate
    // counts identities rather than events.
    await recordCause('shared_itinerary', { tenantId: settings.tenantId, botId });
  } catch (error) {
    logger.warn('[Travel] shared-itinerary re-check failed after a rekey', { botId, error });
  }
}
