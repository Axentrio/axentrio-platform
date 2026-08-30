/**
 * A confirmed booking may not be written until the Booking Customer has agreed
 * to a summary of the exact details. The first create_booking call records those
 * details; a later turn may write only after an explicit yes (or a slot chip for
 * that same hour), and only when a prior assistant reply named that hour and asked
 * a question. A later "change it to 11:00" or "what is the address?" is not that yes.
 *
 * Lives in Redis, same as offered slots: conversation-scoped, dies with TTL, no
 * migration on chat_sessions. Without Redis the gate fails open, matching the
 * offered-slot store — unit tests that never mock Redis keep their old path.
 */
import type { ToolContext, ToolResult } from './tool-adapter';
import { contentToText } from '../llm/llm.types';
import { namesSingleOfferedTime, parseClockTimes } from './clock-times';
import { SLOT_CHIP_CONFIRM_PREFIX } from '../config/bot-language';
import { getRedisClient } from '../config/redis';
import { wallClockKey } from './offered-slots-store';
import { logger } from '../utils/logger';

export const CONFIRMATION_REQUIRED = 'CONFIRMATION_REQUIRED';

const KEY_PREFIX = 'booking:confirm:';
const RESCHEDULE_PREFIX = 'booking:confirm-reschedule:';
const CANCEL_PREFIX = 'booking:confirm-cancel:';
const TTL_MS = 24 * 60 * 60 * 1000;
const CHIP_MAX_CHARS = 80;

export interface PendingBookingDetails {
  startTime: string;
  attendeeName: string;
  serviceId: string;
  runId: string;
  /** Set on reschedule/cancel pending records so a create yes cannot satisfy a move. */
  bookingId?: string;
  kind?: 'create' | 'reschedule' | 'cancel';
}

const AFFIRM_START =
  /^(ja|yes|ok(?:ay|é|e)?|sure|yep|yeah|yup|klopt|prima|goed|akkoord|bevestig(?:d)?|confirm(?:ed)?|oui|d['’]accord|boek het|book it|doe maar|go ahead|in orde|is goed|that(?:'s|s| is) (?:fine|ok|okay|correct|right))\b/;

/** Leading yes. Digits, a question mark, or a no-word mean they did not confirm. */
export function isAffirmativeReply(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > CHIP_MAX_CHARS || /\d/.test(trimmed) || trimmed.includes('?')) {
    return false;
  }
  const normalized = trimmed
    .toLowerCase()
    .replace(/[,.!…]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/\b(niet|nee|not|no|don't|dont|pas)\b/.test(normalized)) return false;
  return AFFIRM_START.test(normalized);
}

/** A short slot-chip payload naming the pending hour, not a details dump. */
export function isConfirmingChip(text: string, startTime: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > CHIP_MAX_CHARS || trimmed.includes('?')) return false;
  if (!SLOT_CHIP_CONFIRM_PREFIX.test(trimmed)) {
    return false;
  }
  const clock = startTime.match(/T(\d{2}):(\d{2})/);
  if (!clock) return false;
  return namesSingleOfferedTime(trimmed, [`${clock[1]}:${clock[2]}`]);
}

export function lastCustomerUtterance(ctx: Pick<ToolContext, 'conversationHistory'>): string {
  const history = ctx.conversationHistory;
  if (!Array.isArray(history)) return '';
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'user') continue;
    const text = contentToText(m.content).trim();
    if (text.startsWith('(Internal note')) continue;
    return text;
  }
  return '';
}

const SUMMARY_ASK = /boek|book|bevestig|confirm|afspraak|appointment|samenvatting|summary|klopt/i;

/**
 * A prior assistant reply named this hour and asked a question. Only replies
 * BEFORE the last real customer line count: a same-turn "Zal ik boeken?" after
 * the yes is the model talking to itself, not a summary the customer saw.
 */
