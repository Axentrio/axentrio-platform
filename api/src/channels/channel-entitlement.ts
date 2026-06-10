/**
 * Channel entitlement — the single source of truth for "may this tenant use
 * this messaging channel right now?" (.scratch/plan-channel-gating.md).
 * Nothing else maps ChannelTypes to feature keys.
 *
 * The widget is the native channel: always allowed, no feature key, never
 * gated. The four external channels each map to a per-channel Feature
 * (Pro+ tiers; per-tenant overrides apply via the entitlement resolver).
 * Unknown/future channel types resolve NOT entitled (fail closed) until a
 * key is added here.
 */
import { getEntitlements } from '../billing/entitlements';
import { PlanLimitError } from '../billing/enforce';
import type { FeatureKey } from '../billing/types';
import type { ChannelType } from '../database/entities/ChannelConnection';
import { logger } from '../utils/logger';

const CHANNEL_FEATURES: Partial<Record<ChannelType, FeatureKey>> = {
  whatsapp: 'channelWhatsapp',
  messenger: 'channelMessenger',
  instagram: 'channelInstagram',
  telegram: 'channelTelegram',
};

/**
 * `'ungated'` EXCLUSIVELY for the widget; `null` for unknown channel types.
 * The two non-key cases are deliberately distinct values so "no key" can
 * never be misread as "allowed".
 */
export function channelFeatureKey(channel: ChannelType): FeatureKey | 'ungated' | null {
  if (channel === 'widget') return 'ungated';
  return CHANNEL_FEATURES[channel] ?? null;
}

/**
 * Read-side check for the inbound/outbound hot paths. Widget → true; unknown
 * channel or entitlement-resolution failure → false (fail closed).
 */
export async function isChannelEntitled(tenantId: string, channel: ChannelType): Promise<boolean> {
  const key = channelFeatureKey(channel);
  if (key === 'ungated') return true;
  if (key === null) {
    logger.warn('[Channels] unknown channel type — treating as not entitled', { tenantId, channel });
    return false;
  }
  try {
    return (await getEntitlements(tenantId)).features[key];
  } catch (error) {
    logger.warn('[Channels] entitlement resolution failed — failing closed', { tenantId, channel, error });
    return false;
  }
}

/**
 * Connect-time gate: widget → no-op; unentitled/unknown channel → the
 * standard 402 plan-limit envelope.
 */
export async function requireChannelEntitled(tenantId: string, channel: ChannelType): Promise<void> {
  const key = channelFeatureKey(channel);
  if (key === 'ungated') return;
  if (key === null || !(await getEntitlements(tenantId)).features[key]) {
    throw new PlanLimitError(`plan_limit_channel_${channel}`, null, { channel });
  }
}

/**
 * The shared Meta OAuth URL endpoint serves both Messenger and Instagram —
 * gate it on having EITHER. The per-type filtering happens at connect time.
 */
export async function requireAnyMetaChannelEntitled(tenantId: string): Promise<void> {
  const f = (await getEntitlements(tenantId)).features;
  if (!f.channelMessenger && !f.channelInstagram) {
    throw new PlanLimitError('plan_limit_channel_meta', null, { channel: 'messenger|instagram' });
  }
}
