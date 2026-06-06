/**
 * Executes the BackfillSharedKbAttachments migration's up() against the real
 * test DB. This is the guard that was missing when the migration shipped with
 * untyped `NULL`/`status` literals that crashed on boot — the integration tests
 * used the schema directly and never ran the migration SQL.
 */
import { describe, it, expect } from 'vitest';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { KnowledgeBase } from '../../database/entities/KnowledgeBase';
import { BotKnowledgeBase } from '../../database/entities/BotKnowledgeBase';
import { BackfillSharedKbAttachments1784700000000 } from '../../database/migrations/1784700000000-BackfillSharedKbAttachments';
import { createTestTenant, createTestAnchorBot } from '../helpers/factories';

describe('BackfillSharedKbAttachments migration', () => {
  it('attaches the tenant primary KB to a bot that has none, and is idempotent', async () => {
    const tenant = await createTestTenant();
    const bot = await createTestAnchorBot(tenant);

    // Precondition: the freshly-created bot has no KB attachment.
    const before = await AppDataSource.getRepository(BotKnowledgeBase).find({ where: { botId: bot.id } });
    expect(before).toHaveLength(0);

    const migration = new BackfillSharedKbAttachments1784700000000();
    const qr = AppDataSource.createQueryRunner();
    try {
      await qr.connect();
      await migration.up(qr); // must not throw (the prod crash was a type error here)
      await migration.up(qr); // idempotent re-run
    } finally {
      await qr.release();
    }

    // A primary (bot-less) KB now exists for the tenant...
    const primary = await AppDataSource.getRepository(KnowledgeBase).findOne({
      where: { tenantId: tenant.id, botId: IsNull() },
    });
    expect(primary).not.toBeNull();

    // ...and the bot is attached to it exactly once (idempotent).
    const after = await AppDataSource.getRepository(BotKnowledgeBase).find({ where: { botId: bot.id } });
    expect(after).toHaveLength(1);
    expect(after[0].knowledgeBaseId).toBe(primary!.id);
  });
});
