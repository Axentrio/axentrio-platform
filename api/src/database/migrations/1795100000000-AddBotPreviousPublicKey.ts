import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Dual-key widget rotation: the current `public_key` stays in the embed snippet,
 * and the previous key keeps resolving for a grace window so customers do not
 * have to re-embed on every rotate.
 */
export class AddBotPreviousPublicKey1795100000000 implements MigrationInterface {
  name = 'AddBotPreviousPublicKey1795100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_bots"
        ADD COLUMN "previous_public_key" character varying(255),
        ADD COLUMN "previous_public_key_expires_at" timestamptz,
        ADD COLUMN "previous_public_key_last_used_at" timestamptz
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_chatbot_bots_previous_public_key"
        ON "chatbot_bots" ("previous_public_key")
        WHERE "previous_public_key" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_chatbot_bots_previous_public_key"`);
    await queryRunner.query(`
      ALTER TABLE "chatbot_bots"
        DROP COLUMN "previous_public_key_last_used_at",
        DROP COLUMN "previous_public_key_expires_at",
        DROP COLUMN "previous_public_key"
    `);
  }
}
