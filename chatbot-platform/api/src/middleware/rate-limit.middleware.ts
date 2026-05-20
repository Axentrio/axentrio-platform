/**
 * Rate Limiting Middleware
 * Implements rate limiting per tenant and per IP
 */
import { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis, RateLimiterMemory, RateLimiterRes, RateLimiterAbstract } from 'rate-limiter-flexible';
import { getRedisClient, isRedisAvailable } from '../config/redis';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import type { AuthenticatedRequest as _AuthenticatedRequest } from './auth.middleware';
import { TenantRequest } from './tenant.middleware';
import { ApiError, RateLimitError } from './error-handler';
import { ERROR_CODES } from './error-codes';

// Rate limiter configurations
const RATE_LIMIT_WINDOW_MS = config.rateLimit.windowMs;
const RATE_LIMIT_MAX_REQUESTS = config.rateLimit.maxRequests;

/**
 * Paths that must keep the LEGACY 429 body shape
 *   `{ error: 'Too Many Requests', retryAfter, message: '...' }`
 * even after the response-envelope migration (plan §10, decision (a)).
 *
 * These middlewares front everything inside `apiRouter`, including OOS
 * integration endpoints (n8n inbound, channel webhooks, RAG, booking). The
 * carve-out changes ONLY the response body wire shape — rate limiting still
 * enforces, `Retry-After` is still set. Match on `req.originalUrl` (NOT
 * `req.path`) because these limiters run inside `apiRouter` (codex round 5 #3).
 *
 * See `timeout.middleware.ts` for the same list and per-path rationale.
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

// In-memory fallback counter for when Redis rate limiter encounters errors.
// This prevents completely failing open when the primary limiter breaks.
// Capped at 50k entries to prevent OOM during sustained Redis outages.
const fallbackCounters = new Map<string, { count: number; resetAt: number }>();
const FALLBACK_MAX_ENTRIES = 50_000;
const FALLBACK_CLEANUP_INTERVAL = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of fallbackCounters) {
    if (entry.resetAt <= now) fallbackCounters.delete(key);
  }
}, FALLBACK_CLEANUP_INTERVAL);

function fallbackConsume(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  let entry = fallbackCounters.get(key);
  if (!entry || entry.resetAt <= now) {
    // Reject new keys when map is at capacity to prevent OOM
    if (!entry && fallbackCounters.size >= FALLBACK_MAX_ENTRIES) {
      return false;
    }
    entry = { count: 0, resetAt: now + windowMs };
    fallbackCounters.set(key, entry);
  }
  entry.count++;
  return entry.count <= maxRequests;
}

// Lazy-initialised limiters (created on first use after Redis is ready)
let ipLimiter: RateLimiterAbstract | null = null;
let tenantLimiter: RateLimiterAbstract | null = null;
let widgetLimiter: RateLimiterAbstract | null = null;
let socketLimiter: RateLimiterAbstract | null = null;

/**
 * Create rate limiter instance — Redis if available, in-memory fallback
 */
function createRateLimiter(
  keyPrefix: string,
  points: number,
  duration: number
): RateLimiterAbstract {
  const client = getRedisClient();
  if (client && isRedisAvailable()) {
    return new RateLimiterRedis({
      storeClient: client,
      keyPrefix,
      points,
      duration: Math.floor(duration / 1000),
      blockDuration: 60,
      inMemoryBlockOnConsumed: points + 1,
      inMemoryBlockDuration: 60,
    });
  }
  // Fallback to in-memory when Redis is not available
  return new RateLimiterMemory({
    keyPrefix,
    points,
    duration: Math.floor(duration / 1000),
  });
}

function ensureLimiters(): void {
  if (!ipLimiter) {
    ipLimiter = createRateLimiter('rl:ip', RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS);
    tenantLimiter = createRateLimiter('rl:tenant', RATE_LIMIT_MAX_REQUESTS * 2, RATE_LIMIT_WINDOW_MS);
    widgetLimiter = createRateLimiter('rl:widget', 50, RATE_LIMIT_WINDOW_MS);
    socketLimiter = createRateLimiter('rl:socket', 100, RATE_LIMIT_WINDOW_MS);
  }
}

