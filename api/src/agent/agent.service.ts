import crypto from 'crypto';
import { DateTime } from 'luxon';
import { ToolRegistry } from './tool-registry';
import { PromptBuilder } from './prompt-builder';
import { MeteringService } from './metering.service';
import { TraceLogger, AgentTrace } from './trace-logger';
import { ToolContext } from './tool-adapter';
import { getProvider } from '../llm/provider-factory';
import { buildPromptTrace } from '../llm/block-ledger';
import { effectiveSelectedSpecialties, resolveSpecialties, specialtyRetrievalTerms } from '../llm/specialty-catalog';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../llm/defaults';
import { ChatMessage, ContentPart, ToolDefinition } from '../llm/llm.types';
import { ChatSession } from '../database/entities/ChatSession';
import { ConversationBinding } from '../database/entities/ConversationBinding';
import { AvailabilityRule } from '../database/entities/AvailabilityRule';
import { ServiceType } from '../database/entities/ServiceType';
import { Tenant } from '../database/entities/Tenant';
import { AppDataSource } from '../database/data-source';
import { listActiveModules } from '../modules';
import { getModule, gatedToolNames, skillPromptAllowed } from '../modules/module-catalog';
import { resolveSkillStates, dropUnreadySkillTools } from '../modules/skill-state';
import { readinessRefinement } from '../llm/skill-readiness';
import { logger } from '../utils/logger';
import { getLlmRuntimeConfigForSession } from '../services/bot-config.service';
import { resolveBoundTemplates, composeTemplateBodies, effectiveConfigFromList, withEffectiveConfig, templateUnavailabilityReason, selectSkillIds } from '../templates/template-resolver';
import { isBookingConfigured } from '../scheduler/booking-readiness';

/** A tappable suggestion rendered by the widget (e.g. an appointment slot). */
export interface QuickReply {
  title: string;
  value: string;
}

export type AgentResult =
  | { type: 'response'; content: string; quickReplies?: QuickReply[] }
  | { type: 'awaiting_confirmation'; toolCallId: string; toolName: string; preview: Record<string, unknown>; message: string }
  | { type: 'max_iterations'; fallbackMessage: string }
  | { type: 'budget_exceeded'; fallbackMessage: string }
  | { type: 'error'; error: string; fallbackMessage: string };

const MAX_ITERATIONS = 10;

/** An image attached to the live user turn, already fetched + base64-encoded. */
export interface AgentImageInput {
  mimeType: string;
  data: string;
}

/** Build the live user turn — multimodal when images are attached, plain string
 *  otherwise (so the common text path is unchanged). */
function buildUserContent(message: string, images?: AgentImageInput[]): string | ContentPart[] {
  if (!images || images.length === 0) return message;
  const parts: ContentPart[] = [];
  if (message) parts.push({ type: 'text', text: message });
  for (const img of images) parts.push({ type: 'image', mimeType: img.mimeType, data: img.data });
  return parts;
}

const BOOKING_MUTATION_TOOLS = ['create_booking', 'request_appointment', 'reschedule_booking', 'cancel_booking'];

interface PendingAvailability {
  slots: Array<{ start: string; end: string }>;
  timezone: string;
  /** The service the slots are for — embedded in the chip so a tap books the
   *  right service when the bot offers more than one. */
  serviceName?: string;
}

/**
 * Turn freshly-offered availability into tappable slot chips.
 *
 * `title` is the human-readable button label; `value` is the message sent back
 * when tapped — a natural-language, absolute date+time+tz the LLM can re-book
 * from. (Telegram's 64-byte callback_data limit doesn't constrain this: quick
 * replies are disabled on the Telegram adapter; the widget + Messenger/IG/
 * WhatsApp have ample payload room.)
 */
function buildSlotQuickReplies(av: PendingAvailability | null): QuickReply[] | undefined {
  if (!av || !av.slots.length) return undefined;
  const forService = av.serviceName ? `${av.serviceName} on ` : '';
  return av.slots.slice(0, 8).map((s) => {
    const dt = DateTime.fromISO(s.start).setZone(av.timezone);
    return {
      title: dt.toFormat('ccc h:mm a'),
      value: `Book ${forService}${dt.toFormat('cccc d LLLL')} at ${dt.toFormat('h:mm a')} (${av.timezone})`,
    };
  });
}

