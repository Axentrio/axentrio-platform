import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cosmetic follow-up to RenameAgentsToSupportAgents1781100000000.
 * Postgres doesn't rename PK/UQ constraint names when you rename a table,
 * so `support_agents` still had `PK_agents` and `UQ_agents_user_id`.
 * Renaming the constraints also renames their backing indexes.
 */
export class RenameSupportAgentsConstraints1781200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "support_agents" RENAME CONSTRAINT "PK_agents" TO "PK_support_agents"`);
    await queryRunner.query(`ALTER TABLE "support_agents" RENAME CONSTRAINT "UQ_agents_user_id" TO "UQ_support_agents_user_id"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "support_agents" RENAME CONSTRAINT "UQ_support_agents_user_id" TO "UQ_agents_user_id"`);
    await queryRunner.query(`ALTER TABLE "support_agents" RENAME CONSTRAINT "PK_support_agents" TO "PK_agents"`);
  }
}
