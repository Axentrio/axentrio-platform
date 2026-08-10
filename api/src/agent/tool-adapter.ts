import type { DataSource } from 'typeorm';
import type { ChatMessage } from '../llm/llm.types';

export interface ToolContext {
  tenantId: string;
  sessionId: string;
  runId: string;
  toolsCalledThisTurn: string[];
  dataSource: DataSource;
  conversationHistory: ChatMessage[];
  /** SpecialtyCatalog S5: selected-specialty aliases/tags that bias KB retrieval
   *  (embedding only). Set by agent.service; absent ⇒ no bias. */
  specialtyTerms?: string[];
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /** R31: set true ONLY for a tool-authored DOMAIN error that is safe to show the
   *  model (e.g. "no availability that day", "service not found"). An UNMARKED
   *  error is treated as a potentially-raw infrastructure exception and is
   *  sanitized to a generic message before it reaches the model — the raw text is
   *  kept in logs/trace only. Secure-by-default: omit ⇒ sanitized. */
  errorSafeForModel?: boolean;
  /**
   * Measurement that must NEVER reach the model.
   *
   * `data` is serialised straight into the tool message, and that message is truncated at 4000
   * characters - so a measurement blob on `data` does not merely waste tokens, it can cut the
   * payload the model actually needs. It would also put vocabulary like "preferred" and "cost"
   * in front of a model that is meant to be unaware any scoring happened (#81 is shadow).
   */
  measurement?: unknown;
}

export interface ToolAdapter {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  hasSideEffects: boolean;
  preconditions?: { toolsCalled?: string[] };
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
