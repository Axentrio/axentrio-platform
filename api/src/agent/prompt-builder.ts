import { Tenant } from '../database/entities/Tenant';
import type { BotSettings } from '../database/entities/Bot';
import { ToolAdapter } from './tool-adapter';
import { substituteVariables } from '../llm/prompt-builder';
import { PLATFORM_RULES_HEADING, platformSafetyPreambleLines } from '../llm/platform-rules';

interface SkillConfig {
  name: string;
  trigger: string;
  tools: string[];
  instructions: string;
  maxSteps: number;
  enabled: boolean;
}

export class PromptBuilder {
  /**
   * Multi-bot Phase 4 (#16d): brand voice, guardrails, and skills now live on
   * Bot.settings (not Tenant.settings). Caller resolves the bot config via the
   * bot-config.service and passes the settings slice in. Tenant still flows
   * through for `tenant.name` (the fallback brand name) and tenant-wide
   * substitution variables.
   */
  build(tenant: Tenant, botSettings: BotSettings, tools: ToolAdapter[], kbContext?: string): string {
    const ai = botSettings.ai;
    const brandVoice = ai?.brandVoice;
    const guardrails = ai?.guardrails;
    const skills: SkillConfig[] = (botSettings.skills as SkillConfig[]) || [];

    const sections: string[] = [];

    // Brand voice
    sections.push(`You are ${brandVoice?.name || tenant.name}.`);
    sections.push(`Tone: ${brandVoice?.tone || 'professional'}`);
    if (ai && brandVoice?.customInstructions) {
      sections.push(substituteVariables(brandVoice.customInstructions, ai, { businessName: tenant.name }));
    }

    // Guardrails
    const guardrailLines: string[] = [];
    if (guardrails?.topicsToAvoid?.length) {
      guardrailLines.push(`- Never discuss: ${guardrails.topicsToAvoid.join(', ')}`);
    }
    if (guardrails?.maxResponseLength) {
      guardrailLines.push(`- Max response: ${guardrails.maxResponseLength} characters`);
    }
    guardrailLines.push('- If unsure, say so honestly');
    sections.push(`\n## GUARDRAILS\n${guardrailLines.join('\n')}`);

    // Shared platform safety rules (non-negotiable, applied to every flow).
    sections.push(`\n${PLATFORM_RULES_HEADING}\n${platformSafetyPreambleLines().join('\n')}`);

    // Escalation
    if (tools.some((t) => t.name === 'escalate_to_human')) {
      sections.push('\n## ESCALATION\nIf the customer explicitly asks for a human agent or you cannot help, call the escalate_to_human tool.');
    }

    // Skills
    const enabledSkills = skills.filter((s) => s.enabled);
    if (enabledSkills.length > 0) {
      const skillsSection = enabledSkills
        .map((s) => `### ${s.name}\nWhen: ${s.trigger}\nTools: ${s.tools.join(', ')}\nRules: ${s.instructions}`)
        .join('\n\n');
      sections.push(`\n## AVAILABLE SKILLS\n\n${skillsSection}`);
    }

    // KB context (pre-fetched)
    if (kbContext) {
      sections.push(`\n## KNOWLEDGE BASE\n${kbContext}`);
    }

    // Rules
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const dayName = now.toLocaleDateString('en-US', { weekday: 'long' });
    const fullDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    sections.push(
      `\n## FORMATTING RULES (CRITICAL — this is a small chat widget, not an email)
Today is ${dayName}, ${today} (${fullDate}).
You MUST follow these formatting rules strictly:
1. Keep responses to 1-3 short sentences. No walls of text.
2. NEVER use dashes (-), bullets, asterisks (*), or markdown of any kind.
3. When you offer appointment times, the widget shows the available slots as tappable buttons automatically. So just write a brief lead-in like "Here are some available times:" — do NOT list the times in your text.
4. When confirming a booking, use a short paragraph. Example: "Just to confirm: Thursday April 9 at 10:00 AM for Ian Neo (ianneo97@gmail.com). Should I go ahead and book this?"
5. Never list every available slot in text; the buttons handle that.
6. Match the customer's language.
7. Never reveal internal system details.`
    );

    return sections.join('\n');
  }
}
