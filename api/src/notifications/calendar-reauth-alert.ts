/**
 * Tell the owner their calendar connection died.
 *
 * `reauth_required` is what the portal reads, and it only reaches an owner who opens Settings.
 * A dead link is not cosmetic: availability fails closed, so new bookings are captured as
 * Requests instead of being written to the calendar, and the owner learns it by inference. With
 * the shared Google OAuth app still in Testing mode - where refresh tokens expire 7 days after
 * consent (#1) - this is a WEEKLY event for every connected Agent until verification lands.
 *
 * DEDUPED PER DAY, and the callers alert only on the healthy -> dead transition. Those two rules
 * do different jobs: the transition stops a notification storm (once flagged, every availability
 * check re-enters the refresh path), and the day bucket keeps the key stable under a race where
 * two concurrent requests both observe the transition - and lets a LATER death, after a reconnect,
 * alert again rather than being swallowed forever by a fixed key.
 */
import { notificationService } from '../services/notification.service';
import { logger } from '../utils/logger';

export interface CalendarReconnectAlert {
  tenantId: string;
  botId: string;
  provider: 'google' | 'outlook';
  accountEmail: string | null;
}

const PROVIDER_LABEL: Record<CalendarReconnectAlert['provider'], string> = {
  google: 'Google Calendar',
  outlook: 'Outlook Calendar',
};

/** `YYYY-MM-DD` in UTC. A day is the bucket, not the episode, for the race reason above. */
function dayBucket(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Never throws. This runs on the token-refresh path a booking depends on, so a notification
 * failure must not turn "the calendar is dead" into "the booking failed".
 */
export async function alertCalendarReconnect(input: CalendarReconnectAlert): Promise<void> {
  const label = PROVIDER_LABEL[input.provider];
  const who = input.accountEmail ? ` (${input.accountEmail})` : '';
  try {
    await notificationService.createForTenant({
      tenantId: input.tenantId,
      type: 'calendar_reconnect_required',
      title: `Reconnect your ${label}`,
      message:
        `${label}${who} stopped syncing, so new bookings are being captured as requests instead ` +
        'of going on your calendar. Reconnect it in Settings to put them back.',
      data: { botId: input.botId, provider: input.provider },
      dedupeBase: `calendar_reauth:${input.botId}:${input.provider}:${dayBucket()}`,
    });
  } catch (err) {
    logger.warn('[calendar-reauth] alert failed', {
      botId: input.botId,
      provider: input.provider,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
