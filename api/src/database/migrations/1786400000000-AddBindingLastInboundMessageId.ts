import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBindingLastInboundMessageId1786400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Stash the latest inbound platform message id so channels that key a typing
    // indicator to a message_id (WhatsApp) can show "typing…" while the bot replies.
    await queryRunner.query(`
      ALTER TABLE "conversation_bindings"
      ADD COLUMN IF NOT EXISTS "lastInboundMessageId" varchar(255)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_bindings" DROP COLUMN IF EXISTS "lastInboundMessageId"`,
    );
  }
}
