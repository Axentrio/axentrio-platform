/**
 * The purge is an explicit list, because most tenant tables have NO foreign key
 * to `tenants` — nothing cascades. That makes a table added later survive every
 * deletion silently, which is the failure mode this file exists to prevent: it
 * reads the REAL schema and fails if a tenant-scoped table is neither purged nor
 * explicitly retained.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import {
  PURGE_BY_TENANT_ID,
  PURGE_BY_CAMEL_TENANT_ID,
  PURGE_BY_SESSION,
  PURGE_BY_CAMEL_SESSION,
  PURGE_VIA_PARENT,
  RETAINED_TABLES,
} from '../../tenants/tenant-deletion.service';

const PURGED = new Set([
  ...PURGE_BY_TENANT_ID,
  ...PURGE_BY_CAMEL_TENANT_ID,
  ...PURGE_BY_SESSION,
  ...PURGE_BY_CAMEL_SESSION,
  ...PURGE_VIA_PARENT,
]);

describe('tenant deletion coverage', () => {
  it('classifies every table that carries a tenant or session key', async () => {
    const rows: Array<{ table_name: string }> = await AppDataSource.query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name IN ('tenant_id', 'tenantId', 'session_id', 'sessionId')
        GROUP BY table_name`,
    );
    // Guards the guard: a schema that failed to build would make this vacuous.
    expect(rows.length).toBeGreaterThan(40);

    const unclassified = rows
      .map((r) => r.table_name)
      .filter((t) => !PURGED.has(t) && !(t in RETAINED_TABLES))
      .sort();

    expect(unclassified).toEqual([]);
  });

  it('names only tables that actually exist — a typo would purge nothing', async () => {
    const rows: Array<{ table_name: string }> = await AppDataSource.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const real = new Set(rows.map((r) => r.table_name));
    const missing = [...PURGED, ...Object.keys(RETAINED_TABLES)]
      .filter((t) => !real.has(t))
      .sort();

    expect(missing).toEqual([]);
  });

  it('retains the accounting tables with a stated reason', () => {
    for (const table of [
      'legal_invoices',
      'billing_events',
      'tenant_billing_accounts',
      'compliance_events',
    ]) {
      expect(RETAINED_TABLES[table], `${table} needs a reason`).toBeTruthy();
      expect(PURGED.has(table)).toBe(false);
    }
  });
});
