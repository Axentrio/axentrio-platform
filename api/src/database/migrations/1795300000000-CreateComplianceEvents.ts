import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Compliance proof that outlives the 90-day audit window.
 *
 * `audit_logs` is the security trail and is swept at AUDIT_RETENTION_DAYS. The
 * proof that a retention sweep ran, or that a data subject's erasure was
 * executed, is routinely needed long after that — and it used to be deleted with
 * the login noise. Separate table, separate period.
 */
export class CreateComplianceEvents1795300000000 implements MigrationInterface {
  name = 'CreateComplianceEvents1795300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "compliance_events" (
        "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
        "tenant_id" uuid,
        "actor_id" varchar(100) NOT NULL,
        "event_type" varchar(100) NOT NULL,
        "subject_type" varchar(50),
        "subject_id" varchar(255),
        "details" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_compliance_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_compliance_events_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_compliance_events_tenant_created"
         ON "compliance_events" ("tenant_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_compliance_events_type_created"
         ON "compliance_events" ("event_type", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "compliance_events"`);
  }
}
