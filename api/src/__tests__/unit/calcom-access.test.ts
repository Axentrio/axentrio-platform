/**
 * Cal.com access helper — pure unit tests.
 *
 * The helper is the single chokepoint for "is Cal.com usable for this bot
 * right now?". It's used by the n8n outbound payload builder, the in-house
 * tool registry, and (transitively, via `requireFeature`) the write
 * endpoints — so its three-way return contract must stay locked.
 */

import { describe, it, expect } from 'vitest';
import {
  getCalcomIntegrationForBot,
  isCalcomAvailableForTier,
} from '../../billing/calcom-access';
import type { BotSettings } from '../../database/entities/Bot';

function botWithCalcom(calcom: Partial<NonNullable<BotSettings['integrations']>['calcom']>): BotSettings {
  return { integrations: { calcom: { ...calcom } } } as BotSettings;
}

const EMPTY_BOT: BotSettings = {} as BotSettings;
const FULL_CREDS = { apiKey: 'cal_live_xxx', eventTypeId: 42 };

describe('isCalcomAvailableForTier', () => {
  it('returns false for the cancellation-sink and entry tiers', () => {
    expect(isCalcomAvailableForTier('free')).toBe(false);
    expect(isCalcomAvailableForTier('essential')).toBe(false);
  });

  it('returns true for the paid tiers that include calendar integrations', () => {
    expect(isCalcomAvailableForTier('pro')).toBe(true);
    expect(isCalcomAvailableForTier('enterprise')).toBe(true);
  });
});

describe('getCalcomIntegrationForBot', () => {
  it('returns null when the tier lacks the entitlement, even with full creds', () => {
    expect(getCalcomIntegrationForBot(botWithCalcom(FULL_CREDS), 'essential')).toBeNull();
    expect(getCalcomIntegrationForBot(botWithCalcom(FULL_CREDS), 'free')).toBeNull();
  });

  it('returns null when the entitlement is present but creds are missing', () => {
    expect(getCalcomIntegrationForBot(EMPTY_BOT, 'pro')).toBeNull();
    expect(getCalcomIntegrationForBot(botWithCalcom({ apiKey: 'cal_live_xxx' }), 'pro')).toBeNull();
    expect(getCalcomIntegrationForBot(botWithCalcom({ eventTypeId: 42 }), 'pro')).toBeNull();
  });

  it('returns the integration config when entitled and fully configured', () => {
    const result = getCalcomIntegrationForBot(botWithCalcom(FULL_CREDS), 'pro');
    expect(result).not.toBeNull();
    expect(result?.apiKey).toBe('cal_live_xxx');
    expect(result?.eventTypeId).toBe(42);
  });

  it('strips Cal.com on the downgrade path (treats stored creds as inert)', () => {
    // Tenant configured Cal.com while Pro, then downgraded to Essential. The
    // stored creds are still in DB but the helper must report null so the
    // outbound payload + tool registry both stop emitting Cal.com.
    expect(getCalcomIntegrationForBot(botWithCalcom(FULL_CREDS), 'essential')).toBeNull();
  });
});
