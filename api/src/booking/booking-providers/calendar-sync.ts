/**
 * Best-effort mirror of internal bookings to the owner's connected calendar
 * (Google or Microsoft). A failed sync never fails the booking itself: the row
 * is flagged `sync_pending` for the reconciler instead.
 */
import { AppDataSource } from '../../database/data-source';
import { Booking } from '../../database/entities/Booking';
import { BookingReference } from '../../database/entities/BookingReference';
import { logger } from '../../utils/logger';
import {
  resolveCalendarProvider,
  providerFor,
  isCalendarSyncAllowed,
} from '../../scheduler/calendar-provider';
import type { BookingContext } from './types';

/**
 * Deterministic external event id derived from the booking id. Google rejects
 * ids longer than 1024 bytes and some characters; hyphens are simply
 * stripped (32 hex chars = valid Google base32hex). Makes the Google create
 * idempotent — a reconciler retry after a partial failure re-uses this id
 * instead of producing a duplicate event.
 */
function googleEventId(bookingId: string): string {
  return bookingId.replace(/-/g, '');
}

export async function markSyncPending(bookingId: string): Promise<void> {
  await AppDataSource.getRepository(Booking)
    .query(
      // Reset the retry budget: a re-flag (reschedule/cancel/create) is a NEW sync
      // episode and must not inherit a prior episode's attempt count (else it can go
      // terminal after only a couple of fresh failures).
      `UPDATE chatbot_bookings SET sync_pending=true, sync_attempts=0, sync_next_attempt_at=null, updated_at=now() WHERE id=$1`,
      [bookingId]
    )
    .catch(() => undefined);
}

/**
 * The ref to operate on for reschedule/cancel. Normally exactly one; if a rare
 * switch/create race left more than one, prefer the ref matching the bot's
 * current active provider, else the earliest-created — deterministic, so the
 * chosen provider is never arbitrary.
 */
export async function canonicalRef(botId: string, bookingId: string): Promise<BookingReference | null> {
  const refs = await AppDataSource.getRepository(BookingReference).find({
    where: { bookingId },
    order: { createdAt: 'ASC' },
  });
  if (refs.length <= 1) return refs[0] ?? null;
  const provider = await resolveCalendarProvider(botId);
  if (provider) {
    const match = refs.find((r) => r.providerType === provider.providerType);
    if (match) return match;
  }
  return refs[0];
}

/** Mirror a new booking to the bot's connected calendar (best-effort). Returns
 *  the meeting join URL if any. `content` is the P6a builder output; the join
 *  URL rides the provider's native conference fields, not the text body. */
export async function syncCalendarCreate(
  ctx: BookingContext,
  bookingId: string,
  content: { summary: string; description: string },
  start: Date,
  end: Date,
  timezone: string,
  location?: string,
  conferencing?: boolean
): Promise<string | null> {
  const provider = await resolveCalendarProvider(ctx.bot.id);
  if (!provider) return null; // no calendar connection
  try {
    const ev = await provider.createEvent(
      ctx.bot.id,
      {
        startISO: start.toISOString(),
        endISO: end.toISOString(),
        timezone,
        summary: content.summary,
        description: content.description,
        ...(location ? { location } : {}),
        ...(conferencing ? { conferencing } : {}),
      },
      { eventId: googleEventId(bookingId) }
    );
    if (!ev) return null;
    const refRepo = AppDataSource.getRepository(BookingReference);
    await refRepo.save(
      refRepo.create({
        bookingId,
        providerType: provider.providerType,
        externalEventId: ev.eventId,
        externalCalendarId: ev.calendarId,
        meetingUrl: ev.meetUrl,
      })
    );
    return ev.meetUrl;
  } catch (err) {
    logger.warn('[Booking] calendar event create failed; booking stands (sync_pending)', {
      bookingId,
      error: err instanceof Error ? err.message : String(err),
    });
    await markSyncPending(bookingId);
    return null;
  }
}

