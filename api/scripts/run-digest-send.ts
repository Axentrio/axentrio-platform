/**
 * Manually drain the weekly-digest email outbox — same claim-based reconciler
 * the nightly RefreshInsightsJob runs (lease → Resend send → sent/backoff),
 * useful for ops verification right after generating a digest instead of
 * waiting for 02:00 UTC.
 *
 *   npx ts-node --transpile-only scripts/run-digest-send.ts
 *
 * Uses api/.env (DATABASE_URL, RESEND_API_KEY) — note: in this repo api/.env
 * points at PROD, so this sends REAL email to tenants' billing addresses.
 */
import 'reflect-metadata';
import { AppDataSource } from '../src/database/data-source';
import { sendDueDigests } from '../src/insights/digest-send.service';

async function main(): Promise<void> {
  await AppDataSource.initialize();
  console.log('[run-digest-send] draining due digests…');
  const result = await sendDueDigests();
  console.log('[run-digest-send] done:', JSON.stringify(result));
  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error('[run-digest-send] failed:', err);
  process.exit(1);
});
