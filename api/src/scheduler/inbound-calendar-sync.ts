/**
 * Inbound calendar sync: owner edits in Google/Outlook update the Axentrio booking.
 *
 * A calendar cannot display an Axentrio error. When the new time breaks a
 * scheduling rule, the event is put back to the booking time and the owner is
 * mailed. The customer is not mailed for a move that did not land.
 */
import { AppDataSource } from '../database/data-source';
import { Booking } from '../database/entities/Booking';
import { ServiceType } from '../database/entities/ServiceType';
import type { CalendarProviderType } from '../database/entities/CalendarCredential';
import { BookingError } from '../booking/booking-providers/types';
import { sendCalendarChangeRejectedEmail } from '../booking/booking-providers/booking-email';
import { externalCancelBooking, externalRescheduleBooking } from '../booking/booking.service';
import { getBotBusinessTimezone } from '../booking/business-timezone';
import { getBotConfigForBotId } from '../services/bot-config.service';
import { logger } from '../utils/logger';
import { returningRows } from '../utils/raw-sql';
import {
  isCalendarSyncAllowed,
  providerFor,
  type ExternalEventState,
} from './calendar-provider';

const LEASE_MINUTES = 2;
const BATCH = 25;
const MAX_ROUND_ATTEMPTS = 6;
const BOOTSTRAP_LOOKBACK_DAYS = 1;
const GRAPH_WINDOW_DAYS = 400;

let running = false;

interface ClaimedCredential {
  id: string;
  tenant_id: string;
  bot_id: string;
  provider: CalendarProviderType;
  calendar_id: string;
  inbound_sync_cursor: string | null;
  inbound_attempts: number;
  lease_token: string;
}

interface MatchedRef {
  external_event_id: string;
  external_calendar_id: string;
  booking_id: string;
}

interface Lease {
  id: string;
  until: string;
}

export type InboundDecision =
  | { action: 'none' }
  | { action: 'cancel' }
  | { action: 'move'; startISO: string; durationMin: number }
  | { action: 'restore'; reason: string }
  | { action: 'defer' };

export function decideInboundChange(
  booking: { startUtc: Date; endUtc: Date },
  state: ExternalEventState
): InboundDecision {
  if (state.kind === 'not_found') return { action: 'cancel' };
  if (state.kind === 'no_access' || state.kind === 'no_connection') return { action: 'defer' };
  if (state.cancelled) return { action: 'cancel' };
  if (state.startISO === null || state.endISO === null) {
    return { action: 'restore', reason: 'An all-day event has no appointment time.' };
  }
  const start = new Date(state.startISO);
  const end = new Date(state.endISO);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return { action: 'restore', reason: 'The end time is not after the start time.' };
  }
  const durationMin = Math.round((end.getTime() - start.getTime()) / 60_000);
  if (durationMin <= 0) {
    return { action: 'restore', reason: 'The end time is not after the start time.' };
  }
  if (
    Math.floor(start.getTime() / 1000) === Math.floor(booking.startUtc.getTime() / 1000) &&
    Math.floor(end.getTime() / 1000) === Math.floor(booking.endUtc.getTime() / 1000)
  ) {
    return { action: 'none' };
  }
  return { action: 'move', startISO: state.startISO, durationMin };
}

/** Owner-readable reason for a refused external move. Keyed on the error code so no
 *  LLM-facing or customer-facing string is ever forwarded verbatim. */
function ownerReasonFor(err: BookingError): string {
  switch (err.code) {
    case 'SLOT_UNAVAILABLE':
      return 'That time overlaps another appointment, or falls outside your booking hours.';
    case 'TRAVEL_TIME_CONFLICT':
      return 'That time cannot be reached from the appointments either side of it.';
    case 'BOOKING_NOT_RESCHEDULABLE':
      return 'That booking is no longer open for changes.';
    default:
      return 'Axentrio could not apply that change.';
  }
}

export async function syncExternalCalendarChanges(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const skip: string[] = [];
    for (let n = 0; n < BATCH; n++) {
      const claimed = returningRows<ClaimedCredential>(
        await AppDataSource.query(
          `UPDATE chatbot_calendar_credentials
              SET inbound_claimed_until = now() + interval '${LEASE_MINUTES} minutes'
            WHERE id IN (
              SELECT id FROM chatbot_calendar_credentials
               WHERE status = 'active'
                 AND reauth_required = false
                 AND (inbound_claimed_until IS NULL OR inbound_claimed_until < now())
                 AND NOT (id = ANY($1::uuid[]))
               ORDER BY inbound_synced_at NULLS FIRST
               LIMIT 1
               FOR UPDATE SKIP LOCKED
            )
          RETURNING id, tenant_id, bot_id, provider, calendar_id, inbound_sync_cursor, inbound_attempts,
                    inbound_claimed_until::text AS lease_token`,
          [skip]
        )
      );
      if (!claimed.length) {
        if (n > 0) {
          logger.info('[Booking] inbound calendar sync claimed credentials', { count: n });
        }
        return;
      }
      const row = claimed[0];
      skip.push(row.id);
      const lease: Lease = { id: row.id, until: row.lease_token };
      try {
        await processCredential(row, lease);
      } catch (err) {
        await recordRoundFailure(lease, err);
      }
    }
    logger.info('[Booking] inbound calendar sync claimed credentials', { count: skip.length });
  } finally {
    running = false;
  }
}

