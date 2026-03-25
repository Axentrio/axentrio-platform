import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddParticipantSoftDelete1774456216131 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE participants
      ADD COLUMN is_deleted BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN deleted_at TIMESTAMP NULL
    `);
    await queryRunner.query(`
      CREATE INDEX idx_participants_active
      ON participants (session_id)
      WHERE is_deleted = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_participants_active`);
    await queryRunner.query(`
      ALTER TABLE participants
      DROP COLUMN IF EXISTS deleted_at,
      DROP COLUMN IF EXISTS is_deleted
    `);
  }
}
