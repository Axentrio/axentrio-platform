import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBotHandoffReasons1775300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // First check what the actual enum type name is
    const result = await queryRunner.query(`
      SELECT t.typname
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      WHERE e.enumlabel = 'user_request'
      LIMIT 1
    `);

    if (result.length === 0) return;
    const enumName = result[0].typname;

    // Add new enum values
    await queryRunner.query(`ALTER TYPE "${enumName}" ADD VALUE IF NOT EXISTS 'bot_escalation_keyword'`);
    await queryRunner.query(`ALTER TYPE "${enumName}" ADD VALUE IF NOT EXISTS 'bot_no_knowledge'`);
    await queryRunner.query(`ALTER TYPE "${enumName}" ADD VALUE IF NOT EXISTS 'bot_error'`);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL doesn't support removing enum values
  }
}