/**
 * Best-effort detector for a final reply that CLAIMS a booking/request was made
 * (or is being made right now). Used ONLY as a hazard signal — what authorizes a
 * confirmation is whether a booking mutation actually succeeded this run (see the
 * egress guard). Patterns are narrow to avoid firing on "you requested X" or a
 * conditional "I'll book it once you confirm". Best-effort per language: English +
 * Dutch (the platform's primary non-English audience) patterns below; the prompt
 * rule is the backstop for languages not covered. NOTE: a fully language-agnostic
 * claim detector needs an LLM classifier — tracked as a follow-up.
 */
function claimsBookingDone(text: string): boolean {
  const t = text.toLowerCase();
  // Narrow, "the bot just did / is about to do it" phrasings. We deliberately
  // avoid ambiguous wording like "your appointment is confirmed" that could refer
  // to an EXISTING booking — the bookingRecorded flag already prevents firing on a
  // legitimate fresh confirmation, so the patterns only need to catch the
  // hallucinated "I did this" claims.
  return [
    // English
    /\bi'?ve (successfully )?(booked|scheduled|requested|submitted|placed|created)\b/,
    /\bi'?ll (go ahead and (book|request|submit|schedule)|proceed( with (the|your|this))?)\b/,
    /\bsuccessfully (requested|booked|scheduled|submitted|created)\b/,
    /\byour (booking|request) (has been|is) (submitted|created|placed|received|sent|booked)\b/,
    // Dutch (best-effort — mirrors the English "I did it" / "your booking is done" shapes)
    /\bik heb (je|uw|het|de|een)?\s?(afspraak|reservering|boeking)?\s?(ge(boekt|reserveerd|pland)|ingepland|aangevraagd|vastgelegd)\b/,
    /\b(je|uw|de) (afspraak|reservering|boeking) (is|staat) (ge(boekt|reserveerd|pland)|ingepland|bevestigd|vastgelegd|aangevraagd)\b/,
  ].some((re) => re.test(t));
}

/** Internal nudge (user role — the Anthropic adapter only honours the FIRST system
 *  message) telling the model to actually call the booking tool instead of claiming
 *  a booking it never made. */
const BOOKING_CORRECTION_NOTE =
  "(Internal note, not from the customer.) You just implied to the customer that their booking or request was made, but no booking was recorded this turn. If you HAVE a booking tool and already have the service, the customer's name, and a time, call the correct booking tool now (and only claim it's done once the tool succeeds). If a required detail is missing, ask for it. If you do NOT have a booking tool available, do NOT claim, confirm, or imply any booking — instead offer to take the customer's details so the team can follow up, in the customer's language.";

/** Safe reply when the model keeps claiming a booking that wasn't recorded (after
 *  one correction, or out of iteration budget) — anything but a false confirmation. */
const BOOKING_SAFE_FALLBACK =
  "Sorry, let me just confirm a couple of details before I put that through — could you confirm the date and time you'd like?";

export class AgentService {
  constructor(
    private toolRegistry: ToolRegistry,
    private promptBuilder: PromptBuilder,
    private metering: MeteringService,
    private traceLogger: TraceLogger,
  ) {}

