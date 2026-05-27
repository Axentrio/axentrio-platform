import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateChannelTables1775500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "channel_connections" (
        "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
        "tenantId" uuid NOT NULL,
        "channel" varchar(20) NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'pending_setup',
        "label" varchar(255),
        "platformAccountId" varchar(255),
        "credentials" jsonb NOT NULL DEFAULT '{}',
        "webhookVerifyToken" varchar(255),
        "webhookSecret" varchar(255),
        "config" jsonb NOT NULL DEFAULT '{}',
        "scopes" text,
        "lastHealthCheckAt" timestamp,
        "lastError" varchar(500),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_channel_connections" PRIMARY KEY ("id"),
        CONSTRAINT "FK_channel_connections_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_channel_conn_tenant_channel" ON "channel_connections" ("tenantId", "channel")`);
    await queryRunner.query(`CREATE INDEX "IDX_channel_conn_tenant_channel_status" ON "channel_connections" ("tenantId", "channel", "status")`);

    await queryRunner.query(`
      CREATE TABLE "conversation_bindings" (
        "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
        "sessionId" uuid NOT NULL,
        "channelConnectionId" uuid NOT NULL,
        "externalUserId" varchar(255) NOT NULL,
        "externalThreadId" varchar(255) NOT NULL,
        "externalUserName" varchar(255),
        "externalAvatarUrl" varchar(500),
        "platformUserData" jsonb NOT NULL DEFAULT '{}',
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversation_bindings" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_conv_binding_conn_user_thread" UNIQUE ("channelConnectionId", "externalUserId", "externalThreadId"),
        CONSTRAINT "FK_conv_binding_session" FOREIGN KEY ("sessionId")
          REFERENCES "chat_sessions"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_conv_binding_channel_conn" FOREIGN KEY ("channelConnectionId")
          REFERENCES "channel_connections"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_conv_binding_session" ON "conversation_bindings" ("sessionId")`);
    await queryRunner.query(`CREATE INDEX "IDX_conv_binding_conn_user" ON "conversation_bindings" ("channelConnectionId", "externalUserId")`);

    await queryRunner.query(`
      CREATE TABLE "webhook_event_log" (
        "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
        "channelConnectionId" uuid NOT NULL,
        "channel" varchar(20) NOT NULL,
        "dedupeKey" varchar(255) NOT NULL,
        "eventType" varchar(50) NOT NULL,
        "rawPayload" jsonb NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'received',
        "error" varchar(500),
        "processingAttempts" integer NOT NULL DEFAULT 0,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhook_event_log" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_webhook_event_dedupe" UNIQUE ("dedupeKey")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_webhook_event_conn_created" ON "webhook_event_log" ("channelConnectionId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX "IDX_webhook_event_status" ON "webhook_event_log" ("status", "createdAt")`);

    await queryRunner.query(`
      CREATE TABLE "message_deliveries" (
        "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
        "internalMessageId" uuid NOT NULL,
        "channelConnectionId" uuid NOT NULL,
        "channel" varchar(20) NOT NULL,
        "platformMessageId" varchar(255),
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "attempts" integer NOT NULL DEFAULT 0,
        "error" varchar(500),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_message_deliveries" PRIMARY KEY ("id"),
        CONSTRAINT "FK_message_delivery_message" FOREIGN KEY ("internalMessageId")
          REFERENCES "messages"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_message_delivery_conn" FOREIGN KEY ("channelConnectionId")
          REFERENCES "channel_connections"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_msg_delivery_internal" ON "message_deliveries" ("internalMessageId")`);
    await queryRunner.query(`CREATE INDEX "IDX_msg_delivery_platform" ON "message_deliveries" ("platformMessageId", "channel")`);
    await queryRunner.query(`CREATE INDEX "IDX_msg_delivery_conn_status" ON "message_deliveries" ("channelConnectionId", "status")`);

    await queryRunner.query(`ALTER TABLE "chat_sessions" ADD "channel" varchar(20) NOT NULL DEFAULT 'widget'`);
    await queryRunner.query(`ALTER TABLE "chat_sessions" ADD "channelConnectionId" uuid`);
    await queryRunner.query(`
      ALTER TABLE "chat_sessions" ADD CONSTRAINT "FK_chat_session_channel_conn"
        FOREIGN KEY ("channelConnectionId") REFERENCES "channel_connections"("id") ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "chat_sessions" DROP CONSTRAINT IF EXISTS "FK_chat_session_channel_conn"`);
    await queryRunner.query(`ALTER TABLE "chat_sessions" DROP COLUMN IF EXISTS "channelConnectionId"`);
    await queryRunner.query(`ALTER TABLE "chat_sessions" DROP COLUMN IF EXISTS "channel"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "message_deliveries"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "webhook_event_log"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "conversation_bindings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "channel_connections"`);
  }
}
