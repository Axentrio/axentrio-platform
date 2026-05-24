import type { ToolAdapter, ToolContext, ToolResult } from '../tool-adapter';
import { searchKnowledge } from '../../llm/rag.service';
import { getBotKnowledgeBaseIds } from '../../knowledge/bot-knowledge-bases';

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
      // Multi-bot: scope retrieval to the session's bot's attached KBs.
      // Null botId (unattributed/legacy session) → tenant-wide (undefined).
      const sessionRows: Array<{ bot_id: string | null }> = await ctx.dataSource.query(
        'SELECT bot_id FROM chat_sessions WHERE id = $1 LIMIT 1',
        [ctx.sessionId],
      );
      const botId = sessionRows[0]?.bot_id ?? null;
      const botKbIds = botId ? await getBotKnowledgeBaseIds(ctx.dataSource, botId) : undefined;
      const result = await searchKnowledge(
        ctx.dataSource,
        ctx.tenantId,
        query,
        ctx.conversationHistory.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        undefined,
        botKbIds
      );
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Knowledge base search failed' };
    }
  }
}
