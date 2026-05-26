/**
 * `runCopilotTurn` — the Copilot agent loop.
 *
 * Lifecycle per turn:
 *
 *   1. Atomic pair insert (user@N + assistant@N+1 'pending') under
 *      `SELECT ... FOR UPDATE` on the conversation. (round 5 #6)
 *   2. Build prompt: system + last-N history + retrieved snippets +
 *      new user message. (PR3 retriever + prompt builder)
 *   3. LLM iteration loop (bounded by:
 *        - `MAX_TOOL_CALLS_PER_TURN` = 8
 *        - `MAX_LLM_ITERATIONS` = 4
 *        - `HARD_TIMEOUT_MS` = 60_000
 *      ). Each iteration:
 *        - stream tokens to SSE
 *        - on `tool_call` events, invoke the tool, push the result
 *          into the in-memory message list as a `role: 'tool'`
 *          entry (NEVER persisted), continue the loop
 *        - on `finalize` with `finishReason: 'stop'`, break out
 *   4. Periodic content UPDATE on the assistant row every 32 tokens
 *      or at tool-call boundaries (whichever first). Final UPDATE
 *      sets `outcome` + `content` + `tokens_in/out/latency_ms`.
 *   5. CopilotTrace INSERT — metadata only.
 *   6. Emit `event: complete` and return.
 *
 * Terminal outcomes (assistant row's final `outcome` value):
 *   - 'success'              — stream finished cleanly, finishReason=stop
 *   - 'aborted'              — `req.close` / drawer close (round 6 #2)
 *   - 'error'                — LLM provider error / unhandled exception
 *   - 'agent_loop_exceeded'  — hit a bound (tool count / LLM iter / timeout)
 *   - 'pending'              — process crashed mid-stream; UI surfaces as
 *                              `[interrupted]` after 90s via `stream_started_at`
 *
 * Counter consumption (PR5 orchestrator) runs BEFORE this. A turn
 * that errors mid-stream still leaves the counter consumed — no
 * rollback (round 5 #1).
 */
import type { DataSource } from 'typeorm';
import { logger } from '../../utils/logger';
import { CopilotMessage, CopilotMessageOutcome, CopilotToolCallSummary } from '../../database/entities/CopilotMessage';
import { CopilotReadOnlyManager } from '../manager/read-only-manager';
import type { CopilotKnowledgeSource, Locale } from '../knowledge/types';
import { buildCopilotPrompt } from './prompt';
import { insertAtomicPair, ConversationClearedMidSendError } from './persist';
import type { CopilotSSESink } from './sse';
import type {
  CopilotLlmMessage,
  CopilotLlmStream,
  CopilotLlmStreamEvent,
  CopilotLlmToolCall,
} from './llm-stream';
import type { CopilotToolRegistry } from '../tools/registry';
import type { CopilotToolContext } from '../tools/types';

export const MAX_TOOL_CALLS_PER_TURN = 8;
export const MAX_LLM_ITERATIONS = 4;
export const HARD_TIMEOUT_MS = 60_000;
const CONTENT_PERSIST_TOKEN_INTERVAL = 32;
const HISTORY_WINDOW = 20;
const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_TEMPERATURE = 0.3;

export interface RunCopilotTurnArgs {
  dataSource: DataSource;
  llm: CopilotLlmStream;
  knowledge: CopilotKnowledgeSource;
  toolRegistry: CopilotToolRegistry;
  sink: CopilotSSESink;
  abortSignal: AbortSignal;
  /** Provider/model envelope. Default model from env (`COPILOT_LLM_MODEL`). */
  model?: string;
  /** Tenant + user from Clerk auth. */
  tenantId: string;
  userId: string;
  /** The user's new message text (already validated by the route). */
  message: string;
  /** Requested locale (defaults to 'en'). */
  locale?: Locale;
}

export interface RunCopilotTurnResult {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  userTurn: number;
  assistantTurn: number;
  outcome: CopilotMessageOutcome;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  toolsCalled: CopilotToolCallSummary[];
}

