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
import { CalendarCredential } from '../../database/entities/CalendarCredential';
import type { CopilotTool, CopilotToolContext } from './types';

export type IntegrationConnectionStatus = 'connected' | 'not_connected';

/**
 * Google Calendar has a third state the others don't: linked, but the token is
 * dead (revoked, or expired under OAuth Testing mode). "Reconnect" and "connect"
 * are different jobs for the owner, and collapsing them sends someone through a
 * first-time setup they already did.
 */
export type CalendarConnectionStatus =
  | 'connected'
  | 'not_connected'
  | 'needs_reconnect';

export interface IntegrationsStatusResult {
  calcom: IntegrationConnectionStatus;
  /** Booking calendar for the anchor bot. Separate from calcom — a tenant can
   *  use either, and answering about one when asked about the other is wrong. */
  googleCalendar: CalendarConnectionStatus;
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
    'Return connection status for Cal.com, Google Calendar, and each social channel (facebook, instagram, telegram, whatsapp). Social + Cal.com values are "connected" or "not_connected". googleCalendar is "connected", "not_connected", or "needs_reconnect" (linked but the token died — tell them to RECONNECT, not to set it up from scratch). Cal.com and Google Calendar are DIFFERENT products: never answer about one when asked about the other. This tool knows nothing about Outlook. No API keys, no webhook secrets, no platform account IDs.',
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

    // Read the stored credential directly rather than calling getGoogleStatus:
    // that handler actively probes Google to refresh a stale token, which is the
    // right thing on a settings screen but not inside a chat turn — a slow or
    // failing Google would stall the Copilot's reply. `reauthRequired` is already
    // persisted by the booking/availability path, so a dead link still surfaces.
    let googleCalendar: CalendarConnectionStatus = 'not_connected';
    if (bot) {
      // Mirrors getActiveCredential() — status:'active' matters, since a
      // disconnected row is retained but must read as not_connected.
      const cred = await ctx.manager.findOne(CalendarCredential, {
        where: { botId: bot.id, provider: 'google', status: 'active' },
        select: ['id', 'reauthRequired'],
      });
      if (cred) googleCalendar = cred.reauthRequired ? 'needs_reconnect' : 'connected';
    }

    return { calcom, googleCalendar, channels };
  },
};
