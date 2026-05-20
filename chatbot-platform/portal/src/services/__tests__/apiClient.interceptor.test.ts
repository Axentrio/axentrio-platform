/**
 * Integration tests for the response interceptor in `apiClient.ts`.
 *
 * Plan: chatbot-platform/docs/api-response-standardization-plan.md §2.4, §7.2.
 *
 * The 10-test unit suite in `apiClient.test.ts` covers `extractApiErrorMessage`
 * + `handleApiError` as pure functions. These tests drive the actual axios
 * instance through `axios-mock-adapter` so the `interceptors.response.use(...)`
 * block at apiClient.ts L91-108 is exercised end-to-end — proving:
 *
 *   - `{success, data}` is unwrapped to `data`.
 *   - `{success, data, meta}` is unwrapped to `{data, meta}`.
 *   - Non-envelope bodies pass through untouched.
 *   - `{success: true, data: null}` unwraps to `null` (knowledge.controller AI
 *     settings empty-state contract — codex round 3 #11).
 *   - Error responses are NOT unwrapped (the body reaches catch handlers as-is).
 *   - 402 responses fire the `handlePlanLimit` toast side-effect.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import MockAdapter from 'axios-mock-adapter';
import axios from 'axios';

// The plan-limit handler does `import('sonner')` dynamically inside the
// rejection branch. Stub it before importing apiClient so we can spy on
// `toast.warning`.
const toastWarning = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    warning: toastWarning,
    success: toastSuccess,
    error: toastError,
  },
}));

// Set tokenProvider to a no-op stub BEFORE importing the client so the
// request interceptor short-circuits without auth.
import apiClient, { api, setTokenProvider, extractApiErrorMessage, handleApiError } from '../apiClient';

setTokenProvider(async () => null);

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
  toastWarning.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
});

afterEach(() => {
  mock.restore();
});

// Belt-and-braces: ensure the mock adapter is fully detached from the
// singleton apiClient instance by the end of this file, so any later test
// suite (or watch-mode rerun) using the same axios instance doesn't pick up
// stale handlers.
afterAll(() => {
  if (mock) mock.restore();
});

// ─── Success responses ──────────────────────────────────────────────────────

describe('response interceptor — success body unwrap', () => {
  it('unwraps `{success: true, data: X}` to X', async () => {
    mock.onGet('/foo').reply(200, {
      success: true,
      data: { id: '1', name: 'X' },
    });

    const result = await api.get<{ id: string; name: string }>('/foo');

    expect(result).toEqual({ id: '1', name: 'X' });
    // Specifically NOT the envelope.
    expect(result).not.toHaveProperty('success');
  });

  it('unwraps `{success, data, meta}` to `{data, meta}` (preserves pagination)', async () => {
    mock.onGet('/list').reply(200, {
      success: true,
      data: [{ id: '1' }, { id: '2' }],
      meta: { pagination: { total: 50, page: 1, limit: 10, totalPages: 5 } },
    });

    const result = await api.get<{ data: unknown[]; meta: unknown }>('/list');

    expect(result).toEqual({
      data: [{ id: '1' }, { id: '2' }],
      meta: { pagination: { total: 50, page: 1, limit: 10, totalPages: 5 } },
    });
  });

  it('unwraps `{success: true, data: null}` to null (empty-state contract)', async () => {
    // knowledge.controller.ts:183 emits `res.json(null)` today for "no AI
    // settings yet"; the migration will switch it to `sendSuccess(res, null)`
    // which goes through the envelope. The portal must continue to see `null`.
    mock.onGet('/settings').reply(200, { success: true, data: null });

    const result = await api.get('/settings');

    expect(result).toBeNull();
  });

  it('non-envelope body passes through untouched', async () => {
    mock.onGet('/raw').reply(200, { foo: 'bar', baz: 42 });

    const result = await api.get<{ foo: string; baz: number }>('/raw');

    expect(result).toEqual({ foo: 'bar', baz: 42 });
  });

  it('`{success: true}` without `data` key does NOT unwrap (would lose the body)', async () => {
    // The interceptor's check at apiClient.ts:94 is `'success' in data && 'data' in data`.
    // A body lacking `data` should NOT be unwrapped (otherwise the caller sees `undefined`).
    mock.onGet('/no-data').reply(200, { success: true });

    const result = await api.get<{ success: boolean }>('/no-data');

    expect(result).toEqual({ success: true });
  });
});

// ─── Error responses ────────────────────────────────────────────────────────

describe('response interceptor — error body is NOT unwrapped', () => {
  it('422 envelope error reaches catch handler with the full body intact', async () => {
    mock.onPost('/items').reply(422, {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Bad input',
        details: { fieldErrors: { name: ['Required'] } },
      },
      meta: {
        timestamp: '2026-05-20T12:00:00.000Z',
        requestId: 'req_abc',
        path: '/items',
      },
    });

    await expect(api.post('/items', { name: 1 })).rejects.toMatchObject({
      response: {
        status: 422,
        data: {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Bad input',
            details: { fieldErrors: { name: ['Required'] } },
          },
          meta: expect.objectContaining({ requestId: 'req_abc' }),
        },
      },
    });
  });

  it('legacy string error 400 reaches catch handler with the legacy body intact', async () => {
    mock.onGet('/old').reply(400, { error: 'plain string' });

    try {
      await api.get('/old');
      throw new Error('should have rejected');
    } catch (err) {
      // Use axios.isAxiosError instead of `instanceof AxiosError` — the latter
      // is flaky in vitest due to multiple AxiosError class identities.
      expect(axios.isAxiosError(err)).toBe(true);
      const ax = err as import('axios').AxiosError<{ error: string }>;
      expect(ax.response?.status).toBe(400);
      expect(ax.response?.data).toEqual({ error: 'plain string' });
    }
  });
});

// ─── extractApiErrorMessage / handleApiError end-to-end ─────────────────────

describe('helper integration — extractApiErrorMessage / handleApiError', () => {
  it('extractApiErrorMessage returns the nested message for a 422 envelope', async () => {
    mock.onPost('/items').reply(422, {
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Bad input' },
      meta: { timestamp: 'x', requestId: 'y', path: '/items' },
    });

    let caught: unknown;
    try {
      await api.post('/items', {});
    } catch (e) {
      caught = e;
    }

    expect(extractApiErrorMessage(caught)).toBe('Bad input');
  });

  it('handleApiError returns the legacy string for an old `{error: "..."}` body', async () => {
    mock.onGet('/old').reply(400, { error: 'plain string' });

    let caught: unknown;
    try {
      await api.get('/old');
    } catch (e) {
      caught = e;
    }

    expect(handleApiError(caught)).toBe('plain string');
  });

  it('handleApiError falls back to "Error N: ..." when the body has no extractable string', async () => {
    // axios-mock-adapter does not populate `response.statusText`, so we can't
    // pin the exact string here — but we can assert the fallback shape (status
    // code present, prefixed with "Error ").
    mock.onGet('/empty').reply(503, {}); // body is `{}` — no error/message field.

    let caught: unknown;
    try {
      await api.get('/empty');
    } catch (e) {
      caught = e;
    }

    expect(handleApiError(caught)).toMatch(/^Error 503:/);
  });
});

// ─── Plan-limit (402) side effect ───────────────────────────────────────────

describe('handlePlanLimit (402) toast side effect', () => {
  it('fires toast.warning with the mapped copy for a known plan-limit code', async () => {
    mock.onGet('/agents').reply(402, {
      success: false,
      error: {
        code: 'plan_limit_agents',
        message: 'Generic server message — should be overridden by PLAN_LIMIT_COPY',
        details: { limit: 5 },
      },
      meta: { timestamp: 'x', requestId: 'y', path: '/agents' },
    });

    try {
      await api.get('/agents');
    } catch {
      /* expected to throw */
    }

    // Lazy import resolves on the microtask queue — give it a tick.
    await new Promise((r) => setTimeout(r, 10));

    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(toastWarning.mock.calls[0][0]).toBe(
      "You've reached your plan's agent limit. Upgrade to add more.",
    );
  });

  it('falls back to server.error.message when the code is unknown', async () => {
    mock.onGet('/unknown').reply(402, {
      success: false,
      error: { code: 'plan_limit_unicorn', message: 'You hit the unicorn limit' },
      meta: { timestamp: 'x', requestId: 'y', path: '/unknown' },
    });

    try {
      await api.get('/unknown');
    } catch {
      /* expected to throw */
    }

    await new Promise((r) => setTimeout(r, 10));

    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(toastWarning.mock.calls[0][0]).toBe('You hit the unicorn limit');
  });
});