/**
 * Get client IP address
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Emit the legacy 429 body shape for OOS integration endpoints. Preserves the
 * `retryAfter` + `message` keys that downstream provider parsers (n8n,
 * channel-webhook tooling) may key off. `Retry-After` header is still set by
 * the caller when an estimate is available.
 */
function emitLegacy429(
  res: Response,
  message: string,
  retryAfter?: number,
): void {
  if (typeof retryAfter === 'number') {
    res.status(429).json({
      error: 'Too Many Requests',
      retryAfter,
      message,
    });
    return;
  }
  res.status(429).json({
    error: 'Too Many Requests',
    message,
  });
}

/**
 * HTTP Middleware: Rate limit by IP address
 */
export function rateLimitByIp(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  ensureLimiters();
  const clientIp = getClientIp(req);

  ipLimiter!
    .consume(clientIp, 1)
    .then(() => {
      next();
    })
    .catch((rateLimiterRes: RateLimiterRes | Error) => {
      if (rateLimiterRes instanceof Error) {
        logger.error('Rate limiter error, using in-memory fallback:', rateLimiterRes);
        if (fallbackConsume(`ip:${clientIp}`, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS)) {
          return next();
        }
        if (shouldUseLegacyEnvelope(req)) {
          emitLegacy429(res, 'Rate limit exceeded (fallback). Please try again later.');
          return;
        }
        return next(
          new ApiError(
            'Rate limit exceeded (fallback). Please try again later.',
            429,
            ERROR_CODES.RATE_LIMIT_FALLBACK,
          ),
        );
      }

      const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000);
      res.setHeader('Retry-After', retryAfter.toString());
      if (shouldUseLegacyEnvelope(req)) {
        emitLegacy429(res, 'Rate limit exceeded. Please try again later.', retryAfter);
        return;
      }
      return next(
        new RateLimitError('Rate limit exceeded. Please try again later.', { retryAfter }),
      );
    });
}

/**
 * HTTP Middleware: Rate limit by tenant
 */
export function rateLimitByTenant(
  req: TenantRequest,
  res: Response,
  next: NextFunction
): void {
  const tenantId = req.tenant?.id;

  if (!tenantId) {
    // No tenant, skip tenant rate limiting
    return next();
  }

  ensureLimiters();
  tenantLimiter!
    .consume(tenantId, 1)
    .then(() => {
      next();
    })
    .catch((rateLimiterRes: RateLimiterRes | Error) => {
      if (rateLimiterRes instanceof Error) {
        logger.error('Tenant rate limiter error, using in-memory fallback:', rateLimiterRes);
        if (fallbackConsume(`tenant:${tenantId}`, RATE_LIMIT_MAX_REQUESTS * 2, RATE_LIMIT_WINDOW_MS)) {
          return next();
        }
        if (shouldUseLegacyEnvelope(req)) {
          emitLegacy429(res, 'Tenant rate limit exceeded (fallback). Please try again later.');
          return;
        }
        return next(
          new ApiError(
            'Rate limit exceeded (fallback). Please try again later.',
            429,
            ERROR_CODES.RATE_LIMIT_FALLBACK,
          ),
        );
      }

      const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000);
      res.setHeader('Retry-After', retryAfter.toString());
      if (shouldUseLegacyEnvelope(req)) {
        emitLegacy429(res, 'Tenant rate limit exceeded. Please try again later.', retryAfter);
        return;
      }
      return next(
        new RateLimitError('Rate limit exceeded. Please try again later.', { retryAfter }),
      );
    });
}

/**
 * HTTP Middleware: Rate limit widget endpoints
 */
export function rateLimitWidget(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const clientIp = getClientIp(req);
  const sessionId = req.headers['x-session-id'] as string;
  const key = sessionId ? `widget:${sessionId}` : `widget:ip:${clientIp}`;

  ensureLimiters();
  widgetLimiter!
    .consume(key, 1)
    .then(() => {
      next();
    })
    .catch((rateLimiterRes: RateLimiterRes | Error) => {
      if (rateLimiterRes instanceof Error) {
        logger.error('Widget rate limiter error, using in-memory fallback:', rateLimiterRes);
        if (fallbackConsume(`widget:${key}`, 50, RATE_LIMIT_WINDOW_MS)) {
          return next();
        }
        if (shouldUseLegacyEnvelope(req)) {
          emitLegacy429(res, 'Widget rate limit exceeded (fallback). Please try again later.');
          return;
        }
        return next(
          new ApiError(
            'Rate limit exceeded (fallback). Please try again later.',
            429,
            ERROR_CODES.RATE_LIMIT_FALLBACK,
          ),
        );
      }

      const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000);
      res.setHeader('Retry-After', retryAfter.toString());
      if (shouldUseLegacyEnvelope(req)) {
        emitLegacy429(res, 'Widget rate limit exceeded. Please try again later.', retryAfter);
        return;
      }
      return next(
        new RateLimitError('Rate limit exceeded. Please try again later.', { retryAfter }),
      );
    });
}

