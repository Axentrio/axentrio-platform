import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Convert all TIMESTAMP columns to TIMESTAMP WITH TIME ZONE (TIMESTAMPTZ).
 *
 * PostgreSQL stores TIMESTAMPTZ in UTC internally and converts to the
 * session timezone on output. Plain TIMESTAMP has no timezone awareness,
 * which can cause silent data corruption when server timezone differs
 * from application expectations.
 *
 * This migration is safe and non-destructive — existing values are
 * interpreted as being in the server's current timezone (UTC on Railway)
 * and converted to UTC TIMESTAMPTZ.
 */
export class ConvertTimestampsToTimestamptz1775700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // chat_sessions
    await queryRunner.query(`
      ALTER TABLE chat_sessions
        ALTER COLUMN started_at TYPE TIMESTAMPTZ USING started_at AT TIME ZONE 'UTC',
        ALTER COLUMN ended_at TYPE TIMESTAMPTZ USING ended_at AT TIME ZONE 'UTC',
        ALTER COLUMN last_activity_at TYPE TIMESTAMPTZ USING last_activity_at AT TIME ZONE 'UTC',
        ALTER COLUMN first_response_at TYPE TIMESTAMPTZ USING first_response_at AT TIME ZONE 'UTC',
        ALTER COLUMN deleted_at TYPE TIMESTAMPTZ USING deleted_at AT TIME ZONE 'UTC',
        ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
        ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
    `);

    // messages
    await queryRunner.query(`
      ALTER TABLE messages
        ALTER COLUMN sent_at TYPE TIMESTAMPTZ USING sent_at AT TIME ZONE 'UTC',
        ALTER COLUMN delivered_at TYPE TIMESTAMPTZ USING delivered_at AT TIME ZONE 'UTC',
        ALTER COLUMN read_at TYPE TIMESTAMPTZ USING read_at AT TIME ZONE 'UTC',
        ALTER COLUMN deleted_at TYPE TIMESTAMPTZ USING deleted_at AT TIME ZONE 'UTC',
        ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
        ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
    `);

    // handoff_requests
    await queryRunner.query(`
      ALTER TABLE handoff_requests
        ALTER COLUMN requested_at TYPE TIMESTAMPTZ USING requested_at AT TIME ZONE 'UTC',
        ALTER COLUMN accepted_at TYPE TIMESTAMPTZ USING accepted_at AT TIME ZONE 'UTC',
        ALTER COLUMN completed_at TYPE TIMESTAMPTZ USING completed_at AT TIME ZONE 'UTC',
        ALTER COLUMN timeout_at TYPE TIMESTAMPTZ USING timeout_at AT TIME ZONE 'UTC',
        ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
        ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
    `);

    // participants
    await queryRunner.query(`
      ALTER TABLE participants
        ALTER COLUMN joined_at TYPE TIMESTAMPTZ USING joined_at AT TIME ZONE 'UTC',
        ALTER COLUMN left_at TYPE TIMESTAMPTZ USING left_at AT TIME ZONE 'UTC',
        ALTER COLUMN last_seen_at TYPE TIMESTAMPTZ USING last_seen_at AT TIME ZONE 'UTC',
        ALTER COLUMN deleted_at TYPE TIMESTAMPTZ USING deleted_at AT TIME ZONE 'UTC',
        ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
        ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
    `);

    // file_uploads
    await queryRunner.query(`
      ALTER TABLE file_uploads
        ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at AT TIME ZONE 'UTC',
        ALTER COLUMN completed_at TYPE TIMESTAMPTZ USING completed_at AT TIME ZONE 'UTC',
        ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
        ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
    `);

    // webhook_delivery_logs
    await queryRunner.query(`
      ALTER TABLE webhook_delivery_logs
        ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
    `);

    // tenants
    await queryRunner.query(`
      ALTER TABLE tenants
        ALTER COLUMN deleted_at TYPE TIMESTAMPTZ USING deleted_at AT TIME ZONE 'UTC',
        ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
        ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
    `);

    // agents
    await queryRunner.query(`
      ALTER TABLE agents
        ALTER COLUMN last_status_change_at TYPE TIMESTAMPTZ USING last_status_change_at AT TIME ZONE 'UTC',
        ALTER COLUMN last_active_at TYPE TIMESTAMPTZ USING last_active_at AT TIME ZONE 'UTC',
        ALTER COLUMN deleted_at TYPE TIMESTAMPTZ USING deleted_at AT TIME ZONE 'UTC',
        ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
        ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
    `);

    // users
    await queryRunner.query(`
      ALTER TABLE users
        ALTER COLUMN last_login_at TYPE TIMESTAMPTZ USING last_login_at AT TIME ZONE 'UTC',
        ALTER COLUMN password_changed_at TYPE TIMESTAMPTZ USING password_changed_at AT TIME ZONE 'UTC',
        ALTER COLUMN deleted_at TYPE TIMESTAMPTZ USING deleted_at AT TIME ZONE 'UTC',
        ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
        ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
    `);

    // audit_logs
    await queryRunner.query(`
      ALTER TABLE audit_logs
        ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
    `);

    // pending_invites
    await queryRunner.query(`
      ALTER TABLE pending_invites
        ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at AT TIME ZONE 'UTC',
        ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
    `);

    // knowledge_bases (camelCase columns)
    await queryRunner.query(`
      ALTER TABLE knowledge_bases
        ALTER COLUMN "lastIndexedAt" TYPE TIMESTAMPTZ USING "lastIndexedAt" AT TIME ZONE 'UTC',
        ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE 'UTC',
        ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ USING "updatedAt" AT TIME ZONE 'UTC';
    `);

    // knowledge_documents (camelCase columns)
    await queryRunner.query(`
      ALTER TABLE knowledge_documents
        ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE 'UTC',
        ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ USING "updatedAt" AT TIME ZONE 'UTC';
    `);

    // knowledge_chunks (camelCase columns)
    await queryRunner.query(`
      ALTER TABLE knowledge_chunks
        ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE 'UTC';
    `);

    // canned_responses (camelCase columns)
    await queryRunner.query(`
      ALTER TABLE canned_responses
        ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE 'UTC',
        ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ USING "updatedAt" AT TIME ZONE 'UTC';
    `);

    // channel_connections (uses camelCase columns)
    await queryRunner.query(`
      ALTER TABLE channel_connections
        ALTER COLUMN "lastHealthCheckAt" TYPE TIMESTAMPTZ USING "lastHealthCheckAt" AT TIME ZONE 'UTC',
        ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE 'UTC',
        ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ USING "updatedAt" AT TIME ZONE 'UTC';
    `);

    // conversation_bindings (uses camelCase columns)
    await queryRunner.query(`
      ALTER TABLE conversation_bindings
        ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE 'UTC';
    `);

    // webhook_event_log (uses camelCase columns)
    await queryRunner.query(`
      ALTER TABLE webhook_event_log
        ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE 'UTC';
    `);

    // message_deliveries (uses camelCase columns)
    await queryRunner.query(`
      ALTER TABLE message_deliveries
        ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE 'UTC',
        ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ USING "updatedAt" AT TIME ZONE 'UTC';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revert all TIMESTAMPTZ columns back to TIMESTAMP
    const tables = [
      { table: 'chat_sessions', columns: ['started_at', 'ended_at', 'last_activity_at', 'first_response_at', 'deleted_at', 'created_at', 'updated_at'] },
      { table: 'messages', columns: ['sent_at', 'delivered_at', 'read_at', 'deleted_at', 'created_at', 'updated_at'] },
      { table: 'handoff_requests', columns: ['requested_at', 'accepted_at', 'completed_at', 'timeout_at', 'created_at', 'updated_at'] },
      { table: 'participants', columns: ['joined_at', 'left_at', 'last_seen_at', 'deleted_at', 'created_at', 'updated_at'] },
      { table: 'file_uploads', columns: ['expires_at', 'completed_at', 'created_at', 'updated_at'] },
      { table: 'webhook_delivery_logs', columns: ['created_at'] },
      { table: 'tenants', columns: ['deleted_at', 'created_at', 'updated_at'] },
      { table: 'agents', columns: ['last_status_change_at', 'last_active_at', 'deleted_at', 'created_at', 'updated_at'] },
      { table: 'users', columns: ['last_login_at', 'password_changed_at', 'deleted_at', 'created_at', 'updated_at'] },
      { table: 'audit_logs', columns: ['created_at'] },
      { table: 'pending_invites', columns: ['expires_at', 'created_at'] },
    ];

    for (const { table, columns } of tables) {
      const alterClauses = columns
        .map(col => `ALTER COLUMN ${col} TYPE TIMESTAMP USING ${col} AT TIME ZONE 'UTC'`)
        .join(', ');
      await queryRunner.query(`ALTER TABLE ${table} ${alterClauses};`);
    }

    // camelCase tables need quoted column names
    await queryRunner.query(`ALTER TABLE channel_connections ALTER COLUMN "lastHealthCheckAt" TYPE TIMESTAMP USING "lastHealthCheckAt" AT TIME ZONE 'UTC', ALTER COLUMN "createdAt" TYPE TIMESTAMP USING "createdAt" AT TIME ZONE 'UTC', ALTER COLUMN "updatedAt" TYPE TIMESTAMP USING "updatedAt" AT TIME ZONE 'UTC';`);
    await queryRunner.query(`ALTER TABLE conversation_bindings ALTER COLUMN "createdAt" TYPE TIMESTAMP USING "createdAt" AT TIME ZONE 'UTC';`);
    await queryRunner.query(`ALTER TABLE webhook_event_log ALTER COLUMN "createdAt" TYPE TIMESTAMP USING "createdAt" AT TIME ZONE 'UTC';`);
    await queryRunner.query(`ALTER TABLE message_deliveries ALTER COLUMN "createdAt" TYPE TIMESTAMP USING "createdAt" AT TIME ZONE 'UTC', ALTER COLUMN "updatedAt" TYPE TIMESTAMP USING "updatedAt" AT TIME ZONE 'UTC';`);
    await queryRunner.query(`ALTER TABLE knowledge_bases ALTER COLUMN "lastIndexedAt" TYPE TIMESTAMP USING "lastIndexedAt" AT TIME ZONE 'UTC', ALTER COLUMN "createdAt" TYPE TIMESTAMP USING "createdAt" AT TIME ZONE 'UTC', ALTER COLUMN "updatedAt" TYPE TIMESTAMP USING "updatedAt" AT TIME ZONE 'UTC';`);
    await queryRunner.query(`ALTER TABLE knowledge_documents ALTER COLUMN "createdAt" TYPE TIMESTAMP USING "createdAt" AT TIME ZONE 'UTC', ALTER COLUMN "updatedAt" TYPE TIMESTAMP USING "updatedAt" AT TIME ZONE 'UTC';`);
    await queryRunner.query(`ALTER TABLE knowledge_chunks ALTER COLUMN "createdAt" TYPE TIMESTAMP USING "createdAt" AT TIME ZONE 'UTC';`);
    await queryRunner.query(`ALTER TABLE canned_responses ALTER COLUMN "createdAt" TYPE TIMESTAMP USING "createdAt" AT TIME ZONE 'UTC', ALTER COLUMN "updatedAt" TYPE TIMESTAMP USING "updatedAt" AT TIME ZONE 'UTC';`);
  }
}
