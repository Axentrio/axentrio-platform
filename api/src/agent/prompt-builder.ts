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
    skillProse?: { id: string; prose: string }[],
    /** Live values for the {services} / {openingHours} / {serviceArea} placeholders.
     *  `services` is only substituted when the bot can actually book; the other two are
     *  business facts and always are. `venueLine` is the formatted venue address (when
     *  a premises is configured): the spoken ## OUR ADDRESS fact and the come-in-person invite.
     *  `hasTravelServices` selects the travel-caveat wording of that address block. */
    liveFields?: { services?: string; openingHours?: string; serviceArea?: string; venueLine?: string; hasTravelServices?: boolean },
    /** Per-turn runtime decisions the composer must not make for itself. */
    runtime?: { proactiveAsk?: boolean; outsideBusinessHours?: boolean }
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
      skillProse,
      customerName,
      templateBody,
      timezone,
      bookingConfigured,
      bookingServices: liveFields?.services,
      openingHours: liveFields?.openingHours,
      serviceArea: liveFields?.serviceArea,
      venueLine: liveFields?.venueLine,
      quotedAddressEnabled: botSettings.quotedAddress?.enabled !== false,
      hasTravelServices: liveFields?.hasTravelServices,
      channel,
      proactiveAsk: runtime?.proactiveAsk,
      outsideBusinessHours: runtime?.outsideBusinessHours,
    });
  }
}
