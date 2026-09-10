/**
 * Rate Limiting Middleware
 * Implements rate limiting per tenant and per IP
 */
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { RateLimiterRedis, RateLimiterRes, RateLimiterAbstract } from 'rate-limiter-flexible';
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
 * 1000 requests / window per client IP, per webhook route. Sized to stop a
 * flood, not to shape provider traffic: every tenant's webhooks arrive from one
 * shared provider egress pool, and all four providers retry in bursts.
 * Mutable so tests can shrink it; the Redis-backed limiters bind it once in
 * `ensureLimiters`.
 */
export const WEBHOOK_IP_RATE_LIMIT = { maxRequests: 1000 };

/** The raw-body provider webhook routes. Each one owns a separate IP bucket. */
export type WebhookRoute = 'clerk' | 'meta' | 'whatsapp' | 'billing';

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
 * `/api/v1/webhooks/billing` is here because `rateLimitWebhookByIp('billing')`
 * fronts it, and the Stripe body shape is a partner contract (ADR 0011). The
 * Clerk webhook has no documented legacy-body claim, so it gets the envelope.
 *
 * `timeout.middleware.ts` keeps the per-path rationale for the shared entries.
 * Its list has no billing entry on purpose: `timeoutMiddleware` mounts only
 * inside `apiRouter`, and the raw-body webhook routes mount before it.
 */
const LEGACY_ENVELOPE_PATHS = [
  /^\/api\/v1\/webhooks\/inbound(\?|$|\/)/,
  /^\/api\/v1\/webhooks\/health(\?|$|\/)/,
  /^\/api\/v1\/webhooks\/events(\?|$|\/)/,
  /^\/api\/v1\/webhooks\/billing(\?|$|\/)/,
  /^\/api\/v1\/internal\/rag(\?|$|\/)/,
  /^\/api\/v1\/internal\/booking(\?|$|\/)/,
  /^\/api\/v1\/channels\/[^/?]+\/webhook(\?|$|\/)/,
] as const;

function shouldUseLegacyEnvelope(req: Request): boolean {
  const url = req.originalUrl;
  return LEGACY_ENVELOPE_PATHS.some((re) => re.test(url));
}

// In-memory fallback counter, used both when the Redis limiter errors mid-flight
// and as the primary enforcement while Redis is unavailable. Capped at 50k
// entries to prevent OOM during sustained Redis outages.
const fallbackCounters = new Map<string, { count: number; resetAt: number }>();
const FALLBACK_MAX_ENTRIES = 50_000;
const FALLBACK_CLEANUP_INTERVAL = 60_000;
const fallbackCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of fallbackCounters) {
    if (entry.resetAt <= now) fallbackCounters.delete(key);
  }
}, FALLBACK_CLEANUP_INTERVAL);
// Unref'd: this sweep must never keep the process alive on shutdown.
fallbackCleanupTimer.unref();

interface FallbackDecision {
  allowed: boolean;
  /** Seconds until the window resets — the `Retry-After` value on rejection. */
  retryAfter: number;
}

function fallbackConsume(key: string, maxRequests: number, windowMs: number): FallbackDecision {
  const now = Date.now();
  let entry = fallbackCounters.get(key);
  if (!entry || entry.resetAt <= now) {
    // Reject new keys when map is at capacity to prevent OOM
    if (!entry && fallbackCounters.size >= FALLBACK_MAX_ENTRIES) {
      return { allowed: false, retryAfter: Math.ceil(windowMs / 1000) };
    }
    entry = { count: 0, resetAt: now + windowMs };
    fallbackCounters.set(key, entry);
  }
  entry.count++;
  return {
    allowed: entry.count <= maxRequests,
    retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
  };
}

// Lazy-initialised limiters (created on first use after Redis is ready).
// `null` means "no Redis-backed limiter yet" — requests are then enforced by
// the capped `fallbackCounters` map above.
let ipLimiter: RateLimiterAbstract | null = null;
const webhookIpLimiters: Record<WebhookRoute, RateLimiterAbstract | null> = {
  clerk: null,
  meta: null,
  whatsapp: null,
  billing: null,
};
let tenantLimiter: RateLimiterAbstract | null = null;
let socketLimiter: RateLimiterAbstract | null = null;

