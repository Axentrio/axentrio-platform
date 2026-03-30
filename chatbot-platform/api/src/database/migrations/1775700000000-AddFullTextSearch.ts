import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFullTextSearch1775700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS tsv tsvector`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_tsv ON knowledge_chunks USING gin(tsv)`);
    await queryRunner.query(`UPDATE knowledge_chunks SET tsv = to_tsvector('english', content) WHERE tsv IS NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_knowledge_chunks_tsv`);
    await queryRunner.query(`ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS tsv`);
  }
}
