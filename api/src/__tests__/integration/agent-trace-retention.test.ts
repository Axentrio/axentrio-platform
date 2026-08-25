/**
 * The agent-trace retention sweep.
 *
 * Against real Postgres, because the bug this replaces was a schema bug and nothing else:
 * the old raw SQL asked for `created_at` while the column is quoted `"createdAt"`, so every
 * run threw and the caller swallowed the error. A mocked query would have passed. These cases
 * only mean anything because the statement reaches the real table.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { AppDataSource } from '../../database/data-source';
import { AgentTrace } from '../../database/entities/AgentTrace';
import {
  sweepAgentTraces,
  TRACE_RETENTION_DAYS,
} from '../../agent/trace-retention.service';
import { createTestTenant } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

const DAY_MS = 24 * 60 * 60 * 1000;

let tenant: Tenant;

/**
 * A trace row aged `ageDays`. `createdAt` is a `@CreateDateColumn`, so the age has to be
 * written after the insert.
 */
async function seedTrace(ageDays: number): Promise<string> {
  const repo = AppDataSource.getRepository(AgentTrace);
  const row = await repo.save(repo.create({ tenantId: tenant.id, trace: {} }));
  if (ageDays > 0) {
    await AppDataSource.query('UPDATE agent_traces SET "createdAt" = $1 WHERE id = $2', [
      new Date(Date.now() - ageDays * DAY_MS),
      row.id,
    ]);
  }
  return row.id;
}

const exists = async (id: string) =>
  (await AppDataSource.getRepository(AgentTrace).countBy({ id })) === 1;

beforeEach(async () => {
  // The sweep counts over the whole table, which is safe because the shared `afterEach`
  // truncates every dirty table and each worker holds its own database.
  tenant = await createTestTenant({ tier: 'pro' });
});

describe('what the sweep removes', () => {
  it('deletes a trace past the retention window and keeps a fresh one', async () => {
    const old = await seedTrace(TRACE_RETENTION_DAYS + 1);
    const fresh = await seedTrace(0);

    expect(await sweepAgentTraces()).toEqual({ deleted: 1 });

    expect(await exists(old)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  it('keeps a trace one day inside the window', async () => {
    const nearly = await seedTrace(TRACE_RETENTION_DAYS - 1);

    expect(await sweepAgentTraces()).toEqual({ deleted: 0 });

    expect(await exists(nearly)).toBe(true);
  });

  it('reports every row it deleted, not just the first', async () => {
    await seedTrace(TRACE_RETENTION_DAYS + 5);
    await seedTrace(TRACE_RETENTION_DAYS + 40);
    await seedTrace(1);

    expect(await sweepAgentTraces()).toEqual({ deleted: 2 });

    expect(await AppDataSource.getRepository(AgentTrace).count()).toBe(1);
  });
});
