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
import { Tenant } from '../database/entities/Tenant';
import { ServiceType } from '../database/entities/ServiceType';
import { AppDataSource } from '../database/data-source';
import { logger } from '../utils/logger';
import { getLlmRuntimeConfigForSession } from '../services/bot-config.service';

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

const BOOKING_MUTATION_TOOLS = ['create_booking', 'reschedule_booking', 'cancel_booking'];

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
    const { botAiSettings, apiKey } = await getLlmRuntimeConfigForSession(session);
    const aiSettings = botAiSettings;
    // Resolve the bot's full settings (for the integrations slice the tool
    // registry needs, and the prompt builder's skills/brandVoice consumption).
    const { getBotConfigForSession } = await import('../services/bot-config.service');
    const { bot, settings: botSettings } = await getBotConfigForSession(session);
    const trace: AgentTrace = {
      sessionId: session.id,
      tenantId: tenant.id,
      iterations: [],
      finishReason: 'completed',
    };

    try {
      const tools = await this.toolRegistry.getToolsForTenant(tenant, botSettings);
      // Load the bookable services catalog for the prompt (only when booking is on).
      const services = tools.some((t) => t.name === 'check_availability')
        ? await AppDataSource.getRepository(ServiceType).find({
            where: { botId: bot.id, isActive: true },
            order: { sortOrder: 'ASC' },
          })
        : [];
      const systemPrompt = this.promptBuilder.build(tenant, botSettings, tools, undefined, services);
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

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        // Budget check
        if (await this.metering.isOverBudget(tenant.id, (aiSettings as any)?.dailyTokenBudget)) {
          trace.finishReason = 'budget_exceeded';
          await this.traceLogger.save(trace);
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
          trace.finishReason = 'completed';
          await this.traceLogger.save(trace);
          return { type: 'response', content: response.content, quickReplies: buildSlotQuickReplies(pendingAvailability) };
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
      await this.traceLogger.save(trace);
      return { type: 'max_iterations', fallbackMessage: "Let me connect you with a human agent." };

    } catch (error) {
      trace.finishReason = 'error';
      await this.traceLogger.save(trace);
      logger.error('Agent loop error', { sessionId: session.id, error });
      return {
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        fallbackMessage: aiSettings?.guardrails?.fallbackMessage || 'Something went wrong. Let me connect you with a human agent.',
      };
    }
  }
}
