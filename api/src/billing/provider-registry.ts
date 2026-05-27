/**
 * Provider registry — single lookup point for billing provider adapters.
 *
 * Providers register themselves at module-load time. Lookup throws if the
 * name is unknown. The webhook router consults the v1 allowlist below to
 * decide which providers receive inbound webhook traffic.
 *
 * Plan: .scratch/plan-billing.md § Implementation outline step 3.
 */

import { ManualBillingProvider } from './providers/manual';
import type { BillingProvider } from './types';

/**
 * v1 webhook allowlist. Adding a new provider's name here is the explicit
 * gate for accepting its webhooks — `supportsWebhooks=true` on a provider
 * alone is NOT enough. This prevents a future provider adapter from
 * silently becoming webhook-routable just by being registered.
 */
export const WEBHOOK_PROVIDER_ALLOWLIST: readonly string[] = ['stripe'];

const providers = new Map<string, BillingProvider>();

export function registerBillingProvider(provider: BillingProvider): void {
  providers.set(provider.name, provider);
}

export function getBillingProvider(name: string): BillingProvider {
  const provider = providers.get(name);
  if (!provider) {
    throw new Error(`getBillingProvider: unknown provider '${name}'`);
  }
  return provider;
}

/**
 * Returns true only if the provider is BOTH (a) on the v1 webhook allowlist
 * AND (b) actually capable of handling webhooks (`supportsWebhooks=true`).
 * Both gates must pass for the webhook router to dispatch to the provider.
 */
export function isWebhookProvider(name: string): boolean {
  if (!WEBHOOK_PROVIDER_ALLOWLIST.includes(name)) return false;
  const provider = providers.get(name);
  return provider !== undefined && provider.supportsWebhooks;
}

export function listBillingProviders(): readonly BillingProvider[] {
  return Array.from(providers.values());
}

// Register built-in providers. Stripe is registered later (step 6) once its
// adapter exists; Manual is always available.
registerBillingProvider(new ManualBillingProvider());