/**
 * Create a Redis-backed rate limiter, or `null` when Redis is unavailable.
 *
 * Deliberately does NOT fall back to `RateLimiterMemory`: its key store has no
 * cap, and because the limiters below are lazy singletons a single Redis-less
 * first request pinned that unbounded store for the life of the process — a
 * spoofable-key flood then grew it without limit. Callers enforce through the
 * capped `fallbackCounters` map instead, and retry Redis on the next request.
 *
 * `blockDuration` is the extra lockout, in seconds, after a key first goes
 * over the limit. With 0 the key is throttled only until its window ends.
 */
function createRateLimiter(
  keyPrefix: string,
  points: number,
  duration: number,
  blockDuration = 60,
): RateLimiterAbstract | null {
  const client = getRedisClient();
  if (client && isRedisAvailable()) {
    return new RateLimiterRedis({
      storeClient: client,
      keyPrefix,
      points,
      duration: Math.floor(duration / 1000),
      blockDuration,
      inMemoryBlockOnConsumed: points + 1,
      inMemoryBlockDuration: blockDuration,
    });
  }
  return null;
}

function ensureLimiters(): void {
  if (!ipLimiter) {
    ipLimiter = createRateLimiter('rl:ip', RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS);
    for (const route of Object.keys(webhookIpLimiters) as WebhookRoute[]) {
      webhookIpLimiters[route] = createRateLimiter(
        `rl:webhook-ip:${route}`,
        WEBHOOK_IP_RATE_LIMIT.maxRequests,
        RATE_LIMIT_WINDOW_MS,
        0,
      );
    }
    tenantLimiter = createRateLimiter('rl:tenant', RATE_LIMIT_MAX_REQUESTS * 2, RATE_LIMIT_WINDOW_MS);
    socketLimiter = createRateLimiter('rl:socket', 100, RATE_LIMIT_WINDOW_MS);
  }
}

/**
 * Get client IP address
 */
function getClientIp(req: Request): string {
  // With `trust proxy` configured (server.ts), Express derives the real client
  // IP into req.ip from the trusted hop. Do NOT read the raw X-Forwarded-For
  // left-most value — it's attacker-spoofable and lets a client mint unlimited
  // rate-limit keys to bypass the limiter. See security audit #I.
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
    res.status(429).json({ // envelope-allow: OOS legacy 429 (plan §10)
      error: 'Too Many Requests',
      retryAfter,
      message,
    });
    return;
  }
  res.status(429).json({ // envelope-allow: OOS legacy 429 (plan §10)
    error: 'Too Many Requests',
    message,
  });
}

/**
 * Enforce a limit through the capped `fallbackCounters` map when no
 * Redis-backed limiter exists. In that state this IS the primary limiter, so
 * the wire shape matches the Redis path exactly (`RATE_LIMIT_EXCEEDED` +
 * `Retry-After`) — unlike the post-error branches below, which report
 * `RATE_LIMIT_FALLBACK` because a real limiter broke mid-flight.
 */
function consumeCappedFallback(
  req: Request,
  res: Response,
  next: NextFunction,
  key: string,
  maxRequests: number,
  windowMs: number,
  legacyMessage: string,
): void {
  const { allowed, retryAfter } = fallbackConsume(key, maxRequests, windowMs);
  if (allowed) {
    next();
    return;
  }
  res.setHeader('Retry-After', retryAfter.toString());
  if (shouldUseLegacyEnvelope(req)) {
    emitLegacy429(res, legacyMessage, retryAfter);
    return;
  }
  next(new RateLimitError('Rate limit exceeded. Please try again later.', { retryAfter }));
}

/** One IP-keyed budget: which limiter holds it, and how big it is. */
interface IpBucket {
  limiter: RateLimiterAbstract | null;
  /** Namespaces the capped in-memory fallback key. */
  keyPrefix: string;
  maxRequests: number;
}

/**
 * Consume one point from an IP-keyed bucket and either continue or reject.
 *
 * `rateLimitByIp` and `rateLimitWebhookByIp` differ only in which bucket they
 * charge and how many points that bucket holds, so the Redis path, the capped
 * in-memory fallback and the two 429 body shapes live here once.
 */
