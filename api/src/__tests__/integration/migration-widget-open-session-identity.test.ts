/**
 * Migration 1791500000000-WidgetOpenSessionIdentity (B-PR4a).
 *
 * ORDER IS THE CONTRACT: remediation must run BEFORE the index build inside
 * the one migration - on dirty prod data an index-first migration fails and
 * crash-loops boot. These tests replay that exact sequence against a dirty
 * fixture.
 *
 * The synchronize-built test schema already carries the index (the entity
 * mirrors the migration), so each test that needs pre-migration state drops
 * it first - the same state prod is in before this migration runs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { AppDataSource } from '../../database/data-source';
import { WidgetOpenSessionIdentity1791500000000 } from '../../database/migrations/1791500000000-WidgetOpenSessionIdentity';
import { createTestTenant, createTestAnchorBot, createTestSession } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';
import type { Bot } from '../../database/entities/Bot';

const INDEX_NAME = 'uq_chat_sessions_widget_open';

async function runMigration(direction: 'up' | 'down', times = 1): Promise<void> {
  const migration = new WidgetOpenSessionIdentity1791500000000();
  const queryRunner = AppDataSource.createQueryRunner();
  try {
    await queryRunner.connect();
    for (let i = 0; i < times; i++) {
      await migration[direction](queryRunner);
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

async function dropIndex(): Promise<void> {
  await AppDataSource.query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
}

interface SessionRow {
  id: string;
  status: string;
  ownership: string;
  ended_at: Date | null;
  closed_reason: string | null;
}

async function rowsFor(tenantId: string, visitorId: string): Promise<SessionRow[]> {
  return AppDataSource.query(
    `SELECT id, status::text AS status, ownership, ended_at,
            metadata->>'closedReason' AS closed_reason
       FROM chat_sessions
      WHERE tenant_id = $1 AND visitor_id = $2
      ORDER BY last_activity_at DESC`,
    [tenantId, visitorId],
  );
}

async function setActivity(sessionId: string, minutesAgo: number): Promise<void> {
  await AppDataSource.query(
    `UPDATE chat_sessions
        SET last_activity_at = now() - ($2 || ' minutes')::interval,
            created_at = now() - ($2 || ' minutes')::interval
      WHERE id = $1`,
    [sessionId, String(minutesAgo)],
  );
}

let tenant: Tenant;
let bot: Bot;

beforeEach(async () => {
  tenant = await createTestTenant();
  bot = await createTestAnchorBot(tenant);
});

describe('WidgetOpenSessionIdentity migration - remediate THEN index', () => {
  it('closes all but the most-recently-active open widget session per identity, notes them, then the index holds', async () => {
    await dropIndex(); // pre-migration prod state

    // The 'anonymous'-style collision: THREE open widget sessions, one identity.
    const dupVisitor = `dup-${crypto.randomBytes(4).toString('hex')}`;
    const oldest = await createTestSession(tenant.id, { botId: bot.id, visitorId: dupVisitor, status: 'waiting' });
    const middle = await createTestSession(tenant.id, { botId: bot.id, visitorId: dupVisitor, status: 'bot' });
    const survivor = await createTestSession(tenant.id, { botId: bot.id, visitorId: dupVisitor, status: 'active' });
    await setActivity(oldest.id, 120);
    await setActivity(middle.id, 60);
    await setActivity(survivor.id, 1);
    // Already-closed history for the same identity: must NOT be re-touched.
    const preClosed = await createTestSession(tenant.id, {
      botId: bot.id,
      visitorId: dupVisitor,
      status: 'closed',
      ownership: 'closed',
    });
    await setActivity(preClosed.id, 240);

    // A clean single-session identity: untouched.
    const cleanVisitor = `clean-${crypto.randomBytes(4).toString('hex')}`;
    const clean = await createTestSession(tenant.id, { botId: bot.id, visitorId: cleanVisitor, status: 'bot' });

    // External sessions sharing one identity: OUT OF SCOPE for the index and
    // for remediation (source <> 'widget').
    const extVisitor = `ext-${crypto.randomBytes(4).toString('hex')}`;
    for (let i = 0; i < 2; i++) {
      await createTestSession(tenant.id, {
        botId: bot.id,
        visitorId: extVisitor,
        status: 'bot',
        source: 'telegram',
        channel: 'telegram',
      });
    }

    await runMigration('up', 2); // twice: re-running the up must be idempotent

    // Duplicate identity: ONE open survivor - the most recently active.
    const dupRows = await rowsFor(tenant.id, dupVisitor);
    const open = dupRows.filter((r) => r.status !== 'closed');
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(survivor.id);
    expect(open[0].closed_reason).toBeNull();

    // Losers: closed + ownership 'closed' + ended_at + the audit note.
    for (const loserId of [oldest.id, middle.id]) {
      const row = dupRows.find((r) => r.id === loserId)!;
      expect(row.status).toBe('closed');
      expect(row.ownership).toBe('closed');
      expect(row.ended_at).not.toBeNull();
      expect(row.closed_reason).toBe('b4a_dedup');
    }

    // Pre-closed history: untouched, and NOT stamped with the note.
    const preClosedRow = dupRows.find((r) => r.id === preClosed.id)!;
    expect(preClosedRow.status).toBe('closed');
    expect(preClosedRow.closed_reason).toBeNull();

    // Clean identity: untouched.
    const cleanRows = await rowsFor(tenant.id, cleanVisitor);
    expect(cleanRows).toHaveLength(1);
    expect(cleanRows[0].id).toBe(clean.id);
    expect(cleanRows[0].status).toBe('bot');
    expect(cleanRows[0].closed_reason).toBeNull();

    // External sessions: BOTH still open, no note.
    const extRows = await rowsFor(tenant.id, extVisitor);
    expect(extRows.filter((r) => r.status !== 'closed')).toHaveLength(2);
    expect(extRows.every((r) => r.closed_reason === null)).toBe(true);

    // The index exists and REJECTS a second open widget session…
    expect(await indexExists()).toBe(true);
    await expect(
      createTestSession(tenant.id, { botId: bot.id, visitorId: dupVisitor, status: 'bot' }),
    ).rejects.toThrow(/uq_chat_sessions_widget_open|duplicate key/i);
    // …while a further CLOSED row and further EXTERNAL rows stay legal.
    await expect(
      createTestSession(tenant.id, {
        botId: bot.id,
        visitorId: dupVisitor,
        status: 'closed',
        ownership: 'closed',
      }),
    ).resolves.toBeDefined();
    await expect(
      createTestSession(tenant.id, {
        botId: bot.id,
        visitorId: extVisitor,
        status: 'bot',
        source: 'telegram',
        channel: 'telegram',
      }),
    ).resolves.toBeDefined();
  });

  it('replays up(), down(), up() cleanly; down never reopens remediated sessions', async () => {
    await dropIndex();

    const visitor = `replay-${crypto.randomBytes(4).toString('hex')}`;
    const loser = await createTestSession(tenant.id, { botId: bot.id, visitorId: visitor, status: 'bot' });
    const winner = await createTestSession(tenant.id, { botId: bot.id, visitorId: visitor, status: 'bot' });
    await setActivity(loser.id, 90);
    await setActivity(winner.id, 5);

    await runMigration('up');
    expect(await indexExists()).toBe(true);

    await runMigration('down', 2); // idempotent down
    expect(await indexExists()).toBe(false);
    // The remediated close is a fact, not schema - down leaves it closed.
    const [afterDown] = await AppDataSource.query(
      `SELECT status::text AS status FROM chat_sessions WHERE id = $1`,
      [loser.id],
    );
    expect(afterDown.status).toBe('closed');

    await runMigration('up');
    expect(await indexExists()).toBe(true);
    const rows = await rowsFor(tenant.id, visitor);
    expect(rows.filter((r) => r.status !== 'closed')).toHaveLength(1);
    expect(rows.find((r) => r.status !== 'closed')!.id).toBe(winner.id);
  });
});
