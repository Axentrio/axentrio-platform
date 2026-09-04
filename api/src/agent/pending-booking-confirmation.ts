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
import { namesPendingDateAndClock, namesSingleOfferedTime, parseClockTimes } from './clock-times';
import { SLOT_CHIP_CONFIRM_PREFIX } from '../config/bot-language';
import { getRedisClient } from '../config/redis';
import { wallClockKey } from './offered-slots-store';
import { logger } from '../utils/logger';

export const CONFIRMATION_REQUIRED = 'CONFIRMATION_REQUIRED';
/** Its own code, because the model's recovery is a different tool rather than a second yes. */
export const MOVE_PENDING = 'MOVE_PENDING';

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
  /** New appointment address when the reschedule is a location change. */
  customerAddress?: string;
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
 * A prior assistant reply named this booking's date and clock and asked a question.
 * Only replies BEFORE the last real customer line count: a same-turn "Zal ik boeken?"
 * after the yes is the model talking to itself, not a summary the customer saw.
 *
 * Date and clock must be one phrase. A refusal that names 2 November 10:00 and a
 * range starting 26 October must not confirm a 26 October 10:00 booking. Live
 * WhatsApp 2026-09-02, session 3f63a9b5.
 */
export function summaryWasAsked(
  history: ToolContext['conversationHistory'],
  startTime: string,
): boolean {
  if (!Array.isArray(history)) return false;
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
    if (namesPendingDateAndClock(text, startTime)) return true;
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

/** A pending move the customer already agreed to; the nudge repeats these exact arguments. */
export interface PendingAgreedMove {
  bookingId: string;
  newStartTime: string;
  customerAddress?: string;
}

/**
 * The reschedule twin of `pendingYesNeedsCreate`: a pending move summary exists and the last
 * customer line is the agreeing yes. Live WaterFix 2026-09-02, session 1bbd5818: the turn after
 * "Ja, bevestig de wijziging" called list_bookings and check_availability but never
 * reschedule_booking, so the customer was told the move could not be confirmed while the slot
 * was free and the gate held a confirmed summary. The run loop reads this to nudge that turn.
 */
export async function pendingYesNeedsReschedule(
  sessionId: string,
  history: ToolContext['conversationHistory'],
): Promise<PendingAgreedMove | null> {
  const last = lastCustomerUtterance({ conversationHistory: history });
  if (!last) return null;
  const lookup = await readPending(sessionId, RESCHEDULE_PREFIX);
  if (lookup.store !== 'up' || lookup.pending == null) return null;
  const pending = lookup.pending;
  if (pending.kind !== 'reschedule' || !pending.bookingId) return null;
  if (!moveWasAgreed(history, pending, last)) return null;
  // The gate stores wallClockKey's minute-precision key; the tool contract documents seconds
  // ("2026-06-19T14:00:00"), so the nudge hands the model the documented shape. The retrying
  // call is re-keyed by the gate, so it still matches the stored pending.
  const withSeconds = /T\d{2}:\d{2}$/.test(pending.startTime) ? `${pending.startTime}:00` : pending.startTime;
  return {
    bookingId: pending.bookingId,
    newStartTime: withSeconds,
    ...(pending.customerAddress ? { customerAddress: pending.customerAddress } : {}),
  };
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
      customerAddress: typeof v.customerAddress === 'string' && v.customerAddress.trim()
        ? v.customerAddress.trim()
        : undefined,
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

/**
 * Did ONE summary the customer already read carry this move whole: the question, the hour, and
 * this exact door?
 *
 * All three in the SAME message, deliberately. Split across messages, an old turn that happened
 * to mention the address would pair with a fresh time-only summary, and a bare "yes" would then
 * move the job to a door the customer never saw beside that hour. That is the wrong-door failure
 * this whole area exists to prevent, so the evidence has to be one sentence they actually read.
 */
function summaryCarriedMove(
  history: ToolContext['conversationHistory'],
  startTime: string,
  address: string,
): boolean {
  const clock = startTime.match(/T(\d{2}):(\d{2})/);
  const needle = address.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!clock || !needle || !Array.isArray(history)) return false;
  const hhmm = `${clock[1]}:${clock[2]}`;
  let lastUser = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'user') continue;
    if (contentToText(m.content).trim().startsWith('(Internal note')) continue;
    lastUser = i;
    break;
  }
  if (lastUser < 0) return false;
  for (let i = 0; i < lastUser; i++) {
    const m = history[i];
    if (m.role !== 'assistant') continue;
    const text = contentToText(m.content);
    if (!text.includes('?') || !SUMMARY_ASK.test(text)) continue;
    if (!text.toLowerCase().replace(/\s+/g, ' ').includes(needle)) continue;
    if (parseClockTimes(text).some((t) => t.key === hhmm)) return true;
  }
  return false;
}

/**
 * The gate's answer, and the address the move must use once it proceeds.
 *
 * The address travels WITH the verdict because the confirming call is often the one that drops
 * it: the gate is what knows the customer already agreed to that door, so it is the only place
 * that can say which address the write owes them. A verdict alone would open the fence and then
 * move the job to the address it had before.
 */
export type RescheduleConfirmation = {
  /** Non-null means the move must not proceed yet. */
  refusal: ToolResult | null;
  /** The caller's address, or the pending one they confirmed. Undefined leaves the row alone. */
  customerAddress?: string;
};

