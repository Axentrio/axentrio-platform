import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateCustomerMemory1793500000000 implements MigrationInterface {
  name = "CreateCustomerMemory1793500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_customer_memory" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "subject_key" varchar(400) NOT NULL,
        "person_key" varchar(400) NULL,
        "channel" varchar(32) NULL,
        "first_seen_at" timestamptz NOT NULL DEFAULT now(),
        "last_seen_at" timestamptz NOT NULL DEFAULT now(),
        "session_count" int NOT NULL DEFAULT 0,
        "live_fact_count" int NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_chatbot_customer_memory" PRIMARY KEY ("id"),
        CONSTRAINT "fk_chatbot_customer_memory_tenant"
          FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chatbot_customer_memory_subject"
        ON "chatbot_customer_memory" ("tenant_id", "subject_key")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_chatbot_customer_memory_person"
        ON "chatbot_customer_memory" ("tenant_id", "person_key")
        WHERE "person_key" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_chatbot_customer_memory_last_seen"
        ON "chatbot_customer_memory" ("last_seen_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_customer_facts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "memory_id" uuid NOT NULL,
        "fact_key" varchar(48) NOT NULL,
        "value_enc" text NOT NULL,
        "value_encrypted" boolean NOT NULL DEFAULT true,
        "confidence" smallint NOT NULL,
        "evidence_message_id" uuid NULL,
        "evidence_span" text NULL,
        "source_session_id" uuid NULL,
        "model" varchar(64) NOT NULL,
        "prompt_version" varchar(32) NOT NULL,
        "extraction_version" int NOT NULL,
        "first_seen_at" timestamptz NOT NULL DEFAULT now(),
        "last_confirmed_at" timestamptz NOT NULL DEFAULT now(),
        "superseded_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_chatbot_customer_facts" PRIMARY KEY ("id"),
        CONSTRAINT "fk_chatbot_customer_facts_tenant"
          FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_chatbot_customer_facts_memory"
          FOREIGN KEY ("memory_id") REFERENCES "chatbot_customer_memory"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_chatbot_customer_facts_session"
          FOREIGN KEY ("source_session_id") REFERENCES "chat_sessions"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chatbot_customer_facts_live"
        ON "chatbot_customer_facts" ("memory_id", "fact_key")
        WHERE "superseded_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_chatbot_customer_facts_key"
        ON "chatbot_customer_facts" ("tenant_id", "fact_key")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_customer_memory_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "session_id" uuid NOT NULL,
        "memory_id" uuid NULL,
        "state" varchar(24) NOT NULL DEFAULT 'pending',
        "attempts" int NOT NULL DEFAULT 0,
        "claimed_until" timestamptz NULL,
        "next_attempt_at" timestamptz NULL,
        "last_error" text NULL,
        "extracted_revision" int NULL,
        "facts_written" int NOT NULL DEFAULT 0,
        "model" varchar(64) NULL,
        "prompt_version" varchar(32) NULL,
        "extraction_version" int NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_chatbot_customer_memory_runs" PRIMARY KEY ("id"),
        CONSTRAINT "fk_chatbot_customer_memory_runs_tenant"
          FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_chatbot_customer_memory_runs_session"
          FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_chatbot_customer_memory_runs_memory"
          FOREIGN KEY ("memory_id") REFERENCES "chatbot_customer_memory"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chatbot_customer_memory_runs_session"
        ON "chatbot_customer_memory_runs" ("session_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_chatbot_customer_memory_runs_due"
        ON "chatbot_customer_memory_runs" ("state", "next_attempt_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ix_chatbot_customer_memory_runs_due"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_chatbot_customer_memory_runs_session"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ix_chatbot_customer_facts_key"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_chatbot_customer_facts_live"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ix_chatbot_customer_memory_last_seen"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ix_chatbot_customer_memory_person"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_chatbot_customer_memory_subject"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "chatbot_customer_memory_runs"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_customer_facts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_customer_memory"`);
  }
}
