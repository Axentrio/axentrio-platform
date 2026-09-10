/**
 * The webhook limiters throttle inside the window only. The portal IP limiter
 * keeps its 60 s block.
 *
 * A provider that overshoots near the end of one window must be served again
 * in the next one. An extended block turns one burst into minutes of 429s,
 * and a provider drops or delays customer events while it lasts.
 *
 * `RateLimiterRedis` is swapped for `RateLimiterMemory`, which applies
 * `blockDuration` by the same rule. The middleware therefore builds and uses
 * its Redis-path limiters here, with no Redis server.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type * as RateLimiterFlexible from 'rate-limiter-flexible';

vi.mock('rate-limiter-flexible', async (importOriginal) => {
  const actual = await importOriginal<typeof RateLimiterFlexible>();
  return { ...actual, RateLimiterRedis: actual.RateLimiterMemory };
});

vi.mock('../../config/redis', () => ({
  getRedisClient: () => ({}),
  isRedisAvailable: () => true,
}));

vi.mock('../../config/environment', () => ({
  config: {
    server: { isDevelopment: false },
    rateLimit: {
      windowMs: 60_000,
      maxRequests: 2,
      wsMaxConnections: 5,
    },
    logging: { level: 'error', format: 'simple', toFile: false, filePath: '' },
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  rateLimitByIp,
  rateLimitWebhookByIp,
  WEBHOOK_IP_RATE_LIMIT,
} from '../../middleware/rate-limit.middleware';
import { RateLimitError } from '../../middleware/error-handler';

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

const LIMIT = 2;
const DEFAULT_WEBHOOK_LIMIT = WEBHOOK_IP_RATE_LIMIT.maxRequests;

function send(middleware: Middleware, ip: string): Promise<'allowed' | 'limited'> {
  return new Promise((resolve, reject) => {
    const req = {
      ip,
      originalUrl: '/api/v1/webhooks/clerk',
      headers: {},
      socket: { remoteAddress: ip },
    } as unknown as Request;
    const res = { setHeader: vi.fn() } as unknown as Response;
    middleware(req, res, (err?: unknown) => {
      if (err === undefined) resolve('allowed');
      else if (err instanceof RateLimitError) resolve('limited');
      else reject(err);
    });
  });
}

/** Spend the whole budget, then go over it one second before the window ends. */
async function overshootAtWindowEnd(middleware: Middleware, ip: string): Promise<void> {
  for (let i = 0; i < LIMIT; i++) {
    // eslint-disable-next-line no-await-in-loop -- the limiter counts requests, so they must be sequential
    expect(await send(middleware, ip)).toBe('allowed');
  }
  vi.advanceTimersByTime(59_000);
  expect(await send(middleware, ip)).toBe('limited');
  vi.advanceTimersByTime(2_000);
}

beforeAll(() => {
  // The Redis-path limiters bind their size on first use.
  WEBHOOK_IP_RATE_LIMIT.maxRequests = LIMIT;
});

afterAll(() => {
  WEBHOOK_IP_RATE_LIMIT.maxRequests = DEFAULT_WEBHOOK_LIMIT;
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('webhook limiter block', () => {
  it('serves a webhook IP again as soon as the next window starts', async () => {
    const webhook = rateLimitWebhookByIp('clerk');

    await overshootAtWindowEnd(webhook, '198.51.100.10');

    expect(await send(webhook, '198.51.100.10')).toBe('allowed');
  });

  it('keeps the 60 s block on the portal IP limiter', async () => {
    await overshootAtWindowEnd(rateLimitByIp, '198.51.100.20');

    expect(await send(rateLimitByIp, '198.51.100.20')).toBe('limited');
  });
});
