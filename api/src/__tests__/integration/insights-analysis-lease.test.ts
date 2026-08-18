import { describe, expect, it } from 'vitest';
import {
  claimAnalysisRun,
  claimInsightsLease,
  releaseAnalysisRun,
} from '../../insights/analysis-eligibility.service';
import { createTestTenant } from '../helpers/factories';

describe('insights analysis lease integration', () => {
  it('prevents an automatic pass from overlapping a manual run', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const now = new Date('2026-08-18T10:00:00Z');

    expect(await claimAnalysisRun(tenant.id, now)).toBe(true);
    expect(await claimInsightsLease(tenant.id, new Date(now.getTime() + 60_000))).toBe(false);

    await releaseAnalysisRun(tenant.id);
    expect(await claimInsightsLease(tenant.id, new Date(now.getTime() + 120_000))).toBe(true);
    await releaseAnalysisRun(tenant.id);
  });
});
