import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SV — optional discount layer on top of the configured service price.
 *
 * A separate, per-service discount that the backend applies to the list price. Every
 * column defaults to off/null so existing rows keep quoting their list price with no
 * behaviour change. `mention_discount_in_chat` gates whether the assistant may present
 * the reduction AS a discount; when off it quotes only the final price.
 */
export class AddServiceDiscount1793400000000 implements MigrationInterface {
  name = 'AddServiceDiscount1793400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        ADD COLUMN IF NOT EXISTS "discount_enabled" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "discount_type" varchar(16),
        ADD COLUMN IF NOT EXISTS "discount_value" numeric(10,2),
        ADD COLUMN IF NOT EXISTS "discount_start_on" date,
        ADD COLUMN IF NOT EXISTS "discount_end_on" date,
        ADD COLUMN IF NOT EXISTS "mention_discount_in_chat" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        DROP COLUMN IF EXISTS "discount_enabled",
        DROP COLUMN IF EXISTS "discount_type",
        DROP COLUMN IF EXISTS "discount_value",
        DROP COLUMN IF EXISTS "discount_start_on",
        DROP COLUMN IF EXISTS "discount_end_on",
        DROP COLUMN IF EXISTS "mention_discount_in_chat"
    `);
  }
}
