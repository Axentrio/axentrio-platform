import { RateLimiterRedis, RateLimiterMemory, RateLimiterAbstract } from 'rate-limiter-flexible';
import { getRedisClient, isRedisAvailable } from '../config/redis';
import { logger } from '../utils/logger';

interface EventRateConfig {
  points: number;
  windowSeconds: number;
}

const EVENT_RATE_CONFIGS: Record<string, EventRateConfig> = {
  'message:send': { points: 30, windowSeconds: 60 },
  'typing:indicator': { points: 60, windowSeconds: 60 },
  'file:upload': { points: 10, windowSeconds: 60 },
  'handoff:request': { points: 5, windowSeconds: 60 },
  'handoff:accept': { points: 10, windowSeconds: 60 },
  'handoff:reject': { points: 10, windowSeconds: 60 },
  'handoff:decline': { points: 10, windowSeconds: 60 },
  'session:join': { points: 20, windowSeconds: 60 },
  'session:leave': { points: 20, windowSeconds: 60 },
  'presence:update': { points: 30, windowSeconds: 60 },
  'agent:join': { points: 20, windowSeconds: 60 },
  'agent:leave': { points: 20, windowSeconds: 60 },
  'agent:status': { points: 20, windowSeconds: 60 },
  'message:read': { points: 60, windowSeconds: 60 },
};

const DEFAULT_CONFIG: EventRateConfig = { points: 100, windowSeconds: 60 };

const limiters = new Map<string, RateLimiterAbstract>();

function createLimiter(eventName: string): RateLimiterAbstract {
  const config = EVENT_RATE_CONFIGS[eventName] || DEFAULT_CONFIG;

  const client = getRedisClient();
  if (client && isRedisAvailable()) {
    return new RateLimiterRedis({
      storeClient: client,
      keyPrefix: `socket_rl_${eventName}`,
      points: config.points,
      duration: config.windowSeconds,
    });
  }

  logger.warn(`Redis unavailable for socket rate limiter (${eventName}), using memory fallback`);
  return new RateLimiterMemory({
    keyPrefix: `socket_rl_${eventName}`,
    points: config.points,
    duration: config.windowSeconds,
  });
}

function getLimiter(eventName: string): RateLimiterAbstract {
  if (!limiters.has(eventName)) {
    limiters.set(eventName, createLimiter(eventName));
  }
  return limiters.get(eventName)!;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

export async function checkEventRateLimit(
  socketId: string,
  tenantId: string,
  eventName: string
): Promise<RateLimitResult> {
  const limiter = getLimiter(eventName);
  const key = `${tenantId}:${socketId}`;

  try {
    await limiter.consume(key);
    return { allowed: true };
  } catch (rateLimiterRes: unknown) {
    const res = rateLimiterRes as { msBeforeNext?: number };
    const retryAfter = Math.ceil((res.msBeforeNext || 1000) / 1000);
    logger.warn('Socket rate limit exceeded', { socketId, tenantId, eventName, retryAfter });
    return { allowed: false, retryAfter };
  }
}
