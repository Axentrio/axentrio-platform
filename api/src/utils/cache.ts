/**
 * Redis Cache Utility
 * Simple cache-aside pattern with graceful Redis degradation
 */
import { getRedisClient } from '../config/redis';

/**
 * Cache-aside wrapper: check Redis first, fall back to fn(), store result.
 * Degrades gracefully if Redis is unavailable.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>
): Promise<T> {
  const redis = getRedisClient();

  if (redis) {
    try {
      const hit = await redis.get(key);
      if (hit) return JSON.parse(hit) as T;
    } catch {
      // Redis down — fall through to fn()
    }
  }

  const result = await fn();

  if (redis) {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(result));
    } catch {
      // Redis down — result still returned, just not cached
    }
  }

  return result;
}

/**
 * Delete specific cache keys. Takes exact keys (not patterns)
 * to avoid the O(N) KEYS command.
 */
export async function invalidate(...keys: string[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis || keys.length === 0) return;

  try {
    await redis.del(...keys);
  } catch {
    // Redis down — skip invalidation
  }
}
