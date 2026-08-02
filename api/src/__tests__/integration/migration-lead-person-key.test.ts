/**
 * Boot-safety guard for AddLeadPersonKey: runs up() against the real test DB so a SQL
 * typo cannot crash-loop prod on boot. Mirrors migration-lead-conversations.test.ts.
 *
 * Integration tests build their schema with `synchronize()` from the entities, so
 * migration SQL is otherwise never executed by any test — the exact gap that has
 * crash-looped this service before. Every statement here is additive and
 * IF NOT EXISTS-guarded; running up() twice proves both.
 *
 * down() is deliberately not exercised: it drops columns the synchronized schema needs
 * for the other suites sharing this worker's database.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { AddLeadPersonKey1788200000000 } from '../../database/migrations/1788200000000-AddLeadPersonKey';

describe('AddLeadPersonKey migration', () => {
  it('up() runs without error and is idempotent against an existing schema', async () => {
    const m = new AddLeadPersonKey1788200000000();
    const qr = AppDataSource.createQueryRunner();
    try {
      await qr.connect();
      await m.up(qr);
      await m.up(qr); // re-running on boot must be a no-op, not an error
    } finally {
      await qr.release();
    }
  });

  it('produces the columns the sweep and the read path use', async () => {
    const cols: Array<{ column_name: string }> = await AppDataSource.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'chatbot_leads'`,
    );
    const names = new Set(cols.map((c) => c.column_name));
    for (const required of [
      'person_key',
      'person_lead_count',
      'person_conversation_count',
      'person_first_seen_at',
      'person_last_seen_at',
    ]) {
      expect(names.has(required)).toBe(true);
    }
  });

  it('indexes the grouping read, and only the rows the sweep may group', async () => {
    // The partial predicate is the point: a NULL key groups with nothing, and an
    // erased row must never be grouped at all. An index that exists only in prod is
    // how index-shape surprises reach production in this repo, so assert the shape
    // the synchronized schema and the migration are both supposed to produce.
    const [idx]: Array<{ indexdef: string }> = await AppDataSource.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'chatbot_leads' AND indexname = 'ix_chatbot_leads_person'`,
    );
    expect(idx).toBeDefined();
    expect(idx.indexdef).toContain('tenant_id');
    expect(idx.indexdef).toContain('person_key');
    expect(idx.indexdef).toContain('deleted_at IS NULL');
    // NOT unique — several rows per key is the entire purpose of the column.
    expect(idx.indexdef).not.toContain('UNIQUE');
  });
});
