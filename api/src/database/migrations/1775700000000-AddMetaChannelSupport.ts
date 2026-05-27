import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMetaChannelSupport1775700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Partial unique index for Meta channels only
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_channel_conn_platform_channel_meta"
      ON "channel_connections" ("platformAccountId", "channel")
      WHERE "channel" IN ('messenger', 'instagram') AND "status" = 'active'
    `);

    // Add lastInboundAt to conversation_bindings
    await queryRunner.query(`
      ALTER TABLE "conversation_bindings"
      ADD COLUMN "lastInboundAt" timestamp
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "conversation_bindings" DROP COLUMN IF EXISTS "lastInboundAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_channel_conn_platform_channel_meta"`);
  }
}
