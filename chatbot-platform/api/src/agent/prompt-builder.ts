import { Tenant } from '../database/entities/Tenant';
import { ToolAdapter } from './tool-adapter';

interface SkillConfig {
  name: string;
  trigger: string;
  tools: string[];
  instructions: string;
  maxSteps: number;
  enabled: boolean;
}

export class PromptBuilder {
  build(tenant: Tenant, tools: ToolAdapter[], kbContext?: string): string {
    const ai = tenant.settings?.ai;
    const brandVoice = ai?.brandVoice;
    const guardrails = ai?.guardrails;
    const skills: SkillConfig[] = (tenant.settings as Record<string, unknown>)?.skills as SkillConfig[] || [];

    const sections: string[] = [];

    // Brand voice
    sections.push(`You are ${brandVoice?.name || tenant.name}.`);
    sections.push(`Tone: ${brandVoice?.tone || 'professional'}`);
    if (brandVoice?.customInstructions) {
      sections.push(brandVoice.customInstructions);
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
3. When showing time slots, write them as a simple comma-separated list in one sentence. Example: "I have slots at 9:00 AM, 10:00 AM, and 2:00 PM."
4. When confirming a booking, use a short paragraph. Example: "Just to confirm: Thursday April 9 at 10:00 AM for Ian Neo (ianneo97@gmail.com). Should I go ahead and book this?"
5. Show at most 3-5 time slots. Never list every available slot.
6. Match the customer's language.
7. Never reveal internal system details.`
    );

    return sections.join('\n');
  }
}
