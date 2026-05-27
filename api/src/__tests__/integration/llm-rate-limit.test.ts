// api/src/__tests__/integration/llm-rate-limit.test.ts
//
// End-to-end: builds a minimal Express app that exposes the rate-limited
// provider wrapper through an HTTP route, then drives it with supertest.
// Verifies that the N+1 call returns HTTP 429 with the documented body shape
// { error: 'daily_llm_limit_reached', limit, used }.
//
// We avoid importing AppDataSource / the full server here so the test stands
// on its own — the unit of work being verified is "LLM call attempt over a
// tenant's daily cap → HTTP 429 with the spec body".

// ── Hoisted module-level mocks ────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ioredis — pure in-process counter, no network. Hoisted by vitest.
vi.mock('ioredis', () => {
  const store = new Map<string, number>();
  class FakeRedis {
    on() { return this; }
    async ping() { return 'PONG'; }
    async incr(key: string) {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    }
    async expire(_key: string, _seconds: number) { return 1; }
    async quit() { return 'OK'; }
  }
  return { default: FakeRedis, __store: store };
});

// Mock the OpenAI SDK so provider.chat() doesn't actually hit the network.
const mockOpenAICreate = vi.fn();
vi.mock('openai', () => {
  function OpenAI() {
    return { chat: { completions: { create: mockOpenAICreate } } };
  }
  return { default: OpenAI };
});

// Imports below the mocks (mocks are hoisted by vitest regardless).
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { initializeRedis } from '../../config/redis';
import { getProvider } from '../../llm/provider-factory';
import { LlmRateLimitError } from '../../llm/llm-rate-limit';
import type { ChatMessage } from '../../llm/llm.types';

// ── Test-local app: route + dedicated error mapper ────────────────────────
//
// We install a small error mapper that turns LlmRateLimitError into the
// exact body shape the spec requires. Production controllers should adopt
// the same pattern: catch + err.toResponseBody().
//
function buildApp(tenantId: string, limit: number) {
  const app = express();
  app.use(express.json());

  app.post('/llm', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const provider = getProvider(
        'openai',
        undefined,
        'test-key',         // bypass encrypted-key path
        tenantId,           // <- enables the rate-limit wrapper
        limit,              // <- per-tenant override used as the cap
      );
      const msgs: ChatMessage[] = [{ role: 'user', content: req.body?.message ?? 'hi' }];
      const result = await provider.chat(msgs, {
        model: 'gpt-4o-mini',
        maxTokens: 50,
        temperature: 0,
        jsonMode: false,
      });
      res.json({ ok: true, content: result.content });
    } catch (err) {
      next(err);
    }
  });

  // Local error handler — mirrors the pattern controllers should use.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof LlmRateLimitError) {
      res.status(429).json(err.toResponseBody());
      return;
    }
    res.status(500).json({ error: err?.message ?? 'unknown' });
  });

  return app;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockOpenAICreate.mockReset();
  mockOpenAICreate.mockResolvedValue({
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  // Ensure the singleton redis client is ready so the wrapper actually
  // enforces (instead of failing open).
  await initializeRedis();
});

describe('integration: LLM daily rate limit over Express', () => {
  it('N+1 call for a tenant with limit N returns HTTP 429 with the documented body', async () => {
    // Unique tenant id per test so the in-process fake-redis counter is
    // isolated across runs (the store persists for the FakeRedis lifetime).
    const tenantId = `tenant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const limit = 3;
    const app = buildApp(tenantId, limit);

    // First N calls all succeed.
    for (let i = 0; i < limit; i++) {
      const ok = await request(app).post('/llm').send({ message: `m${i}` });
      expect(ok.status).toBe(200);
      expect(ok.body.ok).toBe(true);
    }
    // The OpenAI SDK should have been hit exactly N times so far.
    expect(mockOpenAICreate).toHaveBeenCalledTimes(limit);

    // N+1: the wrapper must block BEFORE invoking the SDK.
    const blocked = await request(app).post('/llm').send({ message: 'one too many' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      error: 'daily_llm_limit_reached',
      limit,
      used: limit + 1, // post-increment value (counter recorded the over-cap attempt)
    });
    // Crucially, OpenAI was NOT called for the blocked attempt — we save the
    // real money before the network call.
    expect(mockOpenAICreate).toHaveBeenCalledTimes(limit);
  });
});