async function processCredential(row: ClaimedCredential, lease: Lease): Promise<void> {
  if (!(await isCalendarSyncAllowed(row.tenant_id))) {
    await releaseClaim(lease);
    return;
  }

  const window = syncWindow();
  let batch;
  try {
    if (!(await holdLease(lease))) return;
    batch = await providerFor(row.provider).listChanges(row.bot_id, row.inbound_sync_cursor, window);
  } catch (err) {
    await recordRoundFailure(lease, err);
    return;
  }
  if (!batch) {
    await releaseClaim(lease);
    return;
  }
  if (batch.bootstrapped) {
    await persistCursor(lease, batch.cursor);
    return;
  }

  const matches = batch.eventIds.length
    ? ((await AppDataSource.query(
        `SELECT r.external_event_id, r.external_calendar_id, b.id AS booking_id
           FROM chatbot_booking_references r
           JOIN chatbot_bookings b ON b.id = r.booking_id
          WHERE r.provider_type = $1
            AND r.external_event_id = ANY($2::text[])
            AND b.bot_id = $3
            AND b.status = 'confirmed'
            AND b.start_utc > now()`,
        [row.provider, batch.eventIds, row.bot_id]
      )) as MatchedRef[])
    : [];

  let failures = 0;
  let lastError: unknown = 'inbound candidate failed';
  for (const match of matches) {
    try {
      if (!(await holdLease(lease))) return;
      const state = await providerFor(row.provider).getEvent(
        row.bot_id,
        match.external_event_id,
        match.external_calendar_id
      );
      if (!(await holdLease(lease))) return;
      const result = await applyExternalEventState({
        lease,
        tenantId: row.tenant_id,
        botId: row.bot_id,
        bookingId: match.booking_id,
        ref: {
          externalEventId: match.external_event_id,
          externalCalendarId: match.external_calendar_id,
          providerType: row.provider,
        },
        state,
      });
      if (result === 'lost') return;
      if (result === 'failed') {
        failures += 1;
        lastError = `deferred ${match.external_event_id}`;
      }
    } catch (err) {
      failures += 1;
      lastError = err;
    }
  }

  if (failures > 0) {
    if (row.inbound_attempts + 1 >= MAX_ROUND_ATTEMPTS) {
      logger.error('[Booking] inbound calendar sync skipped poisoned change set', {
        credentialId: row.id,
        botId: row.bot_id,
        attempts: row.inbound_attempts + 1,
      });
      await persistCursor(lease, batch.cursor);
      return;
    }
    await recordRoundFailure(lease, lastError);
    return;
  }
  await persistCursor(lease, batch.cursor);

}

function syncWindow(): { startISO: string; endISO: string } {
  const now = Date.now();
  return {
    startISO: new Date(now - BOOTSTRAP_LOOKBACK_DAYS * 86_400_000).toISOString(),
    endISO: new Date(now + GRAPH_WINDOW_DAYS * 86_400_000).toISOString(),
  };
}

async function applyExternalEventState(input: {
  lease: Lease;
  tenantId: string;
  botId: string;
  bookingId: string;
  ref: { externalEventId: string; externalCalendarId: string; providerType: CalendarProviderType };
  state: ExternalEventState;
}): Promise<'applied' | 'failed' | 'lost'> {
  const booking = await AppDataSource.getRepository(Booking).findOne({ where: { id: input.bookingId } });
  if (!booking || booking.status !== 'confirmed') return 'applied';

  const decision = decideInboundChange(booking, input.state);
  if (decision.action === 'none') return 'applied';
  if (decision.action === 'defer') return 'failed';

  if (decision.action === 'cancel') {
    if (!(await holdLease(input.lease))) return 'lost';
    await externalCancelBooking(
      input.tenantId,
      input.bookingId,
      'Cancelled in the connected calendar'
    );
    logger.info('[Booking] inbound calendar cancel applied', {
      bookingId: input.bookingId,
      provider: input.ref.providerType,
    });
    return 'applied';
  }

  if (decision.action === 'move') {
    try {
      if (!(await holdLease(input.lease))) return 'lost';
      await externalRescheduleBooking(
        input.tenantId,
        input.bookingId,
        decision.startISO,
        decision.durationMin
      );
      logger.info('[Booking] inbound calendar move applied', {
        bookingId: input.bookingId,
        provider: input.ref.providerType,
      });
      return 'applied';
    } catch (err) {
      if (!(err instanceof BookingError)) throw err;
      return restoreExternalEvent(input, booking, decision.startISO, ownerReasonFor(err));
    }
  }

  const attemptedISO = input.state.kind === 'found' ? input.state.startISO : null;
  return restoreExternalEvent(input, booking, attemptedISO, decision.reason);
}

