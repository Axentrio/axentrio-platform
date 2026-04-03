import type { ToolAdapter, ToolContext, ToolResult } from '../tool-adapter';
import { searchKnowledge } from '../../llm/rag.service';

export class KbSearchTool implements ToolAdapter {
  name = 'kb_search';
  description = 'Search the knowledge base for information relevant to the customer query.';
  parameters = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to find relevant knowledge base articles.',
      },
    },
    required: ['query'],
  };
  hasSideEffects = false;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const query = args.query as string;
      const result = await searchKnowledge(
        ctx.dataSource,
        ctx.tenantId,
        query,
        ctx.conversationHistory.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
      );
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Knowledge base search failed' };
    }
  }
}
