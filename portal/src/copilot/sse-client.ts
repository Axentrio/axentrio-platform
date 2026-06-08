/**
 * Streaming Copilot client over fetch + ReadableStream.
 *
 * Two-phase contract (server plan PR7 + round 6 #7):
 *
 *   Phase 1 — pre-stream status check:
 *     - 200  → response.body is SSE; fall through to phase 2
 *     - 402  → parse JSON, throw CopilotPlanGateError so caller can
 *               render <CopilotLockedPreview /> (NOT a toast — Q9 UX)
 *     - 429  → throw CopilotRateLimitedError carrying retryAfter so
 *               caller renders an inline transcript row (NOT a toast)
 *     - else → throw CopilotApiError for the global toast pipeline
 *
 *   Phase 2 — stream parse:
 *     - Async-iterates CopilotSseEvent objects until the body ends
 *     - Honours the AbortSignal (drawer close, navigation, retry)
 *
 * Why not EventSource? EventSource is GET-only and can't carry a
 * POST body or Authorization headers — both of which we need.
 */
import { API_CONFIG } from '@config/api.config';

export type CopilotSseEvent =
  | { event: 'token'; data: { text: string } }
  | { event: 'tool_call_start'; data: { name: string } }
  | { event: 'tool_call_end'; data: { name: string; outcome: 'success' | 'error' } }
  | { event: 'heartbeat'; data: Record<string, never> }
  | {
      event: 'error';
      data: {
        code: 'llm_provider_rate_limit' | 'llm_error' | 'agent_loop_exceeded' | 'aborted';
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

export class CopilotApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'CopilotApiError';
  }
}

export class CopilotPlanGateError extends CopilotApiError {
  constructor(body: unknown) {
    super(402, 'plan_limit_platform_assistant', 'Pro plan required for Copilot', body);
    this.name = 'CopilotPlanGateError';
  }
}

export class CopilotRateLimitedError extends CopilotApiError {
  constructor(
    code: 'copilot_daily_cap_exceeded' | 'copilot_rate_limit_exceeded',
    message: string,
    public readonly retryAfterSeconds: number,
    body: unknown,
  ) {
    super(429, code, message, body);
    this.name = 'CopilotRateLimitedError';
  }
}

interface StreamArgs {
  message: string;
  locale?: 'en' | 'nl' | 'fr';
  signal: AbortSignal;
  /** Returns a Clerk session token. Same plumbing the axios client uses. */
  getToken: () => Promise<string | null>;
}

export async function* streamCopilotMessages(
  args: StreamArgs,
): AsyncGenerator<CopilotSseEvent, void, unknown> {
  const token = await args.getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const url = `${API_CONFIG.baseURL}/copilot/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: args.message, locale: args.locale }),
    signal: args.signal,
  });

  // --- Phase 1: status check ---
  if (!response.ok) {
    let body: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // Non-JSON body (HTML 502 from edge, etc) — fall through with empty body.
    }
    const code = body.error?.code ?? 'unknown_error';
    const message = body.error?.message ?? `Copilot request failed (HTTP ${response.status})`;

    if (response.status === 402 && code === 'plan_limit_platform_assistant') {
      throw new CopilotPlanGateError(body);
    }
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : 60;
      const narrowedCode =
        code === 'copilot_daily_cap_exceeded' || code === 'copilot_rate_limit_exceeded'
          ? code
          : 'copilot_rate_limit_exceeded';
      throw new CopilotRateLimitedError(narrowedCode, message, retryAfter || 60, body);
    }
    throw new CopilotApiError(response.status, code, message, body);
  }

  // --- Phase 2: stream parse ---
  if (!response.body) {
    throw new CopilotApiError(0, 'empty_stream', 'Copilot response had no body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- SSE stream must be read sequentially in order
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      // SSE event framing: events are separated by blank lines.
      let sepIdx: number;
      while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        const parsed = parseSseFrame(frame);
        if (parsed) yield parsed;
      }
    }
  } finally {
    // Ensure the reader is released even on consumer break.
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

function parseSseFrame(frame: string): CopilotSseEvent | null {
  let eventName: string | null = null;
  let dataLine: string | null = null;
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLine = (dataLine ?? '') + line.slice(5).trim();
  }
  if (!eventName) return null;
  try {
    const data = dataLine ? JSON.parse(dataLine) : {};
    return { event: eventName, data } as CopilotSseEvent;
  } catch {
    return null;
  }
}