export async function runCopilotTurn(args: RunCopilotTurnArgs): Promise<RunCopilotTurnResult> {
  const start = Date.now();
  const locale: Locale = args.locale ?? 'en';
  const model = args.model ?? process.env.COPILOT_LLM_MODEL ?? 'gpt-4o-mini';

  // -----------------------------------------------------------------
  // 1. Atomic pair insert. May throw ConversationClearedMidSendError.
  // -----------------------------------------------------------------
  const pair = await insertAtomicPair(args.dataSource, args.tenantId, args.userId, args.message);

  // -----------------------------------------------------------------
  // 2. Load history + retrieve snippets for the prompt.
  // -----------------------------------------------------------------
  const history = await loadHistory(args.dataSource, pair.conversationId, pair.userTurn);
  const snippets = await args.knowledge.search(args.message, locale, 4);

  const tools = args.toolRegistry.getCopilotTools();
  const llmTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters as unknown as Record<string, unknown>,
  }));

  const messages: CopilotLlmMessage[] = buildCopilotPrompt({
    history,
    snippets,
    tools,
    newUserText: args.message,
    requestedLocale: locale,
  });

  // -----------------------------------------------------------------
  // 3. Agent loop bounds — single ABORT controller for stream + tools.
  // -----------------------------------------------------------------
  const turnAbort = new AbortController();
  const timeoutHandle = setTimeout(() => turnAbort.abort('agent_loop_exceeded'), HARD_TIMEOUT_MS);
  const onAbort = () => turnAbort.abort('aborted');
  args.abortSignal.addEventListener('abort', onAbort, { once: true });

  const toolsCalled: CopilotToolCallSummary[] = [];
  let toolCallCount = 0;
  let llmIterations = 0;
  let accumulatedContent = '';
  let tokensInTotal = 0;
  let tokensOutTotal = 0;
  let lastPersistAt = 0; // tokens since last UPDATE

  let outcome: CopilotMessageOutcome = 'pending';
  let error: Error | null = null;

  try {
    iterationLoop: while (llmIterations < MAX_LLM_ITERATIONS) {
      if (turnAbort.signal.aborted) break;
      llmIterations++;

      const pendingToolCalls: CopilotLlmToolCall[] = [];
      let iterationContent = '';
      type FR = 'stop' | 'tool_calls' | 'length' | 'aborted';
      const finishReasonRef: { value: FR } = { value: 'stop' };

      const streamIter = args.llm.stream(messages, {
        model,
        maxTokens: DEFAULT_MAX_TOKENS,
        temperature: DEFAULT_TEMPERATURE,
        tools: llmTools,
        signal: turnAbort.signal,
      });

      for await (const ev of streamIter) {
        if (turnAbort.signal.aborted) break;
        await handleStreamEvent(ev, {
          appendText: (text) => {
            iterationContent += text;
            accumulatedContent += text;
            args.sink.emit({ event: 'token', data: { text } });
            lastPersistAt += text.length;
            if (lastPersistAt >= CONTENT_PERSIST_TOKEN_INTERVAL * 4 /* ≈ chars */) {
              void persistAssistantProgress(args.dataSource, pair.assistantMessageId, accumulatedContent);
              lastPersistAt = 0;
            }
          },
          pushToolCall: (call) => pendingToolCalls.push(call),
          finalize: (fr, usage) => {
            finishReasonRef.value = fr as FR;
            tokensInTotal += usage.promptTokens;
            tokensOutTotal += usage.completionTokens;
          },
        });
      }

      if (turnAbort.signal.aborted) {
        outcome =
          turnAbort.signal.reason === 'agent_loop_exceeded'
            ? 'agent_loop_exceeded'
            : 'aborted';
        break iterationLoop;
      }

      // No tool calls → conversational turn is over.
      if (pendingToolCalls.length === 0) {
        outcome = 'success';
        break iterationLoop;
      }

      // Tool-calling branch — replay assistant message + each tool
      // result into the in-memory message list for the next iteration.
      messages.push({
        role: 'assistant',
        content: iterationContent,
        toolCalls: pendingToolCalls,
      });

      for (const call of pendingToolCalls) {
        if (turnAbort.signal.aborted) break iterationLoop;
        toolCallCount++;
        if (toolCallCount > MAX_TOOL_CALLS_PER_TURN) {
          outcome = 'agent_loop_exceeded';
          break iterationLoop;
        }
        const result = await runOneTool(call, {
          tenantId: args.tenantId,
          userId: args.userId,
          dataSource: args.dataSource,
          toolRegistry: args.toolRegistry,
          sink: args.sink,
        });
        toolsCalled.push({ name: call.name, outcome: result.outcome });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: result.contentForLlm,
        });
      }

      // length-finish without tool calls means the model truncated —
      // we don't loop again, just take what we have.
      if (finishReasonRef.value === 'length') {
        outcome = 'success';
        break iterationLoop;
      }
    }

    if (outcome === 'pending' && llmIterations >= MAX_LLM_ITERATIONS) {
      outcome = 'agent_loop_exceeded';
    }
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
    if (turnAbort.signal.aborted && turnAbort.signal.reason !== 'agent_loop_exceeded') {
      outcome = 'aborted';
    } else {
      outcome = outcome === 'pending' ? 'error' : outcome;
    }
    logger.warn('Copilot agent loop threw', {
      tenantId: args.tenantId,
      userId: args.userId,
      conversationId: pair.conversationId,
      assistantMessageId: pair.assistantMessageId,
      error: error.message,
    });
  } finally {
    clearTimeout(timeoutHandle);
    args.abortSignal.removeEventListener('abort', onAbort);
  }

  // -----------------------------------------------------------------
  // 4. Final UPDATE on the assistant row + CopilotTrace INSERT.
  // -----------------------------------------------------------------
  const latencyMs = Date.now() - start;
  await finalizeAssistantRow(args.dataSource, {
    assistantMessageId: pair.assistantMessageId,
    content: accumulatedContent,
    outcome,
    tokensIn: tokensInTotal,
    tokensOut: tokensOutTotal,
    latencyMs,
    toolsCalled,
  });
  await insertTrace(args.dataSource, {
    tenantId: args.tenantId,
    userId: args.userId,
    conversationId: pair.conversationId,
    turnId: pair.assistantMessageId,
    toolsCalled,
    tokensIn: tokensInTotal,
    tokensOut: tokensOutTotal,
    latencyMs,
    outcome: outcome === 'pending' ? 'error' : outcome,
    retrievalMode: 'lexical',
    llmModel: model,
  });

  // -----------------------------------------------------------------
  // 5. Emit terminal SSE event.
  // -----------------------------------------------------------------
  if (outcome === 'success') {
    args.sink.emit({
      event: 'complete',
      data: {
        turnId: pair.assistantMessageId,
        conversationId: pair.conversationId,
        tokensIn: tokensInTotal,
        tokensOut: tokensOutTotal,
        latencyMs,
      },
    });
  } else {
    const errorCode =
      outcome === 'aborted'
        ? 'aborted'
        : outcome === 'agent_loop_exceeded'
          ? 'agent_loop_exceeded'
          : 'llm_error';
    args.sink.emit({ event: 'error', data: { code: errorCode } });
  }

  return {
    conversationId: pair.conversationId,
    userMessageId: pair.userMessageId,
    assistantMessageId: pair.assistantMessageId,
    userTurn: pair.userTurn,
    assistantTurn: pair.assistantTurn,
    outcome,
    tokensIn: tokensInTotal,
    tokensOut: tokensOutTotal,
    latencyMs,
    toolsCalled,
  };
}

