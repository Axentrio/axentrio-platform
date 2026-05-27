/**
 * Streaming LLM interface for the Copilot agent loop.
 *
 * Separate hierarchy from `src/llm/llm.types.ts` because:
 *   - The Copilot loop needs token-level streaming, which the
 *     existing LLMProvider.chat() returns as a single Promise<full
 *     response>. Bolting `stream: true` onto LLMProvider would change
 *     every caller.
 *   - The Copilot model + provider are env-pinned (gpt-4o-mini in
 *     v1) — we don't need the per-tenant key/provider switching the
 *     existing `getProvider()` factory does.
 *   - This abstraction is the one place the agent loop touches the
 *     LLM. Unit tests mock this interface; the OpenAI impl is the
 *     only prod-shaped class.
 */

/**
 * Wire-format messages we send TO the LLM. Mirrors the OpenAI/
 * Anthropic tool-use protocol shape — including the in-memory
 * `role: 'tool'` messages that carry tool-call results between LLM
 * iterations. These NEVER hit `chatbot_copilot_messages` (per
 * security invariant #11 + round 4 #7) — they live only in the
 * request payload for the next LLM iteration.
 */
export type CopilotLlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      toolCalls?: CopilotLlmToolCall[];
    }
  | {
      role: 'tool';
      toolCallId: string;
      name: string;
      content: string;
    };

export interface CopilotLlmToolCall {
  /** Provider-generated call id; used to thread the tool result back. */
  id: string;
  name: string;
  /** Tool arguments as a JSON-parsed object. */
  arguments: Record<string, unknown>;
}

export interface CopilotLlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CopilotLlmStreamOptions {
  model: string;
  maxTokens: number;
  temperature: number;
  tools?: CopilotLlmToolDefinition[];
  /** Tied to the SSE socket so abort propagates upstream. */
  signal: AbortSignal;
}

/**
 * Events the LLM stream emits in order. The agent loop assembles
 * tokens into the assistant message, accumulates tool calls until
 * `finalize`, then either acts on the tool calls or completes the
 * turn.
 *
 * Provider chunk deltas are normalised here — the OpenAI impl
 * reconstructs partial tool-call args across chunks; the consumer
 * sees a flat event stream.
 */
export type CopilotLlmStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; call: CopilotLlmToolCall }
  | {
      type: 'finalize';
      finishReason: 'stop' | 'tool_calls' | 'length' | 'aborted';
      usage: { promptTokens: number; completionTokens: number };
    };

/**
 * The agent loop calls `stream()` and iterates the returned async
 * iterable. The implementation MUST honor `options.signal` —
 * aborting must stop further yields promptly.
 */
export interface CopilotLlmStream {
  stream(
    messages: CopilotLlmMessage[],
    options: CopilotLlmStreamOptions,
  ): AsyncIterable<CopilotLlmStreamEvent>;
}
