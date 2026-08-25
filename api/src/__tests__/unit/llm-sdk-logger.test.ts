/**
 * The provider SDKs retry twice on their own and narrate it to their logger at
 * `info`, which the default `warn` level dropped. These tests pin the contract
 * that makes those retries visible without changing any behaviour.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(),
}));
vi.mock('../../utils/logger', () => ({ logger: mockLogger }));

import { sdkLogger, SDK_LOG_LEVEL } from '../../llm/sdk-logger';

beforeEach(() => {
  mockLogger.error.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.info.mockReset();
  mockLogger.debug.mockReset();
});

describe('llm · sdkLogger', () => {
  it('surfaces a retry, which the SDK reports at info, as a warning', () => {
    sdkLogger('openai').info('[log_abc] connection failed - retrying, 2 attempts remaining');

    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[llm:openai] [log_abc] connection failed - retrying, 2 attempts remaining',
      { rest: [] },
    );
    // Not info: a hidden retry has to be findable in a log search.
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('tags each provider so two clients can be told apart', () => {
    sdkLogger('anthropic').warn('slow down');
    expect(mockLogger.warn).toHaveBeenCalledWith('[llm:anthropic] slow down', { rest: [] });
  });

  it('keeps errors at error level and passes the SDK detail through', () => {
    sdkLogger('openai').error('request failed', { status: 429 });
    expect(mockLogger.error).toHaveBeenCalledWith('[llm:openai] request failed', {
      rest: [{ status: 429 }],
    });
  });

  it('drops debug, so a request payload can never leak an API key through here', () => {
    sdkLogger('openai').debug('sending request', { headers: { authorization: 'Bearer sk-secret' } });

    expect(mockLogger.debug).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('asks for the level that shows retries and nothing per-request', () => {
    // 'warn' hides the retry narration; 'debug' narrates every request.
    expect(SDK_LOG_LEVEL).toBe('info');
  });
});
