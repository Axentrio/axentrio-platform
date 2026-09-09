import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Legal holds: the Art 17(3)(e) exception, made explicit.
 *
 * The retention sweeps previously had no way to exempt anything, so a dispute that
 * needed a specific conversation preserved could only be served by switching the
 * retention period off for the whole tenant — which keeps everything, forever.
 */
export class CreateLegalHolds1795500000000 implements MigrationInterface {
  name = 'CreateLegalHolds1795500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "legal_holds" (
        "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
        "tenant_id" uuid NOT NULL,
        "reason" text NOT NULL,
        "scope" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "opened_by" uuid NOT NULL,
        "opened_at" timestamptz NOT NULL DEFAULT now(),
        "review_due_at" timestamptz NOT NULL,
        "released_at" timestamptz,
        "released_by" uuid,
        "release_reason" text,
        CONSTRAINT "PK_legal_holds" PRIMARY KEY ("id"),
        CONSTRAINT "FK_legal_holds_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);
    // The sweeps ask one question per candidate row: is there an ACTIVE hold for
    // this tenant? A partial index keeps that answer cheap.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_legal_holds_active"
         ON "legal_holds" ("tenant_id")
         WHERE "released_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "legal_holds"`);
  }
}
