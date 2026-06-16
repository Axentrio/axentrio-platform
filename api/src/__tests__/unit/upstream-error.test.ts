import { describe, it, expect } from 'vitest';
import { isUpstreamRateLimit, rethrowIfUpstreamRateLimit } from '../../llm/upstream-error';
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
