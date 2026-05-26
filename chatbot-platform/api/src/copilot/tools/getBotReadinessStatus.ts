/**
 * Copilot tool: getBotReadinessStatus
 *
 * Returns four booleans describing whether the tenant's anchor bot is
 * "ready to chat with visitors." Drives answers like:
 *   - "Is my bot configured?"
 *   - "Why isn't my bot replying?" — combined with getIntegrationsStatus
 *
 * Returns BOOLEANS ONLY — no brand voice text, no custom instructions,
 * no fallback messages, no model identifiers. The bot's prompt content
 * is hidden (per invariant #8: `Bot.settings.ai.brandVoice.customInstructions`
 * is system-prompt-adjacent and not leaked to Copilot).
 */
import { IsNull } from 'typeorm';
import { Bot } from '../../database/entities/Bot';
import { Tenant } from '../../database/entities/Tenant';
import type { CopilotTool, CopilotToolContext } from './types';

export interface BotReadinessStatusResult {
  aiEnabled: boolean;
  hasWebhook: boolean;
  brandVoiceConfigured: boolean;
  embedSnippetReady: boolean;
}

export const getBotReadinessStatus: CopilotTool<
  Record<string, never>,
  BotReadinessStatusResult
> = {
  name: 'getBotReadinessStatus',
  description:
    'Return four booleans describing whether the tenant\'s anchor bot is ready: aiEnabled, hasWebhook (n8n outbound configured), brandVoiceConfigured, embedSnippetReady. No free-text fields — booleans only.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args, ctx: CopilotToolContext): Promise<BotReadinessStatusResult> {
    const [tenant, bot] = await Promise.all([
      ctx.manager.findOne(Tenant, {
        where: { id: ctx.tenantId },
        select: ['id', 'webhookUrl'],
      }),
      ctx.manager.findOne(Bot, {
        where: { tenantId: ctx.tenantId, isDefault: true, deletedAt: IsNull() },
        select: ['id', 'publicKey', 'settings'],
      }),
    ]);

    if (!tenant) {
      throw new Error(`getBotReadinessStatus: tenant ${ctx.tenantId} not found`);
    }

    // hasWebhook is a tenant-level fact, independent of bot anchor state.
    const hasWebhook =
      typeof tenant.webhookUrl === 'string' && tenant.webhookUrl.trim().length > 0;

    if (!bot) {
      // Bot-dependent fields are false; the tenant-level webhook bit
      // still reflects reality so an admin investigating "why no bot"
      // sees their webhook config is fine.
      return {
        aiEnabled: false,
        hasWebhook,
        brandVoiceConfigured: false,
        embedSnippetReady: false,
      };
    }

    const ai = bot.settings?.ai;
    const brandVoice = ai?.brandVoice;

    return {
      aiEnabled: ai?.enabled === true,
      hasWebhook,
      brandVoiceConfigured:
        typeof brandVoice?.name === 'string' &&
        brandVoice.name.trim().length > 0 &&
        typeof brandVoice?.tone === 'string' &&
        brandVoice.tone.trim().length > 0,
      embedSnippetReady: typeof bot.publicKey === 'string' && bot.publicKey.length > 0,
    };
  },
};