export function summaryWasAsked(
  history: ToolContext['conversationHistory'],
  startTime: string,
): boolean {
  const clock = startTime.match(/T(\d{2}):(\d{2})/);
  if (!clock || !Array.isArray(history)) return false;
  const hhmm = `${clock[1]}:${clock[2]}`;
  let lastUser = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'user') continue;
    const text = contentToText(m.content).trim();
    if (text.startsWith('(Internal note')) continue;
    lastUser = i;
    break;
  }
  if (lastUser < 0) return false;
  for (let i = 0; i < lastUser; i++) {
    const m = history[i];
    if (m.role !== 'assistant') continue;
    const text = contentToText(m.content);
    if (!text.includes('?') || !SUMMARY_ASK.test(text)) continue;
    if (parseClockTimes(text).some((t) => t.key === hhmm)) return true;
  }
  return false;
}

/** True when a pending summary exists and the last customer line is an explicit yes. */
export async function pendingYesNeedsCreate(
  sessionId: string,
  history: ToolContext['conversationHistory'],
): Promise<boolean> {
  if (!isAffirmativeReply(lastCustomerUtterance({ conversationHistory: history }))) return false;
  const lookup = await readPending(sessionId);
  if (lookup.store !== 'up' || lookup.pending == null) return false;
  return summaryWasAsked(history, lookup.pending.startTime);
}

function parsePending(raw: string | null): PendingBookingDetails | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingBookingDetails>;
    if (
      typeof v.startTime !== 'string' ||
      typeof v.attendeeName !== 'string' ||
      typeof v.runId !== 'string'
    ) {
      return null;
    }
    return {
      startTime: v.startTime,
      attendeeName: v.attendeeName,
      serviceId: typeof v.serviceId === 'string' ? v.serviceId : '',
      runId: v.runId,
      bookingId: typeof v.bookingId === 'string' ? v.bookingId : undefined,
      kind:
        v.kind === 'reschedule' || v.kind === 'cancel' || v.kind === 'create' ? v.kind : undefined,
    };
  } catch {
    return null;
  }
}

