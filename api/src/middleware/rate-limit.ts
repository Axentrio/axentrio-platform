/**
 * Rate Limiting Middleware
 * Redis-based rate limiting per tenant and IP
 */

import { Request, Response, NextFunction } from 'express';
import { getRedisClient } from '../config/redis';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { RateLimitError } from './error-handler';

// Helper functions
const redisKeys = {
  rateLimit: (key: string) => `rl:${key}`,
};

/**
 * OOS body-shape carve-out (plan §10). See `rate-limit.middleware.ts` and
 * `timeout.middleware.ts` for the same list and rationale. The limiters in
 * THIS file are exported as named instances (`apiRateLimiter`,
 * `widgetRateLimiter`, etc.) and applied per-route via `app.use(...)` /
 * `router.use(...)`. They can also front OOS routes when wired that way, so
 * we apply the same carve-out to keep behavior uniform across both rate-limit
 * modules.
 *
 * Match on `req.originalUrl` — see codex round 5 #3 for the mount-relativity
 * reasoning.
 */
const LEGACY_ENVELOPE_PATHS = [
  /^\/api\/v1\/webhooks\/inbound(\?|$|\/)/,
  /^\/api\/v1\/webhooks\/health(\?|$|\/)/,
  /^\/api\/v1\/webhooks\/events(\?|$|\/)/,
  /^\/api\/v1\/internal\/rag(\?|$|\/)/,
  /^\/api\/v1\/internal\/booking(\?|$|\/)/,
  /^\/api\/v1\/channels\/[^/?]+\/webhook(\?|$|\/)/,
] as const;

function shouldUseLegacyEnvelope(req: Request): boolean {
  const url = req.originalUrl;
  return LEGACY_ENVELOPE_PATHS.some((re) => re.test(url));
}

// Rate limit configuration interface
interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyPrefix?: string;
  skipSuccessfulRequests?: boolean;
}

/**
 * Create rate limit key
 */
const createRateLimitKey = (req: Request, prefix: string): string => {
  const identifier = req.user?.id || req.widget?.visitorId || req.ip || 'unknown';
  const tenantId = req.tenant?.id || req.user?.tenantId || req.widget?.tenantId || 'global';
  return redisKeys.rateLimit(`${prefix}:${tenantId}:${identifier}`);
};

/**
 * Redis-based rate limiter
 */
const createRedisRateLimiter = (config: RateLimitConfig) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const redis = getRedisClient();
      if (!redis) {
        // No Redis — fail open
        return next();
      }
      const key = createRateLimitKey(req, config.keyPrefix || 'api');
      const windowSeconds = Math.floor(config.windowMs / 1000);

      // Get current count
      const current = await redis.get(key);
      const count = current ? parseInt(current, 10) : 0;

      if (count >= config.maxRequests) {
        // Rate limit exceeded
        const ttl = await redis.ttl(key);
        res.setHeader('Retry-After', ttl.toString());
        res.setHeader('X-RateLimit-Limit', config.maxRequests.toString());
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('X-RateLimit-Reset', (Date.now() + ttl * 1000).toString());

        logger.warn('Rate limit exceeded', {
          requestId: req.requestId,
          key: key.split(':').pop(),
          count,
        });

        if (shouldUseLegacyEnvelope(req)) {
          // OOS carve-out: preserve legacy 429 body for provider-integration
          // endpoints. `Retry-After` header is already set above (L54-equivalent).
          res.status(429).json({ // envelope-allow: OOS legacy 429 (plan §10)
            error: 'Too Many Requests',
            retryAfter: ttl,
            message: 'Rate limit exceeded. Please try again later.',
          });
          return;
        }
        return next(
          new RateLimitError('Rate limit exceeded. Please try again later.', {
            retryAfter: ttl,
          }),
        );
      }

      // Increment counter
      const pipeline = redis.pipeline();
      pipeline.incr(key);
      pipeline.expire(key, windowSeconds);
      await pipeline.exec();

      // Set headers
      const remaining = config.maxRequests - count - 1;
      res.setHeader('X-RateLimit-Limit', config.maxRequests.toString());
      res.setHeader('X-RateLimit-Remaining', Math.max(0, remaining).toString());

      next();
    } catch (error) {
      logger.error('Rate limiting error', {
        requestId: req.requestId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Fail open - allow request if rate limiter fails
      next();
    }
  };
};

/**
 * Standard API rate limiter
 */
export const apiRateLimiter = createRedisRateLimiter({
  windowMs: config.rateLimit.windowMs,
  maxRequests: config.rateLimit.maxRequests,
  keyPrefix: 'api',
});

/**
 * Strict rate limiter for sensitive endpoints
 */
export const strictRateLimiter = createRedisRateLimiter({
  windowMs: 60000, // 1 minute
  maxRequests: 10,
  keyPrefix: 'strict',
});

/**
 * Login rate limiter
 */
export const loginRateLimiter = createRedisRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 5,
  keyPrefix: 'login',
});

