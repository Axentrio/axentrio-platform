/**
 * Concrete `CopilotLlmStream` impl over the OpenAI SDK's streaming
 * chat completions API.
 *
 * OpenAI chunk deltas arrive in pieces — a tool call's `arguments`
 * field may span 5+ chunks. This wrapper reconstructs them and emits
 * a normalised `CopilotLlmStreamEvent` stream to the agent loop.
 *
 * The agent loop owns the AbortSignal; we plumb it into the SDK's
 * `signal` option so `controller.abort()` on `req.close` propagates
 * upstream and stops further token consumption.
 *
 * The OPENAI_API_KEY env var must be set in any environment that
 * actually serves Copilot. Tests use the scripted mock in
 * `copilot-agent-loop.test.ts` — they never instantiate this class.
 */
import OpenAI from 'openai';
import type {
  CopilotLlmMessage,
  CopilotLlmStream,
  CopilotLlmStreamEvent,
  CopilotLlmStreamOptions,
  CopilotLlmToolCall,
} from './llm-stream';

type OpenAIChatRoleMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

function toOpenAIMessage(m: CopilotLlmMessage): OpenAIChatRoleMessage {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === 'assistant') {
    if (m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    return { role: 'assistant', content: m.content };
  }
  return { role: m.role, content: m.content };
}

type OpenAIFinishReason = 'stop' | 'tool_calls' | 'length' | 'aborted';

/**
 * Tool-call reconstruction state. OpenAI delivers tool_calls as
 * per-chunk deltas keyed by `index`. We accumulate name + arguments
 * string until `finish_reason` flips to 'tool_calls'.
 */
interface AccTool {
  id: string;
  name: string;
  args: string; // raw JSON string under construction
}

type OpenAIToolCallDelta = {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

type OpenAIChoiceDelta = {
  content?: string;
  tool_calls?: OpenAIToolCallDelta[];
};

interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
}

/** Accumulator folded over every streamed chunk. */
interface StreamAccumulator {
  readonly toolsByIndex: Map<number, AccTool>;
  readonly usage: UsageTotals;
  finishReason: OpenAIFinishReason;
}

function toOpenAITools(options: CopilotLlmStreamOptions) {
  return options.tools && options.tools.length > 0
    ? options.tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    : undefined;
}

function accumulateToolCallDeltas(
  toolsByIndex: Map<number, AccTool>,
  deltas: OpenAIToolCallDelta[],
): void {
  for (const tcDelta of deltas) {
    const idx = tcDelta.index;
    let acc = toolsByIndex.get(idx);
    if (!acc) {
      acc = { id: tcDelta.id ?? '', name: '', args: '' };
      toolsByIndex.set(idx, acc);
    }
    if (tcDelta.id) acc.id = tcDelta.id;
    if (tcDelta.function?.name) acc.name += tcDelta.function.name;
    if (tcDelta.function?.arguments) acc.args += tcDelta.function.arguments;
  }
}

function resolveFinishReason(
  current: OpenAIFinishReason,
  reason: string | null | undefined,
): OpenAIFinishReason {
  if (reason === 'stop') return 'stop';
  if (reason === 'tool_calls') return 'tool_calls';
  if (reason === 'length') return 'length';
  return current;
}

// OpenAI sends usage in the final chunk only when explicitly
// requested via stream_options.include_usage. Newer SDKs may also
// send usage on the last chunk by default; read defensively.
function applyChunkUsage(chunk: OpenAI.Chat.ChatCompletionChunk, totals: UsageTotals): void {
  const usage = chunk.usage;
  if (!usage) return;
  totals.promptTokens = usage.prompt_tokens ?? totals.promptTokens;
  totals.completionTokens = usage.completion_tokens ?? totals.completionTokens;
}

/** Fold one chunk into `acc`; returns the delta text to emit, if any. */
function consumeChunk(chunk: OpenAI.Chat.ChatCompletionChunk, acc: StreamAccumulator): string | undefined {
  applyChunkUsage(chunk, acc.usage);
  const choice = chunk.choices?.[0];
  if (!choice) return undefined;
  const delta = choice.delta as OpenAIChoiceDelta;

  if (delta?.tool_calls) {
    accumulateToolCallDeltas(acc.toolsByIndex, delta.tool_calls);
  }
  acc.finishReason = resolveFinishReason(acc.finishReason, choice.finish_reason);

  return delta?.content;
}

function parseToolCallArgs(raw: string): Record<string, unknown> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    // Malformed args from the provider — yield with empty args and
    // let the tool implementation reject.
    return {};
  }
}

function assembleToolCalls(toolsByIndex: Map<number, AccTool>): CopilotLlmToolCall[] {
  return [...toolsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, acc]) => ({
      id: acc.id,
      name: acc.name,
      arguments: parseToolCallArgs(acc.args),
    }));
}

export class OpenAICopilotLlmStream implements CopilotLlmStream {
  private readonly client: OpenAI;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error(
        'OpenAICopilotLlmStream: OPENAI_API_KEY (or constructor apiKey) is required.',
      );
    }
    this.client = new OpenAI({ apiKey: key });
  }

  async *stream(
    messages: CopilotLlmMessage[],
    options: CopilotLlmStreamOptions,
  ): AsyncIterable<CopilotLlmStreamEvent> {
    const isGpt5 = /^gpt-5/.test(options.model);
    const stream = await this.client.chat.completions.create(
      {
        model: options.model,
        messages: messages.map(toOpenAIMessage) as OpenAI.Chat.ChatCompletionMessageParam[],
        ...(isGpt5
          ? { max_completion_tokens: options.maxTokens, reasoning_effort: options.reasoningEffort ?? 'none' }
          : { max_tokens: options.maxTokens, temperature: options.temperature }),
        tools: toOpenAITools(options),
        stream: true,
        // Without `include_usage` the streamed response carries no
        // token counters, which would leave every CopilotTrace at
        // tokensIn/Out = 0. The final chunk arrives with `usage`
        // populated when this flag is set.
        stream_options: { include_usage: true },
      },
      { signal: options.signal },
    );

    const acc: StreamAccumulator = {
      toolsByIndex: new Map<number, AccTool>(),
      usage: { promptTokens: 0, completionTokens: 0 },
      finishReason: 'stop',
    };

    try {
      for await (const chunk of stream) {
        if (options.signal.aborted) {
          acc.finishReason = 'aborted';
          break;
        }
        const text = consumeChunk(chunk, acc);
        if (text) {
          yield { type: 'token', text };
        }
      }

      // Emit assembled tool calls (one event each) before finalize.
      if (acc.finishReason === 'tool_calls' || acc.toolsByIndex.size > 0) {
        for (const call of assembleToolCalls(acc.toolsByIndex)) {
          yield { type: 'tool_call', call };
        }
        if (acc.finishReason === 'stop') acc.finishReason = 'tool_calls';
      }

      yield {
        type: 'finalize',
        finishReason: acc.finishReason,
        usage: { ...acc.usage },
      };
    } catch (err) {
      // OpenAI SDK signals abort by throwing — translate into our
      // 'aborted' finalize so the loop sees it cleanly.
      if (options.signal.aborted) {
        yield {
          type: 'finalize',
          finishReason: 'aborted',
          usage: { ...acc.usage },
        };
        return;
      }
      throw err;
    }
  }
}
