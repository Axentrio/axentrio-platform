import { AppDataSource } from '../database/data-source';
import { logger } from '../utils/logger';

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

      const repo = AppDataSource.getRepository('agent_traces');
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
      logger.warn('Failed to save agent trace', { sessionId: trace.sessionId, error });
    }
  }
}
