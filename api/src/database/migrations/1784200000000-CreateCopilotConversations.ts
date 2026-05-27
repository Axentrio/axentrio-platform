import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M9a — Copilot conversations + messages + trace audit log.
 *
 * Three tables:
 *
 *  - `chatbot_copilot_conversations` — one active conversation per
 *    (tenant_id, user_id). Soft-deleted via `archived_at`. The "active"
 *    guarantee is enforced via a partial unique INDEX (not a constraint)
 *    so we can change semantics in v1.1 without a constraint rename.
 *
 *  - `chatbot_copilot_messages` — paired user + assistant rows per turn,
 *    serialized via `conversations.next_turn` under SELECT FOR UPDATE.
 *    No `'tool'` role in v1 — tool invocations accumulate as
 *    `tools_called` jsonb on the assistant row. `stream_started_at`
 *    powers stale-pending detection so a crashed mid-stream row can be
 *    distinguished from a still-in-flight one.
 *
 *  - `chatbot_copilot_traces` — metadata-only audit log per the security
 *    invariants: tool NAMES + OUTCOME only, never args, query text, or
 *    tool outputs. Each turn writes one trace row in the agent-loop
 *    wrapper (NOT in tool implementations).
 *
 * Two triggers enforce tenant/conversation consistency at the DB layer
 * (defense in depth):
 *   - messages: denormalized tenant_id must match the parent conversation
 *   - traces: turn_id (when set) must reference an assistant message in
 *     the same tenant + conversation
 *
 * Shared-schema `chatbot_` prefix per the n8n co-tenancy rule.
 */
