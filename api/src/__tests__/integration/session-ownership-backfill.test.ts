import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { AddSessionOwnershipColumns1791300000000 } from '../../database/migrations/1791300000000-AddSessionOwnershipColumns';
import type { ChatSession } from '../../database/entities/ChatSession';
import {
  createTestAgent,
  createTestSession,
  createTestTenant,
  createTestUser,
} from '../helpers/factories';

const OWNERSHIP_COLUMNS = [
  'ownership',
  'ownership_version',
  'human_control_mode',
  'human_control_duration_hours',
  'human_control_until',
  'human_control_started_at',
] as const;

async function runUp(): Promise<void> {
  const migration = new AddSessionOwnershipColumns1791300000000();
  const queryRunner = AppDataSource.createQueryRunner();
  try {
    await queryRunner.connect();
    await migration.up(queryRunner);
    await migration.up(queryRunner);
  } finally {
    await queryRunner.release();
  }
}

async function ownershipOf(sessionId: string): Promise<string> {
  const [row] = await AppDataSource.query(
    `SELECT ownership FROM chat_sessions WHERE id = $1`,
    [sessionId],
  );
  return row.ownership;
}

async function columnsOf(queryRunner: QueryRunner) {
  return queryRunner.query(
    `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'chat_sessions'
        AND column_name = ANY($1::text[])
      ORDER BY column_name`,
    [OWNERSHIP_COLUMNS],
  ) as Promise<
    Array<{
      column_name: string;
      data_type: string;
      character_maximum_length: number | null;
      is_nullable: 'YES' | 'NO';
      column_default: string | null;
    }>
  >;
}

describe('AddSessionOwnershipColumns migration', () => {
  const backfillCases = [
    { name: 'closed sessions', status: 'closed' as const, assignedAgent: false, expected: 'closed' },
    { name: 'bot-owned waiting sessions', status: 'waiting' as const, assignedAgent: false, expected: 'bot_owned' },
    { name: 'assigned handoffs', status: 'handoff' as const, assignedAgent: true, expected: 'human_owned' },
    { name: 'unassigned handoffs', status: 'handoff' as const, assignedAgent: false, expected: 'handoff_requested' },
    { name: 'active sessions with an assigned agent', status: 'active' as const, assignedAgent: true, expected: 'human_owned' },
    { name: 'active sessions without an agent', status: 'active' as const, assignedAgent: false, expected: 'bot_owned' },
  ] as const;

  it.each(backfillCases)('backfills $name to $expected', async ({ status, assignedAgent, expected }) => {
    const tenant = await createTestTenant();
    let assignedAgentId: string | undefined;
    if (assignedAgent) {
      const user = await createTestUser(tenant.id);
      const agent = await createTestAgent(tenant.id, user.id);
      assignedAgentId = agent.id;
    }

    const overrides: Partial<ChatSession> = { status };
    if (assignedAgentId) overrides.assignedAgentId = assignedAgentId;
    const session = await createTestSession(tenant.id, overrides);

    await runUp();

    expect(await ownershipOf(session.id)).toBe(expected);
  });

  it('enforces the nullable 1..24 hour duration range', async () => {
    const tenant = await createTestTenant();
    const session = await createTestSession(tenant.id);
    await runUp();

    const setDuration = (hours: number | null) =>
      AppDataSource.query(
        `UPDATE chat_sessions SET human_control_duration_hours = $1 WHERE id = $2`,
        [hours, session.id],
      );

    await expect(setDuration(0)).rejects.toThrow(
      /chk_chat_sessions_human_control_duration_hours|violates check constraint/i,
    );
    await expect(setDuration(25)).rejects.toThrow(
      /chk_chat_sessions_human_control_duration_hours|violates check constraint/i,
    );
    await expect(setDuration(1)).resolves.toBeDefined();
    await expect(setDuration(24)).resolves.toBeDefined();
    await expect(setDuration(null)).resolves.toBeDefined();
  });

  it('replays up(), down(), and up() cleanly against the synchronized schema', async () => {
    // Keep this row-free and last in the file: down() temporarily removes columns that the
    // synchronized entity metadata expects, then restores the schema before the test returns.
    const migration = new AddSessionOwnershipColumns1791300000000();
    const queryRunner = AppDataSource.createQueryRunner();
    let needsRestore = false;
    try {
      await queryRunner.connect();
      await migration.up(queryRunner);
      await migration.up(queryRunner);
      needsRestore = true;
      await migration.down(queryRunner);

      expect(await columnsOf(queryRunner)).toEqual([]);
      await migration.down(queryRunner);
      expect(await columnsOf(queryRunner)).toEqual([]);

      await migration.up(queryRunner);
      needsRestore = false;
      const columns = await columnsOf(queryRunner);
      const byName = Object.fromEntries(columns.map((column) => [column.column_name, column]));

      expect(columns).toHaveLength(6);
      expect(byName.ownership).toMatchObject({
        data_type: 'character varying',
        character_maximum_length: 24,
        is_nullable: 'NO',
      });
      expect(byName.ownership.column_default).toContain("'bot_owned'");
      expect(byName.ownership_version).toMatchObject({
        data_type: 'integer',
        character_maximum_length: null,
        is_nullable: 'NO',
      });
      expect(byName.ownership_version.column_default).toContain('0');
      expect(byName.human_control_mode).toMatchObject({
        data_type: 'character varying',
        character_maximum_length: 16,
        is_nullable: 'YES',
        column_default: null,
      });
      expect(byName.human_control_duration_hours).toMatchObject({
        data_type: 'integer',
        character_maximum_length: null,
        is_nullable: 'YES',
        column_default: null,
      });
      expect(byName.human_control_until).toMatchObject({
        data_type: 'timestamp with time zone',
        character_maximum_length: null,
        is_nullable: 'YES',
        column_default: null,
      });
      expect(byName.human_control_started_at).toMatchObject({
        data_type: 'timestamp with time zone',
        character_maximum_length: null,
        is_nullable: 'YES',
        column_default: null,
      });

      const [constraint] = await queryRunner.query(
        `SELECT conname
           FROM pg_constraint
          WHERE conrelid = 'chat_sessions'::regclass
            AND conname = $1`,
        ['chk_chat_sessions_human_control_duration_hours'],
      );
      expect(constraint?.conname).toBe('chk_chat_sessions_human_control_duration_hours');
    } finally {
      if (needsRestore) await migration.up(queryRunner);
      await queryRunner.release();
    }
  });
});
