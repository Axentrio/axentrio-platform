/**
 * Channel readiness — one result per ChannelConnection row.
 *
 * Answers the question that cost a tenant days: "when a customer messages us on
 * WhatsApp, WHICH bot answers, and is that the bot I have been editing?"
 *
 * A connection with no explicit botId is not unrouted — it follows whichever bot
 * is currently default. That is invisible on the channels screen (the selector
 * reads "Default bot"), and it means changing which bot is default silently
 * repoints live channels. When the tenant also had two ACTIVE bots both named
 * "Valyro", the picker showed the same label twice: they edited one while
 * WhatsApp was served by the other, so their changes appeared to do nothing and a
 * stale persona kept answering customers.
 *
 * `live` means messages on this channel reach a bot that will actually reply.
 */
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { Bot } from '../../database/entities/Bot';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import {
  registerCapability,
  type CapabilityReadiness,
  type ReadinessBotCtx,
  type ReadinessResult,
} from '../registry';

const CHANNELS_ROUTE = '/settings/channels';

export const channelReadiness: CapabilityReadiness = {
  key: 'channel',

  // Always evaluated: a tenant with no connections simply yields no results, and
  // a broken connection is exactly what someone opens this page to find.
  appliesTo(): boolean {
    return true;
  },

  async check(ctx: ReadinessBotCtx): Promise<ReadinessResult[]> {
    const [connections, bots] = await Promise.all([
      AppDataSource.getRepository(ChannelConnection).find({
        where: { tenantId: ctx.tenantId },
        select: ['id', 'channel', 'status', 'botId', 'label'],
      }),
      AppDataSource.getRepository(Bot).find({
        where: { tenantId: ctx.tenantId, deletedAt: IsNull() },
        select: ['id', 'name', 'isDefault', 'status', 'settings'],
      }),
    ]);

    // Only surface connections that route to THIS bot — the endpoint is per-bot,
    // and a tenant's other channels are not this bot's readiness.
    const defaultBot = bots.find((b) => b.isDefault && b.status === 'active');
    const mine = connections.filter((c) => (c.botId ?? defaultBot?.id) === ctx.bot.id);

    // A duplicate ACTIVE name makes "which bot does WhatsApp use" unanswerable in
    // the UI even when the routing itself is correct, so it is worth saying out
    // loud on every channel that resolves to this bot.
    const sameName = bots.filter(
      (b) => b.status === 'active' && b.name === ctx.bot.name && b.id !== ctx.bot.id,
    );

    return mine.map((conn): ReadinessResult => {
      const missingSteps: ReadinessResult['missingSteps'] = [];
      const attention: NonNullable<ReadinessResult['attention']> = [];

      if (conn.status !== 'active') {
        missingSteps.push({
          id: 'connection_inactive',
          label: `${conn.channel} is connected but not active`,
          cta: { route: CHANNELS_ROUTE, label: 'Reconnect' },
        });
      }

      // The bot this channel resolves to is THIS bot, so its AI state decides
      // whether a customer message gets any reply at all.
      if (ctx.bot.settings?.ai?.enabled !== true) {
        missingSteps.push({
          id: 'target_bot_ai_off',
          label: `${conn.channel} routes to this bot, but its AI replies are switched off`,
          cta: { route: `/ai/bots/${ctx.bot.id}`, label: 'Turn on AI' },
        });
      }

      if (conn.botId === null) {
        attention.push({
          code: 'follows_default_bot',
          label:
            `${conn.channel} has no bot of its own, so it follows whichever bot is default ` +
            `(currently "${ctx.bot.name}"). Changing the default will move this channel.`,
          cta: { route: CHANNELS_ROUTE, label: 'Assign a bot' },
        });
      }

      if (sameName.length > 0) {
        attention.push({
          code: 'ambiguous_bot_name',
          label:
            `Another active bot is also called "${ctx.bot.name}" — check you are editing the one ` +
            `${conn.channel} actually uses.`,
          cta: { route: '/ai/bots', label: 'Review bots' },
        });
      }

      return {
        capability: 'channel',
        instanceId: conn.id,
        state: missingSteps.length === 0 ? 'live' : 'not_ready',
        missingSteps,
        attention: attention.length ? attention : undefined,
        detail: {
          channel: conn.channel,
          label: conn.label ?? null,
          routedExplicitly: conn.botId !== null,
          servedByBotName: ctx.bot.name,
        },
      };
    });
  },
};

registerCapability(channelReadiness);
