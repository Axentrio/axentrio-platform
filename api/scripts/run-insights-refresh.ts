/**
 * Manually trigger the Insights refresh for one tenant — same code path as
 * the nightly RefreshInsightsJob (judge → canonicalize → aggregate), useful
 * for ops verification and for backfilling right after enabling a tenant
 * instead of waiting for 02:00 UTC.
 *
 *   npx ts-node --transpile-only scripts/run-insights-refresh.ts <tenantId>
 *
 * Uses api/.env (DATABASE_URL, OPENAI_API_KEY/ANTHROPIC_API_KEY) — be aware
 * that in this repo api/.env points at PROD.
 */
import 'reflect-metadata';
import { AppDataSource } from '../src/database/data-source';
import { refreshTenantInsights } from '../src/insights/refresh-insights.job';

async function main(): Promise<void> {
  const tenantId = process.argv[2];
  if (!tenantId) {
    console.error('usage: ts-node scripts/run-insights-refresh.ts <tenantId>');
    process.exit(1);
  }
  await AppDataSource.initialize();
  console.log(`[run-insights-refresh] refreshing tenant ${tenantId}…`);
  await refreshTenantInsights(tenantId);
  await AppDataSource.destroy();
  console.log('[run-insights-refresh] done');
}

main().catch((err) => {
  console.error('[run-insights-refresh] failed:', err);
  process.exit(1);
});
