import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-channel bot routing: let a channel connection target a specific bot.
 *
 * Nullable `botId` on `channel_connections`. NULL → inbound messages fall back
 * to the tenant's anchor bot (current behaviour). FK `ON DELETE SET NULL` so
 * deleting a bot quietly reverts its channels to the anchor rather than failing.
 */
export class AddBotIdToChannelConnection1784800000000 implements MigrationInterface {
  name = 'AddBotIdToChannelConnection1784800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "channel_connections" ADD COLUMN IF NOT EXISTS "botId" uuid`);
    await queryRunner.query(`
      ALTER TABLE "channel_connections"
        ADD CONSTRAINT "FK_channel_connections_bot"
        FOREIGN KEY ("botId") REFERENCES "chatbot_bots"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_channel_conn_bot" ON "channel_connections" ("botId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_channel_conn_bot"`);
    await queryRunner.query(
      `ALTER TABLE "channel_connections" DROP CONSTRAINT IF EXISTS "FK_channel_connections_bot"`,
    );
    await queryRunner.query(`ALTER TABLE "channel_connections" DROP COLUMN IF EXISTS "botId"`);
  }
}
