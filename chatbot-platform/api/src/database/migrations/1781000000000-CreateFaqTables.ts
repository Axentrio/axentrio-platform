import { MigrationInterface, QueryRunner } from 'typeorm';
import { INITIAL_FAQ_SEED } from '../seeds/faq-initial.seed';

export class CreateFaqTables1781000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "faq_sections" (
        "id" varchar(64) NOT NULL,
        "position" int NOT NULL,
        "isReserved" boolean NOT NULL DEFAULT false,
        "titles" jsonb NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_faq_sections" PRIMARY KEY ("id"),
        CONSTRAINT "CK_faq_sections_id_kebab"
          CHECK ("id" ~ '^[a-z]([a-z0-9-]*[a-z0-9])?$'),
        CONSTRAINT "CK_faq_sections_titles_shape"
          CHECK (
            jsonb_typeof("titles") = 'object'
            AND "titles" ? 'en'
            AND length("titles"->>'en') > 0
          )
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_faq_sections_position" ON "faq_sections" ("position")`);

    await queryRunner.query(`
      CREATE TABLE "faq_items" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "sectionId" varchar(64) NOT NULL,
        "slug" varchar(80) NOT NULL,
        "position" int NOT NULL,
        "question" jsonb NOT NULL,
        "answer" jsonb NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_faq_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_faq_items_section" FOREIGN KEY ("sectionId")
          REFERENCES "faq_sections"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_faq_items_section_slug" UNIQUE ("sectionId", "slug"),
        CONSTRAINT "CK_faq_items_slug_kebab"
          CHECK ("slug" ~ '^[a-z]([a-z0-9-]*[a-z0-9])?$'),
        CONSTRAINT "CK_faq_items_question_shape"
          CHECK (
            jsonb_typeof("question") = 'object'
            AND "question" ? 'en'
            AND length("question"->>'en') > 0
          ),
        CONSTRAINT "CK_faq_items_answer_shape"
          CHECK (
            jsonb_typeof("answer") = 'object'
            AND "answer" ? 'en'
            AND length("answer"->>'en') > 0
          )
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_faq_items_section_position" ON "faq_items" ("sectionId", "position")`
    );

    // Seed initial content.
    for (const section of INITIAL_FAQ_SEED) {
      await queryRunner.query(
        `INSERT INTO "faq_sections" ("id", "position", "isReserved", "titles")
         VALUES ($1, $2, $3, $4::jsonb)`,
        [section.id, section.position, section.isReserved, JSON.stringify(section.titles)]
      );
      for (const item of section.items) {
        await queryRunner.query(
          `INSERT INTO "faq_items" ("sectionId", "slug", "position", "question", "answer")
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
          [
            section.id,
            item.slug,
            item.position,
            JSON.stringify(item.question),
            JSON.stringify(item.answer),
          ]
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "faq_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "faq_sections"`);
  }
}
