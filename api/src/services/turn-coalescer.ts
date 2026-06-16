/**
 * Message Turn Coalescer
 *
 * Debounces a burst of user messages typed in quick succession into ONE agent
 * turn — killing the double-reply / double-LLM-cost problem (e.g. a customer
 * sends their email on one line, then their phone on the next). See the approved
 * design at .scratch/plan-message-coalescer.md.
 *
 * Shape: one delayed Bull job per inbound message + a recomputed `dueAt`. Each
 * message advances `dueAt`, so the LAST message's job is the one that fires at
 * the right time; earlier jobs fire early, see `now < dueAt`, and return. The
 * run-lock (owner-token + heartbeat) is the single liveness authority and is held
 * only during the actual agent run, never during the wait. Correctness is carried
 * by a DURABLE tuple watermark on chat_sessions (not Redis), so a message can
 * never be lost or double-answered.
 *
 * Fail-open: if the coalescer is disabled, Redis is down, or anything throws
 * after the message is persisted, we fall back to the legacy inline forward so a
 * persisted message always gets answered.
 */

import { randomUUID } from 'crypto';
import type { Job } from 'bull';
import { logger } from '../utils/logger';
import { getRedisClient } from '../config/redis';
import { getQueue } from '../queue/message-queue';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Message } from '../database/entities/Message';
import { decrypt } from '../utils/encryption';
import { computeDueAt, isContactFragment } from './turn-timing';
import {
  forwardMessageToN8n,
  runTurn,
  isForwardingReady,
  getNewestUnansweredUserMessage,
  getUnansweredBounds,
} from './message-forwarding.service';

export const TURN_COALESCE_QUEUE = 'turn-coalesce';
export { computeDueAt } from './turn-timing';

// Behind a flag so the first deploy is a no-op (legacy inline path). Flip on
// after live validation.
const ENABLED = process.env.TURN_COALESCER_ENABLED === 'true';

const STATE_TTL_MS = 120_000;
const LOCK_TTL_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const REARM_MS = 500;

const sessionRepository = AppDataSource.getRepository(ChatSession);

const stateKey = (sessionId: string): string => `turn:state:${sessionId}`;
const lockKey = (sessionId: string): string => `agent:lock:${sessionId}`;

/** Capture-mode signal for a stored (possibly encrypted) inbound message. */
function looksLikeContactFragment(message: Message): boolean {
  const text = message.contentEncrypted ? decrypt(message.content) : message.content || '';
  return isContactFragment(text);
}

// ── Redis Lua: atomic state update + owner-token lock + identity clear ──────

// Atomically: set first-tuple (NX), set last-tuple, INCR count, refresh TTL.
// Returns [count, firstPendingAt]. Timestamps are DB created_at ms (one clock).
const STATE_UPDATE_LUA = `
local key = KEYS[1]
local createdAt = ARGV[1]
local msgId = ARGV[2]
local ttl = tonumber(ARGV[3])
local first = redis.call('HGET', key, 'firstPendingAt')
if not first then
  redis.call('HSET', key, 'firstPendingAt', createdAt, 'firstPendingId', msgId)
  first = createdAt
end
local count = redis.call('HINCRBY', key, 'count', 1)
redis.call('HSET', key, 'lastPendingAt', createdAt, 'lastPendingId', msgId)
redis.call('PEXPIRE', key, ttl)
return {count, first}
`;

// Extend the lock TTL only if we still own it (owner-token compare).
const REFRESH_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

// Release the lock only if we still own it.
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

