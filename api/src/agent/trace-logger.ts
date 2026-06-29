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
