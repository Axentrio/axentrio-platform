import crypto from 'crypto';
import { DateTime } from 'luxon';
import { ToolRegistry } from './tool-registry';
import { PromptBuilder } from './prompt-builder';
import { MeteringService } from './metering.service';
import { TraceLogger, AgentTrace } from './trace-logger';
import { ToolContext } from './tool-adapter';
import { getProvider } from '../llm/provider-factory';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../llm/defaults';
import { ChatMessage, ToolDefinition } from '../llm/llm.types';
import { ChatSession } from '../database/entities/ChatSession';
import { ConversationBinding } from '../database/entities/ConversationBinding';
import { Tenant } from '../database/entities/Tenant';
import { AppDataSource } from '../database/data-source';
import { listActiveModules } from '../modules';
import { logger } from '../utils/logger';
import { getLlmRuntimeConfigForSession } from '../services/bot-config.service';
import { resolveBoundTemplate, effectiveConfigFrom, withEffectiveConfig } from '../templates/template-resolver';

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
 * conditional "I'll book it once you confirm". English phrasings only; the prompt
 * rule is the backstop for other languages.
 */
function claimsBookingDone(text: string): boolean {
  const t = text.toLowerCase();
  // Narrow, "the bot just did / is about to do it" phrasings. We deliberately
  // avoid ambiguous wording like "your appointment is confirmed" that could refer
  // to an EXISTING booking — the bookingRecorded flag already prevents firing on a
  // legitimate fresh confirmation, so the patterns only need to catch the
  // hallucinated "I did this" claims.
  return [
    /\bi'?ve (successfully )?(booked|scheduled|requested|submitted|placed|created)\b/,
    /\bi'?ll (go ahead and (book|request|submit|schedule)|proceed( with (the|your|this))?)\b/,
    /\bsuccessfully (requested|booked|scheduled|submitted|created)\b/,
    /\byour (booking|request) (has been|is) (submitted|created|placed|received|sent|booked)\b/,
  ].some((re) => re.test(t));
}

/** Internal nudge (user role — the Anthropic adapter only honours the FIRST system
 *  message) telling the model to actually call the booking tool instead of claiming
 *  a booking it never made. */
const BOOKING_CORRECTION_NOTE =
  "(Internal note, not from the customer.) You just told the customer their booking or request was made, but you did not call create_booking or request_appointment this turn, so nothing was recorded. If you already have the service, the customer's name, and a time, call the correct tool now. If a required detail is still missing, ask the customer for it. Do NOT tell the customer it's done until the tool has actually succeeded.";

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
    const resolvedTemplate = await resolveBoundTemplate(bot);
    const eff = effectiveConfigFrom(resolvedTemplate);
    const aiSettings = botAiSettings ? withEffectiveConfig(botAiSettings, eff) : botAiSettings;
    const effBotSettings = { ...botSettings, ai: aiSettings };
    const trace: AgentTrace = {
      sessionId: session.id,
      tenantId: tenant.id,
      iterations: [],
      finishReason: 'completed',
    };

    try {
      const tools = await this.toolRegistry.getToolsForTenant(tenant, botSettings);
      // Booking activeness drives the egress guard below (a bot without the
      // booking tools can't be nudged to "actually call create_booking").
      const bookingActive = tools.some((t) => t.name === 'create_booking');
      // Module prompt contributions (e.g. booking's bookable-services catalog).
      // Each active module builds (and loads data for) its own section; the
      // resolver call hits the same per-tenant caches the tool registry used.
      const moduleSections: string[] = [];
      for (const active of await listActiveModules(tenant.id)) {
        if (!active.module.buildPromptSection) continue;
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
      // Template body (layer 2) + effective tone/guardrails both come from the
      // one resolve above (effBotSettings carries the effective AI slice).
      const systemPrompt = this.promptBuilder.build(tenant, effBotSettings, tools, undefined, moduleSections, customerName, resolvedTemplate.body);
      // Model/provider are platform-standardised — always the platform default,
      // never per-bot/tenant (see llm/defaults).
      const provider = getProvider(DEFAULT_PROVIDER, apiKey ?? undefined);
      const model = DEFAULT_MODEL;

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
        { role: 'user', content: message },
      ];

      const toolsCalled: string[] = [];
      // Latest availability offered this run — surfaced as slot chips on the
      // reply, unless a booking mutation later consumes/invalidates the offer.
      let pendingAvailability: PendingAvailability | null = null;
      // Egress guard state: was a booking/request actually recorded this run, and
      // have we already nudged the model once for claiming one that wasn't?
      let bookingRecorded = false;
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

          // TODO: Task 12 will add confirmation gate for hasSideEffects tools
          // For now, execute directly (Phase 1 ships without confirmation UX)

          // Execute tool
          const ctx: ToolContext = {
            tenantId: tenant.id,
            sessionId: session.id,
            runId,
            toolsCalledThisTurn: toolsCalled,
            dataSource: AppDataSource,
            conversationHistory: messages,
          };

          try {
            const result = await tool.execute(toolCall.arguments, ctx);
            toolsCalled.push(tool.name);
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
            let resultJson = JSON.stringify(result.data ?? { error: result.error });
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
            const errorMsg = error instanceof Error ? error.message : 'Tool execution failed';
            messages.push({ role: 'tool', content: JSON.stringify({ error: errorMsg }), toolCallId: toolCall.id });
            traceEntry.toolCalls.push({
              name: tool.name,
              args: toolCall.arguments,
              result: { success: false, error: errorMsg },
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