function enforceIpLimit(
  req: Request,
  res: Response,
  next: NextFunction,
  bucket: IpBucket,
): void {
  const { limiter, maxRequests } = bucket;
  const clientIp = getClientIp(req);
  const fallbackKey = `${bucket.keyPrefix}:${clientIp}`;

  if (!limiter) {
    consumeCappedFallback(
      req,
      res,
      next,
      fallbackKey,
      maxRequests,
      RATE_LIMIT_WINDOW_MS,
      'Rate limit exceeded. Please try again later.',
    );
    return;
  }

  limiter
    .consume(clientIp, 1)
    .then(() => {
      next();
    })
    .catch((rateLimiterRes: RateLimiterRes | Error) => {
      if (rateLimiterRes instanceof Error) {
        logger.error('Rate limiter error, using in-memory fallback:', rateLimiterRes);
        if (fallbackConsume(fallbackKey, maxRequests, RATE_LIMIT_WINDOW_MS).allowed) {
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
 * HTTP Middleware: Rate limit by IP address
 */
export function rateLimitByIp(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  ensureLimiters();
  enforceIpLimit(req, res, next, {
    limiter: ipLimiter,
    keyPrefix: 'ip',
    maxRequests: RATE_LIMIT_MAX_REQUESTS,
  });
}

/**
 * HTTP Middleware factory: rate limit one raw-body webhook route by IP address.
 *
 * The four provider webhook routes (Clerk, Meta, WhatsApp, billing) mount
 * ahead of `express.json()` because HMAC verification needs the exact request
 * bytes. That also put them ahead of `rateLimitByIp`, so an attacker who could
 * not forge a signature could still flood them for free. This middleware runs
 * before `express.raw()` on exactly those paths; it reads only `req.ip`, never
 * the body, so the Buffer reaches the verifier untouched.
 *
 * Each route charges its OWN bucket (`rl:webhook-ip:<route>`), apart from the
 * portal bucket and from the other routes. WhatsApp arrives from the same Meta
 * egress IPs as Messenger and Instagram, so one shared bucket would let one
 * provider starve another. A webhook burst also must not spend the
 * browser-facing budget of the same IP.
 *
 * There is no extended block. An IP over the limit gets 429 only until the
 * current window ends, then recovers, so the Redis limiter and the capped
 * in-memory fallback behave the same under the same load.
 */
export function rateLimitWebhookByIp(
  route: WebhookRoute,
): (req: Request, res: Response, next: NextFunction) => void {
  const keyPrefix = `webhook-ip:${route}`;
  return (req: Request, res: Response, next: NextFunction): void => {
    ensureLimiters();
    enforceIpLimit(req, res, next, {
      limiter: webhookIpLimiters[route],
      keyPrefix,
      maxRequests: WEBHOOK_IP_RATE_LIMIT.maxRequests,
    });
  };
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
  if (!tenantLimiter) {
    consumeCappedFallback(
      req,
      res,
      next,
      `tenant:${tenantId}`,
      RATE_LIMIT_MAX_REQUESTS * 2,
      RATE_LIMIT_WINDOW_MS,
      'Tenant rate limit exceeded. Please try again later.',
    );
    return;
  }

  tenantLimiter
    .consume(tenantId, 1)
    .then(() => {
      next();
    })
    .catch((rateLimiterRes: RateLimiterRes | Error) => {
      if (rateLimiterRes instanceof Error) {
        logger.error('Tenant rate limiter error, using in-memory fallback:', rateLimiterRes);
        if (fallbackConsume(`tenant:${tenantId}`, RATE_LIMIT_MAX_REQUESTS * 2, RATE_LIMIT_WINDOW_MS).allowed) {
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

    if (!ipLimiter || !tenantLimiter) {
      consumeCappedFallback(
        req,
        res,
        next,
        `combined:${clientIp}:${tenantId || 'none'}`,
        RATE_LIMIT_MAX_REQUESTS,
        RATE_LIMIT_WINDOW_MS,
        'Rate limit exceeded. Please try again later.',
      );
      return;
    }

    const promises: Promise<RateLimiterRes>[] = [];

    // IP rate limiting
    if (!options.skipIp) {
      promises.push(ipLimiter.consume(clientIp, 1));
    }

    // Tenant rate limiting
    if (!options.skipTenant && tenantId) {
      promises.push(tenantLimiter.consume(tenantId, 1));
    }

    Promise.all(promises)
      .then(() => {
        next();
      })
      .catch((error: RateLimiterRes | Error) => {
        if (error instanceof Error) {
          logger.error('Combined rate limiter error, using in-memory fallback:', error);
          const fallbackKey = `combined:${clientIp}:${tenantId || 'none'}`;
          if (fallbackConsume(fallbackKey, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS).allowed) {
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
    if (!socketLimiter) {
      // No Redis: the capped map is the limiter, not a degraded fallback.
      return fallbackConsume(`socket:${key}`, 100, RATE_LIMIT_WINDOW_MS).allowed;
    }
    await socketLimiter.consume(key, 1);
    return true;
  } catch (error) {
    if (error instanceof Error) {
      logger.error('Socket rate limiter error, using in-memory fallback:', error);
      return fallbackConsume(`socket:${key}`, 100, RATE_LIMIT_WINDOW_MS).allowed;
    }
    return false;
  }
}

/**
 * Get rate limit status for a key
 */
export async function getRateLimitStatus(
  key: string,
  type: 'ip' | 'tenant' | 'socket' = 'ip'
): Promise<{ remaining: number; resetTime: Date } | null> {
  try {
    ensureLimiters();
    let limiter: RateLimiterAbstract | null;
    switch (type) {
      case 'tenant':
        limiter = tenantLimiter;
        break;
      case 'socket':
        limiter = socketLimiter;
        break;
      default:
        limiter = ipLimiter;
    }
    // Without Redis there is no queryable limiter state — the capped fallback
    // map is per-process and not part of this public status surface.
    if (!limiter) return null;

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

// --- Named per-route Redis limiters (folded from rate-limit.ts) ---

interface NamedLimiterConfig {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
  identifier?: (req: Request) => string | undefined;
}

const createRateLimitKey = (req: Request, prefix: string): string => {
  const identifier = req.user?.id || req.widget?.visitorId || req.ip || 'unknown';
  const tenantId = req.tenant?.id || req.user?.tenantId || req.widget?.tenantId || 'global';
  return `rl:${prefix}:${tenantId}:${identifier}`;
};

const createRedisRateLimiter = (limiterConfig: NamedLimiterConfig) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const redis = getRedisClient();
      if (!redis) {
        // No Redis — fail open
        return next();
      }
      const customId = limiterConfig.identifier?.(req);
      const key = customId
        ? `rl:${limiterConfig.keyPrefix}:${customId}`
        : createRateLimitKey(req, limiterConfig.keyPrefix);
      const windowSeconds = Math.floor(limiterConfig.windowMs / 1000);

      // Get current count
      const current = await redis.get(key);
      const count = current ? parseInt(current, 10) : 0;

      if (count >= limiterConfig.maxRequests) {
        // Rate limit exceeded
        const ttl = await redis.ttl(key);
        res.setHeader('Retry-After', ttl.toString());
        res.setHeader('X-RateLimit-Limit', limiterConfig.maxRequests.toString());
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('X-RateLimit-Reset', (Date.now() + ttl * 1000).toString());

        logger.warn('Rate limit exceeded', {
          requestId: req.requestId,
          key: key.split(':').pop(),
          count,
        });

        if (shouldUseLegacyEnvelope(req)) {
          // OOS carve-out: preserve legacy 429 body for provider-integration endpoints.
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
      const remaining = limiterConfig.maxRequests - count - 1;
      res.setHeader('X-RateLimit-Limit', limiterConfig.maxRequests.toString());
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
 * Widget route limiter: 60 requests/min keyed per widget visitor.
 */
export const widgetRateLimiter = createRedisRateLimiter({
  windowMs: 60000, // 1 minute
  maxRequests: 60,
  keyPrefix: 'widget',
});

/**
 * Address suggestions, which fire WHILE SOMEONE TYPES and cost money per request.
 *
 * Sized for a human filling in one address, not for a page of them: with a three-character
 * minimum and a debounce in the client, entering a full Belgian address costs a handful of
 * requests. Forty a minute leaves a fast typist and a couple of corrections comfortable while
 * bounding what a stuck client or a hostile session can spend.
 *
 * Redis-backed rather than in-memory, because in-memory counts per replica: two containers would
 * silently permit twice the limit, and neither would know.
 */
export const placesRateLimiter = createRedisRateLimiter({
  windowMs: 60000,
  maxRequests: 40,
  keyPrefix: 'places',
});

function widgetKeyIdentifier(req: Request): string | undefined {
  const body = req.body;
  const candidates = [
    body && typeof body === 'object' ? body.widgetId : undefined,
    body && typeof body === 'object' ? body.apiKey : undefined,
    req.query.widgetId,
    req.query.apiKey,
  ];
  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.length > 0) {
      return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
    }
  }
  return undefined;
}

/** 1000 new sessions / 10 min per bot key — must exceed any tenant's peak new-visitor rate; the origin allow-list is the abuse gate */
export const widgetKeyInitRateLimiter = createRedisRateLimiter({
  windowMs: 600_000,
  maxRequests: 1000,
  keyPrefix: 'widget-key-init',
  identifier: widgetKeyIdentifier,
});
