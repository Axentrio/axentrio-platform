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
import { EventType } from '../database/entities/EventType';
import { AvailabilityRule } from '../database/entities/AvailabilityRule';
import { logger } from '../utils/logger';
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from '../integrations/google/google-calendar.service';

const LEASE_MINUTES = 2;
const MAX_ATTEMPTS = 6;
// Backoff for attempts 1..5 (minutes); the 6th failure is terminal.
const BACKOFF_MINUTES = [5, 15, 45, 120, 240];
const BATCH = 25;

let running = false;

interface ClaimedRow {
  id: string;
  bot_id: string;
  status: string;
  start_utc: string;
  end_utc: string;
  event_type_id: string | null;
  sync_attempts: number;
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
      RETURNING id, bot_id, status, start_utc, end_utc, event_type_id, sync_attempts`
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

async function processOne(row: ClaimedRow): Promise<void> {
  const refRepo = AppDataSource.getRepository(BookingReference);
  const ref = await refRepo.findOne({ where: { bookingId: row.id, providerType: 'google' } });

  // Cancelled → delete the mirrored event (on its real home) if any.
  if (row.status === 'cancelled') {
    if (ref) {
      const res = await deleteCalendarEvent(row.bot_id, ref.externalEventId, ref.externalCalendarId);
      if (res === 'no_access') return terminal(row, 'reconnect needed: no access to delete event');
    }
    return clear(row);
  }

  // Not a live confirmed booking → nothing to mirror.
  if (row.status !== 'confirmed') return clear(row);

  const meta = await loadEventMeta(row);
  if (!meta.summary || !meta.timezone) {
    return terminal(row, 'event type or availability rule missing');
  }
  const input = {
    startISO: new Date(row.start_utc).toISOString(),
    endISO: new Date(row.end_utc).toISOString(),
    timezone: meta.timezone,
    summary: meta.summary,
  };

  if (ref) {
    const res = await updateCalendarEvent(row.bot_id, ref.externalEventId, input, ref.externalCalendarId);
    if (res === 'no_access') return terminal(row, 'reconnect needed: no access to update event');
    if (res === 'not_found') {
      // Event was deleted on Google → recreate (deterministic id) on its home.
      const ev = await createCalendarEvent(row.bot_id, input, {
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

  // Confirmed + no ref → create (deterministic id; legacy rows were neutralized
  // by the migration, so this never duplicates a pre-reconciler event).
  const ev = await createCalendarEvent(row.bot_id, input, { eventId: googleEventId(row.id) });
  if (!ev) return clear(row); // no Google connection → nothing to mirror
  await refRepo.save(
    refRepo.create({
      bookingId: row.id,
      providerType: 'google',
      externalEventId: ev.eventId,
      externalCalendarId: ev.calendarId,
      meetingUrl: ev.meetUrl,
    })
  );
  return clear(row);
}

async function loadEventMeta(row: ClaimedRow): Promise<{ summary?: string; timezone?: string }> {
  const etRepo = AppDataSource.getRepository(EventType);
  const eventType = row.event_type_id
    ? await etRepo.findOne({ where: { id: row.event_type_id } })
    : await etRepo.findOne({ where: { botId: row.bot_id, isActive: true } });
  const rule = await AppDataSource.getRepository(AvailabilityRule).findOne({ where: { botId: row.bot_id } });
  return { summary: eventType?.name, timezone: rule?.timezone };
}

async function clear(row: ClaimedRow): Promise<void> {
  await AppDataSource.query(
    `UPDATE chatbot_bookings
        SET sync_pending = false, sync_claimed_until = null, sync_last_error = null, updated_at = now()
      WHERE id = $1`,
    [row.id]
  );
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
