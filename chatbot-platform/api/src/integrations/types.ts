import type { requireFeature } from '../billing/enforce';

/** The billing-feature keys accepted by requireFeature (derived, no extra coupling). */
export type IntegrationFeature = Parameters<typeof requireFeature>[1];

export type IntegrationConfig = Record<string, unknown>;

/**
 * A provider for a bot-scoped third-party *capability* the bot uses during a
 * conversation (Cal.com today; Stripe, CRM, … later). This is the integration
 * analogue of a ChannelAdapter: register one per kind and the controller
 * dispatches generically.
 *
 * Storage stays in `Bot.settings.integrations[kind]` (see integrations/registry)
 * so existing egress readers keep working unchanged.
 */
export interface IntegrationProvider {
  /** Stable key; also the storage key under Bot.settings.integrations. */
  readonly kind: string;
  /** Billing feature required to connect/use this integration. */
  readonly feature: IntegrationFeature;
  /** Plan-limit error code thrown when the feature gate fails. */
  readonly errorCode: string;

  /** Strip secrets from stored config for API responses (e.g. apiKey → hasApiKey). */
  redact(config: IntegrationConfig): Record<string, unknown>;

  /**
   * Merge a PATCH-style settings update into existing config, encrypting any
   * secrets. Returns the config to persist (caller persists null to clear).
   */
  applyUpdate(existing: IntegrationConfig | null, patch: unknown): IntegrationConfig;

  /** Optional side-effect after a config write (e.g. auto-provision a webhook). */
  afterUpdate?(tenantId: string, config: IntegrationConfig | null): Promise<void>;
}
