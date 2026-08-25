import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Links a Gap to the knowledge document that answers it.
 *
 * `ON DELETE SET NULL`, not CASCADE: deleting the document must not delete the Gap. The
 * FK IS the answered flag - the API and the portal both gate on `answer_document_id`, so
 * removing the document on the Knowledge page makes the Gap answerable again, which is
 * the truth (the topic is unanswered once the text is gone). `answered_at` is kept for
 * the audit trail and for before/after measurement; nothing gates on it.
 */
export class AddGapAnswer1793200000000 implements MigrationInterface {
  name = 'AddGapAnswer1793200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_gaps"
        ADD COLUMN IF NOT EXISTS "answer_document_id" uuid,
        ADD COLUMN IF NOT EXISTS "answered_at" timestamptz
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_chatbot_gaps_answer_document'
        ) THEN
          ALTER TABLE "chatbot_gaps"
            ADD CONSTRAINT "FK_chatbot_gaps_answer_document"
            FOREIGN KEY ("answer_document_id")
            REFERENCES "knowledge_documents"("id") ON DELETE SET NULL;
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chatbot_gaps" DROP CONSTRAINT IF EXISTS "FK_chatbot_gaps_answer_document"`,
    );
    await queryRunner.query(`
      ALTER TABLE "chatbot_gaps"
        DROP COLUMN IF EXISTS "answered_at",
        DROP COLUMN IF EXISTS "answer_document_id"
    `);
  }
}
