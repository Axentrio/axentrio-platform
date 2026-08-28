/**
 * Google-sync reconciliation worker (P0-4).
 *
 * Bookings are DB-first; the Google mirror is best-effort and flags `sync_pending`
 * on failure. This worker retries those flagged rows so a transient Google blip
 * doesn't permanently lose the calendar event.
 *
 * Safety properties:
 * - Claim via `FOR UPDATE SKIP LOCKED` + a short lease (`sync_claimed_until`) so
 *   concurrent runs / replicas never process the same row. The claim txn is tiny;
 *   Google IO happens OUTSIDE any transaction.
 * - Idempotent create: the deterministic event id (booking uuid sans hyphens, same
 *   as InternalProvider) makes a retry after a partial failure a no-op (409→fetch).
 * - Bounded backoff (5m→15m→45m→2h→4h) then terminal after MAX_ATTEMPTS, recording
 *   sync_last_error and clearing sync_pending so it stops being re-claimed.
 */
import { AppDataSource } from '../database/data-source';
import { BookingReference } from '../database/entities/BookingReference';
import { ServiceType } from '../database/entities/ServiceType';
import { BookingSettings } from '../database/entities/BookingSettings';
import { resolveBookingEventLocation } from '../booking/booking-providers/event-location';
import { AvailabilityRule } from '../database/entities/AvailabilityRule';
import { getBotBusinessTimezone } from '../booking/business-timezone';
import { logger } from '../utils/logger';
import { resolveCalendarProvider, providerFor, isCalendarSyncAllowed } from './calendar-provider';
import { applyExternalRemoval } from './inbound-calendar-sync';
import { returningRows } from '../utils/raw-sql';
import { buildBookingEventContent } from '../booking/booking-providers/booking-content';
import { buildManageUrl } from './booking-token';

const LEASE_MINUTES = 2;
const MAX_ATTEMPTS = 6;
// Backoff for attempts 1..5 (minutes); the 6th failure is terminal.
const BACKOFF_MINUTES = [5, 15, 45, 120, 240];
const BATCH = 25;

let running = false;

interface ClaimedRow {
  id: string;
  tenant_id: string;
  bot_id: string;
  status: string;
  start_utc: string;
  end_utc: string;
  event_type_id: string | null;
  sync_attempts: number;
  /** Claim-time updated_at (::text for exact equality — node-pg truncates
   *  timestamptz to ms, which would break an optimistic compare). */
  updated_at: string;
}

/** Deterministic Google event id — MUST match InternalProvider.googleEventId. */
function googleEventId(bookingId: string): string {
  return bookingId.replace(/-/g, '');
}

/**
 * Process one tick: claim a batch of due, unleased pending bookings and reconcile
 * each. Re-entrancy guarded in-process; safe to call from a setInterval.
 */
/**
 * How long a confirmed booking may legitimately sit with no calendar mirror and no pending
 * flag before we treat it as orphaned.
 *
 * The inline create path commits the booking FIRST and mirrors it after — deliberately, so
 * a calendar outage cannot cost a customer their slot. That leaves a short, entirely normal
 * window in which `confirmed + no reference + sync_pending = false` is simply "the calendar
 * call is still in flight". Ten minutes is far longer than that call can take and far
 * shorter than a customer waits for their invite.
 */
const ORPHAN_GRACE_MINUTES = 10;

/**
 * Re-flag confirmed bookings whose mirror was never created and which nothing will ever
 * retry.
 *
 * The claim below only ever sees `sync_pending = true`. If the process dies between the
 * transaction commit and the `markSyncPending` that a failed calendar call performs, the row
 * lands in a state no sweep reclaims: confirmed, no mirror, no flag. The customer holds a
 * real slot the owner's calendar never learns about — and because the booking IS valid, the
 * only symptom is a double-booking weeks later.
 *
 * Deliberately narrow: future bookings only (mirroring a past appointment helps nobody), and
 * only rows past the grace window, so this never races the ordinary create path.
 */
async function reflagOrphanedMirrors(): Promise<void> {
  const reflagged = returningRows<{ id: string }>(await AppDataSource.query(
    `UPDATE chatbot_bookings b
        SET sync_pending = true, updated_at = now()
      WHERE b.status = 'confirmed'
        AND b.sync_pending = false
        AND b.start_utc > now()
        AND b.created_at < now() - interval '${ORPHAN_GRACE_MINUTES} minutes'
        AND NOT EXISTS (
          SELECT 1 FROM chatbot_booking_references r WHERE r.booking_id = b.id
        )
      RETURNING b.id`
  ));
  if (reflagged.length) {
    // Worth a WARN, not an info: reaching this means a process died mid-create, and the
    // count is the number of customers who were holding an invisible appointment.
    logger.warn('[Booking] re-flagged confirmed bookings with no calendar mirror', {
      count: reflagged.length,
      bookingIds: reflagged.slice(0, 10).map((r) => r.id),
    });
  }
}

