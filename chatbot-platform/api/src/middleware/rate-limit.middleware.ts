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

// Rate limiter configurations
const RATE_LIMIT_WINDOW_MS = config.rateLimit.windowMs;
const RATE_LIMIT_MAX_REQUESTS = config.rateLimit.maxRequests;

// In-memory fallback counter for when Redis rate limiter encounters errors.
// This prevents completely failing open when the primary limiter breaks.
const fallbackCounters = new Map<string, { count: number; resetAt: number }>();
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
        res.status(429).json({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded (fallback). Please try again later.',
        });
        return;
      }

      const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000);
      res.setHeader('Retry-After', retryAfter.toString());
      res.status(429).json({
        error: 'Too Many Requests',
        retryAfter,
        message: 'Rate limit exceeded. Please try again later.',
      });
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
        res.status(429).json({
          error: 'Too Many Requests',
          message: 'Tenant rate limit exceeded (fallback). Please try again later.',
        });
        return;
      }

      const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000);
      res.setHeader('Retry-After', retryAfter.toString());
      res.status(429).json({
        error: 'Too Many Requests',
        retryAfter,
        message: 'Tenant rate limit exceeded. Please try again later.',
      });
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
        res.status(429).json({
          error: 'Too Many Requests',
          message: 'Widget rate limit exceeded (fallback). Please try again later.',
        });
        return;
      }

      const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000);
      res.setHeader('Retry-After', retryAfter.toString());
      res.status(429).json({
        error: 'Too Many Requests',
        retryAfter,
        message: 'Widget rate limit exceeded. Please try again later.',
      });
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
          res.status(429).json({
            error: 'Too Many Requests',
            message: 'Rate limit exceeded (fallback). Please try again later.',
          });
          return;
        }

        const retryAfter = Math.ceil(error.msBeforeNext / 1000);
        res.setHeader('Retry-After', retryAfter.toString());
        res.status(429).json({
          error: 'Too Many Requests',
          retryAfter,
          message: 'Rate limit exceeded. Please try again later.',
        });
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
  try {
    ensureLimiters();
    const key = tenantId ? `socket:${tenantId}:${socketId}` : `socket:${socketId}`;
    await socketLimiter!.consume(key, 1);
    return true;
  } catch (error) {
    if (error instanceof Error) {
      logger.error('Socket rate limiter error, using in-memory fallback:', error);
      return fallbackConsume(`socket:${key}`, 100, RATE_LIMIT_WINDOW_MS);
    }
    return false; // Rate limit exceeded
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
