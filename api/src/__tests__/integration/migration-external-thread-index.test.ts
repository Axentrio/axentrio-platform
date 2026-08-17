/**
 * Boot-safety guard for AddExternalThreadIndex (#132 / #140).
 *
 * The first version of this migration indexed unquoted `channel_connection_id`,
 * which has never existed — the ChatSession column is camelCase
 * `"channelConnectionId"` (added by 177550). The shipped SQL only creates the
 * expression index on that quoted identifier (`CREATE INDEX IF NOT EXISTS`).
 * It does not add the column if missing: prod already had it when this
 * migration ran, so a column-less schema is out of contract.
 *
 * Follow-on migrations 179200 / 179210 / 179220 are also exercised once so a
 * missing-table / missing-column typo in those cannot hide behind this index.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { AddExternalThreadIndex1791900000000 } from '../../database/migrations/1791900000000-AddExternalThreadIndex';
import { AddCustomerChoosesLocation1792000000000 } from '../../database/migrations/1792000000000-AddCustomerChoosesLocation';
import { AddAccountInformation1792100000000 } from '../../database/migrations/1792100000000-AddAccountInformation';
import { AddRoutePriority1792200000000 } from '../../database/migrations/1792200000000-AddRoutePriority';

const INDEX_NAME = 'ix_chat_sessions_external_thread';
const COLUMN_NAME = 'channelConnectionId';

async function runUp(
  migration: { up: (qr: import('typeorm').QueryRunner) => Promise<void> },
  times = 1,
): Promise<void> {
  const queryRunner = AppDataSource.createQueryRunner();
  try {
    await queryRunner.connect();
    for (let i = 0; i < times; i++) {
      await migration.up(queryRunner);
    }
  } finally {
    await queryRunner.release();
  }
}

async function indexExists(): Promise<boolean> {
  const rows = await AppDataSource.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [INDEX_NAME],
  );
  return rows.length > 0;
}

async function columnExists(columnName: string): Promise<boolean> {
  const rows = await AppDataSource.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'chat_sessions'
        AND column_name = $1`,
    [columnName],
  );
  return rows.length > 0;
}

async function indexDef(): Promise<string> {
  const [idx] = await AppDataSource.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = $1`,
    [INDEX_NAME],
  );
  return idx.indexdef;
}

/** Restore the 177550 column + FK so later tests share the synchronized schema. */
async function restoreChannelConnectionColumn(): Promise<void> {
  await AppDataSource.query(
    `ALTER TABLE "chat_sessions" ADD COLUMN IF NOT EXISTS "channelConnectionId" uuid`,
  );
  await AppDataSource.query(
    `ALTER TABLE "chat_sessions" DROP CONSTRAINT IF EXISTS "FK_chat_session_channel_conn"`,
  );
  await AppDataSource.query(`
    ALTER TABLE "chat_sessions" ADD CONSTRAINT "FK_chat_session_channel_conn"
      FOREIGN KEY ("channelConnectionId") REFERENCES "channel_connections"("id") ON DELETE SET NULL
  `);
}

describe('AddExternalThreadIndex migration', () => {
  it('up() is idempotent against a schema that already has the column', async () => {
    expect(await columnExists(COLUMN_NAME)).toBe(true);
    await runUp(new AddExternalThreadIndex1791900000000(), 2);
    expect(await indexExists()).toBe(true);
    expect(await columnExists(COLUMN_NAME)).toBe(true);
    expect(await columnExists('channel_connection_id')).toBe(false);

    const def = await indexDef();
    expect(def).toContain(`"${COLUMN_NAME}"`);
    expect(def).not.toContain('channel_connection_id');
  });

  it('up() hard-fails when "channelConnectionId" is missing (out of contract)', async () => {
    await AppDataSource.query(`DROP INDEX IF EXISTS "ix_chat_sessions_external_thread"`);
    await AppDataSource.query(
      `ALTER TABLE "chat_sessions" DROP CONSTRAINT IF EXISTS "FK_chat_session_channel_conn"`,
    );
    await AppDataSource.query(
      `ALTER TABLE "chat_sessions" DROP COLUMN IF EXISTS "channelConnectionId"`,
    );
    await AppDataSource.query(
      `ALTER TABLE "chat_sessions" DROP COLUMN IF EXISTS channel_connection_id`,
    );
    expect(await columnExists(COLUMN_NAME)).toBe(false);
    expect(await indexExists()).toBe(false);

    try {
      await expect(runUp(new AddExternalThreadIndex1791900000000())).rejects.toThrow(
        /column ["']channelConnectionId["'] does not exist/i,
      );
      expect(await columnExists(COLUMN_NAME)).toBe(false);
      expect(await columnExists('channel_connection_id')).toBe(false);
      expect(await indexExists()).toBe(false);
    } finally {
      await restoreChannelConnectionColumn();
    }
  });

  it('follow-on migrations 179200–179220 apply on the current schema', async () => {
    await runUp(new AddCustomerChoosesLocation1792000000000(), 2);
    await runUp(new AddAccountInformation1792100000000(), 2);

    // 179220's CHECK is not IF NOT EXISTS; TypeORM wraps each boot in a
    // transaction so a failed first run rolls back, but a second call in this
    // test would raise. Run once, then confirm the column is there.
    await runUp(new AddRoutePriority1792200000000(), 1);

    const serviceCols: Array<{ column_name: string }> = await AppDataSource.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'chatbot_service_types'
          AND column_name = 'customer_chooses_location'`,
    );
    expect(serviceCols).toHaveLength(1);

    const tenantCols: Array<{ column_name: string }> = await AppDataSource.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tenants'
          AND column_name IN (
            'official_business_name', 'vat_number', 'contact_person',
            'invoice_address', 'invoice_email', 'account_phone', 'vat_verified'
          )`,
    );
    expect(tenantCols).toHaveLength(7);

    const routeCols: Array<{ column_name: string }> = await AppDataSource.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'chatbot_booking_settings'
          AND column_name = 'travel_route_priority'`,
    );
    expect(routeCols).toHaveLength(1);
  });
});
