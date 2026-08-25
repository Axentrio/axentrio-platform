/**
 * Funnel the provider SDKs' own log into ours.
 *
 * Both SDK clients retry internally — `maxRetries` defaults to 2, so one logical
 * call can be three HTTP attempts with backoff between them. None of that was
 * visible to us: the retry narration goes to the SDK's logger at `info`, and the
 * default level is `warn`, so it was dropped. A throttled call and a genuinely
 * slow one looked identical, both simply "one slow model call".
 *
 * This changes NO behaviour. Same retries, same resilience, same customer
 * experience. Removing the SDK retries instead would have been a customer-facing
 * change: `callProviderWithRetry` only retries once more, and an exhausted retry
 * ends the turn with the fallback message (see agent.service.ts, the 2026-08-13
 * booking incident).
 *
 * Level mapping is deliberate. In both SDKs every `info` site sits on a failure
 * or retry path (5 of 5 in each client), and the per-request narration is at
 * `debug`. So `info` is promoted to `warn`: a hidden retry is worth finding in a
 * log search, and the happy path stays silent.
 *
 * `debug` is dropped on purpose rather than forwarded. The SDK's debug payload
 * includes request headers, so a future `logLevel: 'debug'` cannot leak an API
 * key through this adapter.
 */
import { logger } from '../utils/logger';

type LogFn = (message: string, ...rest: unknown[]) => void;

/** The `Logger` shape both SDK clients accept. */
export interface SdkLogger {
  error: LogFn;
  warn: LogFn;
  info: LogFn;
  debug: LogFn;
}

export function sdkLogger(provider: 'openai' | 'anthropic'): SdkLogger {
  const tag = `[llm:${provider}]`;
  return {
    error: (message, ...rest) => logger.error(`${tag} ${message}`, { rest }),
    warn: (message, ...rest) => logger.warn(`${tag} ${message}`, { rest }),
    // Retries and connection failures land here; see the level note above.
    info: (message, ...rest) => logger.warn(`${tag} ${message}`, { rest }),
    debug: () => {},
  };
}

/** Level that surfaces retries without narrating every request. */
export const SDK_LOG_LEVEL = 'info' as const;
