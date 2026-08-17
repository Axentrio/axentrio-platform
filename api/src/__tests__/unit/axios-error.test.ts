import { describe, it, expect } from 'vitest';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { parseAxiosError, sanitizeGraphError } from '../../utils/axios-error';

const TOKEN = 'EAABsupersecretpagetoken';

function graphAxiosError(): AxiosError {
  return new AxiosError(
    'Request failed with status code 400',
    'ERR_BAD_REQUEST',
    {
      url: `https://graph.facebook.com/v25.0/178414000/subscribed_apps?access_token=${TOKEN}`,
      method: 'post',
      params: { access_token: TOKEN },
      headers: { Authorization: `Bearer ${TOKEN}` },
    } as InternalAxiosRequestConfig,
    { path: `/v25.0/178414000/subscribed_apps?access_token=${TOKEN}` },
    {
      status: 400,
      statusText: 'Bad Request',
      headers: {},
      config: {} as InternalAxiosRequestConfig,
      data: {
        error: {
          message: 'IG account is not a business account',
          type: 'OAuthException',
          code: 190,
          error_subcode: 460,
          fbtrace_id: 'A1b2C3',
        },
      },
    },
  );
}

describe('sanitizeGraphError', () => {
  it('keeps Graph diagnostics and drops URL, token, and request config', () => {
    const error = graphAxiosError();
    const safe = sanitizeGraphError(error);

    expect(safe).toEqual({
      message: 'IG account is not a business account',
      retryable: false,
      status: 400,
      code: 190,
      subcode: 460,
      fbtraceId: 'A1b2C3',
    });

    const dumped = JSON.stringify(safe);
    expect(dumped).not.toContain(TOKEN);
    expect(dumped).not.toContain('access_token');
    expect(dumped).not.toContain('graph.facebook.com');
    expect(dumped).not.toMatch(/[?&]/);
    expect(safe).not.toHaveProperty('config');
    expect(safe).not.toHaveProperty('url');
  });

  it('falls back to Error.message for non-axios failures', () => {
    expect(sanitizeGraphError(new Error('duplicate key value violates unique constraint'))).toEqual({
      message: 'duplicate key value violates unique constraint',
      retryable: true,
    });
  });
});

describe('parseAxiosError', () => {
  it('prefers the Graph error message', () => {
    expect(parseAxiosError(graphAxiosError()).message).toBe('IG account is not a business account');
  });
});