async function restoreExternalEvent(
  input: {
    lease: Lease;
    botId: string;
    bookingId: string;
    ref: { externalEventId: string; externalCalendarId: string; providerType: CalendarProviderType };
  },
  booking: Booking,
  attemptedISO: string | null,
  reason: string
): Promise<'applied' | 'failed' | 'lost'> {
  if (!(await holdLease(input.lease))) return 'lost';
  const timezone = await getBotBusinessTimezone(input.botId);
  const res = await providerFor(input.ref.providerType).updateEvent(
    input.botId,
    input.ref.externalEventId,
    {
      startISO: booking.startUtc.toISOString(),
      endISO: booking.endUtc.toISOString(),
      timezone,
    },
    input.ref.externalCalendarId
  );
  if (res !== 'ok') return 'failed';

  if (!(await holdLease(input.lease))) return 'lost';
  await notifyOwnerRejected({
    botId: input.botId,
    booking,
    attemptedStart: attemptedISO ? new Date(attemptedISO) : booking.startUtc,
    reason,
    timezone,
  });
  return 'applied';
}

async function notifyOwnerRejected(input: {
  botId: string;
  booking: Booking;
  attemptedStart: Date;
  reason: string;
  timezone: string;
}): Promise<void> {
  let ownerEmail: string | undefined;
  try {
    const bot = await getBotConfigForBotId(input.botId);
    ownerEmail = bot.settings?.ai?.supportEmail?.trim() || undefined;
  } catch {
    ownerEmail = undefined;
  }
  if (!ownerEmail) {
    logger.warn('[Booking] inbound restore owner email skipped - no supportEmail configured', {
      bookingId: input.booking.id,
      botId: input.botId,
    });
    return;
  }
  const service = input.booking.eventTypeId
    ? await AppDataSource.getRepository(ServiceType).findOne({ where: { id: input.booking.eventTypeId } })
    : null;
  await sendCalendarChangeRejectedEmail({
    ownerEmail,
    serviceName: service?.name ?? 'Appointment',
    attemptedStart: input.attemptedStart,
    restoredStart: input.booking.startUtc,
    timezone: input.timezone,
    attendeeName: input.booking.attendeeName ?? '',
    reason: input.reason,
  });
}

/** The owner removed the mirror. Cancel the booking; no-op if it is not confirmed. */
export async function applyExternalRemoval(input: {
  tenantId: string;
  botId: string;
  bookingId: string;
}): Promise<void> {
  const booking = await AppDataSource.getRepository(Booking).findOne({ where: { id: input.bookingId } });
  if (!booking || booking.status !== 'confirmed') return;
  await externalCancelBooking(input.tenantId, input.bookingId, 'Cancelled in the connected calendar');
}

async function holdLease(lease: Lease): Promise<boolean> {
  const rows = returningRows<{ lease_token: string }>(
    await AppDataSource.query(
      `UPDATE chatbot_calendar_credentials
          SET inbound_claimed_until = now() + interval '${LEASE_MINUTES} minutes'
        WHERE id = $1 AND inbound_claimed_until = $2::timestamptz
        RETURNING inbound_claimed_until::text AS lease_token`,
      [lease.id, lease.until]
    )
  );
  const next = rows[0]?.lease_token;
  if (!next) return false;
  lease.until = next;
  return true;
}

async function persistCursor(lease: Lease, cursor: string): Promise<void> {
  await AppDataSource.query(
    `UPDATE chatbot_calendar_credentials
        SET inbound_sync_cursor = $3,
            inbound_synced_at = now(),
            inbound_attempts = 0,
            inbound_last_error = NULL,
            inbound_claimed_until = NULL
      WHERE id = $1 AND inbound_claimed_until = $2::timestamptz`,
    [lease.id, lease.until, cursor]
  );
}

async function recordRoundFailure(lease: Lease, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await AppDataSource.query(
    `UPDATE chatbot_calendar_credentials
        SET inbound_attempts = inbound_attempts + 1,
            inbound_last_error = $3,
            inbound_claimed_until = NULL
      WHERE id = $1 AND inbound_claimed_until = $2::timestamptz`,
    [lease.id, lease.until, message.slice(0, 2000)]
  );
}

async function releaseClaim(lease: Lease): Promise<void> {
  await AppDataSource.query(
    `UPDATE chatbot_calendar_credentials
        SET inbound_claimed_until = NULL
      WHERE id = $1 AND inbound_claimed_until = $2::timestamptz`,
    [lease.id, lease.until]
  );
}
