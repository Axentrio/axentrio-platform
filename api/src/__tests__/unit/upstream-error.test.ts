import { describe, it, expect } from 'vitest';
import {
  isUpstreamRateLimit,
  rethrowIfUpstreamRateLimit,
  isUpstreamServerError,
  isUpstreamUnreachable,
  isRetryableUpstream,
  UpstreamUnreachableError,
} from '../../llm/upstream-error';
import { RateLimitError } from '../../middleware/error-handler';

describe('upstream-error', () => {
  it('detects a provider 429 by numeric status', () => {
    // Shape of an OpenAI/Anthropic SDK APIError.
    expect(isUpstreamRateLimit({ status: 429, code: 'rate_limit_exceeded' })).toBe(true);
  });

  it('ignores non-429 and non-error values', () => {
    expect(isUpstreamRateLimit({ status: 500 })).toBe(false);
    expect(isUpstreamRateLimit(new Error('boom'))).toBe(false);
    expect(isUpstreamRateLimit('429')).toBe(false);
    expect(isUpstreamRateLimit(null)).toBe(false);
    expect(isUpstreamRateLimit(undefined)).toBe(false);
  });

  it('rethrows a 429 as a RateLimitError (HTTP 429), passing other errors through', () => {
    expect(() => rethrowIfUpstreamRateLimit({ status: 429 })).toThrow(RateLimitError);
    try {
      rethrowIfUpstreamRateLimit({ status: 429 });
    } catch (e) {
      expect((e as RateLimitError).statusCode).toBe(429);
    }
    // Non-429 → no throw; the caller's existing handling runs.
    expect(() => rethrowIfUpstreamRateLimit({ status: 500 })).not.toThrow();
    expect(() => rethrowIfUpstreamRateLimit(new Error('x'))).not.toThrow();
  });
});

describe('isUpstreamServerError', () => {
  it('detects any provider 5xx by numeric status', () => {
    expect(isUpstreamServerError({ status: 500 })).toBe(true);
    expect(isUpstreamServerError({ status: 502 })).toBe(true);
    expect(isUpstreamServerError({ status: 503 })).toBe(true);
    expect(isUpstreamServerError({ status: 504 })).toBe(true);
  });

  it('ignores 4xx, 429, and transport errors with no status', () => {
    expect(isUpstreamServerError({ status: 429 })).toBe(false);
    expect(isUpstreamServerError({ status: 400 })).toBe(false);
    expect(isUpstreamServerError({ status: 499 })).toBe(false);
    // A DB/Redis transport failure carries no HTTP status → never a "server error".
    expect(isUpstreamServerError(new Error('connect ECONNREFUSED 10.0.0.4:5432'))).toBe(false);
    expect(isUpstreamServerError(null)).toBe(false);
  });
});

describe('isUpstreamUnreachable', () => {
  it('detects the SDK connection error by name', () => {
    expect(isUpstreamUnreachable({ name: 'APIConnectionError', message: 'Connection error.' })).toBe(true);
    expect(isUpstreamUnreachable({ name: 'APIConnectionTimeoutError' })).toBe(true);
  });

  it('detects a libuv transport code, on the error or its cause', () => {
    expect(isUpstreamUnreachable({ code: 'ECONNRESET' })).toBe(true);
    expect(isUpstreamUnreachable(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }))).toBe(true);
    expect(isUpstreamUnreachable(new Error('socket hang up'))).toBe(true);
  });

  it('does NOT treat an HTTP error as a transport failure', () => {
    expect(isUpstreamUnreachable({ status: 500, message: 'ECONNRESET-ish text' })).toBe(false);
    expect(isUpstreamUnreachable({ status: 429 })).toBe(false);
  });

  it('ignores a plain error with no network signal', () => {
    expect(isUpstreamUnreachable(new Error('prompt composition blew up'))).toBe(false);
    expect(isUpstreamUnreachable(null)).toBe(false);
  });
});

describe('isRetryableUpstream', () => {
  it('retries a 429, a 5xx, and an unreachable provider', () => {
    expect(isRetryableUpstream({ status: 429, code: 'rate_limit_exceeded' })).toBe(true);
    expect(isRetryableUpstream({ status: 503 })).toBe(true);
    expect(isRetryableUpstream({ name: 'APIConnectionError' })).toBe(true);
  });

  it('does NOT retry an exhausted quota, a 4xx, or a bot fault', () => {
    // A quota-exhausted 429 will not clear on a retry.
    expect(isRetryableUpstream({ status: 429, code: 'insufficient_quota' })).toBe(false);
    expect(isRetryableUpstream({ status: 400 })).toBe(false);
    expect(isRetryableUpstream(new Error('prompt composition blew up'))).toBe(false);
  });
});

describe('UpstreamUnreachableError', () => {
  it('keeps the underlying message and cause', () => {
    const cause = new Error('socket hang up');
    const wrapped = new UpstreamUnreachableError(cause);
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.name).toBe('UpstreamUnreachableError');
    expect(wrapped.message).toBe('socket hang up');
    expect(wrapped.cause).toBe(cause);
  });
});
