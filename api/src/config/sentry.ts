import * as Sentry from '@sentry/node';
import { config } from './environment';
import { BUILD_COMMIT } from '../utils/build-info';

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn || config.server.isTest) {
    return; // Sentry disabled when no DSN or in test
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || config.server.env,
    release: BUILD_COMMIT === 'unknown' ? undefined : BUILD_COMMIT,
    sendDefaultPii: false,
    tracesSampleRate: config.server.isProduction ? 0.2 : 1.0,
    integrations: [
      Sentry.expressIntegration(),
      Sentry.postgresIntegration(),
    ],
  });
}

export { Sentry };
