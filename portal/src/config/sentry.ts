/**
 * Sentry (browser) configuration.
 * Mirrors the API setup (api/src/config/sentry.ts): only initializes when a DSN
 * is provided, so local/dev builds without VITE_SENTRY_DSN are unaffected.
 */
import * as Sentry from '@sentry/react';

export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) {
    return; // Sentry disabled when no DSN
  }

  Sentry.init({
    dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE || undefined,
    sendDefaultPii: false,
    tracesSampleRate: import.meta.env.PROD ? 0.2 : 1.0,
    integrations: [Sentry.browserTracingIntegration()],
  });
}

export { Sentry };
