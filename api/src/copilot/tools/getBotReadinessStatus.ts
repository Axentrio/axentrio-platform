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
  /**
   * TRUE means this tenant is routed down the LEGACY n8n path instead of the
   * built-in agent — an unusual, opt-in state, not a setup step.
   *
   * Was `hasWebhook`, described as "n8n outbound configured". That framing dates
   * from when replies really did leave through a webhook; n8n is retired and the
   * agent answers in-process now. The old name read as missing configuration, and
   * the Copilot told a live tenant "to allow your bot to reply, you will need to
   * set up a webhook" — advice that would have DIVERTED their working bot to the
   * dead workflow (turn-coalescer.ts routes custom-webhook tenants away from
   * runTurn). FALSE is the healthy, normal state.
   */
  usesLegacyWebhookRouting: boolean;
  brandVoiceConfigured: boolean;
  embedSnippetReady: boolean;
}

export const getBotReadinessStatus: CopilotTool<
  Record<string, never>,
  BotReadinessStatusResult
> = {
  name: 'getBotReadinessStatus',
  description:
    "Return four booleans about the tenant's ANCHOR bot only (a tenant may have several bots; this says nothing about the others, and nothing about which bot a channel uses): aiEnabled, usesLegacyWebhookRouting, brandVoiceConfigured, embedSnippetReady. usesLegacyWebhookRouting=false is NORMAL and healthy — it does NOT mean anything is missing, and a webhook is NEVER required for the bot to reply; true means the tenant opted into the retired n8n path instead of the built-in agent. None of these four explain why a bot is not replying: for that, check plan/credits, whether AI is enabled, or hand off to a person. No free-text fields — booleans only.",
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

    // Tenant-level fact, independent of bot anchor state.
    const usesLegacyWebhookRouting =
      typeof tenant.webhookUrl === 'string' && tenant.webhookUrl.trim().length > 0;

    if (!bot) {
      // Bot-dependent fields are false; the tenant-level webhook bit
      // still reflects reality so an admin investigating "why no bot"
      // sees their webhook config is fine.
      return {
        aiEnabled: false,
        usesLegacyWebhookRouting,
        brandVoiceConfigured: false,
        embedSnippetReady: false,
      };
    }

    const ai = bot.settings?.ai;
    const brandVoice = ai?.brandVoice;

    return {
      aiEnabled: ai?.enabled === true,
      usesLegacyWebhookRouting,
      // Tone is now template-owned (admin-controlled) and always resolves to at
      // least the platform default, so readiness only turns on the tenant-owned
      // chatbot name.
      brandVoiceConfigured:
        typeof brandVoice?.name === 'string' && brandVoice.name.trim().length > 0,
      embedSnippetReady: typeof bot.publicKey === 'string' && bot.publicKey.length > 0,
    };
  },
};
