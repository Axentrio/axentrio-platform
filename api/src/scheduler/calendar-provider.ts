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
import { getEntitlements } from '../billing/entitlements';
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
 * Is external calendar sync allowed for this tenant right now? Resolved
 * entitlements (`calendarSync`), so per-tenant overrides and the
 * free/non-active deny apply. Fail closed: a resolution error means no
 * external calendar calls (plan D9).
 *
 * Scope: booking/sync flows only. Explicit user-initiated disconnect may
 * still revoke tokens at the provider — credential revocation is a security
 * action, not a capability use.
 */
export async function isCalendarSyncAllowed(tenantId: string): Promise<boolean> {
  try {
    return (await getEntitlements(tenantId)).features.calendarSync;
  } catch (error) {
    logger.warn('[Calendar] sync entitlement resolution failed — failing closed', { tenantId, error });
    return false;
  }
}

/**
 * DB-only stored calendar identity for the conflict key (plan D9): reads the
 * bot's active credential and derives the account-unique identity WITHOUT any
 * external API call, so conflict keys stay stable even when sync is disabled
 * by entitlement. Mirrors resolveCalendarIdentity / resolveOutlookIdentity
 * semantics. Malformed/partial identity → null (callers fall back to the
 * bot-scoped key, warning logged) — never throw, never repair via the API.
 */
export async function resolveStoredCalendarIdentity(
  botId: string
): Promise<{ identity: string | null; providerType: CalendarProviderType } | null> {
  const cred = await loadActiveCredential(botId);
  if (!cred) return null;
  if (cred.provider === 'microsoft') {
    if (typeof cred.accountId === 'string' && cred.accountId) {
      return { identity: cred.accountId, providerType: 'microsoft' };
    }
    logger.warn('[Calendar] stored microsoft identity malformed — using bot-scoped conflict key', { botId });
    return { identity: null, providerType: 'microsoft' };
  }
  if (typeof cred.calendarId === 'string' && cred.calendarId && cred.calendarId !== 'primary') {
    return { identity: cred.calendarId, providerType: 'google' };
  }
  if (typeof cred.accountEmail === 'string' && cred.accountEmail) {
    return { identity: cred.accountEmail, providerType: 'google' };
  }
  // Legacy creds (primary + unknown email) legitimately have no identity.
  return { identity: null, providerType: 'google' };
}

async function loadActiveCredential(botId: string): Promise<CalendarCredential | null> {
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
  return active[0];
}

/**
 * Resolve the adapter for the bot's single active credential, or null when the
 * bot has no connection — or when the tenant's entitlements disallow external
 * calendar sync (stored credentials stay as inert config that re-activates on
 * upgrade/re-enable; plan D9). Conflict keys must NOT come from this resolver —
 * use resolveStoredCalendarIdentity, which ignores the entitlement gate.
 */
export async function resolveCalendarProvider(botId: string): Promise<CalendarProvider | null> {
  const cred = await loadActiveCredential(botId);
  if (!cred) return null;
  if (!(await isCalendarSyncAllowed(cred.tenantId))) {
    logger.debug('[Calendar] sync disabled by entitlement — credential inert', { botId });
    return null;
  }
  return providerFor(cred.provider);
}
