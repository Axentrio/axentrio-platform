import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../../database/data-source', () => ({
  AppDataSource: { query },
}));

import { claimInsightsLease } from '../../insights/analysis-eligibility.service';

describe('insights analysis lease', () => {
  beforeEach(() => query.mockReset());

  it('claims without stamping the manual cooldown and reports a held lease', async () => {
    query.mockResolvedValueOnce([{ tenant_id: 'tenant-1' }]).mockResolvedValueOnce([]);

    expect(await claimInsightsLease('tenant-1', new Date('2026-08-18T10:00:00Z'))).toBe(true);
    expect(await claimInsightsLease('tenant-1', new Date('2026-08-18T10:01:00Z'))).toBe(false);

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('analysis_running_since');
    expect(sql).not.toContain('last_manual_run_at');
  });
});
