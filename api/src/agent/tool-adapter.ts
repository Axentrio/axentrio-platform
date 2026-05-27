import type { DataSource } from 'typeorm';
import type { ChatMessage } from '../llm/llm.types';

export interface ToolContext {
  tenantId: string;
  sessionId: string;
  runId: string;
  toolsCalledThisTurn: string[];
  dataSource: DataSource;
  conversationHistory: ChatMessage[];
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ToolAdapter {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  hasSideEffects: boolean;
  preconditions?: { toolsCalled?: string[] };
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
