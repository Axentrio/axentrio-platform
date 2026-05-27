import { registerIntegrationProvider } from './registry';
import { calcomProvider } from './providers/calcom';

// Register at import time so the registry is populated as soon as the
// integrations module loads. The controller reads the registry lazily at
// request time, and consumers (the running server, and wire tests that mount
// the routes on their own express app) don't all call the boot hook below —
// so import-time registration is the reliable guarantee. Idempotent (Map keyed
// by kind).
registerIntegrationProvider(calcomProvider);

/**
 * Explicit boot hook, mirroring registerChannelAdapter for messaging channels.
 * Safe to call alongside the import-time registration above (idempotent).
 */
export function registerIntegrationProviders(): void {
  registerIntegrationProvider(calcomProvider);
}

export { calcomProvider };
