/**
 * The two degradation causes that belong to a TENANT, not to the operator.
 *
 * A platform outage is somebody paying a bill or fixing a key, and it goes to
 * `PLATFORM_ALERT_EMAIL` (see `travel-health.ts`). These two are different: the only person who
 * can act is the business owner, and an alert that names nobody who can act is not an alert.
 *
 * BOTH NOTIFY ON THE FIRST OCCURRENCE, with no burst threshold, because both are DEFINITE
 * STATES rather than symptoms needing corroboration:
 *
 *   - a spent element cap is a fact about that tenant's month the moment it happens;
 *   - the shared-itinerary detector fires ONCE, on rekey — a rule of "N occurrences in a window"
 *     would mean the configuration alert could literally never fire, which is what an earlier
 *     draft of this would have shipped.
 *
 * Deduplicated per period rather than per event, so a tenant that keeps hitting its cap all
 * month is told once and not once per booking.
 */
import { notificationService } from '../../services/notification.service';
import { logger } from '../../utils/logger';

/** The month a cap belongs to, so the next one notifies again. */
const currentPeriod = (): string => new Date().toISOString().slice(0, 7);

/**
 * This tenant has spent its monthly element budget, so travel checking has stopped verifying
 * drives for them and fallen back to distance bounds.
 *
 * Not a refusal and not an outage — ADR-0015's degraded branch working as designed. What makes
 * it worth saying is that the owner cannot otherwise tell: their bookings keep flowing, checked
 * less thoroughly than they believe.
 */
export async function notifyTenantCapExhausted(tenantId: string): Promise<void> {
  try {
    await notificationService.createForTenant({
      tenantId,
      type: 'travel_cap_exhausted',
      title: 'Travel checking is using estimates this month',
      message:
        'Your appointments have used this month’s travel-time checks. New bookings are still ' +
        'taken and still spaced out, but journeys are estimated from distance rather than ' +
        'measured, so a tight one may get through. This resets at the start of next month.',
      data: { period: currentPeriod() },
      // One per tenant per month. A tenant at its cap emits this on every booking otherwise.
      dedupeBase: `travel-cap:${tenantId}:${currentPeriod()}`,
    });
  } catch (error) {
    logger.warn('[travel-health] could not notify a tenant of a spent cap', { tenantId, error });
  }
}

/**
 * Two Agents are booking into one calendar, so travel checking has switched itself off for this
 * one.
 *
 * THE CAUSE THAT IS NOT A GOOGLE FAILURE AT ALL. Gate 4 makes the feature inert the moment two
 * Agents resolve to the same itinerary key, because their bookings would read as one person's
 * day and slots would be held back for journeys nobody makes. Nothing unsafe runs — and the
 * owner is never told that protection they believe is applying has stopped.
 *
 * Nobody needs to pay anyone here. The fix is a calendar, which is why this reads differently
 * from the other two.
 */
export async function notifyItinerarySharedInert(input: {
  tenantId: string;
  botId: string;
  botName?: string;
}): Promise<void> {
  const who = input.botName ? `“${input.botName}”` : 'One of your Agents';
  try {
    await notificationService.createForTenant({
      tenantId: input.tenantId,
      type: 'travel_shared_itinerary',
      title: 'Travel checking has paused for one of your Agents',
      message:
        `${who} now books into the same calendar as another Agent, so travel-time checking has ` +
        'stopped running for it. Two Agents sharing one calendar would be read as one person’s ' +
        'day, and times would be held back for journeys nobody makes. Give each Agent its own ' +
        'calendar to turn it back on.',
      data: { botId: input.botId },
      // Per Agent, not per rekey: connecting and disconnecting a calendar repeatedly should not
      // produce a stream of identical notices.
      dedupeBase: `travel-shared:${input.tenantId}:${input.botId}`,
    });
  } catch (error) {
    logger.warn('[travel-health] could not notify a tenant of a shared itinerary', {
      tenantId: input.tenantId,
      botId: input.botId,
      error,
    });
  }
}
