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
import { AvailabilityRule } from '../database/entities/AvailabilityRule';
import { logger } from '../utils/logger';
import { resolveCalendarProvider, providerFor, isCalendarSyncAllowed } from './calendar-provider';
import { buildBookingEventContent } from '../n8n/booking-providers/booking-content';
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
export async function reconcilePendingBookingSyncs(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const claimed: ClaimedRow[] = await AppDataSource.query(
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
    );
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
  };

  if (ref) {
    const provider = providerFor(ref.providerType as 'google' | 'microsoft');
    const res = await provider.updateEvent(row.bot_id, ref.externalEventId, input, ref.externalCalendarId);
    if (res === 'no_access') return terminal(row, 'reconnect needed: no access to update event');
    if (res === 'no_connection') {
      return terminal(row, `reconnect needed: no active ${ref.providerType} credential for stored ref`);
    }
    if (res === 'not_found') {
      // Event was deleted in the calendar → recreate (deterministic id) on its home.
      const ev = await provider.createEvent(row.bot_id, input, {
        eventId: googleEventId(row.id),
        calendarId: ref.externalCalendarId,
      });
      if (ev) {
        ref.externalEventId = ev.eventId;
        ref.externalCalendarId = ev.calendarId;
        ref.meetingUrl = ev.meetUrl;
        await refRepo.save(ref);
      }
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

/**
 * Resolve the rich event body + timezone for a row. Builds `content` from the
 * SAME P6a builder the inline create uses (loading the booking row's
 * customer/intake fields) so a reconciler-retried event is byte-identical to an
 * inline one. Returns `content: undefined` when the service type or availability
 * rule is missing (caller marks terminal).
 */
async function loadEventMeta(
  row: ClaimedRow
): Promise<{ content?: { summary: string; description: string }; timezone?: string; startUtc?: string; endUtc?: string }> {
  const etRepo = AppDataSource.getRepository(ServiceType);
  const eventType = row.event_type_id
    ? await etRepo.findOne({ where: { id: row.event_type_id } })
    : await etRepo.findOne({ where: { botId: row.bot_id, isActive: true } });
  const rule = await AppDataSource.getRepository(AvailabilityRule).findOne({ where: { botId: row.bot_id } });
  if (!eventType || !rule) return { timezone: rule?.timezone };

  const bookingRows: Array<{
    attendee_name: string | null;
    attendee_email: string | null;
    customer_phone: string | null;
    customer_address: string | null;
    ai_summary: string | null;
    notes: string | null;
    intake_answers: unknown;
    start_utc: string;
    end_utc: string;
  }> = await AppDataSource.query(
    `SELECT attendee_name, attendee_email, customer_phone, customer_address,
            ai_summary, notes, intake_answers, start_utc, end_utc
       FROM chatbot_bookings WHERE id = $1`,
    [row.id]
  );
  const b = bookingRows[0];
  const content = buildBookingEventContent(
    {
      attendeeName: b?.attendee_name,
      attendeeEmail: b?.attendee_email,
      customerPhone: b?.customer_phone,
      customerAddress: b?.customer_address,
      aiSummary: b?.ai_summary,
      notes: b?.notes,
      intakeAnswers: b?.intake_answers,
    },
    { name: eventType.name, description: eventType.description, intakeQuestions: eventType.intakeQuestions },
    buildManageUrl(row.id)
  );
  return { content, timezone: rule.timezone, startUtc: b?.start_utc ?? row.start_utc, endUtc: b?.end_utc ?? row.end_utc };
}

async function clear(row: ClaimedRow): Promise<void> {
  // Re-assert the claim: only clear the dirty flag if the row hasn't changed since
  // we claimed it. A concurrent reschedule/cancel bumps updated_at (and drives its
  // own calendar update), so if it raced us we must NOT clear sync_pending — leave
  // it for the next tick to reconcile against the new state, else the mirror could
  // be stranded at a stale time with no re-sync flag.
  const cleared: Array<{ id: string }> = await AppDataSource.query(
    `UPDATE chatbot_bookings
        SET sync_pending = false, sync_claimed_until = null, sync_last_error = null,
            sync_attempts = 0, sync_next_attempt_at = null, updated_at = now()
      WHERE id = $1 AND updated_at::text = $2
      RETURNING id`,
    [row.id, row.updated_at]
  );
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
