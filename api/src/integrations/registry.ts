import { getAnchorBotConfig, replaceAnchorBotSettingsSection } from '../services/bot-config.service';
import type { BotSettings } from '../database/entities/Bot';
import { IntegrationProvider, IntegrationConfig } from './types';

const providers = new Map<string, IntegrationProvider>();

export function registerIntegrationProvider(provider: IntegrationProvider): void {
  providers.set(provider.kind, provider);
}

export function getAllIntegrationProviders(): IntegrationProvider[] {
  return Array.from(providers.values());
}

// --- Persistence (kept on Bot.settings.integrations so egress readers are unchanged) ---

export async function readAllIntegrations(tenantId: string): Promise<Record<string, IntegrationConfig>> {
  const { settings } = await getAnchorBotConfig(tenantId);
  return (settings.integrations ?? {}) as Record<string, IntegrationConfig>;
}

export async function readIntegrationConfig(
  tenantId: string,
  kind: string,
): Promise<IntegrationConfig | null> {
  const all = await readAllIntegrations(tenantId);
  return all[kind] ?? null;
}

/** Set (or, with null, clear) one integration's config, preserving the others. */
export async function writeIntegrationConfig(
  tenantId: string,
  kind: string,
  config: IntegrationConfig | null,
): Promise<void> {
  const all = await readAllIntegrations(tenantId);
  const updated: Record<string, IntegrationConfig> = { ...all };
  if (config === null) {
    delete updated[kind];
  } else {
    updated[kind] = config;
  }
  await replaceAnchorBotSettingsSection(tenantId, 'integrations', updated as BotSettings['integrations']);
}
