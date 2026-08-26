/**
 * Copilot tool: getIntegrationsStatus
 *
 * Returns the connection status of the anchor bot's booking calendar and its
 * social/messaging channels.
 *
 * Booking runs on the in-house scheduler, which syncs to ONE connected calendar
 * — Google or Microsoft (Outlook). Cal.com is shelved: `booking.service` ignores
 * `integrations.provider` and books internally for every bot, so Cal.com is NOT
 * an integration the copilot reports. Mentioning it would send owners to connect
 * a product the platform no longer books through — the exact wrong-information
 * bug this tool exists to avoid.
 *
 * Channel mapping note: the platform's `ChannelType` uses `messenger` for
 * Facebook Messenger. The Copilot output exposes it as `facebook` to match how
 * admins talk about it ("I want to connect Facebook").
 */
import { IsNull } from 'typeorm';
import { Bot } from '../../database/entities/Bot';
import {
  ChannelConnection,
  type ChannelType,
} from '../../database/entities/ChannelConnection';
import {
  CalendarCredential,
  type CalendarProviderType,
} from '../../database/entities/CalendarCredential';
import type { CopilotTool, CopilotToolContext } from './types';

export type IntegrationConnectionStatus = 'connected' | 'not_connected';

/**
 * The booking calendar has a third state the channels don't: linked, but the
 * token is dead (revoked, or expired under OAuth Testing mode). "Reconnect" and
 * "connect" are different jobs for the owner, and collapsing them sends someone
 * through a first-time setup they already did.
 */
export type CalendarConnectionStatus = 'connected' | 'not_connected' | 'needs_reconnect';

export interface IntegrationsStatusResult {
  /**
   * The booking calendar linked to the anchor bot. Booking runs on the in-house
   * scheduler, which syncs to ONE calendar: `provider` says which product it is
   * (Google or Microsoft/Outlook), or null when none is linked. A bot uses one
   * or the other, never both.
   */
  calendar: {
    provider: CalendarProviderType | null;
    status: CalendarConnectionStatus;
  };
  channels: {
    facebook: IntegrationConnectionStatus;
    instagram: IntegrationConnectionStatus;
    telegram: IntegrationConnectionStatus;
    whatsapp: IntegrationConnectionStatus;
  };
}

const COPILOT_CHANNEL_BY_ENUM: Partial<
  Record<ChannelType, keyof IntegrationsStatusResult['channels']>
> = {
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
    'Return connection status for the ANCHOR bot: the booking calendar and each social channel (facebook, instagram, telegram, whatsapp). Bookings run on the in-house scheduler, which syncs to ONE connected calendar — `calendar.provider` is "google", "microsoft" (Microsoft/Outlook), or null (none linked); `calendar.status` is "connected", "not_connected", or "needs_reconnect" (linked but the token died — tell them to RECONNECT, not set up from scratch). A bot uses Google OR Microsoft, never both; never tell someone to connect the other one. The platform does NOT use Cal.com — never mention it. Channel values are "connected" or "not_connected". No API keys, no webhook secrets, no account IDs.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args, ctx: CopilotToolContext): Promise<IntegrationsStatusResult> {
    const [bot, connections] = await Promise.all([
      ctx.manager.findOne(Bot, {
        where: { tenantId: ctx.tenantId, isDefault: true, deletedAt: IsNull() },
        select: ['id'],
      }),
      ctx.manager.find(ChannelConnection, {
        where: { tenantId: ctx.tenantId },
        select: ['id', 'channel', 'status'],
      }),
    ]);

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

    // Read the stored credential directly rather than probing the provider: a
    // slow or failing Google/Microsoft would stall the Copilot's reply.
    // `reauthRequired` is already persisted by the booking/availability path, so
    // a dead link still surfaces. At most one credential is active per bot
    // (unique index on bot_id where status='active'), whichever provider it is.
    let calendar: IntegrationsStatusResult['calendar'] = {
      provider: null,
      status: 'not_connected',
    };
    if (bot) {
      const cred = await ctx.manager.findOne(CalendarCredential, {
        where: { botId: bot.id, status: 'active' },
        select: ['id', 'provider', 'reauthRequired'],
      });
      if (cred) {
        calendar = {
          provider: cred.provider,
          status: cred.reauthRequired ? 'needs_reconnect' : 'connected',
        };
      }
    }

    return { calendar, channels };
  },
};
