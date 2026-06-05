/**
 * Shared-knowledge attachment for bots (multi-bot config editing).
 *
 * Every bot retrieves only from its attached KnowledgeBases (see
 * `getBotKnowledgeBaseIds` / `kb-search.tool`). Until per-bot KB management
 * ships, all bots share the tenant's primary KB (`botId IS NULL`) so a created
 * bot answers from the same documents instead of an empty set.
 *
 * Used by bot creation (`POST /bots`) and anchor auto-provision. Both run inside
 * a transaction, so this takes the caller's `EntityManager`. Conflict-safe and
 * idempotent: re-running attaches nothing twice.
 */
import { EntityManager, IsNull } from 'typeorm';
import { KnowledgeBase } from '../database/entities/KnowledgeBase';
import { BotKnowledgeBase } from '../database/entities/BotKnowledgeBase';

/**
 * Ensure the tenant's primary KB exists and is attached to `botId`.
 * @returns the primary KnowledgeBase id.
 */
export async function ensureSharedKbAttached(
  manager: EntityManager,
  tenantId: string,
  botId: string,
): Promise<string> {
  // 1. Ensure the tenant-primary (bot-less) KB exists. `orIgnore()` emits a
  //    targetless `ON CONFLICT DO NOTHING`, safe against the `botId IS NULL`
  //    partial-unique index and a concurrent create.
  let primary = await manager.findOne(KnowledgeBase, { where: { tenantId, botId: IsNull() } });
  if (!primary) {
    await manager
      .createQueryBuilder()
      .insert()
      .into(KnowledgeBase)
      .values({ tenantId, botId: null, status: 'inactive' })
      .orIgnore()
      .execute();
    primary = await manager.findOne(KnowledgeBase, { where: { tenantId, botId: IsNull() } });
  }
  if (!primary) {
    throw new Error(`Failed to resolve primary KnowledgeBase for tenant ${tenantId}`);
  }

  // 2. Attach to the bot. The join PK `(bot_id, knowledge_base_id)` makes the
  //    `ON CONFLICT DO NOTHING` re-attach a no-op.
  await manager
    .createQueryBuilder()
    .insert()
    .into(BotKnowledgeBase)
    .values({ botId, knowledgeBaseId: primary.id, tenantId })
    .orIgnore()
    .execute();

  return primary.id;
}
