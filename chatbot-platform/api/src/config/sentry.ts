import * as Sentry from '@sentry/node';
import { config } from './environment';

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn || config.server.isTest) {
    return; // Sentry disabled when no DSN or in test
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || config.server.env,
    sendDefaultPii: true,
    tracesSampleRate: config.server.isProduction ? 0.2 : 1.0,
    integrations: [
      Sentry.expressIntegration(),
      Sentry.postgresIntegration(),
    ],
  });
}

export { Sentry };
