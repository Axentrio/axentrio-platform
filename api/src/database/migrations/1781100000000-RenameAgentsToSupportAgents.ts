import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Renames the `agents` table to `support_agents` to avoid a naming collision
 * with n8n (2.21+ creates its own `agents` table for AI Agent Builder).
 * Our table holds human handoff operators, not LLM agents — the new name
 * is also clearer.
 */
export class RenameAgentsToSupportAgents1781100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agents" RENAME TO "support_agents"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "support_agents" RENAME TO "agents"`);
  }
}