// -------------------------------------------------------------------
// Stream event handler — splits token / tool_call / finalize routing.
// -------------------------------------------------------------------
interface StreamHandlers {
  appendText(text: string): void;
  pushToolCall(call: CopilotLlmToolCall): void;
  finalize(
    fr: 'stop' | 'tool_calls' | 'length' | 'aborted',
    usage: { promptTokens: number; completionTokens: number },
  ): void;
}

async function handleStreamEvent(ev: CopilotLlmStreamEvent, h: StreamHandlers): Promise<void> {
  switch (ev.type) {
    case 'token':
      h.appendText(ev.text);
      return;
    case 'tool_call':
      h.pushToolCall(ev.call);
      return;
    case 'finalize':
      h.finalize(ev.finishReason, ev.usage);
      return;
  }
}

// -------------------------------------------------------------------
// Tool invocation — emits tool_call_start/end SSE events with NAME +
// OUTCOME ONLY (security invariant #11). Tool args/results never go
// over SSE and never reach `CopilotTrace.tools_called` content.
// -------------------------------------------------------------------
async function runOneTool(
  call: CopilotLlmToolCall,
  ctx: {
    tenantId: string;
    userId: string;
    dataSource: DataSource;
    toolRegistry: CopilotToolRegistry;
    sink: CopilotSSESink;
  },
): Promise<{ outcome: 'success' | 'error'; contentForLlm: string }> {
  ctx.sink.emit({ event: 'tool_call_start', data: { name: call.name } });
  const tool = ctx.toolRegistry.getCopilotTool(call.name);
  if (!tool) {
    ctx.sink.emit({ event: 'tool_call_end', data: { name: call.name, outcome: 'error' } });
    return { outcome: 'error', contentForLlm: JSON.stringify({ error: 'unknown_tool' }) };
  }
  const toolCtx: CopilotToolContext = {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    manager: new CopilotReadOnlyManager(ctx.dataSource.manager, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    }),
  };
  try {
    const result = await tool.execute(call.arguments as Record<string, never>, toolCtx);
    ctx.sink.emit({ event: 'tool_call_end', data: { name: call.name, outcome: 'success' } });
    return { outcome: 'success', contentForLlm: JSON.stringify(result) };
  } catch (err) {
    logger.warn('Copilot tool execution failed', {
      tenantId: ctx.tenantId,
      tool: call.name,
      error: err instanceof Error ? err.message : String(err),
    });
    ctx.sink.emit({ event: 'tool_call_end', data: { name: call.name, outcome: 'error' } });
    return {
      outcome: 'error',
      contentForLlm: JSON.stringify({
        error: 'tool_execution_failed',
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

// -------------------------------------------------------------------
// History / persistence helpers
// -------------------------------------------------------------------
async function loadHistory(
  dataSource: DataSource,
  conversationId: string,
  beforeTurn: number,
): Promise<CopilotMessage[]> {
  // Load up to HISTORY_WINDOW most recent messages whose turn < the
  // user's new turn. Sorted DESC, then reversed to ASC for prompt
  // building.
  const rows = await dataSource.getRepository(CopilotMessage).find({
    where: { conversationId },
    order: { turn: 'DESC' },
    take: HISTORY_WINDOW,
  });
  return rows.filter((r) => r.turn < beforeTurn).reverse();
}

async function persistAssistantProgress(
  dataSource: DataSource,
  assistantMessageId: string,
  content: string,
): Promise<void> {
  try {
    await dataSource.query(
      `UPDATE chatbot_copilot_messages SET content = $1 WHERE id = $2`,
      [content, assistantMessageId],
    );
  } catch (err) {
    logger.warn('Copilot progressive content UPDATE failed (continuing)', {
      assistantMessageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface FinalizeArgs {
  assistantMessageId: string;
  content: string;
  outcome: CopilotMessageOutcome;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  toolsCalled: CopilotToolCallSummary[];
}

async function finalizeAssistantRow(dataSource: DataSource, a: FinalizeArgs): Promise<void> {
  try {
    await dataSource.query(
      `UPDATE chatbot_copilot_messages
          SET content = $1,
              outcome = $2,
              tokens_in = $3,
              tokens_out = $4,
              latency_ms = $5,
              tools_called = $6
        WHERE id = $7`,
      [
        a.content,
        a.outcome,
        a.tokensIn,
        a.tokensOut,
        a.latencyMs,
        JSON.stringify(a.toolsCalled),
        a.assistantMessageId,
      ],
    );
  } catch (err) {
    // Per round 6 #2: final-update failure logs + continues. Leaves
    // the row at outcome='pending'; stale-pending detection (>90s)
    // marks it as `[interrupted]` on next GET /conversation.
    logger.error('Copilot finalize assistant row failed', {
      assistantMessageId: a.assistantMessageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface TraceArgs {
  tenantId: string;
  userId: string;
  conversationId: string;
  turnId: string;
  toolsCalled: CopilotToolCallSummary[];
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  outcome: 'success' | 'aborted' | 'error' | 'agent_loop_exceeded';
  retrievalMode: 'lexical' | 'vector' | 'hybrid';
  llmModel: string;
}

async function insertTrace(dataSource: DataSource, t: TraceArgs): Promise<void> {
  try {
    await dataSource.query(
      `INSERT INTO chatbot_copilot_traces
        (tenant_id, user_id, conversation_id, turn_id, tools_called,
         tokens_in, tokens_out, latency_ms, outcome, retrieval_mode, llm_model)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
      [
        t.tenantId,
        t.userId,
        t.conversationId,
        t.turnId,
        JSON.stringify(t.toolsCalled),
        t.tokensIn,
        t.tokensOut,
        t.latencyMs,
        t.outcome,
        t.retrievalMode,
        t.llmModel,
      ],
    );
  } catch (err) {
    logger.error('Copilot trace INSERT failed (continuing)', {
      assistantMessageId: t.turnId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Re-export for callers (PR7 routes) that need to map the typed error
// to an HTTP response.
export { ConversationClearedMidSendError };
