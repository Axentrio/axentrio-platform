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

function rescheduleUpdateInput(
  times: { startISO: string; endISO: string; timezone: string },
  conferencing: boolean | undefined,
  location: string | undefined,
  hasMeetUrl: boolean,
) {
  // Video with an existing join link: times only, keep the conference.
  // Video with no join link: mint one and clear any leftover street.
  // Anything else: write the resolved place and drop conferencing.
  if (conferencing === false) {
    return { ...times, location: location ?? '', conferencing: false as const };
  }
  if (conferencing === true && !hasMeetUrl) {
    return { ...times, location: location ?? '', conferencing: true as const };
  }
  return times;
}

type RescheduleTimes = { startISO: string; endISO: string; timezone: string };
type RecreateInput = RescheduleTimes & {
  summary: string;
  description: string;
  location?: string;
  conferencing?: boolean;
};

async function rescheduleExistingRef(
  ctx: BookingContext,
  bookingId: string,
  ref: BookingReference,
  updateInput: ReturnType<typeof rescheduleUpdateInput>,
  recreateInput: RecreateInput,
  conferencing: boolean | undefined,
  latestMeetUrl: string | null,
): Promise<string | null> {
  const refRepo = AppDataSource.getRepository(BookingReference);
  const provider = providerFor(ref.providerType as 'google' | 'microsoft');
  const res = await provider.updateEvent(ctx.bot.id, ref.externalEventId, updateInput, ref.externalCalendarId);
  if (res.status === 'ok') {
    if (conferencing === false) {
      if (ref.meetingUrl) {
        ref.meetingUrl = null;
        await refRepo.save(ref);
      }
      return null;
    }
    if (conferencing === true && res.meetUrl) {
      ref.meetingUrl = res.meetUrl;
      await refRepo.save(ref);
      return res.meetUrl;
    }
    return latestMeetUrl;
  }
  if (res.status === 'not_found') {
    const ev = await provider.createEvent(ctx.bot.id, recreateInput, {
      eventId: googleEventId(bookingId),
      calendarId: ref.externalCalendarId,
    });
    if (ev) {
      ref.externalEventId = ev.eventId;
      ref.externalCalendarId = ev.calendarId;
      ref.meetingUrl = ev.meetUrl;
      await refRepo.save(ref);
      return conferencing ? ev.meetUrl : null;
    }
    return latestMeetUrl;
  }
  if (res.status === 'no_access' || res.status === 'no_connection') {
    await markSyncPending(bookingId);
  }
  return latestMeetUrl;
}

async function rescheduleMissingRef(
  ctx: BookingContext,
  bookingId: string,
  recreateInput: RecreateInput,
  conferencing: boolean | undefined,
  latestMeetUrl: string | null,
): Promise<string | null> {
  const provider = await resolveCalendarProvider(ctx.bot.id);
  if (!provider) return latestMeetUrl;
  const ev = await provider.createEvent(ctx.bot.id, recreateInput, {
    eventId: googleEventId(bookingId),
  });
  if (!ev) return latestMeetUrl;
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
  return conferencing ? ev.meetUrl : null;
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
   * Placement for BOTH a live update and a recreate.
   *
   * A plain update used to PATCH times alone so owner body edits survived. That
   * also left a leftover Meet conference and Meet LOCATION after a type change.
   * Current service type wins: a non-video reschedule writes the resolved place
   * and drops conferencing. Description is still not patched. A recreate builds
   * the event from nothing, so anything omitted here is gone for good.
   */
  placement?: { location?: string; conferencing?: boolean }
): Promise<string | null> {
  const { location, conferencing } = placement ?? {};
  if (!(await isCalendarSyncAllowed(ctx.tenant.id))) {
    return conferencing ? (await canonicalRef(ctx.bot.id, bookingId))?.meetingUrl ?? null : null;
  }
  const ref = await canonicalRef(ctx.bot.id, bookingId);
  let latestMeetUrl = conferencing ? (ref?.meetingUrl ?? null) : null;
  const times = { startISO: start.toISOString(), endISO: end.toISOString(), timezone };
  const updateInput = rescheduleUpdateInput(times, conferencing, location, Boolean(ref?.meetingUrl));
  const recreateInput = {
    ...times,
    summary: content.summary,
    description: content.description,
    ...(location ? { location } : {}),
    ...(conferencing ? { conferencing } : {}),
  };
  try {
    latestMeetUrl = ref
      ? await rescheduleExistingRef(
          ctx,
          bookingId,
          ref,
          updateInput,
          recreateInput,
          conferencing,
          latestMeetUrl,
        )
      : await rescheduleMissingRef(ctx, bookingId, recreateInput, conferencing, latestMeetUrl);
  } catch (err) {
    logger.warn('[Booking] calendar event reschedule sync failed (sync_pending)', {
      bookingId,
      error: err instanceof Error ? err.message : String(err),
    });
    await markSyncPending(bookingId);
  }
  return latestMeetUrl;
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

