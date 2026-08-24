/**
 * Tenant settings presenter
 *
 * GET /tenants/me and PATCH /tenants/me both render the anchor bot's settings
 * for the portal. The two used to carry identical inline copies of this
 * projection, so a secret-stripping fix applied to one could silently miss the
 * other. One function now owns the shape both endpoints return.
 */

import type { Tenant } from "../database/entities/Tenant";
import type { BotSettings } from "../database/entities/Bot";
import { resolveDefaultTakeoverHours } from "../services/inbox-prefs.service";

/**
 * Project anchor-bot settings into the client-facing settings object.
 *
 * Tenant retains only `ai.apiKey` (the secret) and the inbox preferences, so
 * both are merged in from `tenant`. The API key itself never leaves the server:
 * it only renders the `hasApiKey` boolean.
 */
export function presentTenantSettings(
  botSettings: BotSettings,
  tenant: Tenant,
): Record<string, any> {
  const settings: Record<string, any> = { ...botSettings };
  settings.inbox = {
    defaultTakeoverHours: resolveDefaultTakeoverHours(
      tenant.settings?.inbox?.defaultTakeoverHours,
    ),
  };
  if (settings.ai) {
    const tenantApiKey = tenant.settings?.ai?.apiKey;
    // Defensive: bot.settings.ai shouldn't carry apiKey, but strip it anyway.
    const { apiKey: _stale, ...aiRest } = settings.ai as { apiKey?: string };
    settings.ai = { ...aiRest, hasApiKey: !!tenantApiKey };
  }
  if (settings.integrations?.calcom) {
    const { apiKey, ...calcomRest } = settings.integrations.calcom;
    settings.integrations = {
      ...settings.integrations,
      calcom: { ...calcomRest, hasApiKey: !!apiKey },
    };
  }
  return settings;
}
