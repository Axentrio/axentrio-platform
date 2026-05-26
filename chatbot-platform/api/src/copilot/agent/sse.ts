/**
 * SSE event encoding + emitter sink for the Copilot agent loop.
 *
 * The loop is framework-agnostic: it calls `sink.emit(event)`. The
 * route layer (PR7) supplies a sink that writes to `res.write`. Tests
 * supply a sink that collects events for assertion.
 *
 * The wire format follows the locked Q7 SSE event contract:
 *
 *   event: token
 *   data: {"text": "..."}
 *
 *   event: tool_call_start
 *   data: {"name": "getLeadStats"}
 *
 *   event: tool_call_end
 *   data: {"name": "getLeadStats", "outcome": "success" | "error"}
 *
 *   event: heartbeat
 *   data: {}
 *
 *   event: error
 *   data: {"code": "...", "retryAfter"?: <seconds>}
 *
 *   event: complete
 *   data: {"turnId": "...", "conversationId": "...", "tokensIn": N, "tokensOut": N, "latencyMs": N}
 *
 * Tool-call events carry NAME + OUTCOME ONLY — never args, results,
 * or resource IDs (security invariant #11).
 */

export type CopilotSSEEvent =
  | { event: 'token'; data: { text: string } }
  | { event: 'tool_call_start'; data: { name: string } }
  | {
      event: 'tool_call_end';
      data: { name: string; outcome: 'success' | 'error' };
    }
  | { event: 'heartbeat'; data: Record<string, never> }
  | {
      event: 'error';
      data: {
        code:
          | 'llm_provider_rate_limit'
          | 'llm_error'
          | 'agent_loop_exceeded'
          | 'aborted';
        retryAfter?: number;
      };
    }
  | {
      event: 'complete';
      data: {
        turnId: string;
        conversationId: string;
        tokensIn: number;
        tokensOut: number;
        latencyMs: number;
      };
    };

/**
 * Serialise a single event to the SSE wire frame: `event: <name>\n
 * data: <json>\n\n`. Trailing blank line is REQUIRED by the SSE spec
 * — without it the consumer never sees the event.
 */
export function serializeSSE(event: CopilotSSEEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * Sink interface the agent loop calls. The route layer wires this to
 * `res.write` plus a heartbeat timer; tests wire it to an in-memory
 * buffer.
 *
 * `emit` MUST be safe to call after the underlying socket has closed
 * — implementations should drop further writes silently (the loop
 * may still need to call emit during its abort cleanup).
 */
export interface CopilotSSESink {
  emit(event: CopilotSSEEvent): void;
}

/**
 * Buffer sink for tests + offline serialisation. `events` is the
 * accumulated list; `wireText()` joins them for snapshot/string
 * assertions.
 */
export class BufferedSSESink implements CopilotSSESink {
  readonly events: CopilotSSEEvent[] = [];
  emit(event: CopilotSSEEvent): void {
    this.events.push(event);
  }
  wireText(): string {
    return this.events.map(serializeSSE).join('');
  }
}
