/**
 * Per-bot knowledge mode (multi-bot, "dedicated replaces shared").
 *
 * A bot's knowledge is either:
 *   - 'shared'    → attached to the tenant's primary KB (`botId IS NULL`); answers
 *                   from the org-wide documents managed in the Knowledge tab.
 *   - 'dedicated' → attached to its OWN KB (`botId = bot.id`); answers only from
 *                   that bot's documents.
 *
 * Switching is mutually exclusive: enabling dedicated detaches the shared KB,
 * and switching back re-attaches the shared KB. Switching back is non-destructive
 * — the dedicated KB and its documents are kept (just detached), so toggling
 * doesn't lose data; only explicit document deletion removes docs.
 */
import { In, IsNull, EntityManager } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { KnowledgeBase } from '../database/entities/KnowledgeBase';
import { BotKnowledgeBase } from '../database/entities/BotKnowledgeBase';

export type BotKnowledgeMode = 'shared' | 'dedicated';

export interface BotKnowledgeState {
  mode: BotKnowledgeMode;
  /** The active KB id (dedicated KB when dedicated, primary KB when shared). */
  kbId: string | null;
}

/** Inspect a bot's attached KBs to derive its knowledge mode + active KB id. */
export async function getBotKnowledgeState(tenantId: string, botId: string): Promise<BotKnowledgeState> {
  const attached = await AppDataSource.getRepository(BotKnowledgeBase).find({ where: { botId, tenantId } });
  if (attached.length === 0) return { mode: 'shared', kbId: null };

  const kbs = await AppDataSource.getRepository(KnowledgeBase).findBy({
    id: In(attached.map((a) => a.knowledgeBaseId)),
  });
  const dedicated = kbs.find((k) => k.botId === botId);
  if (dedicated) return { mode: 'dedicated', kbId: dedicated.id };
  const primary = kbs.find((k) => k.botId === null);
  return { mode: 'shared', kbId: primary ? primary.id : null };
}

/** Switch a bot to its own dedicated KB: create/reuse it, attach, detach the shared KB. */
export async function enableDedicatedKb(tenantId: string, botId: string): Promise<BotKnowledgeState> {
  return AppDataSource.transaction(async (m: EntityManager) => {
    const kbRepo = m.getRepository(KnowledgeBase);
    let kb = await kbRepo.findOne({ where: { tenantId, botId } });
    if (!kb) kb = await kbRepo.save(kbRepo.create({ tenantId, botId, status: 'inactive' }));

    await m
      .createQueryBuilder()
      .insert()
      .into(BotKnowledgeBase)
      .values({ botId, knowledgeBaseId: kb.id, tenantId })
      .orIgnore()
      .execute();

    // Detach every other KB from this bot (i.e. the shared primary KB).
    await m
      .createQueryBuilder()
      .delete()
      .from(BotKnowledgeBase)
      .where('bot_id = :botId AND knowledge_base_id != :kbId', { botId, kbId: kb.id })
      .execute();

    return { mode: 'dedicated', kbId: kb.id };
  });
}

/** Switch a bot back to the shared primary KB. Keeps the dedicated KB + its docs (detached). */
export async function disableDedicatedKb(tenantId: string, botId: string): Promise<BotKnowledgeState> {
  return AppDataSource.transaction(async (m: EntityManager) => {
    const kbRepo = m.getRepository(KnowledgeBase);
    let primary = await kbRepo.findOne({ where: { tenantId, botId: IsNull() } });
    if (!primary) primary = await kbRepo.save(kbRepo.create({ tenantId, botId: null, status: 'inactive' }));

    await m
      .createQueryBuilder()
      .insert()
      .into(BotKnowledgeBase)
      .values({ botId, knowledgeBaseId: primary.id, tenantId })
      .orIgnore()
      .execute();

    // Detach the dedicated KB (kept for later re-enable; not deleted).
    const dedicated = await kbRepo.findOne({ where: { tenantId, botId } });
    if (dedicated) {
      await m
        .createQueryBuilder()
        .delete()
        .from(BotKnowledgeBase)
        .where('bot_id = :botId AND knowledge_base_id = :kbId', { botId, kbId: dedicated.id })
        .execute();
    }

    return { mode: 'shared', kbId: primary.id };
  });
}
