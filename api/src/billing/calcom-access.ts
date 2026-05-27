/**
 * Cal.com access helper — the single chokepoint for "is Cal.com usable for
 * this bot right now?". Returns null in three cases:
 *
 *   1. The tenant's tier lacks the `calendarIntegrations` entitlement
 *   2. No API key stored on the bot
 *   3. No event type selected on the bot
 *
 * Stored creds are treated as inert config that re-activates on upgrade,
 * so downgrades work cleanly without a cleanup step. Callers (outbound n8n
 * payload builder, in-house tool registry, future consumers) all route
 * through this — they never re-derive the gate themselves.
 *
 * The write endpoint uses `requireFeature(tenantId, 'calendarIntegrations',
 * …)` from `enforce.ts` to throw 402 before storing creds.
 */

import type { BotSettings } from '../database/entities/Bot';
import type { TenantTier } from '../database/entities/Tenant';
import { entitlementsFor } from './entitlements';

export type CalcomIntegrationConfig = NonNullable<
  NonNullable<BotSettings['integrations']>['calcom']
>;

export function isCalcomAvailableForTier(tier: TenantTier | null | undefined): boolean {
  if (!tier) return false;
  // Pass null overrides — calendarIntegrations is a pure feature flag, not
  // capacity-bound, so the per-tenant overrides don't matter here.
  // Unknown tiers (e.g. a malformed DB row) fail closed rather than crashing
  // the message-forwarding hot path.
  try {
    return entitlementsFor(tier, { maxSessions: null, dailyLlmCallLimit: null })
      .features.calendarIntegrations;
  } catch {
    return false;
  }
}

export function getCalcomIntegrationForBot(
  botSettings: BotSettings,
  tier: TenantTier | null | undefined,
): CalcomIntegrationConfig | null {
  if (!isCalcomAvailableForTier(tier)) return null;
  const calcom = botSettings.integrations?.calcom;
  if (!calcom?.apiKey || !calcom?.eventTypeId) return null;
  return calcom;
}
