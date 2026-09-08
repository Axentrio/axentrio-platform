import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import type { Request, Response } from 'express';

const redisStore = vi.hoisted(() => new Map<string, string>());
vi.mock('../../config/redis', () => ({
  getRedisClient: () => ({
    get: async (key: string) => redisStore.get(key) ?? null,
    set: async (key: string, value: string) => {
      redisStore.set(key, value);
      return 'OK';
    },
    incr: async (key: string) => {
      const next = Number(redisStore.get(key) ?? '0') + 1;
      redisStore.set(key, String(next));
      return next;
    },
    expire: async () => 1,
    ttl: async () => 60,
    pipeline: () => {
      const ops: Array<() => void> = [];
      const chain = {
        incr: (key: string) => {
          ops.push(() => {
            const next = Number(redisStore.get(key) ?? '0') + 1;
            redisStore.set(key, String(next));
          });
          return chain;
        },
        expire: () => chain,
        exec: async () => {
          for (const op of ops) op();
          return [];
        },
      };
      return chain;
    },
  }),
  isRedisAvailable: () => true,
}));

import { widgetKeyInitRateLimiter } from '../../middleware/rate-limit.middleware';
import { RateLimitError } from '../../middleware/error-handler';

function hashedKey(apiKey: string): string {
  return `rl:widget-key-init:${crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
}

function mockReq(body: Record<string, string>): Request {
  return { body, query: {}, headers: {} } as Request;
}

function mockRes(): Response & { headerStore: Record<string, string> } {
  const headerStore: Record<string, string> = {};
  return {
    headerStore,
    setHeader: (name: string, value: string) => {
      headerStore[name.toLowerCase()] = String(value);
    },
    status() {
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response & { headerStore: Record<string, string> };
}

describe('widgetKeyInitRateLimiter', () => {
  beforeEach(() => redisStore.clear());

  it('429s when the hashed key is already at the cap and leaves another key alone', async () => {
    const capped = 'bk_capped_key';
    const other = 'bk_other_key';
    redisStore.set(hashedKey(capped), '1000');

    const blockedNext = vi.fn();
    const blockedRes = mockRes();
    await widgetKeyInitRateLimiter(mockReq({ apiKey: capped }), blockedRes, blockedNext);
    expect(blockedNext.mock.calls[0][0]).toBeInstanceOf(RateLimitError);
    expect(blockedRes.headerStore['retry-after']).toBe('60');

    const okNext = vi.fn();
    await widgetKeyInitRateLimiter(mockReq({ apiKey: other }), mockRes(), okNext);
    expect(okNext).toHaveBeenCalledOnce();
    expect(okNext.mock.calls[0][0]).toBeUndefined();
  });

  it('hashes widgetId the same as apiKey for the same value', async () => {
    const key = 'bk_widget_id_key';
    const okNext = vi.fn();
    await widgetKeyInitRateLimiter(mockReq({ widgetId: key }), mockRes(), okNext);
    expect(okNext).toHaveBeenCalledOnce();
    expect(redisStore.has(hashedKey(key))).toBe(true);
  });
});