/**
 * Is this call the same move the customer already agreed to?
 *
 * THE ADDRESS IS THE ONE ARGUMENT THE MODEL DROPS AND RE-ADDS BETWEEN CALLS, and every miss
 * rewrites the pending record, so the next yes is measured against the shape just stored and the
 * customer can agree forever (WaterFix, 2026-09-01: three yes answers, three refusals, and the
 * appointment never moved). Unstated therefore repeats the pending address - but only on
 * evidence, because the address is the customer's, and one they never read is a door they never
 * agreed to. A DIFFERENT address, time or booking is a different move and still refuses.
 */
function rescheduleWasConfirmed(
  pending: PendingBookingDetails | null,
  asked: { bookingId: string; newStartTime: string; customerAddress?: string },
  ctx: ToolContext,
  last: string,
): boolean {
  if (!pending || pending.kind !== 'reschedule') return false;
  if (pending.bookingId !== asked.bookingId || pending.startTime !== asked.newStartTime) return false;
  if (asked.customerAddress !== undefined && pending.customerAddress !== asked.customerAddress) return false;
  return moveWasAgreed(ctx.conversationHistory, pending, last);
}

/**
 * The customer's yes matched THIS pending move. A move that carries a door needs the door in
 * the summary, whether or not the confirming call repeats it: tool arguments are the model's
 * output, not the customer's word. A slot chip is not that evidence - it names an hour.
 * Shared by the tool gate and the run-loop nudge so both judge a yes by the same summary.
 */
function moveWasAgreed(
  history: ToolContext['conversationHistory'],
  pending: PendingBookingDetails,
  last: string,
): boolean {
  if (pending.customerAddress) {
    return isAffirmativeReply(last) && summaryCarriedMove(history, pending.startTime, pending.customerAddress);
  }
  return (
    isConfirmingChip(last, pending.startTime) ||
    (isAffirmativeReply(last) && summaryWasAsked(history, pending.startTime))
  );
}

export async function refuseUnlessRescheduleConfirmed(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<RescheduleConfirmation> {
  const last = lastCustomerUtterance(ctx);
  if (!last) return { refusal: null };

  const lookup = await readPending(ctx.sessionId, RESCHEDULE_PREFIX);
  if (lookup.store === 'down') return { refusal: null };

  const newStartTime = await wallClockKey(ctx.sessionId, String(args.newStartTime ?? ''));
  const bookingId = String(args.bookingId ?? '');
  const customerAddress =
    typeof args.customerAddress === 'string' && args.customerAddress.trim()
      ? args.customerAddress.trim()
      : undefined;
  const pending = lookup.pending;
  const confirmed = rescheduleWasConfirmed(pending, { bookingId, newStartTime, customerAddress }, ctx, last);

  if (confirmed) {
    await clearPending(ctx.sessionId, RESCHEDULE_PREFIX);
    return { refusal: null, customerAddress: customerAddress ?? pending?.customerAddress };
  }

  const stored = await writePending(
    ctx.sessionId,
    {
      startTime: newStartTime,
      attendeeName: '',
      serviceId: '',
      runId: ctx.runId,
      bookingId,
      kind: 'reschedule',
      customerAddress,
    },
    RESCHEDULE_PREFIX,
  );
  if (!stored) return { refusal: null };

  const addressBit = customerAddress ? ' and the new address' : '';
  return {
    refusal: {
      success: false,
      error:
        `${CONFIRMATION_REQUIRED}: Do not tell the customer the appointment was moved. Send a short summary ` +
        `of the existing appointment, the new time${addressBit}, then wait for an explicit yes. Call reschedule_booking ` +
        `again only after they confirm this same move. Do not pick a different time than the one they named.`,
      errorSafeForModel: true,
      data: { needsConfirmation: true, bookingId, newStartTime, customerAddress },
    },
  };
}

/**
 * A NEW BOOKING WHILE A MOVE IS OPEN IS ALMOST ALWAYS THE MOVE.
 *
 * Live on WaterFix (2026-09-01) a customer asked to move an at-home appointment, the first time
 * they named was not offered, and the bot showed the next day's list instead. They tapped a slot,
 * said yes, and the model called `create_booking`. The tenant then held TWO confirmed
 * appointments for the same person: the original still standing on its slot, and a second one the
 * customer never asked for. Nothing downstream can catch that - both writes are individually
 * valid, and a duplicate is only wrong because of an intention recorded a few turns earlier.
 *
 * The pending move IS that record, so this refuses the create once and names the booking the
 * customer was moving. Refusing forever would trap the customer who genuinely wants a second
 * appointment, so the record is cleared as it refuses: a model that calls again gets through, one
 * turn later, having been told what it was about to do.
 */
export async function refuseCreateWhileMovePending(ctx: ToolContext): Promise<ToolResult | null> {
  const lookup = await readPending(ctx.sessionId, RESCHEDULE_PREFIX);
  if (lookup.store === 'down') return null;
  const pending = lookup.pending;
  if (!pending?.bookingId) return null;
  await clearPending(ctx.sessionId, RESCHEDULE_PREFIX);
  return {
    success: false,
    error:
      `${MOVE_PENDING}: You were moving this customer's existing appointment (bookingId "${pending.bookingId}"). ` +
      `Creating a booking now leaves that one standing and gives them two. If they picked a new time for THAT ` +
      `appointment, call reschedule_booking with bookingId "${pending.bookingId}" and the time they chose. Only if ` +
      `they want a SECOND appointment as well as the one they already have, call create_booking again.`,
    errorSafeForModel: true,
    data: { movePending: true, bookingId: pending.bookingId, movingFrom: pending.startTime },
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

