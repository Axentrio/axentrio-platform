import { MigrationInterface, QueryRunner } from 'typeorm';

export class BackfillQuotedAddress1792700000000 implements MigrationInterface {
  name = 'BackfillQuotedAddress1792700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "chatbot_bots"
         SET "settings" = "settings" - 'quotedAddress',
             "updated_at" = now()
       WHERE "settings" @> '{"quotedAddress":{"enabled":false}}'::jsonb
    `);
  }

  public async down(): Promise<void> {
    // Irreversible: legacy defaults cannot be distinguished from later owner choices.
  }
}
