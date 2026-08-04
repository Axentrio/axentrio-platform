/**
 * Copilot tool: listBots
 *
 * Every other bot tool inspects the ANCHOR bot only. Asked "which bots do I have
 * and which one does WhatsApp use?", the Copilot answered from
 * getBotReadinessStatus and said "you have one bot" — the tenant had three, two
 * of them sharing a name.
 *
 * That is not a cosmetic miss. A tenant edited one "Valyro" while WhatsApp was
 * served by the other, so their changes appeared to do nothing and a stale
 * persona kept answering customers for days. Which bot a channel routes to is
 * exactly the question that was unanswerable.
 *
 * Returns identity + routing only — no prompt content, no brand voice text, no
 * keys (invariant #8: prompt-adjacent config is never leaked to Copilot).
 */
import { IsNull } from 'typeorm';
import { Bot } from '../../database/entities/Bot';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import type { CopilotTool, CopilotToolContext } from './types';

export interface CopilotBotSummary {
  name: string;
  /** The name this bot introduces itself with, when it differs from `name`.
   *  Null when they match — a bot recorded as "test account" that greets people
   *  as "Luc" is a real and confusing case worth surfacing. */
  introducesItselfAs: string | null;
  isDefault: boolean;
  aiEnabled: boolean;
  /** Channels routed to this bot. A channel with no explicit bot follows the
   *  default one, and is reported here against that default. */
  channels: string[];
}

export interface ListBotsResult {
  bots: CopilotBotSummary[];
  /** True when two or more ACTIVE bots share a name — the condition that makes
   *  "edit the Valyro bot" ambiguous and sends someone to the wrong one. */
  hasDuplicateNames: boolean;
}

export const listBots: CopilotTool<Record<string, never>, ListBotsResult> = {
  name: 'listBots',
  description:
    'List every ACTIVE bot in the workspace with its name, the name it introduces itself with (introducesItselfAs, null when identical), whether it is the default, whether AI is on, and which channels route to it. Use this for ANY question about how many bots there are, which bot serves a channel, or which bot to edit — the other bot tools only ever see the default bot and will undercount. When hasDuplicateNames is true, say so and disambiguate by default/channel, because editing the wrong same-named bot looks like the edit did nothing. Names only — no prompt content, no keys.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args, ctx: CopilotToolContext): Promise<ListBotsResult> {
    const [bots, connections] = await Promise.all([
      ctx.manager.find(Bot, {
        where: { tenantId: ctx.tenantId, status: 'active', deletedAt: IsNull() },
        select: ['id', 'name', 'isDefault', 'settings'],
      }),
      ctx.manager.find(ChannelConnection, {
        where: { tenantId: ctx.tenantId },
        select: ['id', 'channel', 'status', 'botId'],
      }),
    ]);

    const defaultBot = bots.find((b) => b.isDefault);
    const channelsByBot = new Map<string, string[]>();
    for (const c of connections) {
      if (c.status !== 'active') continue;
      // A null botId is not "unrouted" — it silently follows whichever bot is
      // currently default, which is why changing the default moves live channels.
      const target = c.botId ?? defaultBot?.id;
      if (!target) continue;
      channelsByBot.set(target, [...(channelsByBot.get(target) ?? []), c.channel]);
    }

    const summaries = bots.map((b) => {
      const persona = b.settings?.ai?.brandVoice?.name ?? null;
      return {
        name: b.name,
        introducesItselfAs: persona && persona !== b.name ? persona : null,
        isDefault: b.isDefault,
        aiEnabled: b.settings?.ai?.enabled === true,
        channels: channelsByBot.get(b.id) ?? [],
      };
    });

    const seen = new Set<string>();
    const hasDuplicateNames = summaries.some((s) =>
      seen.size === seen.add(s.name).size,
    );

    return { bots: summaries, hasDuplicateNames };
  },
};
