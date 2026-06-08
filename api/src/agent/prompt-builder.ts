import { Tenant } from '../database/entities/Tenant';
import type { BotSettings } from '../database/entities/Bot';
import type { ServiceType, IntakeQuestion } from '../database/entities/ServiceType';
import { ToolAdapter } from './tool-adapter';

/** Human price hint for the service catalog (prices are populated in a later slice). */
function priceHint(s: ServiceType): string {
  switch (s.priceDisplayType) {
    case 'fixed':
      return s.fixedPrice ? `€${s.fixedPrice}` : '';
    case 'from':
      return s.fixedPrice ? `from €${s.fixedPrice}` : '';
    case 'range':
      return s.minPrice && s.maxPrice ? `€${s.minPrice}–€${s.maxPrice}` : '';
    case 'on_request':
      return 'price on request';
    default:
      return '';
  }
}

/** One-line hygiene for owner text in the prompt: collapse whitespace → drop `·`/`"` → trim. */
function sanitizeForLine(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[·"]/g, '').trim();
}

/** Indented `Intake questions:` sub-block for a service, in array order (≤8 short lines). */
function intakeLines(s: ServiceType): string {
  const questions = Array.isArray(s.intakeQuestions) ? s.intakeQuestions : [];
  const lines = questions
    // Defensive: skip malformed entries (legacy/hand-edited jsonb) so a non-string
    // id/label/option can never reach `.replace()` and crash prompt construction.
    .filter(
      (q): q is IntakeQuestion =>
        !!q && typeof q.id === 'string' && typeof q.label === 'string' && (q.type === 'text' || q.type === 'choice')
    )
    .map((q) => {
      const label = sanitizeForLine(q.label);
      const req = q.required ? 'required' : 'optional';
      const validOptions =
        q.type === 'choice' && Array.isArray(q.options)
          ? q.options.filter((o): o is string => typeof o === 'string')
          : [];
      const opts = validOptions.length ? ` · options: ${validOptions.map(sanitizeForLine).join(', ')}` : '';
      return `    - ${q.id} · "${label}" · ${q.type} · ${req}${opts}`;
    });
  if (!lines.length) return '';
  return `\n  Intake questions:\n${lines.join('\n')}`;
}
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
  build(
    tenant: Tenant,
    botSettings: BotSettings,
    tools: ToolAdapter[],
    kbContext?: string,
    services?: ServiceType[]
  ): string {
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

    // Bookable services catalog (multi-service). Only when booking is configured.
    if (services && services.length) {
      const lines = services
        .map((s) => {
          const price = priceHint(s);
          const mode = s.bookingMode === 'request' ? 'request-only' : 'auto-book';
          // P5a: customerLocationRequired maps to PHONE (callback number), not address.
          const contact = [s.customerAddressRequired ? 'needs address' : '', s.customerLocationRequired ? 'needs phone' : '']
            .filter(Boolean)
            .join(' · ');
          // P5c: show the duration RANGE for range/ai services (the agent passes durationMin).
          const isRange =
            (s.durationMode === 'range' || s.durationMode === 'ai') &&
            typeof s.minDurationMin === 'number' &&
            typeof s.maxDurationMin === 'number' &&
            s.minDurationMin > 0 &&
            s.maxDurationMin >= s.minDurationMin;
          const durationLabel = isRange
            ? `${s.minDurationMin}-${s.maxDurationMin} min (${s.durationMode === 'ai' ? 'AI-estimated' : 'choose length'})`
            : `${s.durationMin} min`;
          const head = `- ${s.id} · ${s.name}${s.category ? ` (${s.category})` : ''} · ${durationLabel} · ${mode}${price ? ` · ${price}` : ''}${contact ? ` · ${contact}` : ''}`;
          return `${head}${intakeLines(s)}`;
        })
        .join('\n');
      // Only inject the ask-intake rule when a service actually renders questions
      // (a service whose questions are all malformed produces no lines → no dangling rule).
      const hasIntake = services.some((s) => intakeLines(s) !== '');
      const hasContact = services.some((s) => s.customerAddressRequired || s.customerLocationRequired);
      const hasCapacity = services.some((s) => typeof s.maxBookingsPerDay === 'number' && s.maxBookingsPerDay > 0);
      const hasDuration = services.some((s) => s.durationMode === 'range' || s.durationMode === 'ai');
      const hasOnRequestPrice = services.some((s) => s.priceDisplayType === 'on_request');
      sections.push(
        `\n## SERVICES (bookable)
When the customer wants to book, identify which service they mean and pass its id as serviceId. Use the SAME service whose availability you checked. Follow these rules IN ORDER:
1. If their request matches no service or is ambiguous, ask a disambiguating question FIRST — do not confirm and do not capture a request until you know the service. Never guess.
2. Once the service is known: use create_booking (auto-confirm) ONLY for an "auto-book" service when the customer has chosen an available time you checked.
3. Otherwise use request_appointment (and tell the customer it is a request the business owner will review — not a confirmation): when the service is "request-only", the scope/duration is unclear, the job sounds complex/urgent/risky, or you are otherwise not confident you can safely confirm. Never invent a confirmation.${
          hasIntake
            ? `
4. If the chosen service lists "Intake questions", ask any required question the customer hasn't already answered before calling the booking tool (you may ask optional ones too, but never block the booking on them). Pass every answer you have in the tool's intakeAnswers object, keyed by the question id shown before each question. If a booking tool returns an error, fix it and re-call the tool, re-including the answers you already collected.`
            : ''
        }${
          hasContact
            ? `
5. If the chosen service is flagged "needs address" and/or "needs phone", ask for it before booking or capturing the request, and pass it as customerAddress / customerPhone. If a booking tool returns ADDRESS_REQUIRED or PHONE_REQUIRED, ask for the missing detail and re-call the tool with it.`
            : ''
        }${
          hasCapacity
            ? `
6. If create_booking returns CAPACITY_REACHED, that service is fully booked for that day — offer the customer the next available day instead; do not retry the same day.`
            : ''
        }${
          hasDuration
            ? `
7. For a service shown with a duration RANGE (e.g. "30-90 min"), establish the length FIRST — ask the customer how long they need ("choose length"), or estimate it from the conversation ("AI-estimated") — then pass that as durationMin to check_availability AND the booking tool (same value). If a tool returns DURATION_OUT_OF_RANGE, pick a length within the shown range. If create_booking returns SLOT_UNAVAILABLE for a range service, the chosen length didn't fit that start — offer a different start or a shorter length within range; don't retry the same start+length.`
            : ''
        }
- Price: if asked, you may state the price shown on a service line (e.g. "€25", "from €80"); NEVER invent or guess a number. A service whose price is not shown has no fixed price to quote.${
          hasOnRequestPrice
            ? ' For a service priced "on request", do not quote a number — capture the job via request_appointment so the owner can quote.'
            : ''
        }
${lines}`
      );
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
