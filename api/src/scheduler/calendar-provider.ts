/**
 * CalendarProvider port (P6c).
 *
 * A botId-keyed seam over the per-provider calendar services so InternalProvider
 * and the sync reconciler can mirror bookings without knowing whether the bot is
 * on Google or Microsoft. `resolveCalendarProvider(botId)` picks the adapter for
 * the bot's single active credential (defensive if somehow >1).
 *
 * The adapters are thin: they delegate to the existing Google/Microsoft event
 * services, which each own their own token/connection handling. The
 * no-connection ⇒ null vs broken ⇒ throw invariant is preserved per method.
 */
import { AppDataSource } from '../database/data-source';
import { CalendarCredential, CalendarProviderType } from '../database/entities/CalendarCredential';
import { logger } from '../utils/logger';
import {
  getGoogleBusyForBot,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  resolveCalendarIdentity,
  type CalendarEventInput,
  type CalendarEventResult,
  type CreateEventOpts,
  type GoogleBusyInterval as BusyInterval,
} from '../integrations/google/google-calendar.service';
import {
  getOutlookBusyForBot,
  createOutlookEvent,
  updateOutlookEvent,
  deleteOutlookEvent,
} from '../integrations/microsoft/outlook-events.service';
import { resolveOutlookIdentity } from '../integrations/microsoft/outlook-calendar.service';

export type { CalendarEventInput, CalendarEventResult, CreateEventOpts, BusyInterval };
export type UpdateEventResult = 'ok' | 'not_found' | 'no_access' | 'no_connection';
export type DeleteEventResult = 'ok' | 'no_access' | 'no_connection';

export interface CalendarProvider {
  readonly providerType: CalendarProviderType;
  /** Busy intervals, or null when the bot has no active connection; throws on API failure (fail-closed). */
  getBusy(botId: string, startISO: string, endISO: string): Promise<BusyInterval[] | null>;
  /** Create the owner event; null when no connection; throws on non-idempotent failure. */
  createEvent(botId: string, input: CalendarEventInput, opts?: CreateEventOpts): Promise<CalendarEventResult | null>;
  /** Patch event times only (never the body). */
  updateEvent(
    botId: string,
    eventId: string,
    input: Pick<CalendarEventInput, 'startISO' | 'endISO' | 'timezone'>,
    calendarId?: string
  ): Promise<UpdateEventResult>;
  deleteEvent(botId: string, eventId: string, calendarId?: string): Promise<DeleteEventResult>;
  /** Account-unique identity for the conflict key, or null. */
  resolveIdentity(botId: string): Promise<string | null>;
}

const googleProvider: CalendarProvider = {
  providerType: 'google',
  getBusy: getGoogleBusyForBot,
  createEvent: createCalendarEvent,
  updateEvent: updateCalendarEvent,
  deleteEvent: deleteCalendarEvent,
  resolveIdentity: resolveCalendarIdentity,
};

const microsoftProvider: CalendarProvider = {
  providerType: 'microsoft',
  getBusy: getOutlookBusyForBot,
  createEvent: createOutlookEvent,
  // Microsoft writes to the default calendar; the calendarId arg is ignored.
  updateEvent: (botId, eventId, input) => updateOutlookEvent(botId, eventId, input),
  deleteEvent: (botId, eventId) => deleteOutlookEvent(botId, eventId),
  resolveIdentity: resolveOutlookIdentity,
};

/** The provider for a given CalendarCredential provider value. */
export function providerFor(provider: CalendarProviderType): CalendarProvider {
  return provider === 'microsoft' ? microsoftProvider : googleProvider;
}

/**
 * Resolve the adapter for the bot's single active credential, or null when the
 * bot has no connection. If somehow more than one active credential exists
 * (the active unique index should prevent it), the most recent wins and we log.
 */
export async function resolveCalendarProvider(botId: string): Promise<CalendarProvider | null> {
  const active = await AppDataSource.getRepository(CalendarCredential).find({
    where: { botId, status: 'active' },
    order: { createdAt: 'DESC' },
  });
  if (active.length === 0) return null;
  if (active.length > 1) {
    logger.warn('[Calendar] more than one active credential for bot — using the most recent', {
      botId,
      count: active.length,
    });
  }
  return providerFor(active[0].provider);
}