async function readPending(
  sessionId: string,
  prefix = KEY_PREFIX,
): Promise<{ store: 'up'; pending: PendingBookingDetails | null } | { store: 'down' }> {
  const redis = getRedisClient();
  if (!redis) return { store: 'down' };
  try {
    return { store: 'up', pending: parsePending(await redis.get(`${prefix}${sessionId}`)) };
  } catch (err) {
    logger.warn('[booking] pending confirmation read failed; failing open', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { store: 'down' };
  }
}

async function writePending(
  sessionId: string,
  pending: PendingBookingDetails,
  prefix = KEY_PREFIX,
): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return false;
  try {
    await redis.set(`${prefix}${sessionId}`, JSON.stringify(pending), 'PX', String(TTL_MS));
    return true;
  } catch (err) {
    logger.warn('[booking] pending confirmation write failed; failing open', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function clearPending(sessionId: string, prefix = KEY_PREFIX): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.del(`${prefix}${sessionId}`);
  } catch {
    // Non-fatal: a stale pending only re-asks.
  }
}

/** Test/reset helper: the pending create_booking summary for this session, if any. */
export async function peekPendingBooking(
  sessionId: string,
): Promise<PendingBookingDetails | null> {
  const result = await readPending(sessionId);
  return result.store === 'up' ? result.pending : null;
}

/** Test helper: persist a pending confirmation the same way create_booking does. */
export async function putPendingBooking(
  sessionId: string,
  pending: PendingBookingDetails,
): Promise<boolean> {
  return writePending(sessionId, pending);
}

/**
 * null → proceed to write. A ToolResult → refuse and keep the provider untouched.
 */
export async function refuseUnlessConfirmed(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  const last = lastCustomerUtterance(ctx);
  // No customer utterance: internal callers and existing unit tests with empty history.
  if (!last) return null;

  const lookup = await readPending(ctx.sessionId);
  // Redis is optional. No store means we cannot remember a pending summary, so we
  // must not refuse forever after a yes the next turn cannot see.
  if (lookup.store === 'down') return null;

  const details = {
    startTime: await wallClockKey(ctx.sessionId, String(args.startTime ?? '')),
    attendeeName: String(args.attendeeName ?? '').trim(),
    serviceId: String(args.serviceId ?? ''),
  };
  const pending = lookup.pending;
  const sameService = !pending?.serviceId || !details.serviceId || pending.serviceId === details.serviceId;
  const confirmed =
    !!pending &&
    pending.startTime === details.startTime &&
    pending.attendeeName.toLowerCase() === details.attendeeName.toLowerCase() &&
    sameService &&
    (isConfirmingChip(last, pending.startTime) ||
      (isAffirmativeReply(last) && summaryWasAsked(ctx.conversationHistory, pending.startTime)));

  if (confirmed) {
    await clearPending(ctx.sessionId);
    return null;
  }

  const stored = await writePending(ctx.sessionId, {
    ...details,
    runId: ctx.runId,
  });
  if (!stored) return null;

  return {
    success: false,
    error:
      `${CONFIRMATION_REQUIRED}: Do not tell the customer they are booked. Send a short summary ` +
      `of the service, date, time, name, and the final price from that service's SERVICES line ` +
      `when one is shown, then wait for an explicit yes. Call create_booking again only after ` +
      `they confirm this same booking. Giving every detail in one first message is not confirmation.`,
    errorSafeForModel: true,
    data: {
      needsConfirmation: true,
      startTime: details.startTime,
      attendeeName: details.attendeeName,
      serviceId: details.serviceId || undefined,
    },
  };
}

export async function refuseUnlessRescheduleConfirmed(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  const last = lastCustomerUtterance(ctx);
  if (!last) return null;

  const lookup = await readPending(ctx.sessionId, RESCHEDULE_PREFIX);
  if (lookup.store === 'down') return null;

  const newStartTime = await wallClockKey(ctx.sessionId, String(args.newStartTime ?? ''));
  const bookingId = String(args.bookingId ?? '');
  const pending = lookup.pending;
  const confirmed =
    !!pending &&
    pending.kind === 'reschedule' &&
    pending.bookingId === bookingId &&
    pending.startTime === newStartTime &&
    (isConfirmingChip(last, pending.startTime) ||
      (isAffirmativeReply(last) && summaryWasAsked(ctx.conversationHistory, pending.startTime)));

  if (confirmed) {
    await clearPending(ctx.sessionId, RESCHEDULE_PREFIX);
    return null;
  }

  const stored = await writePending(
    ctx.sessionId,
    { startTime: newStartTime, attendeeName: '', serviceId: '', runId: ctx.runId, bookingId, kind: 'reschedule' },
    RESCHEDULE_PREFIX,
  );
  if (!stored) return null;

  return {
    success: false,
    error:
      `${CONFIRMATION_REQUIRED}: Do not tell the customer the appointment was moved. Send a short summary ` +
      `of the existing appointment and the new time, then wait for an explicit yes. Call reschedule_booking ` +
      `again only after they confirm this same move.`,
    errorSafeForModel: true,
    data: { needsConfirmation: true, bookingId, newStartTime },
  };
}

export async function refuseUnlessCancelConfirmed(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  const last = lastCustomerUtterance(ctx);
  if (!last) return null;

  const lookup = await readPending(ctx.sessionId, CANCEL_PREFIX);
  if (lookup.store === 'down') return null;

  const bookingId = String(args.bookingId ?? '');
  const pending = lookup.pending;
  const confirmed =
    !!pending &&
    pending.kind === 'cancel' &&
    pending.bookingId === bookingId &&
    (isAffirmativeReply(last) || isConfirmingChip(last, pending.startTime));

  if (confirmed) {
    await clearPending(ctx.sessionId, CANCEL_PREFIX);
    return null;
  }

  const stored = await writePending(
    ctx.sessionId,
    { startTime: '', attendeeName: '', serviceId: '', runId: ctx.runId, bookingId, kind: 'cancel' },
    CANCEL_PREFIX,
  );
  if (!stored) return null;

  return {
    success: false,
    error:
      `${CONFIRMATION_REQUIRED}: Do not tell the customer the appointment was cancelled. Confirm which ` +
      `appointment they mean, then wait for an explicit yes. Call cancel_booking again only after they confirm.`,
    errorSafeForModel: true,
    data: { needsConfirmation: true, bookingId },
  };
}