export async function reconcilePendingBookingSyncs(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Before claiming: rescue anything the claim can structurally never see.
    await reflagOrphanedMirrors();
    // NOTE: UPDATE…RETURNING through .query() yields [rows, count], NOT rows —
    // consuming it raw produced two phantom "rows" per tick forever (see
    // utils/raw-sql.ts).
    const claimed = returningRows<ClaimedRow>(await AppDataSource.query(
      `UPDATE chatbot_bookings
          SET sync_claimed_until = now() + interval '${LEASE_MINUTES} minutes'
        WHERE id IN (
          SELECT id FROM chatbot_bookings
           WHERE sync_pending = true
             AND (sync_claimed_until IS NULL OR sync_claimed_until < now())
             AND (sync_next_attempt_at IS NULL OR sync_next_attempt_at <= now())
           ORDER BY sync_next_attempt_at NULLS FIRST
           LIMIT ${BATCH}
           FOR UPDATE SKIP LOCKED
        )
      RETURNING id, tenant_id, bot_id, status, start_utc, end_utc, event_type_id, sync_attempts, updated_at::text AS updated_at`
    ));
    if (!claimed.length) return;
    logger.info('[Booking] reconciler claimed pending syncs', { count: claimed.length });
    for (const row of claimed) {
      try {
        await processOne(row);
      } catch (err) {
        await recordFailure(row, err);
      }
    }
  } finally {
    running = false;
  }
}

/**
 * The ref to reconcile. Normally exactly one; if a rare switch/create race left
 * more than one, prefer the ref matching the bot's current active provider, else
 * the earliest-created (mirrors InternalProvider.canonicalRef).
 */
