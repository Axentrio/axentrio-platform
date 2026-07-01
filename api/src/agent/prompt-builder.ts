import { Tenant } from '../database/entities/Tenant';
import type { BotSettings } from '../database/entities/Bot';
import { ToolAdapter } from './tool-adapter';
import { composeSystemPrompt, type SkillConfig } from '../llm/compose-system-prompt';
import type { BlockLedger } from '../llm/block-ledger';
import type { ResolvedSpecialty } from '../llm/specialty-catalog';

export class PromptBuilder {
  /**
   * Multi-bot Phase 4 (#16d): brand voice, guardrails, and skills now live on
   * Bot.settings (not Tenant.settings). Caller resolves the bot config via the
   * bot-config.service and passes the settings slice in. Tenant still flows
   * through for `tenant.name` (the fallback brand name) and tenant-wide
   * substitution variables.
   *
   * Composition itself lives in compose-system-prompt.ts — this is a thin
   * adapter onto the agent mode of the single composer.
   */
  build(
    tenant: Tenant,
    botSettings: BotSettings,
    tools: ToolAdapter[],
    kbContext?: string,
    moduleSections?: string[],
    customerName?: string,
    templateBody?: string,
    timezone?: string,
    bookingConfigured?: boolean,
    channel?: string,
    specialties?: ResolvedSpecialty[],
    authoredModules?: { id: string; prose: string }[]
  ): { prompt: string; ledger: BlockLedger } {
    return composeSystemPrompt({
      mode: 'agent',
      ai: botSettings.ai,
      tenantName: tenant.name,
      tier: tenant.tier,
      specialties,
      tools,
      skills: (botSettings.skills as SkillConfig[]) || [],
      kbContext,
      moduleSections,
      authoredModules,
      customerName,
      templateBody,
      timezone,
      bookingConfigured,
      channel,
    });
  }
}