export async function syncCalendarReschedule(
  ctx: BookingContext,
  bookingId: string,
  /**
   * Full event content, not a bare title. An owner who deletes the event and triggers the
   * recreate branch below used to get a title with a COMPLETELY EMPTY body — losing the
   * customer, the phone, the address and the manage link in one step.
   */
  content: { summary: string; description: string },
  start: Date,
  end: Date,
  timezone: string,
  /**
   * What a RECREATE needs, and an update does not.
   *
   * Grouped rather than trailing positionally, because the difference is the whole point and
   * a signature should not need a paragraph to say which arguments apply when. A plain update
   * deliberately PATCHes times alone so the owner's own edits to the event survive. A recreate
   * builds the event from nothing, so anything omitted here is gone for good: the recreate
   * SUCCEEDS, so `markSyncPending` never fires and the reconciler - which claims
   * `sync_pending` rows only - never revisits it. Omitting them cost the venue AND nulled the
   * stored Meet URL, which then blanked the join link on every later reschedule and in the
   * portal's booking list.
   */
  recreate?: { location?: string; conferencing?: boolean }
): Promise<void> {
  const { location, conferencing } = recreate ?? {};
  // Plan D9: no external calendar calls when sync is entitlement-disabled.
  // The booking itself is already updated internally; the mirror is
  // intentionally suspended (re-enables with the entitlement).
  if (!(await isCalendarSyncAllowed(ctx.tenant.id))) return;
  const refRepo = AppDataSource.getRepository(BookingReference);
  const ref = await canonicalRef(ctx.bot.id, bookingId);
  try {
    const input = { startISO: start.toISOString(), endISO: end.toISOString(), timezone };
    const recreateInput = {
      ...input,
      summary: content.summary,
      description: content.description,
      ...(location ? { location } : {}),
      ...(conferencing ? { conferencing } : {}),
    };
    if (ref) {
      // Route by the REF's provider — the event lives there. After a provider
      // switch, rescheduling an OLD event targets its original provider, which
      // returns no_connection (cred gone) → sync_pending for manual attention.
      const provider = providerFor(ref.providerType as 'google' | 'microsoft');
      const res = await provider.updateEvent(ctx.bot.id, ref.externalEventId, input, ref.externalCalendarId);
      if (res === 'not_found') {
        // Live reschedule instruction: recreate the mirror. The background
        // reconciler takes the opposite branch (cancel the booking) when the
        // owner deleted the event with no Axentrio action in flight.
        const ev = await provider.createEvent(ctx.bot.id, recreateInput, {
          eventId: googleEventId(bookingId),
          calendarId: ref.externalCalendarId,
        });
        if (ev) {
          ref.externalEventId = ev.eventId;
          ref.externalCalendarId = ev.calendarId;
          ref.meetingUrl = ev.meetUrl;
          await refRepo.save(ref);
        }
      } else if (res === 'no_access' || res === 'no_connection') {
        // Event lives on a now-inaccessible / disconnected account.
        await markSyncPending(bookingId);
      }
    } else {
      // Calendar connected after the booking was created → create on the bot's
      // current active provider now.
      const provider = await resolveCalendarProvider(ctx.bot.id);
      if (!provider) return;
      const ev = await provider.createEvent(ctx.bot.id, recreateInput, {
        eventId: googleEventId(bookingId),
      });
      if (ev) {
        await refRepo.save(
          refRepo.create({
            bookingId,
            providerType: provider.providerType,
            externalEventId: ev.eventId,
            externalCalendarId: ev.calendarId,
            meetingUrl: ev.meetUrl,
          })
        );
      }
    }
  } catch (err) {
    logger.warn('[Booking] calendar event reschedule sync failed (sync_pending)', {
      bookingId,
      error: err instanceof Error ? err.message : String(err),
    });
    await markSyncPending(bookingId);
  }
}

export async function syncCalendarCancel(ctx: BookingContext, bookingId: string): Promise<void> {
  // Plan D9: no external calendar calls when sync is entitlement-disabled.
  if (!(await isCalendarSyncAllowed(ctx.tenant.id))) return;
  const ref = await canonicalRef(ctx.bot.id, bookingId);
  if (!ref) return;
  try {
    await providerFor(ref.providerType as 'google' | 'microsoft').deleteEvent(
      ctx.bot.id,
      ref.externalEventId,
      ref.externalCalendarId
    );
  } catch (err) {
    logger.warn('[Booking] calendar event cancel sync failed', {
      bookingId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
