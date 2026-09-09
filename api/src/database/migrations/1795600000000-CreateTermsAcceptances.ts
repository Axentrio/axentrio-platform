import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Accepted-terms record. Nothing recorded which version of the Terms a customer
 * agreed to, when, or by whom — so the contract being enforced was the one we
 * could not show.
 */
export class CreateTermsAcceptances1795600000000 implements MigrationInterface {
  name = 'CreateTermsAcceptances1795600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "terms_acceptances" (
        "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
        "tenant_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "terms_version" varchar(32) NOT NULL,
        "accepted_at" timestamptz NOT NULL DEFAULT now(),
        "ip_address" varchar(45),
        "user_agent" varchar(255),
        CONSTRAINT "PK_terms_acceptances" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_terms_acceptances_subject_version" UNIQUE ("tenant_id", "user_id", "terms_version"),
        CONSTRAINT "FK_terms_acceptances_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_terms_acceptances_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "terms_acceptances"`);
  }
}
