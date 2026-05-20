import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import type { AxiosResponse } from 'axios';
import { extractApiErrorMessage, handleApiError } from '../apiClient';

/**
 * Build an AxiosError whose `isAxiosError` flag is true (so `axios.isAxiosError`
 * recognises it). We construct via the class then attach a `response` with the
 * body shape under test.
 */
function makeAxiosError(
  data: unknown,
  status = 500,
  statusText = 'Internal Server Error',
): AxiosError {
  const err = new AxiosError('Request failed');
  const headers = new AxiosHeaders();
  const response: AxiosResponse = {
    data,
    status,
    statusText,
    headers,
    config: { headers } as never,
  };
  err.response = response;
  err.request = {}; // populated by axios on real errors that reached the network
  return err;
}

/**
 * Axios error with `request` but no `response` — the network-error / timeout case.
 */
function makeAxiosNetworkError(): AxiosError {
  const err = new AxiosError('Network Error');
  err.request = {};
  return err;
}

describe('extractApiErrorMessage', () => {
  it('returns the string for legacy string-only `{error:"msg"}` bodies', () => {
    expect(extractApiErrorMessage(makeAxiosError({ error: 'msg' }))).toBe('msg');
  });

  it('returns the nested message for envelope `{error:{message:"msg"}}` bodies', () => {
    expect(
      extractApiErrorMessage(makeAxiosError({ error: { message: 'msg' } })),
    ).toBe('msg');
  });

  it('returns undefined when the error object has no message (e.g. only code)', () => {
    expect(
      extractApiErrorMessage(makeAxiosError({ error: { code: 'X' } })),
    ).toBeUndefined();
  });

  it('returns the message for bare `{message:"msg"}` bodies', () => {
    expect(extractApiErrorMessage(makeAxiosError({ message: 'msg' }))).toBe('msg');
  });

  it('prefers data.message over a string data.error (legacy rate-limit body)', () => {
    // Today's rate-limit response is `{error:'Too Many Requests', message:'Rate limit exceeded...'}`.
    // The helper picks the more useful `message` copy.
    expect(
      extractApiErrorMessage(
        makeAxiosError({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded. Please try again later.',
        }),
      ),
    ).toBe('Rate limit exceeded. Please try again later.');
  });

  it('returns undefined for plain non-Axios errors', () => {
    expect(extractApiErrorMessage(new Error('boom'))).toBeUndefined();
  });

  it('returns undefined for Axios errors without a response (network/timeout)', () => {
    expect(extractApiErrorMessage(makeAxiosNetworkError())).toBeUndefined();
  });
});

describe('handleApiError', () => {
  it('falls through to the generic message for non-Axios errors (regression guard)', () => {
    // Earlier helper drafts returned `error.message` for plain Errors, which
    // overrode this legacy fallback. The helper is strictly axios-response-only
    // so this case is preserved.
    expect(handleApiError(new Error('boom'))).toBe('An unexpected error occurred.');
  });

  it('returns the network-error string for Axios errors without a response', () => {
    expect(handleApiError(makeAxiosNetworkError())).toBe(
      'Network error. Please check your connection.',
    );
  });

  it('returns "Error N: statusText" for Axios responses with no extractable body string', () => {
    // Body has no error/message field at all.
    expect(handleApiError(makeAxiosError({}, 503, 'Service Unavailable'))).toBe(
      'Error 503: Service Unavailable',
    );
  });
});
