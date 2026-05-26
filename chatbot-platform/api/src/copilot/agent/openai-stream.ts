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
    const tools =
      options.tools && options.tools.length > 0
        ? options.tools.map((t) => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }))
        : undefined;

    const stream = await this.client.chat.completions.create(
      {
        model: options.model,
        messages: messages.map(toOpenAIMessage) as OpenAI.Chat.ChatCompletionMessageParam[],
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        tools,
        stream: true,
      },
      { signal: options.signal },
    );

    // Tool-call reconstruction state. OpenAI delivers tool_calls as
    // per-chunk deltas keyed by `index`. We accumulate name +
    // arguments string until `finish_reason` flips to 'tool_calls'.
    interface AccTool {
      id: string;
      name: string;
      args: string; // raw JSON string under construction
    }
    const tools_by_index = new Map<number, AccTool>();

    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'aborted' = 'stop';

    try {
      for await (const chunk of stream) {
        if (options.signal.aborted) {
          finishReason = 'aborted';
          break;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta as {
          content?: string;
          tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };

        if (delta?.content) {
          yield { type: 'token', text: delta.content };
        }

        if (delta?.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            const idx = tcDelta.index;
            let acc = tools_by_index.get(idx);
            if (!acc) {
              acc = { id: tcDelta.id ?? '', name: '', args: '' };
              tools_by_index.set(idx, acc);
            }
            if (tcDelta.id) acc.id = tcDelta.id;
            if (tcDelta.function?.name) acc.name += tcDelta.function.name;
            if (tcDelta.function?.arguments) acc.args += tcDelta.function.arguments;
          }
        }

        if (choice.finish_reason === 'stop') finishReason = 'stop';
        else if (choice.finish_reason === 'tool_calls') finishReason = 'tool_calls';
        else if (choice.finish_reason === 'length') finishReason = 'length';

        // OpenAI sends usage in the final chunk only when explicitly
        // requested via stream_options.include_usage. Newer SDKs may
        // also send usage on the last chunk by default; read defensively.
        const usage = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
        if (usage) {
          promptTokens = usage.prompt_tokens ?? promptTokens;
          completionTokens = usage.completion_tokens ?? completionTokens;
        }
      }

      // Emit assembled tool calls (one event each) before finalize.
      if (finishReason === 'tool_calls' || tools_by_index.size > 0) {
        for (const [, acc] of [...tools_by_index.entries()].sort(([a], [b]) => a - b)) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = acc.args ? (JSON.parse(acc.args) as Record<string, unknown>) : {};
          } catch {
            // Malformed args from the provider — yield with empty args
            // and let the tool implementation reject.
            parsedArgs = {};
          }
          const call: CopilotLlmToolCall = {
            id: acc.id,
            name: acc.name,
            arguments: parsedArgs,
          };
          yield { type: 'tool_call', call };
        }
        if (finishReason === 'stop') finishReason = 'tool_calls';
      }

      yield {
        type: 'finalize',
        finishReason,
        usage: { promptTokens, completionTokens },
      };
    } catch (err) {
      // OpenAI SDK signals abort by throwing — translate into our
      // 'aborted' finalize so the loop sees it cleanly.
      if (options.signal.aborted) {
        yield {
          type: 'finalize',
          finishReason: 'aborted',
          usage: { promptTokens, completionTokens },
        };
        return;
      }
      throw err;
    }
  }
}
