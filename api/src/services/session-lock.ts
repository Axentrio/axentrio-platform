/**
 * Owner-token session locks shared with the turn-coalescer
 * (`agent:lock:{sessionId}`). Refresh/release MUST be owner-token-scoped: an
 * unconditional PEXPIRE/DEL could extend or delete a lock the coalescer owns
 * (and vice-versa) → concurrent runs / double reply.
 *
 * The `await import('../config/redis')` inside each call is DELIBERATE, not an
 * oversight: it keeps Redis off this module's load path so a Redis outage or
 * config gap can never break importing this file, and every failure below
 * fails open by design.
 */
import { randomUUID } from 'crypto';

export const NO_REDIS_LOCK = 'no-redis';
const LOCK_REFRESH_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`;
const LOCK_RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export async function acquireSessionLock(sessionId: string, ttlMs: number = 60000): Promise<string | null> {
  try {
    const { getRedisClient } = await import('../config/redis');
    const redis = getRedisClient();
    if (!redis) return NO_REDIS_LOCK; // no Redis = no lock (fail open)
    const token = randomUUID();
    const result = await redis.set(`agent:lock:${sessionId}`, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? token : null;
  } catch {
    return NO_REDIS_LOCK; // fail open
  }
}

// Extend the lock while a multi-turn drain is in progress, so a slow burst
// doesn't let the TTL lapse and admit a concurrent run. Owner-token-scoped.
export async function refreshSessionLock(sessionId: string, token: string, ttlMs: number = 60000): Promise<void> {
  if (token === NO_REDIS_LOCK) return;
  try {
    const { getRedisClient } = await import('../config/redis');
    const redis = getRedisClient();
    if (redis) await redis.eval(LOCK_REFRESH_LUA, 1, `agent:lock:${sessionId}`, token, String(ttlMs));
  } catch {
    // ignore
  }
}

export async function releaseSessionLock(sessionId: string, token: string): Promise<void> {
  if (token === NO_REDIS_LOCK) return;
  try {
    const { getRedisClient } = await import('../config/redis');
    const redis = getRedisClient();
    if (redis) await redis.eval(LOCK_RELEASE_LUA, 1, `agent:lock:${sessionId}`, token);
  } catch {
    // ignore
  }
}
