/**
 * Resolve the KnowledgeBase ids attached to a Bot (multi-bot RAG scoping).
 * Reads the chatbot_bot_knowledge_bases join table.
 */
import { DataSource } from 'typeorm';

export async function getBotKnowledgeBaseIds(
  dataSource: DataSource,
  botId: string,
): Promise<string[]> {
  const rows: Array<{ knowledge_base_id: string }> = await dataSource.query(
    'SELECT knowledge_base_id FROM chatbot_bot_knowledge_bases WHERE bot_id = $1',
    [botId],
  );
  return rows.map((r) => r.knowledge_base_id);
}