  async run(
    message: string,
    session: ChatSession,
    tenant: Tenant,
    conversationHistory: ChatMessage[],
    images?: AgentImageInput[],
  ): Promise<AgentResult> {
    const runId = crypto.randomUUID();
    // Multi-bot Phase 4 (#16d): resolve the bot config for this session.
    // The behavioural slice (brand voice / guardrails / integrations) lives on
    // Bot.settings; the LLM provider secret stays on Tenant.settings.ai.apiKey
    // and is returned alongside as `apiKey` by this resolver.
    // One resolve for the whole runtime config: bot row + its full settings
    // (the integrations slice the tool registry needs, plus the prompt
    // builder's skills/brandVoice), the AI behavioural slice, and the tenant
    // LLM key — all from a single bot+tenant lookup.
    const { bot, botSettings, botAiSettings, apiKey } = await getLlmRuntimeConfigForSession(session);
    // Tone + policy guardrails come from the bound template (effectiveBotConfig),
    // not the bot. Override the AI slice once so every downstream read (prompt
    // builder, fallback messages) uses the effective values; escalationKeywords
    // and other operational fields are preserved. One resolve → body + config.
    const resolvedTemplates = await resolveBoundTemplates(bot);
    // AC4: surface "the missing vertical" — a bound template that resolved to a
    // fallback (archived/missing/unpublished) is invisible otherwise. Log it with
    // bot+tenant context (the resolver has neither). The superadmin endpoint lists
    // these bots for review.
    const unavailableReason = resolvedTemplates[0] ? templateUnavailabilityReason(resolvedTemplates[0]) : null;
    if (unavailableReason) {
      logger.warn('Bound bot template unavailable — fell back', {
        botId: bot.id,
        tenantId: tenant.id,
        templateId: resolvedTemplates[0].templateId,
        reason: unavailableReason,
      });
    }
    const templateBody = composeTemplateBodies(resolvedTemplates, bot.templateMode ?? 'or');
    const eff = effectiveConfigFromList(resolvedTemplates);
    const aiSettings = botAiSettings ? withEffectiveConfig(botAiSettings, eff) : botAiSettings;
    const effBotSettings = { ...botSettings, ai: aiSettings };
    const trace: AgentTrace = {
      sessionId: session.id,
      tenantId: tenant.id,
      iterations: [],
      finishReason: 'completed',
    };

    try {
      let tools = await this.toolRegistry.getToolsForTenant(tenant, botSettings);
      // Booking activeness drives the egress guard below (a bot without the
      // booking tools can't be nudged to "actually call create_booking").
      const bookingActive = tools.some((t) => t.name === 'create_booking');
      // Module prompt contributions (e.g. booking's bookable-services catalog).
      // Each active module builds (and loads data for) its own section; the
      // resolver call hits the same per-tenant caches the tool registry used.
      // Composable-templates: a skill influences the LLM — its TOOLS *and* its PROMPT
      // section — iff its template selected it. Resolve the selection up-front so the
      // module prompt sections below are gated in LOCKSTEP with the tools gated later.
      // Otherwise a no-booking bot still gets booking's "SERVICES (bookable)" catalog +
      // "you MUST call create_booking" text with no tool behind it (LEAK-1). See
      // gatedToolNames — same predicate, applied to the prompt surface.
      const composableEnabled = process.env.COMPOSABLE_TEMPLATES_ENABLED === 'true';
      const expectedModuleIds = resolvedTemplates[0]?.expectedModules;
      // H6: skills come from ALL bound templates (composeTemplateBodies already unions
      // their prompt bodies), not just the primary — else a secondary template's skills
      // silently don't take effect. Union each binding's effective skills.
      const selectedSkillIds = [...new Set(
        resolvedTemplates.flatMap((rt) =>
          selectSkillIds({
            selectedSkillIds: composableEnabled ? (rt.selectedSkillIds ?? null) : null,
            expectedModules: rt.expectedModules ?? [],
          }),
        ),
      )];
      const moduleSections: string[] = [];
      const activeModules = await listActiveModules(tenant.id);
      const activeModuleIds = activeModules.map((a) => a.module.id);
      for (const active of activeModules) {
        if (!active.module.buildPromptSection) continue;
        // Prompt gate: skip the section of an active skill the template didn't select.
        if (!skillPromptAllowed(active.module.id, selectedSkillIds, composableEnabled)) continue;
        try {
          const section = await active.module.buildPromptSection({
            tenantId: tenant.id,
            botId: bot.id,
            config: active.config,
          });
          if (section) moduleSections.push(section);
        } catch (error) {
          logger.warn(`Module prompt section failed for ${active.module.id} — skipped`, {
            tenantId: tenant.id,
            error,
          });
        }
      }
      // Pre-fill the customer's name from their messaging-channel profile (channel
      // sessions only) so the agent can confirm it rather than ask cold. Widget
      // sessions have no binding/profile name.
      let customerName: string | undefined;
      if (session.channel && session.channel !== 'widget') {
        const binding = await AppDataSource.getRepository(ConversationBinding).findOne({
          where: { sessionId: session.id },
          select: { externalUserName: true },
        });
        customerName = binding?.externalUserName ?? undefined;
      }
      // Anchor the prompt's date context to the booking timezone (booking bots only;
      // one indexed lookup). Non-booking bots fall back to server/UTC as before.
      let bookingTimezone: string | undefined;
      let bookingConfigured = false;
      if (bookingActive) {
        try {
          const rule = await AppDataSource.getRepository(AvailabilityRule).findOne({
            where: { botId: bot.id },
            select: { timezone: true },
          });
          bookingTimezone = rule?.timezone || undefined;
          // ponytail: rule existence is treated as "hours set up". A rule with empty
          // weeklyHours would still pass here (ceiling) — fine for the phantom-booking
          // case we target (no rule at all); tighten later if empty-hours configs appear.
          // "Bookable online" = active AND online-bookable; an inactive or
          // phone-only service must not flip this true (it isn't bookable via
          // the chat). isActive matches the catalog's own filter.
          const services = await AppDataSource.getRepository(ServiceType).find({
            where: { botId: bot.id, isActive: true, onlineBookable: true },
            select: { id: true, bookingMode: true },
          });
          bookingConfigured = isBookingConfigured(services, !!rule);
        } catch (error) {
          // Fail OPEN: on a lookup error don't suppress booking — a transient DB blip
          // must not falsely decline a CONFIGURED tenant. Worst case is the prior
          // behavior (unconfigured tenant may still over-offer), never a regression.
          logger.warn('booking config check failed — treating booking as usable', { tenantId: tenant.id, error });
          bookingConfigured = true;
        }
      }
      // Template body (layer 2) + effective tone/guardrails both come from the
      // one resolve above (effBotSettings carries the effective AI slice).
      // SpecialtyCatalog (S2/S4): scope to the bound template's vertical (category),
      // resolve the bot's effective specialties, and pass them to the composer so a
      // requiresSpecialPrompt specialty injects its exception block.
      const vertical = resolvedTemplates[0]?.category ?? null;
      const selectedSpecialtyDefs = effectiveSelectedSpecialties(effBotSettings.ai?.selectedSpecialties, vertical);
      const specialties = resolveSpecialties(selectedSpecialtyDefs);
      const specialtyTerms = specialtyRetrievalTerms(selectedSpecialtyDefs);
      // composableEnabled / boundSkillIds / expectedModuleIds / selectedSkillIds are
      // hoisted above (so the module prompt sections are gated in lockstep with tools).
      // Resolve each selected/active skill's STATE for the trace; Phase 3b (behind
      // SKILL_STATE_ENABLED) then drops a non-ready skill's tools (no phantom bookings).
      const skillStates = resolveSkillStates({
        selected: selectedSkillIds,
        active: activeModuleIds,
        gateKind: (id) => getModule(id)?.gate.kind,
        readiness: (id) => readinessRefinement(id, { bookingConfigured }),
      });
      // Templates are the SOLE source of skills: the bot's skills are exactly what
      // its template composes (∩ entitlements). A Dental template that binds {booking}
      // won't also offer handoff just because the plan allows it; and NO template (or
      // one gone unavailable) → selectedSkillIds is empty → no skills, matching the
      // "answers from your knowledge base only" empty-state. Drop every active skill's
      // tools the template didn't select. Flag-gated (OFF → legacy, entitlement-only).
      if (composableEnabled) {
        const drop = gatedToolNames(selectedSkillIds, activeModuleIds);
        if (drop.size) tools = tools.filter((tl) => !drop.has(tl.name));
      }
      // Per-template skill prose: the version's OVERRIDE if set, else the skill's
      // code-default (defaultProse). Only for skills that resolved `ready`, so an
      // unconfigured skill contributes no prose. Behind the flag (OFF → unchanged).
      // H6: merge prose overrides across all bound templates (primary wins on conflict —
      // it's applied last), so a secondary template's skill still gets its authored prose.
      const skillProseOverrides = Object.assign({}, ...[...resolvedTemplates].reverse().map((rt) => rt.skillProse ?? {})) as Record<string, string>;
      const skillProse = composableEnabled
        ? selectedSkillIds
            .filter((id) => skillStates[id] === 'ready')
            .map((id) => ({ id, prose: (skillProseOverrides?.[id] ?? getModule(id)?.defaultProse ?? '').trim() }))
            .filter((sp) => sp.prose.length > 0)
        : [];
      // Template variables — apply the bound template's declared DEFAULTS under the
      // bot's own tenant-filled values (bot value wins), so a declared {placeholder}
      // with a default substitutes even before a tenant fills it in.
      // Every DECLARED variable resolves to a value — its default, else empty — so an
      // unfilled one renders as blank rather than leaking a literal {key} to the model.
      const varDefaults: Record<string, string> = {};
      for (const v of resolvedTemplates[0]?.variables ?? []) {
        varDefaults[v.key] = typeof v.default === 'string' ? v.default : '';
      }
      if (aiSettings && Object.keys(varDefaults).length) {
        const av = aiSettings as { templateVariables?: Record<string, string> };
        av.templateVariables = { ...varDefaults, ...(av.templateVariables ?? {}) };
      }
      // Phase 3b (behind SKILL_STATE_ENABLED, default OFF). ON → drop a non-ready
      // skill's tools before the model sees them, so an entitled-but-unconfigured
      // booking bot physically cannot call create_booking (no phantom bookings);
      // the existing tool-driven composer then renders "BOOKING (NOT AVAILABLE)".
      // OFF → unchanged (the prompt drives off bookingConfigured, as before).
      if (process.env.SKILL_STATE_ENABLED === 'true') {
        tools = dropUnreadySkillTools(tools, skillStates, (id) => getModule(id)?.tools.map((t) => t.name) ?? []);
      }
      const { prompt: systemPrompt, ledger } = this.promptBuilder.build(tenant, effBotSettings, tools, undefined, moduleSections, customerName, templateBody, bookingTimezone, bookingConfigured, session.channel, specialties, skillProse);
      // Merge the composer's block ledger with agent.service's module knowledge
      // (the composer can't name modules) onto the trace — nests in trace.jsonb,
      // no migration. Persisted on every fire-and-forget save below.
      trace.prompt = buildPromptTrace(ledger, {
        activeModuleIds,
        expectedModuleIds,
        skillStates,
        resolvedTemplateId: resolvedTemplates[0]?.templateId,
        resolvedTemplateVersion: resolvedTemplates[0]?.resolvedVersion,
      });
      // Model/provider are platform-standardised — always the platform default,
      // never per-bot/tenant (see llm/defaults).
      const provider = getProvider(DEFAULT_PROVIDER, apiKey ?? undefined);
      const model = DEFAULT_MODEL;

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
        { role: 'user', content: buildUserContent(message, images) },
      ];

      const toolsCalled: string[] = [];
      // Latest availability offered this run — surfaced as slot chips on the
      // reply, unless a booking mutation later consumes/invalidates the offer.
      let pendingAvailability: PendingAvailability | null = null;
      // Egress guard state: was a booking/request actually recorded this run, and
      // have we already nudged the model once for claiming one that wasn't?
      let bookingRecorded = false;
      // #7: per-run guard — a side-effecting tool must not execute twice with
      // identical args within one agent run (a model re-emitting the same call).
      // Cross-run re-invocation (the coalescer re-arming a turn) is already
      // neutralised by the booking provider's idempotency window + DB constraints
      // for create/request; reschedule/cancel re-runs are self-idempotent (same
      // target = no new effect).
      const sideEffectsInvoked = new Set<string>();
      let correctionAttempted = false;

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        // Budget check
        if (await this.metering.isOverBudget(tenant.id, (aiSettings as any)?.dailyTokenBudget)) {
          trace.finishReason = 'budget_exceeded';
          void this.traceLogger.save(trace); // fire-and-forget: keeps the trace write off the response path
          return {
            type: 'budget_exceeded',
            fallbackMessage: aiSettings?.guardrails?.fallbackMessage || 'I apologize, but I am temporarily unavailable.',
          };
        }

        // Build tool definitions for LLM
        const toolDefs: ToolDefinition[] | undefined = tools.length > 0
          ? tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
          : undefined;

        // Call LLM
        const startMs = Date.now();
        const timeoutMs = 30000; // 30 seconds
        const response = await Promise.race([
          provider.chat(messages, { model, maxTokens: 1000, temperature: 0.3, jsonMode: false, tools: toolDefs }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('LLM request timeout after 30s')), timeoutMs)),
        ]);
        const latencyMs = Date.now() - startMs;

        // Record metering
        await this.metering.record(tenant.id, response.usage);

        // Build trace entry
        const traceEntry: AgentTrace['iterations'][0] = {
          llmCall: { model, ...response.usage, latencyMs },
          toolCalls: [],
        };

        // No tool calls — final response
        if (response.finishReason === 'stop' || !response.toolCalls?.length) {
          trace.iterations.push(traceEntry);
          const finalContent = response.content ?? '';
          // Egress guard (issue #35): never let the model tell the customer a
          // booking/request happened unless one was actually recorded this run.
          if (bookingActive && !bookingRecorded && claimsBookingDone(finalContent)) {
            if (!correctionAttempted && i < MAX_ITERATIONS - 1) {
              correctionAttempted = true;
              logger.warn('[agent] blocked unrecorded booking claim; nudging model to act', { sessionId: session.id });
              messages.push({ role: 'assistant', content: finalContent });
              messages.push({ role: 'user', content: BOOKING_CORRECTION_NOTE });
              continue; // re-run: model should call the tool or ask for the missing detail
            }
            trace.finishReason = 'completed';
            void this.traceLogger.save(trace);
            logger.warn('[agent] persistent unrecorded booking claim; returning safe fallback', { sessionId: session.id });
            return { type: 'response', content: BOOKING_SAFE_FALLBACK };
          }
          trace.finishReason = 'completed';
          void this.traceLogger.save(trace); // fire-and-forget: keeps the trace write off the response path
          return { type: 'response', content: finalContent, quickReplies: buildSlotQuickReplies(pendingAvailability) };
        }

        // Process tool calls
        // Append assistant message WITH toolCalls BEFORE processing tool results
        messages.push({ role: 'assistant', content: response.content || '', toolCalls: response.toolCalls });

        for (const toolCall of response.toolCalls) {
          const tool = tools.find((t) => t.name === toolCall.name);
          const toolStartMs = Date.now();

          if (!tool) {
            messages.push({ role: 'tool', content: JSON.stringify({ error: `Unknown tool: ${toolCall.name}` }), toolCallId: toolCall.id });
            continue;
          }

          // Precondition check
          if (tool.preconditions?.toolsCalled) {
            const missing = tool.preconditions.toolsCalled.filter((t) => !toolsCalled.includes(t));
            if (missing.length > 0) {
              const errorMsg = `Must call ${missing.join(', ')} before ${tool.name}`;
              messages.push({ role: 'tool', content: JSON.stringify({ error: errorMsg }), toolCallId: toolCall.id });
              traceEntry.toolCalls.push({ name: tool.name, args: toolCall.arguments, result: { success: false, error: errorMsg }, latencyMs: 0 });
              continue;
            }
          }

          // #7: dedupe side-effecting tools within this run — an identical (tool,
          // args) call a second time, AFTER it already succeeded, does NOT re-execute;
          // the model is told it was already performed. Marked only on success (below)
          // so a failed first attempt can still be retried. (Cross-run dedupe is the
          // provider's idempotency job.)
          const sideEffectSig = tool.hasSideEffects
            ? `${tool.name}:${JSON.stringify(toolCall.arguments)}`
            : null;
          if (sideEffectSig && sideEffectsInvoked.has(sideEffectSig)) {
            messages.push({ role: 'tool', content: JSON.stringify({ note: 'already_performed', tool: tool.name }), toolCallId: toolCall.id });
            traceEntry.toolCalls.push({ name: tool.name, args: toolCall.arguments, result: { success: true }, latencyMs: 0 });
            continue;
          }

          // Execute tool
          const ctx: ToolContext = {
            tenantId: tenant.id,
            sessionId: session.id,
            runId,
            toolsCalledThisTurn: toolsCalled,
            dataSource: AppDataSource,
            conversationHistory: messages,
            specialtyTerms: specialtyTerms.length ? specialtyTerms : undefined,
          };

          try {
            const result = await tool.execute(toolCall.arguments, ctx);
            toolsCalled.push(tool.name);
            // #7: only now (post-success) is the side-effect "performed" — a failed
            // attempt stays retryable.
            if (sideEffectSig && result.success) sideEffectsInvoked.add(sideEffectSig);
            // Track offered slots for the chip UI; a booking mutation clears them.
            if (tool.name === 'check_availability' && result.success && result.data) {
              const d = result.data as {
                slots?: Array<{ start: string; end: string }>;
                timezone?: string;
                serviceName?: string;
              };
              if (Array.isArray(d.slots)) {
                pendingAvailability = { slots: d.slots, timezone: d.timezone ?? 'UTC', serviceName: d.serviceName };
              }
            } else if (BOOKING_MUTATION_TOOLS.includes(tool.name) && result.success) {
              pendingAvailability = null;
              bookingRecorded = true;
            }
            // R31: a tool that fails may return a raw infra error (err.message)
            // as result.error; never forward an UNMARKED error to the model — it
            // could be echoed to the customer. Only errors a tool explicitly
            // marks errorSafeForModel (authored domain errors) pass through; the
            // rest become a generic message. The full result stays in the trace.
            let modelPayload: unknown;
            if (result.success) {
              modelPayload = result.data ?? {};
            } else if (result.errorSafeForModel) {
              modelPayload = { error: result.error };
            } else {
              logger.warn('Agent tool error sanitized for model', {
                sessionId: session.id, tool: tool.name, error: result.error,
              });
              modelPayload = { error: `The ${tool.name} tool couldn't complete that request right now.` };
            }
            let resultJson = JSON.stringify(modelPayload);
            if (resultJson.length > 4000) {
              resultJson = resultJson.substring(0, 4000) + '...[truncated]';
            }
            messages.push({
              role: 'tool',
              content: resultJson,
              toolCallId: toolCall.id,
            });
            traceEntry.toolCalls.push({
              name: tool.name,
              args: toolCall.arguments,
              result,
              latencyMs: Date.now() - toolStartMs,
            });
          } catch (error) {
            // R31: an UNEXPECTED tool exception (SQL error, stack, connection
            // string, internal id) must never reach the model context — the model
            // can echo it to the customer. Log the real error server-side + keep
            // it in the trace, but hand the model a sanitized, generic message.
            // (A tool that RETURNS an error is sanitized at the boundary above
            // unless it set errorSafeForModel; this catch covers tools that THROW.)
            const rawMsg = error instanceof Error ? error.message : 'Tool execution failed';
            logger.error('Agent tool threw', { sessionId: session.id, tool: tool.name, error });
            const safeMsg = `The ${tool.name} tool is temporarily unavailable. Do not retry it this turn.`;
            messages.push({ role: 'tool', content: JSON.stringify({ error: safeMsg }), toolCallId: toolCall.id });
            traceEntry.toolCalls.push({
              name: tool.name,
              args: toolCall.arguments,
              result: { success: false, error: rawMsg },
              latencyMs: Date.now() - toolStartMs,
            });
          }
        }

        trace.iterations.push(traceEntry);
      }

      // Max iterations reached
      trace.finishReason = 'max_iterations';
      void this.traceLogger.save(trace); // fire-and-forget: keeps the trace write off the response path
      return { type: 'max_iterations', fallbackMessage: "Let me connect you with a human agent." };

    } catch (error) {
      trace.finishReason = 'error';
      void this.traceLogger.save(trace); // fire-and-forget: keeps the trace write off the response path
      logger.error('Agent loop error', { sessionId: session.id, error });
      return {
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        fallbackMessage: aiSettings?.guardrails?.fallbackMessage || 'Something went wrong. Let me connect you with a human agent.',
      };
    }
  }
}
