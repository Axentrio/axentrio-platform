import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAgentTables1780100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "tool_definitions" (
        "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
        "tenantId" uuid NOT NULL,
        "name" varchar(100) NOT NULL,
        "description" text,
        "handlerType" varchar(20) NOT NULL CHECK ("handlerType" IN ('webhook', 'n8n')),
        "handlerConfig" jsonb NOT NULL DEFAULT '{}',
        "parametersSchema" jsonb NOT NULL DEFAULT '{}',
        "hasSideEffects" boolean NOT NULL DEFAULT false,
        "preconditions" jsonb,
        "enabled" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tool_definitions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_tool_definitions_tenant_name" UNIQUE ("tenantId", "name"),
        CONSTRAINT "FK_tool_definitions_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_tool_definitions_tenant_enabled"
        ON "tool_definitions" ("tenantId")
        WHERE "enabled" = true
    `);

    await queryRunner.query(`
      CREATE TABLE "agent_traces" (
        "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
        "tenantId" uuid NOT NULL,
        "sessionId" uuid,
        "messageId" uuid,
        "trace" jsonb NOT NULL DEFAULT '{}',
        "totalTokens" integer,
        "totalLatencyMs" integer,
        "finishReason" varchar(30),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_traces" PRIMARY KEY ("id"),
        CONSTRAINT "FK_agent_traces_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_agent_traces_tenant_created" ON "agent_traces" ("tenantId", "createdAt" DESC)`);
    await queryRunner.query(`CREATE INDEX "IDX_agent_traces_session_created" ON "agent_traces" ("sessionId", "createdAt" DESC)`);

    await queryRunner.query(`
      CREATE TABLE "tenant_usage" (
        "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
        "tenantId" uuid NOT NULL,
        "date" date NOT NULL,
        "promptTokens" integer NOT NULL DEFAULT 0,
        "completionTokens" integer NOT NULL DEFAULT 0,
        "totalTokens" integer NOT NULL DEFAULT 0,
        "llmCalls" integer NOT NULL DEFAULT 0,
        "toolCalls" integer NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tenant_usage" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_tenant_usage_tenant_date" UNIQUE ("tenantId", "date"),
        CONSTRAINT "FK_tenant_usage_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "tenant_usage"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_traces"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tool_definitions"`);
  }
}