// Clear turn:state only if its last-pending tuple is <= hwm (identity compare on
// the durable message tuple, not a wall-clock compare).
const CLEAR_IF_CONSUMED_LUA = `
local lastAt = redis.call('HGET', KEYS[1], 'lastPendingAt')
local lastId = redis.call('HGET', KEYS[1], 'lastPendingId')
if not lastAt then return 0 end
local curAt = tonumber(lastAt)
local hwmAt = tonumber(ARGV[1])
if curAt < hwmAt or (curAt == hwmAt and lastId <= ARGV[2]) then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

// ── Scheduling (inbound) ───────────────────────────────────────────────────

/**
 * Schedule (or re-arm) a coalesced turn for a freshly-persisted inbound user
 * message. Replaces the direct forwardMessageToN8n() call at the inbound sites.
 */
export async function scheduleTurn(session: ChatSession, message: Message): Promise<void> {
  const redis = getRedisClient();
  // Disabled or no Redis → legacy inline behaviour (today's path).
  if (!ENABLED || !redis) {
    await forwardMessageToN8n(session, message);
    return;
  }
  // Only text/image user turns are coalesced; anything else uses the legacy path.
  if (message.type !== 'text' && message.type !== 'image') {
    await forwardMessageToN8n(session, message);
    return;
  }

  try {
    const createdAtMs = message.createdAt.getTime();
    const captureMode = looksLikeContactFragment(message);

    const res = (await redis.eval(
      STATE_UPDATE_LUA,
      1,
      stateKey(session.id),
      String(createdAtMs),
      message.id,
      String(STATE_TTL_MS),
    )) as [number, string];
    const count = Number(res[0]);
    const firstPendingAt = Number(res[1]);

    const dueAt = computeDueAt({ firstPendingAt, lastPendingAt: createdAtMs, count, captureMode });
    await redis.hset(stateKey(session.id), 'dueAt', String(dueAt));

    const queue = getQueue(TURN_COALESCE_QUEUE);
    if (!queue) throw new Error('turn-coalesce queue unavailable');
    await queue.add(
      { sessionId: session.id, tenantId: session.tenantId },
      {
        jobId: `${session.id}:${message.id}`,
        delay: Math.max(0, dueAt - Date.now()),
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  } catch (err) {
    // Fail-open on ANY scheduling failure — never leave a persisted message
    // without a runnable turn.
    logger.warn('[coalescer] scheduleTurn failed — falling back to inline forward', {
      sessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
    await forwardMessageToN8n(session, message);
  }
}

/** Re-arm a delayed coalesce job (used for early-job / lock-miss / error paths). */
async function rearm(sessionId: string, tenantId: string, delay: number): Promise<void> {
  const queue = getQueue(TURN_COALESCE_QUEUE);
  if (!queue) return;
  await queue.add(
    { sessionId, tenantId },
    {
      jobId: `${sessionId}:rearm:${randomUUID()}`,
      delay: Math.max(0, delay),
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}

// ── Processor (due side) ───────────────────────────────────────────────────

export async function coalesceProcessor(job: Job): Promise<void> {
  const { sessionId, tenantId } = job.data as { sessionId: string; tenantId: string };
  const redis = getRedisClient();
  if (!redis) return; // scheduled via Redis; if it's gone there's nothing to do.

  // Deps-ready guard — a job from a previous process can fire before the agent /
  // forwarding services are wired during boot.
  if (!isForwardingReady()) {
    await rearm(sessionId, tenantId, REARM_MS);
    return;
  }

  // Acquire the run-lock (owner token). Lock-miss ⇒ a run is in flight ⇒ re-arm.
  const token = randomUUID();
  const acquired = await redis.set(lockKey(sessionId), token, 'PX', LOCK_TTL_MS, 'NX');
  if (acquired !== 'OK') {
    await rearm(sessionId, tenantId, REARM_MS);
    return;
  }

  // Heartbeat: keep the lock alive for the whole (possibly slow) agent run, so a
  // legitimately slow run is never falsely reclaimed.
  const heartbeat = setInterval(() => {
    redis.eval(REFRESH_LUA, 1, lockKey(sessionId), token, String(LOCK_TTL_MS)).catch(() => {});
  }, HEARTBEAT_MS);

  try {
    const session = await sessionRepository.findOne({ where: { id: sessionId } });
    if (!session) return;

    const pending = await getNewestUnansweredUserMessage(session);
    if (!pending) return; // everything answered.

    // Re-derive dueAt UNDER the lock — closes the read-then-run gap. Prefer the
    // stored dueAt; if turn:state was lost (TTL/restart) recompute from the DB.
    const dueAt = await resolveDueAt(redis, session, pending);
    if (Date.now() < dueAt) {
      await rearm(sessionId, tenantId, dueAt - Date.now());
      return;
    }

    const status = await runTurn(session, pending);

    if (status === 'answered') {
      // Clear state only if no message newer than hwm is recorded.
      await redis
        .eval(CLEAR_IF_CONSUMED_LUA, 1, stateKey(sessionId), String(pending.createdAt.getTime()), pending.id)
        .catch(() => {});
    } else if (status === 'stale') {
      // A newer message arrived (or watermark race) — let it form the next turn.
      await rearm(sessionId, tenantId, REARM_MS);
    }
    // 'noop' (paused bot / AI off / no tenant): nothing to clear or re-arm.
  } catch (err) {
    logger.error('[coalescer] processor error — re-arming', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    await rearm(sessionId, tenantId, REARM_MS);
  } finally {
    clearInterval(heartbeat);
    await redis.eval(RELEASE_LUA, 1, lockKey(sessionId), token).catch(() => {});
  }
}

/** Stored dueAt from Redis, or a DB recompute when turn:state was lost. */
async function resolveDueAt(
  redis: NonNullable<ReturnType<typeof getRedisClient>>,
  session: ChatSession,
  pending: Message,
): Promise<number> {
  const stored = await redis.hget(stateKey(session.id), 'dueAt');
  if (stored != null) return Number(stored);

  const bounds = await getUnansweredBounds(session);
  if (!bounds) return 0; // nothing pending → run now (caller already has pending).
  return computeDueAt({
    firstPendingAt: bounds.firstAt.getTime(),
    lastPendingAt: bounds.lastAt.getTime(),
    count: bounds.count,
    captureMode: looksLikeContactFragment(pending),
  });
}