export class CreateCopilotConversations1784200000000 implements MigrationInterface {
  name = 'CreateCopilotConversations1784200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------
    // chatbot_copilot_conversations
    // ---------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_copilot_conversations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "title" varchar(255) NULL,
        "next_turn" int NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "archived_at" timestamptz NULL,
        CONSTRAINT "pk_chatbot_copilot_conversations" PRIMARY KEY ("id"),
        CONSTRAINT "fk_chatbot_copilot_conv_tenant"
          FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_chatbot_copilot_conv_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    // Partial UNIQUE INDEX (not a constraint) — only one active
    // (archived_at IS NULL) conversation per (tenant_id, user_id).
    // Constraint syntax can't express a WHERE clause, so this must be
    // an index. ON CONFLICT references the columns + WHERE clause.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chatbot_copilot_conv_active"
        ON "chatbot_copilot_conversations" ("tenant_id", "user_id")
        WHERE "archived_at" IS NULL
    `);

    // ---------------------------------------------------------------
    // chatbot_copilot_messages
    // ---------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_copilot_messages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "conversation_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "turn" int NOT NULL,
        "role" varchar(16) NOT NULL,
        "content" text NOT NULL,
        "tools_called" jsonb NULL,
        "outcome" varchar(32) NULL,
        "tokens_in" int NULL,
        "tokens_out" int NULL,
        "latency_ms" int NULL,
        "stream_started_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_chatbot_copilot_messages" PRIMARY KEY ("id"),
        CONSTRAINT "uq_chatbot_copilot_msg_turn" UNIQUE ("conversation_id", "turn"),
        CONSTRAINT "fk_chatbot_copilot_msg_conv"
          FOREIGN KEY ("conversation_id") REFERENCES "chatbot_copilot_conversations"("id") ON DELETE CASCADE,
        CONSTRAINT "chk_chatbot_copilot_msg_role" CHECK ("role" IN ('user','assistant')),
        CONSTRAINT "chk_chatbot_copilot_msg_outcome"
          CHECK ("outcome" IS NULL OR "outcome" IN ('pending','success','aborted','error','agent_loop_exceeded'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chatbot_copilot_messages_conv_turn"
        ON "chatbot_copilot_messages" ("conversation_id", "turn")
    `);

    // DB-level tenant consistency: message.tenant_id must match its
    // parent conversation's tenant_id. App-level helper sets the right
    // value; this trigger is the belt-and-suspenders backstop.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_copilot_message_tenant_matches_conversation()
        RETURNS trigger AS $$
      BEGIN
        IF NEW.tenant_id IS DISTINCT FROM (
          SELECT tenant_id FROM chatbot_copilot_conversations WHERE id = NEW.conversation_id
        ) THEN
          RAISE EXCEPTION 'tenant_id mismatch between chatbot_copilot_messages and its conversation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER "trg_chatbot_copilot_messages_tenant_consistency"
        BEFORE INSERT OR UPDATE ON "chatbot_copilot_messages"
        FOR EACH ROW EXECUTE FUNCTION assert_copilot_message_tenant_matches_conversation()
    `);

    // ---------------------------------------------------------------
    // chatbot_copilot_traces
    // ---------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_copilot_traces" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "conversation_id" uuid NULL,
        "turn_id" uuid NULL,
        "tools_called" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "tokens_in" int NULL,
        "tokens_out" int NULL,
        "latency_ms" int NULL,
        "outcome" varchar(32) NOT NULL,
        "retrieval_mode" varchar(16) NULL,
        "llm_model" varchar(64) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_chatbot_copilot_traces" PRIMARY KEY ("id"),
        CONSTRAINT "fk_chatbot_copilot_traces_tenant"
          FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_chatbot_copilot_traces_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_chatbot_copilot_traces_conv"
          FOREIGN KEY ("conversation_id") REFERENCES "chatbot_copilot_conversations"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_chatbot_copilot_traces_turn"
          FOREIGN KEY ("turn_id") REFERENCES "chatbot_copilot_messages"("id") ON DELETE SET NULL,
        CONSTRAINT "chk_chatbot_copilot_traces_outcome"
          CHECK ("outcome" IN ('success','aborted','error','agent_loop_exceeded'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chatbot_copilot_traces_tenant_created"
        ON "chatbot_copilot_traces" ("tenant_id", "created_at" DESC)
    `);

    // Trace consistency: if turn_id is set, the referenced message must
    // be in the same tenant + conversation and be a `role='assistant'`
    // row. Defense in depth alongside the FK.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_copilot_trace_message_consistency()
        RETURNS trigger AS $$
      DECLARE
        msg_tenant uuid;
        msg_conv uuid;
        msg_role varchar(16);
      BEGIN
        IF NEW.turn_id IS NULL THEN
          RETURN NEW;
        END IF;
        SELECT tenant_id, conversation_id, role
          INTO msg_tenant, msg_conv, msg_role
          FROM chatbot_copilot_messages WHERE id = NEW.turn_id;
        IF msg_tenant IS DISTINCT FROM NEW.tenant_id THEN
          RAISE EXCEPTION 'chatbot_copilot_traces.tenant_id mismatches the referenced message';
        END IF;
        IF NEW.conversation_id IS NOT NULL AND msg_conv IS DISTINCT FROM NEW.conversation_id THEN
          RAISE EXCEPTION 'chatbot_copilot_traces.conversation_id mismatches the referenced message';
        END IF;
        IF msg_role <> 'assistant' THEN
          RAISE EXCEPTION 'chatbot_copilot_traces.turn_id must reference an assistant message, got %', msg_role;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER "trg_chatbot_copilot_traces_consistency"
        BEFORE INSERT OR UPDATE ON "chatbot_copilot_traces"
        FOR EACH ROW EXECUTE FUNCTION assert_copilot_trace_message_consistency()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_chatbot_copilot_traces_consistency" ON "chatbot_copilot_traces"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS assert_copilot_trace_message_consistency()`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_chatbot_copilot_traces_tenant_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_copilot_traces"`);

    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_chatbot_copilot_messages_tenant_consistency" ON "chatbot_copilot_messages"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS assert_copilot_message_tenant_matches_conversation()`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_chatbot_copilot_messages_conv_turn"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_copilot_messages"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "uq_chatbot_copilot_conv_active"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_copilot_conversations"`);
  }
}