async function canonicalRef(botId: string, bookingId: string): Promise<BookingReference | null> {
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

async function processOne(row: ClaimedRow): Promise<void> {
  // Plan D9: no external calendar calls when sync is entitlement-disabled.
  // One check here covers every reconciler path (ref-routed deletes/updates
  // included). Terminal (not clear) so sync_last_error records why the mirror
  // is suspended; re-enabling the entitlement resumes future syncs.
  if (!(await isCalendarSyncAllowed(row.tenant_id))) {
    return terminal(row, 'calendar sync disabled by plan entitlements');
  }
  const refRepo = AppDataSource.getRepository(BookingReference);
  const ref = await canonicalRef(row.bot_id, row.id);

  // Cancelled → delete the mirrored event (on its real home) if any. Route by the
  // REF's provider; a ref whose provider is no longer connected goes terminal.
  if (row.status === 'cancelled') {
    if (ref) {
      const res = await providerFor(ref.providerType as 'google' | 'microsoft').deleteEvent(
        row.bot_id,
        ref.externalEventId,
        ref.externalCalendarId
      );
      if (res === 'no_access') return terminal(row, 'reconnect needed: no access to delete event');
      if (res === 'no_connection') {
        return terminal(row, `reconnect needed: no active ${ref.providerType} credential for stored ref`);
      }
    }
    return clear(row);
  }

  // Not a live confirmed booking → nothing to mirror.
  if (row.status !== 'confirmed') return clear(row);

  const meta = await loadEventMeta(row);
  if (!meta.content || !meta.timezone) {
    return terminal(row, 'event type or availability rule missing');
  }
  // `description` is only consumed by createCalendarEvent (re)creates;
  // updateCalendarEvent Picks start/end/timezone, so a reschedule never PATCHes
  // the body (owner edits to an existing event survive).
  const input = {
    // Live times (re-read in loadEventMeta), so a reschedule that landed after the
    // claim is pushed as the CURRENT time, not the stale snapshot.
    startISO: new Date(meta.startUtc!).toISOString(),
    endISO: new Date(meta.endUtc!).toISOString(),
    timezone: meta.timezone,
    summary: meta.content.summary,
    description: meta.content.description,
    ...(meta.location ? { location: meta.location } : {}),
    ...(meta.conferencing ? { conferencing: true } : {}),
  };

  if (ref) {
    const provider = providerFor(ref.providerType as 'google' | 'microsoft');
    const res = await provider.updateEvent(row.bot_id, ref.externalEventId, input, ref.externalCalendarId);
    if (res === 'no_access') return terminal(row, 'reconnect needed: no access to update event');
    if (res === 'no_connection') {
      return terminal(row, `reconnect needed: no active ${ref.providerType} credential for stored ref`);
    }
    if (res === 'not_found') {
      await applyExternalRemoval({ tenantId: row.tenant_id, botId: row.bot_id, bookingId: row.id });
      return clear(row);
    }
    return clear(row);
  }

  // Confirmed + no ref → create on the bot's current active provider (deterministic
  // id; legacy rows were neutralized by the migration, so this never duplicates a
  // pre-reconciler event).
  const provider = await resolveCalendarProvider(row.bot_id);
  if (!provider) return clear(row); // no connection → nothing to mirror
  const ev = await provider.createEvent(row.bot_id, input, { eventId: googleEventId(row.id) });
  if (!ev) return clear(row);
  await refRepo.save(
    refRepo.create({
      bookingId: row.id,
      providerType: provider.providerType,
      externalEventId: ev.eventId,
      externalCalendarId: ev.calendarId,
      meetingUrl: ev.meetUrl,
    })
  );
  return clear(row);
}

/** Every column the reconciled content and location builders read from `chatbot_bookings`. */
interface BookingContentRow {
  attendee_name: string | null;
  attendee_email: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  ai_summary: string | null;
  notes: string | null;
  intake_answers: unknown;
  start_utc: string;
  end_utc: string;
  source_channel: string | null;
  uploaded_files: unknown;
  booked_duration_min: number | null;
}

/**
 * Booked minutes for the rebuilt body: the stored value when the row carries one,
 * else the span itself — the same fallback the inline create path uses.
 */
function reconciledDurationMin(b: BookingContentRow | undefined): number | null {
  return (
    b?.booked_duration_min ??
    (b?.start_utc && b?.end_utc
      ? Math.round((new Date(b.end_utc).getTime() - new Date(b.start_utc).getTime()) / 60_000)
      : null)
  );
}

/** The event body, from the SAME P6a builder the inline create uses. */
function buildReconciledContent(
  row: ClaimedRow,
  b: BookingContentRow | undefined,
  eventType: ServiceType
): { summary: string; description: string } {
  return buildBookingEventContent(
    {
      attendeeName: b?.attendee_name,
      attendeeEmail: b?.attendee_email,
      customerPhone: b?.customer_phone,
      customerAddress: b?.customer_address,
      aiSummary: b?.ai_summary,
      notes: b?.notes,
      intakeAnswers: b?.intake_answers,
      bookingId: row.id,
      durationMin: reconciledDurationMin(b),
      sourceChannel: b?.source_channel,
      uploadedFileCount: Array.isArray(b?.uploaded_files) ? b.uploaded_files.length : 0,
    },
    {
      name: eventType.name,
      description: eventType.description,
      intakeQuestions: eventType.intakeQuestions,
      preparationInstructions: eventType.preparationInstructions,
    },
    buildManageUrl(row.id)
  );
}

/**
 * A rebuilt mirror must carry the SAME location an inline one does, or a crash silently
 * downgrades the event the owner navigates by. Same pure helpers as the create path.
 */
async function resolveMirrorLocation(
  botId: string,
  eventType: ServiceType,
  customerAddress: string | null | undefined
): Promise<string | undefined> {
  const settings = await AppDataSource.getRepository(BookingSettings).findOne({
    where: { botId },
  });
  return resolveBookingEventLocation(eventType, {
    // As on the create path, the Meet URL is not an input to the event.
    meetUrl: null,
    customerAddress,
    venue: {
      street: settings?.venueStreet ?? null,
      postalCode: settings?.venuePostalCode ?? null,
      city: settings?.venueCity ?? null,
      country: settings?.venueCountry ?? null,
    },
  });
}

/**
 * Resolve the rich event body + timezone for a row. Builds `content` from the
 * SAME P6a builder the inline create uses (loading the booking row's
 * customer/intake fields) so a reconciler-retried event is byte-identical to an
 * inline one. Returns `content: undefined` when the service type or availability
 * rule is missing (caller marks terminal).
 */
async function loadEventMeta(
  row: ClaimedRow
): Promise<{
  content?: { summary: string; description: string };
  /** Resolved venue for the mirror; absent means the event states no place. */
  location?: string;
  /** Video service — a rebuilt mirror must not sprout a Meet link an inline one lacks. */
  conferencing?: boolean;
  timezone?: string;
  startUtc?: string;
  endUtc?: string;
}> {
  const etRepo = AppDataSource.getRepository(ServiceType);
  const eventType = row.event_type_id
    ? await etRepo.findOne({ where: { id: row.event_type_id } })
    : await etRepo.findOne({ where: { botId: row.bot_id, isActive: true } });
  const rule = await AppDataSource.getRepository(AvailabilityRule).findOne({ where: { botId: row.bot_id } });
  // Canonical, server-owned business timezone — the bot is authoritative on
  // read; the rule row only gates "is booking configured at all".
  const timezone = await getBotBusinessTimezone(row.bot_id);
  if (!eventType || !rule) return { timezone };

  const bookingRows: BookingContentRow[] = await AppDataSource.query(
    // Every column the content builder reads. This SELECT is the whole reason the module
    // docstring promises byte-identical parity between a reconciled event and an inline
    // one — a field added to the builder but not here silently produces two different
    // bodies for the same booking.
    `SELECT attendee_name, attendee_email, customer_phone, customer_address,
            ai_summary, notes, intake_answers, start_utc, end_utc,
            source_channel, uploaded_files, booked_duration_min
       FROM chatbot_bookings WHERE id = $1`,
    [row.id]
  );
  const b = bookingRows[0];
  const content = buildReconciledContent(row, b, eventType);
  const location = await resolveMirrorLocation(row.bot_id, eventType, b?.customer_address);
  return {
    content,
    location,
    conferencing: eventType.locationType === 'google_meet',
    timezone,
    startUtc: b?.start_utc ?? row.start_utc,
    endUtc: b?.end_utc ?? row.end_utc,
  };
}

async function clear(row: ClaimedRow): Promise<void> {
  // Re-assert the claim: only clear the dirty flag if the row hasn't changed since
  // we claimed it. A concurrent reschedule/cancel bumps updated_at (and drives its
  // own calendar update), so if it raced us we must NOT clear sync_pending — leave
  // it for the next tick to reconcile against the new state, else the mirror could
  // be stranded at a stale time with no re-sync flag.
  const cleared = returningRows<{ id: string }>(await AppDataSource.query(
    `UPDATE chatbot_bookings
        SET sync_pending = false, sync_claimed_until = null, sync_last_error = null,
            sync_attempts = 0, sync_next_attempt_at = null, updated_at = now()
      WHERE id = $1 AND updated_at::text = $2
      RETURNING id`,
    [row.id, row.updated_at]
  ));
  if (!cleared.length) {
    logger.info('[Booking] reconciler skipped clear — row changed since claim (will re-reconcile)', {
      bookingId: row.id,
    });
  }
}

async function terminal(row: ClaimedRow, reason: string): Promise<void> {
  await AppDataSource.query(
    `UPDATE chatbot_bookings
        SET sync_pending = false, sync_claimed_until = null, sync_last_error = $2, updated_at = now()
      WHERE id = $1`,
    [row.id, reason]
  );
  logger.warn('[Booking] sync terminal (manual attention)', { bookingId: row.id, reason });
}

async function recordFailure(row: ClaimedRow, err: unknown): Promise<void> {
  const attempts = (row.sync_attempts ?? 0) + 1;
  const msg = err instanceof Error ? err.message : String(err);
  if (attempts >= MAX_ATTEMPTS) {
    await AppDataSource.query(
      `UPDATE chatbot_bookings
          SET sync_pending = false, sync_claimed_until = null, sync_attempts = $2,
              sync_last_error = $3, updated_at = now()
        WHERE id = $1`,
      [row.id, attempts, `terminal after ${attempts} attempts: ${msg}`]
    );
    logger.error('[Booking] sync gave up after max attempts', { bookingId: row.id, attempts, error: msg });
    return;
  }
  const backoff = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
  await AppDataSource.query(
    `UPDATE chatbot_bookings
        SET sync_claimed_until = null, sync_attempts = $2, sync_last_error = $3,
            sync_next_attempt_at = now() + ($4 || ' minutes')::interval, updated_at = now()
      WHERE id = $1`,
    [row.id, attempts, msg, String(backoff)]
  );
  logger.warn('[Booking] sync retry scheduled', { bookingId: row.id, attempts, backoffMinutes: backoff });
}
