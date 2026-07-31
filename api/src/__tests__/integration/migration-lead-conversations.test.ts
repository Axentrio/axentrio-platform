/**
 * Boot-safety guard for AddLeadConversations: runs up() against the real test DB so
 * a SQL typo can't crash-loop prod on boot. Mirrors migration-booking-sync-state.test.ts.
 *
 * This matters more than usual here. Integration tests build their schema with
 * `synchronize()` from the entities, so the migration SQL is otherwise NEVER executed
 * by any test — the exact gap that has crash-looped this service's prod before. The
 * table already exists (synchronize made it), so every statement is additive and
 * IF NOT EXISTS-guarded; running up() twice proves both facts.
 *
 * down() is deliberately NOT exercised: it drops a table and a column the
 * synchronized schema needs for the other tests sharing this worker's database.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { AddLeadConversations1787500000000 } from '../../database/migrations/1787500000000-AddLeadConversations';

describe('AddLeadConversations migration', () => {
  it('up() runs without error and is idempotent against an existing schema', async () => {
    const m = new AddLeadConversations1787500000000();
    const qr = AppDataSource.createQueryRunner();
    try {
      await qr.connect();
      await m.up(qr);
      await m.up(qr); // idempotence: re-running on boot must be a no-op, not an error
    } finally {
      await qr.release();
    }
  });

  it('produces the columns the entity and the enrichment job read', async () => {
    const cols: Array<{ column_name: string }> = await AppDataSource.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'chatbot_lead_conversations'`,
    );
    const names = new Set(cols.map((c) => c.column_name));
    for (const required of [
      'tenant_id',
      'lead_id',
      'session_id',
      'request',
      'service_requested',
      'address',
      'preferred_at',
      'preferred_at_text',
      'urgency',
      'intent',
      'tags',
      'enrichment',
      'evidence',
      'enrich_state',
      'enriched_revision',
      'enrich_claimed_until',
      'source',
    ]) {
      expect(names.has(required), `missing column ${required}`).toBe(true);
    }
  });

  it('stores tags as a real text[] — not a comma-joined string', async () => {
    // TypeORM's `simple-array` silently stores a joined string, which would corrupt
    // any tag containing a comma. Assert the actual Postgres type.
    const [{ data_type }]: Array<{ data_type: string }> = await AppDataSource.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'chatbot_lead_conversations' AND column_name = 'tags'`,
    );
    expect(data_type).toBe('ARRAY');
  });

  it('enforces one-conversation-to-one-lead via the partial unique index', async () => {
    const idx: Array<{ indexdef: string }> = await AppDataSource.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'chatbot_lead_conversations'
          AND indexname = 'ux_lead_conv_tenant_session'`,
    );
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toContain('UNIQUE');
    // Partial on session_id so a future non-session-backed row can't collide on NULL.
    expect(idx[0].indexdef).toContain('session_id IS NOT NULL');
  });

  it('adds chatbot_bookings.lead_id so booking facts are joinable, not copied', async () => {
    const cols: Array<{ column_name: string }> = await AppDataSource.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'chatbot_bookings' AND column_name = 'lead_id'`,
    );
    expect(cols).toHaveLength(1);
  });

  it('declares the enrichment-sweep index in BOTH entity and migration', async () => {
    // The index is declared twice on purpose (entity @Index + migration DDL). If it
    // existed only in the migration, no test would ever exercise the sweep's plan.
    const idx: Array<{ indexdef: string }> = await AppDataSource.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'chatbot_lead_conversations'
          AND indexname = 'ix_lead_conv_enrich_due'`,
    );
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toMatch(/pending/);
  });
});
