/**
 * A confirmed booking may not be written until the Booking Customer has agreed
 * to a summary of the exact details. The first create_booking call records those
 * details; a later turn may write only after an explicit yes (or a slot chip for
 * that same hour). A later "change it to 11:00" or "what is the address?" is not
 * that yes, and different details replace the pending record instead of writing.
 *
 * Lives in Redis, same as offered slots: conversation-scoped, dies with TTL, no
 * migration on chat_sessions. Without Redis the gate fails open, matching the
 * offered-slot store — unit tests that never mock Redis keep their old path.
 */
import type { ToolContext, ToolResult } from './tool-adapter';
import { contentToText } from '../llm/llm.types';
import { namesSingleOfferedTime } from './clock-times';
import { getRedisClient } from '../config/redis';
import { wallClockKey } from './offered-slots-store';
import { logger } from '../utils/logger';

export const CONFIRMATION_REQUIRED = 'CONFIRMATION_REQUIRED';

const KEY_PREFIX = 'booking:confirm:';
const TTL_MS = 24 * 60 * 60 * 1000;
const CHIP_MAX_CHARS = 80;

export interface PendingBookingDetails {
  startTime: string;
  attendeeName: string;
  serviceId: string;
  runId: string;
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
  if (!trimmed || trimmed.length > CHIP_MAX_CHARS) return false;
  const clock = startTime.match(/T(\d{2}):(\d{2})/);
  if (!clock) return false;
  return namesSingleOfferedTime(trimmed, [`${clock[1]}:${clock[2]}`]);
}

export function lastCustomerUtterance(ctx: ToolContext): string {
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
    };
  } catch {
    return null;
  }
}

async function readPending(
  sessionId: string,
): Promise<{ store: 'up'; pending: PendingBookingDetails | null } | { store: 'down' }> {
  const redis = getRedisClient();
  if (!redis) return { store: 'down' };
  try {
    return { store: 'up', pending: parsePending(await redis.get(`${KEY_PREFIX}${sessionId}`)) };
  } catch (err) {
    logger.warn('[booking] pending confirmation read failed; failing open', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { store: 'down' };
  }
}

async function writePending(sessionId: string, pending: PendingBookingDetails): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return false;
  try {
    await redis.set(`${KEY_PREFIX}${sessionId}`, JSON.stringify(pending), 'PX', String(TTL_MS));
    return true;
  } catch (err) {
    logger.warn('[booking] pending confirmation write failed; failing open', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function clearPending(sessionId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.del(`${KEY_PREFIX}${sessionId}`);
  } catch {
    // Non-fatal: a stale pending only re-asks.
  }
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
    ctx.runId !== pending.runId &&
    (isAffirmativeReply(last) || isConfirmingChip(last, pending.startTime));

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
