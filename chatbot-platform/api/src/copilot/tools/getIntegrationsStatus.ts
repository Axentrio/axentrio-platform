/**
 * Copilot tool: getIntegrationsStatus
 *
 * Returns the connection status of every integration the tenant could
 * have wired up — Cal.com and the four social/messaging channels.
 *
 * Zero-filled exhaustive: every channel key is always present in the
 * output even when the tenant has no row for it. Saves the LLM from
 * misinterpreting absence as "unknown."
 *
 * Channel mapping note: the platform's `ChannelType` uses `messenger`
 * for Facebook Messenger. The Copilot output exposes it as `facebook`
 * to match how admins talk about it ("I want to connect Facebook").
 */
import { IsNull } from 'typeorm';
import { Bot } from '../../database/entities/Bot';
import {
  ChannelConnection,
  type ChannelType,
} from '../../database/entities/ChannelConnection';
import type { CopilotTool, CopilotToolContext } from './types';

export type IntegrationConnectionStatus = 'connected' | 'not_connected';

export interface IntegrationsStatusResult {
  calcom: IntegrationConnectionStatus;
  channels: {
    facebook: IntegrationConnectionStatus;
    instagram: IntegrationConnectionStatus;
    telegram: IntegrationConnectionStatus;
    whatsapp: IntegrationConnectionStatus;
  };
}

const COPILOT_CHANNEL_BY_ENUM: Partial<Record<ChannelType, keyof IntegrationsStatusResult['channels']>> = {
  messenger: 'facebook',
  instagram: 'instagram',
  telegram: 'telegram',
  whatsapp: 'whatsapp',
};

export const getIntegrationsStatus: CopilotTool<
  Record<string, never>,
  IntegrationsStatusResult
> = {
  name: 'getIntegrationsStatus',
  description:
    'Return connection status for Cal.com and each social channel (facebook, instagram, telegram, whatsapp). Each value is "connected" or "not_connected". No API keys, no webhook secrets, no platform account IDs.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args, ctx: CopilotToolContext): Promise<IntegrationsStatusResult> {
    const [bot, connections] = await Promise.all([
      ctx.manager.findOne(Bot, {
        where: { tenantId: ctx.tenantId, isDefault: true, deletedAt: IsNull() },
        select: ['id', 'settings'],
      }),
      ctx.manager.find(ChannelConnection, {
        where: { tenantId: ctx.tenantId },
        select: ['id', 'channel', 'status'],
      }),
    ]);

    const calcomConfig = bot?.settings?.integrations?.calcom;
    const calcom: IntegrationConnectionStatus =
      typeof calcomConfig?.apiKey === 'string' &&
      calcomConfig.apiKey.length > 0 &&
      typeof calcomConfig?.eventTypeId !== 'undefined' &&
      calcomConfig.eventTypeId !== null
        ? 'connected'
        : 'not_connected';

    const channels: IntegrationsStatusResult['channels'] = {
      facebook: 'not_connected',
      instagram: 'not_connected',
      telegram: 'not_connected',
      whatsapp: 'not_connected',
    };
    for (const c of connections) {
      const key = COPILOT_CHANNEL_BY_ENUM[c.channel];
      if (key && c.status === 'active') {
        channels[key] = 'connected';
      }
    }

    return { calcom, channels };
  },
};