/**
 * Combined rate limiting middleware
 * Applies both IP and tenant rate limiting
 */
export function rateLimit(
  options: { skipTenant?: boolean; skipIp?: boolean } = {}
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    ensureLimiters();
    const clientIp = getClientIp(req);
    const tenantReq = req as TenantRequest;
    const tenantId = tenantReq.tenant?.id;

    const promises: Promise<RateLimiterRes>[] = [];

    // IP rate limiting
    if (!options.skipIp) {
      promises.push(ipLimiter!.consume(clientIp, 1));
    }

    // Tenant rate limiting
    if (!options.skipTenant && tenantId) {
      promises.push(tenantLimiter!.consume(tenantId, 1));
    }

    Promise.all(promises)
      .then(() => {
        next();
      })
      .catch((error: RateLimiterRes | Error) => {
        if (error instanceof Error) {
          logger.error('Combined rate limiter error, using in-memory fallback:', error);
          const fallbackKey = `combined:${clientIp}:${tenantId || 'none'}`;
          if (fallbackConsume(fallbackKey, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS)) {
            return next();
          }
          if (shouldUseLegacyEnvelope(req)) {
            emitLegacy429(res, 'Rate limit exceeded (fallback). Please try again later.');
            return;
          }
          return next(
            new ApiError(
              'Rate limit exceeded (fallback). Please try again later.',
              429,
              ERROR_CODES.RATE_LIMIT_FALLBACK,
            ),
          );
        }

        const retryAfter = Math.ceil(error.msBeforeNext / 1000);
        res.setHeader('Retry-After', retryAfter.toString());
        if (shouldUseLegacyEnvelope(req)) {
          emitLegacy429(res, 'Rate limit exceeded. Please try again later.', retryAfter);
          return;
        }
        return next(
          new RateLimitError('Rate limit exceeded. Please try again later.', { retryAfter }),
        );
      });
  };
}

/**
 * Check socket event rate limit
 */
export async function checkSocketRateLimit(
  socketId: string,
  tenantId?: string
): Promise<boolean> {
  const key = tenantId ? `socket:${tenantId}:${socketId}` : `socket:${socketId}`;
  try {
    ensureLimiters();
    await socketLimiter!.consume(key, 1);
    return true;
  } catch (error) {
    if (error instanceof Error) {
      logger.error('Socket rate limiter error, using in-memory fallback:', error);
      return fallbackConsume(`socket:${key}`, 100, RATE_LIMIT_WINDOW_MS);
    }
    return false;
  }
}

/**
 * Get rate limit status for a key
 */
export async function getRateLimitStatus(
  key: string,
  type: 'ip' | 'tenant' | 'widget' | 'socket' = 'ip'
): Promise<{ remaining: number; resetTime: Date } | null> {
  try {
    ensureLimiters();
    let limiter: RateLimiterAbstract;
    switch (type) {
      case 'tenant':
        limiter = tenantLimiter!;
        break;
      case 'widget':
        limiter = widgetLimiter!;
        break;
      case 'socket':
        limiter = socketLimiter!;
        break;
      default:
        limiter = ipLimiter!;
    }

    const res = await limiter.get(key);
    if (!res) {
      return {
        remaining: limiter.points,
        resetTime: new Date(Date.now() + limiter.duration * 1000),
      };
    }

    return {
      remaining: Math.max(0, res.remainingPoints),
      resetTime: new Date(Date.now() + res.msBeforeNext),
    };
  } catch (error) {
    logger.error('Error getting rate limit status:', error);
    return null;
  }
}
