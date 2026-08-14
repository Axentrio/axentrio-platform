import { AppDataSource } from '../database/data-source';
import { AgentTrace as AgentTraceEntity } from '../database/entities/AgentTrace';
import { logger } from '../utils/logger';
import type { PromptTrace } from '../llm/block-ledger';

export interface AgentTrace {
  sessionId: string;
  tenantId: string;
  messageId?: string;
  iterations: Array<{
    llmCall: { model: string; promptTokens: number; completionTokens: number; latencyMs: number };
    toolCalls: Array<{
      name: string;
      args: Record<string, unknown>;
      result: { success: boolean; error?: string; data?: unknown };
      latencyMs: number;
      confirmed?: boolean;
    }>;
  }>;
  finishReason: 'completed' | 'max_iterations' | 'budget_exceeded' | 'error';
  /** Prompt-build legibility record (which blocks the customer prompt received
   *  and why) — nests into the `trace` jsonb, no schema change. Absent on the
   *  RAG/legacy paths that don't run the agent composer. */
  prompt?: PromptTrace;
  /** WHY the run ended, not just the shape of the ending. See `TerminalOutcome`. */
  terminal?: TerminalOutcome;
}

/**
 * How a bot fault is told apart from a provider outage, after the fact.
 *
 * `finishReason: 'error'` says a run ended badly and nothing else. A production failure on
 * 2026-08-13 left exactly that and no way to choose between an exhausted platform key, upstream
 * throttling, a 30-second LLM timeout and a genuine fault in the run — five causes, one word, and
 * an operator with no next step. The distinction is not cosmetic: `upstream_*` is a platform
 * emergency affecting every tenant at once, `bot_fault` is one conversation going wrong.
 */
export type TerminalErrorKind =
  | 'upstream_quota'
  | 'upstream_rate_limit'
  | 'upstream_server_error'
  | 'upstream_unreachable'
  | 'llm_timeout'
  | 'bot_fault';

export interface TerminalOutcome {
  /** Mirrors the returned union's `type`, so the record and the reply cannot disagree. */
  result: 'completed' | 'max_iterations' | 'budget_exceeded' | 'error';
  /**
   * Present only when `result` is `error`.
   *
   * The message is the provider's or the thrown error's own words, TRUNCATED and never a stack:
   * this column is read by support, and an unbounded error string is how a payload ends up in an
   * audit table. It is deliberately absent from every customer-facing path — the fallback the
   * customer reads is the tenant's own wording and must stay that way.
   */
  error?: { kind: TerminalErrorKind; message: string };
}

/** Errors are operator-facing, not a place to spool a payload into the audit table. */
const MAX_ERROR_CHARS = 500;

export function terminalErrorFrom(error: unknown, kind: TerminalErrorKind): TerminalOutcome['error'] {
  const message = error instanceof Error ? error.message : String(error);
  return { kind, message: message.slice(0, MAX_ERROR_CHARS) };
}

const PII_FIELDS = ['email', 'attendeeemail', 'attendee_email', 'phone', 'phonenumber'];

function maskPiiInArgs(args: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...args };
  for (const [key, value] of Object.entries(masked)) {
    if (typeof value === 'string' && PII_FIELDS.includes(key.toLowerCase())) {
      if (value.includes('@')) {
        const [local, domain] = value.split('@');
        masked[key] = `${local[0]}${'*'.repeat(Math.max(local.length - 1, 2))}@${domain}`;
      } else {
        masked[key] = value.slice(0, 2) + '*'.repeat(Math.max(value.length - 2, 4));
      }
    }
  }
  return masked;
}

export class TraceLogger {
  async save(trace: AgentTrace): Promise<void> {
    try {
      const totalTokens = trace.iterations.reduce(
        (sum, it) => sum + it.llmCall.promptTokens + it.llmCall.completionTokens,
        0,
      );
      const totalLatencyMs = trace.iterations.reduce(
        (sum, it) => sum + it.llmCall.latencyMs + it.toolCalls.reduce((s, tc) => s + tc.latencyMs, 0),
        0,
      );

      const sanitizedTrace = {
        ...trace,
        iterations: trace.iterations.map((it) => ({
          ...it,
          toolCalls: it.toolCalls.map((tc) => ({
            ...tc,
            args: maskPiiInArgs(tc.args),
          })),
        })),
      };

      const repo = AppDataSource.getRepository(AgentTraceEntity);
      await repo.save(
        repo.create({
          tenantId: trace.tenantId,
          sessionId: trace.sessionId,
          messageId: trace.messageId,
          trace: sanitizedTrace,
          totalTokens,
          totalLatencyMs,
          finishReason: trace.finishReason,
        }),
      );
    } catch (error) {
      // Escalated from warn → error: the ledger is an audit trail, so a dropped
      // save loses the record of what the customer prompt contained. Emit the
      // block keys so the decision is still recoverable from logs (L7).
      logger.error('Failed to save agent trace (prompt-build audit record lost)', {
        sessionId: trace.sessionId,
        tenantId: trace.tenantId,
        includedBlocks: trace.prompt?.includedBlocks,
        excludedBlocks: trace.prompt?.excludedBlocks,
        error,
      });
    }
  }
}
