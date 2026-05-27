import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1774400000000 implements MigrationInterface {
  name = 'InitialSchema1774400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Extensions
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // Enum types (PostgreSQL has no CREATE TYPE IF NOT EXISTS, so use DO blocks)
    const enums: [string, string[]][] = [
      ['tenants_tier_enum', ['free', 'pro', 'enterprise']],
      ['tenants_status_enum', ['active', 'suspended', 'cancelled']],
      ['users_role_enum', ['super_admin', 'admin', 'supervisor', 'agent']],
      ['agents_status_enum', ['online', 'away', 'busy', 'offline']],
      ['chat_sessions_status_enum', ['active', 'closed', 'waiting', 'handoff', 'bot']],
      ['participants_type_enum', ['user', 'agent', 'bot', 'system']],
      ['messages_type_enum', ['text', 'image', 'file', 'system', 'typing']],
      ['messages_status_enum', ['sending', 'sent', 'delivered', 'read', 'failed']],
      ['handoff_requests_status_enum', ['requested', 'accepted', 'rejected', 'completed', 'timeout']],
      ['handoff_requests_reason_enum', ['user_request', 'bot_confidence_low', 'escalation_trigger', 'business_hours']],
      ['handoff_requests_priority_enum', ['low', 'medium', 'high', 'urgent']],
      ['file_uploads_status_enum', ['pending', 'uploading', 'completed', 'failed', 'cancelled']],
      ['webhook_delivery_logs_direction_enum', ['inbound', 'outbound']],
      ['webhook_delivery_logs_status_enum', ['success', 'failed', 'retrying', 'dropped']],
    ];

    for (const [name, values] of enums) {
      const valuesList = values.map(v => `'${v}'`).join(', ');
      await queryRunner.query(`
        DO $$ BEGIN
          CREATE TYPE "${name}" AS ENUM (${valuesList});
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      `);
    }

    // Tenants
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tenants" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" varchar(255) NOT NULL,
        "slug" varchar(100) NOT NULL,
        "api_key" varchar(255) NOT NULL,
        "clerk_org_id" varchar(255),
        "webhook_url" varchar(500),
        "webhook_secret" varchar(255),
        "tier" "tenants_tier_enum" NOT NULL DEFAULT 'free',
        "status" "tenants_status_enum" NOT NULL DEFAULT 'active',
        "settings" jsonb NOT NULL DEFAULT '{}',
        "max_sessions" int NOT NULL DEFAULT 100,
        "current_sessions" int NOT NULL DEFAULT 0,
        "custom_domain" varchar(255),
        "billing_info" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "PK_tenants" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_tenants_slug" UNIQUE ("slug"),
        CONSTRAINT "UQ_tenants_api_key" UNIQUE ("api_key"),
        CONSTRAINT "UQ_tenants_clerk_org_id" UNIQUE ("clerk_org_id")
      )
    `);

    // Users
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "email" varchar(255) NOT NULL,
        "clerk_user_id" varchar(255),
        "password" varchar(255),
        "name" varchar(100) NOT NULL,
        "role" "users_role_enum" NOT NULL DEFAULT 'agent',
        "avatar_url" varchar(500),
        "is_active" boolean NOT NULL DEFAULT true,
        "email_verified" boolean NOT NULL DEFAULT false,
        "timezone" varchar(255),
        "locale" varchar(10),
        "notification_preferences" jsonb,
        "last_login_at" TIMESTAMP,
        "last_login_ip" varchar(255),
        "password_changed_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "PK_users" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_clerk_user_id" UNIQUE ("clerk_user_id"),
        CONSTRAINT "FK_users_tenant" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_tenant_email" ON "users" ("tenant_id", "email")`);

    // Agents
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "status" "agents_status_enum" NOT NULL DEFAULT 'offline',
        "max_concurrent_chats" int NOT NULL DEFAULT 5,
        "current_chat_count" int NOT NULL DEFAULT 0,
        "skills" text[] NOT NULL DEFAULT '{}',
        "languages" varchar(10)[] NOT NULL DEFAULT '{en}',
        "total_chats_handled" int NOT NULL DEFAULT 0,
        "avg_response_time_seconds" int NOT NULL DEFAULT 0,
        "satisfaction_score" decimal(3,2) NOT NULL DEFAULT 0,
        "last_status_change_at" TIMESTAMP,
        "last_active_at" TIMESTAMP,
        "current_ip" varchar(255),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "PK_agents" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_agents_user_id" UNIQUE ("user_id"),
        CONSTRAINT "FK_agents_tenant" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_agents_user" FOREIGN KEY ("user_id") REFERENCES "users"("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_agents_tenant_status" ON "agents" ("tenant_id", "status")`);

    // Chat Sessions
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chat_sessions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "visitor_id" varchar(255) NOT NULL,
        "status" "chat_sessions_status_enum" NOT NULL DEFAULT 'waiting',
        "assigned_agent_id" uuid,
        "source" varchar(100) NOT NULL DEFAULT 'widget',
        "subject" varchar(500),
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "message_count" int NOT NULL DEFAULT 0,
        "unread_count" int NOT NULL DEFAULT 0,
        "duration_seconds" int,
        "priority" varchar(50),
        "tags" varchar(100)[],
        "started_at" TIMESTAMP NOT NULL DEFAULT now(),
        "ended_at" TIMESTAMP,
        "last_activity_at" TIMESTAMP NOT NULL DEFAULT now(),
        "first_response_at" TIMESTAMP,
        "first_response_time_seconds" int,
        "satisfaction_rating" decimal(3,2),
        "satisfaction_feedback" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "PK_chat_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_chat_sessions_tenant" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_chat_sessions_agent" FOREIGN KEY ("assigned_agent_id") REFERENCES "agents"("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_chat_sessions_tenant_status" ON "chat_sessions" ("tenant_id", "status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_chat_sessions_tenant_visitor" ON "chat_sessions" ("tenant_id", "visitor_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_chat_sessions_agent_status" ON "chat_sessions" ("assigned_agent_id", "status")`);

    // Participants
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "participants" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "session_id" uuid NOT NULL,
        "type" "participants_type_enum" NOT NULL,
        "user_id" uuid,
        "name" varchar(100) NOT NULL,
        "avatar_url" varchar(500),
        "email" varchar(255),
        "metadata" jsonb,
        "is_anonymous" boolean NOT NULL DEFAULT false,
        "joined_at" TIMESTAMP NOT NULL DEFAULT now(),
        "left_at" TIMESTAMP,
        "last_seen_at" TIMESTAMP,
        "is_deleted" boolean NOT NULL DEFAULT false,
        "deleted_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_participants" PRIMARY KEY ("id"),
        CONSTRAINT "FK_participants_session" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_participants_session_type" ON "participants" ("session_id", "type")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_participants_active" ON "participants" ("session_id") WHERE is_deleted = false`);

    // Messages
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "messages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "session_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "participant_id" uuid NOT NULL,
        "type" "messages_type_enum" NOT NULL DEFAULT 'text',
        "content" text NOT NULL DEFAULT '',
        "content_encrypted" boolean NOT NULL DEFAULT false,
        "metadata" jsonb,
        "status" "messages_status_enum" NOT NULL DEFAULT 'sending',
        "reply_to_id" uuid,
        "sent_at" TIMESTAMP,
        "delivered_at" TIMESTAMP,
        "read_at" TIMESTAMP,
        "edit_count" int NOT NULL DEFAULT 0,
        "is_deleted" boolean NOT NULL DEFAULT false,
        "deleted_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_messages" PRIMARY KEY ("id"),
        CONSTRAINT "FK_messages_session" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_messages_participant" FOREIGN KEY ("participant_id") REFERENCES "participants"("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_session_created" ON "messages" ("session_id", "created_at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_tenant_created" ON "messages" ("tenant_id", "created_at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_participant_created" ON "messages" ("participant_id", "created_at")`);

    // Handoff Requests
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "handoff_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "session_id" uuid NOT NULL,
        "requested_by" uuid NOT NULL,
        "requested_at" TIMESTAMP NOT NULL DEFAULT now(),
        "status" "handoff_requests_status_enum" NOT NULL DEFAULT 'requested',
        "reason" "handoff_requests_reason_enum" NOT NULL,
        "priority" "handoff_requests_priority_enum" NOT NULL DEFAULT 'medium',
        "assigned_agent_id" uuid,
        "accepted_at" TIMESTAMP,
        "completed_at" TIMESTAMP,
        "timeout_at" TIMESTAMP,
        "notes" text,
        "context" jsonb,
        "rejection_reason" varchar(100),
        "wait_time_seconds" int NOT NULL DEFAULT 0,
        "handle_time_seconds" int NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_handoff_requests" PRIMARY KEY ("id"),
        CONSTRAINT "FK_handoff_requests_session" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_handoff_requests_agent" FOREIGN KEY ("assigned_agent_id") REFERENCES "agents"("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_handoff_requests_session_status" ON "handoff_requests" ("session_id", "status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_handoff_requests_tenant_status" ON "handoff_requests" ("tenant_id", "status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_handoff_requests_agent_status" ON "handoff_requests" ("assigned_agent_id", "status")`);

    // File Uploads
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "file_uploads" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "session_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "participant_id" uuid NOT NULL,
        "file_name" varchar(255) NOT NULL,
        "file_type" varchar(100) NOT NULL,
        "file_size" bigint NOT NULL,
        "chunk_size" int NOT NULL,
        "total_chunks" int NOT NULL,
        "uploaded_chunks" int[] NOT NULL DEFAULT '{}',
        "status" "file_uploads_status_enum" NOT NULL DEFAULT 'pending',
        "storage_path" varchar(500),
        "public_url" varchar(500),
        "checksum" varchar(64),
        "checksum_algorithm" varchar(64),
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "retry_count" int NOT NULL DEFAULT 0,
        "error_message" varchar(500),
        "expires_at" TIMESTAMP,
        "completed_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_file_uploads" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_file_uploads_session_status" ON "file_uploads" ("session_id", "status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_file_uploads_tenant_created" ON "file_uploads" ("tenant_id", "created_at")`);

    // Webhook Delivery Logs
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "webhook_delivery_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "event" varchar(100) NOT NULL,
        "direction" "webhook_delivery_logs_direction_enum" NOT NULL,
        "url" varchar(500) NOT NULL,
        "status" "webhook_delivery_logs_status_enum" NOT NULL,
        "http_status" int,
        "duration_ms" int NOT NULL DEFAULT 0,
        "error" text,
        "request_body" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhook_delivery_logs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_webhook_delivery_logs_tenant" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_webhook_delivery_tenant_created" ON "webhook_delivery_logs" ("tenant_id", "created_at" DESC)`);

    // Pending Invites
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "pending_invites" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "email" varchar(255) NOT NULL,
        "role" varchar(50) NOT NULL,
        "invited_by" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "expires_at" TIMESTAMP NOT NULL,
        CONSTRAINT "PK_pending_invites" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_pending_invites_tenant_email" UNIQUE ("tenant_id", "email"),
        CONSTRAINT "FK_pending_invites_tenant" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_pending_invites_inviter" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    // Audit Logs
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "audit_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid,
        "actor_id" uuid NOT NULL,
        "action" varchar(100) NOT NULL,
        "entity_type" varchar(50) NOT NULL,
        "entity_id" uuid NOT NULL,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_tenant_created" ON "audit_logs" ("tenant_id", "created_at" DESC)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_actor_created" ON "audit_logs" ("actor_id", "created_at" DESC)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_logs" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "pending_invites" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "webhook_delivery_logs" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "file_uploads" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "handoff_requests" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "messages" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "participants" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chat_sessions" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agents" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tenants" CASCADE`);
    await queryRunner.query(`DROP TYPE IF EXISTS "webhook_delivery_logs_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "webhook_delivery_logs_direction_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "file_uploads_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "handoff_requests_priority_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "handoff_requests_reason_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "handoff_requests_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "messages_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "messages_type_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "participants_type_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "chat_sessions_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "agents_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "users_role_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "tenants_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "tenants_tier_enum"`);
  }
}