/**
 * Widget rate limiter
 */
export const widgetRateLimiter = createRedisRateLimiter({
  windowMs: 60000, // 1 minute
  maxRequests: 60,
  keyPrefix: 'widget',
});

/**
 * WebSocket connection rate limiter
 */
export const wsConnectionRateLimiter = createRedisRateLimiter({
  windowMs: 60000, // 1 minute
  maxRequests: config.rateLimit.wsMaxConnections,
  keyPrefix: 'ws-conn',
});

/**
 * Message rate limiter per session
 */
export const messageRateLimiter = createRedisRateLimiter({
  windowMs: 10000, // 10 seconds
  maxRequests: 10,
  keyPrefix: 'message',
});

/**
 * File upload rate limiter
 */
export const uploadRateLimiter = createRedisRateLimiter({
  windowMs: 60000, // 1 minute
  maxRequests: 5,
  keyPrefix: 'upload',
});

/**
 * Tenant-specific rate limiter
 */
export const tenantRateLimiter = (customConfig?: Partial<RateLimitConfig>) => {
  return createRedisRateLimiter({
    windowMs: config.rateLimit.windowMs,
    maxRequests: config.rateLimit.maxRequests,
    keyPrefix: 'tenant',
    ...customConfig,
  });
};

/**
 * Burst rate limiter (for handling traffic spikes)
 */
export const burstRateLimiter = createRedisRateLimiter({
  windowMs: 1000, // 1 second
  maxRequests: 10,
  keyPrefix: 'burst',
});

/**
 * Sliding window rate limiter (more accurate)
 */
export const slidingWindowLimiter = (maxRequests: number, windowMs: number) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const redis = getRedisClient();
      if (!redis) {
        return next();
      }
      const key = createRateLimitKey(req, 'sliding');
      const now = Date.now();
      const windowStart = now - windowMs;

      // Remove old entries
      await redis.zremrangebyscore(key, 0, windowStart);

      // Count current entries
      const count = await redis.zcard(key);

      if (count >= maxRequests) {
        const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
        const resetTime = parseInt(oldest[1], 10) + windowMs;
        const retryAfter = Math.ceil((resetTime - now) / 1000);

        res.setHeader('Retry-After', retryAfter.toString());
        res.setHeader('X-RateLimit-Limit', maxRequests.toString());
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('X-RateLimit-Reset', resetTime.toString());

        if (shouldUseLegacyEnvelope(req)) {
          res.status(429).json({ // envelope-allow: OOS legacy 429 (plan §10)
            error: 'Too Many Requests',
            retryAfter,
            message: 'Rate limit exceeded. Please try again later.',
          });
          return;
        }
        return next(
          new RateLimitError('Rate limit exceeded. Please try again later.', {
            retryAfter,
          }),
        );
      }

      // Add current request
      await redis.zadd(key, now, `${now}-${Math.random()}`);
      await redis.pexpire(key, windowMs);

      res.setHeader('X-RateLimit-Limit', maxRequests.toString());
      res.setHeader('X-RateLimit-Remaining', (maxRequests - count - 1).toString());

      next();
    } catch (error) {
      logger.error('Sliding window rate limiter error', {
        requestId: req.requestId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      next();
    }
  };
};

/**
 * Get rate limit status for a key
 */
export const getRateLimitStatus = async (
  key: string,
  windowMs: number,
  maxRequests: number
): Promise<{
  limit: number;
  remaining: number;
  reset: number;
  window: number;
}> => {
  try {
    const redis = getRedisClient();
    if (!redis) {
      return { limit: maxRequests, remaining: maxRequests, reset: Date.now() + windowMs, window: windowMs };
    }
    const fullKey = redisKeys.rateLimit(key);
    const count = await redis.get(fullKey);
    const ttl = await redis.ttl(fullKey);

    const currentCount = count ? parseInt(count, 10) : 0;
    const reset = ttl > 0 ? Date.now() + ttl * 1000 : Date.now() + windowMs;

    return {
      limit: maxRequests,
      remaining: Math.max(0, maxRequests - currentCount),
      reset,
      window: windowMs,
    };
  } catch (error) {
    logger.error('Get rate limit status error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {
      limit: maxRequests,
      remaining: maxRequests,
      reset: Date.now() + windowMs,
      window: windowMs,
    };
  }
};

/**
 * Reset rate limit for a key
 */
export const resetRateLimit = async (key: string): Promise<void> => {
  try {
    const redis = getRedisClient();
    if (!redis) return;
    await redis.del(redisKeys.rateLimit(key));
  } catch (error) {
    logger.error('Reset rate limit error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export default {
  apiRateLimiter,
  strictRateLimiter,
  loginRateLimiter,
  widgetRateLimiter,
  wsConnectionRateLimiter,
  messageRateLimiter,
  uploadRateLimiter,
  tenantRateLimiter,
  burstRateLimiter,
  slidingWindowLimiter,
  getRateLimitStatus,
  resetRateLimit,
};
