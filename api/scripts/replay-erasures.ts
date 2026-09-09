/**
 * Replay the erasures a database restore undid.
 *
 *   npx ts-node scripts/replay-erasures.ts --since 2026-09-09T02:00:00Z
 *   npx ts-node scripts/replay-erasures.ts --since <dump time> --dry-run
 *
 * Run this after ANY restore. `pg_dump` snapshots are immutable, so everything
 * erased after the dump's timestamp comes back with the restore — including data
 * subjects who asked to be forgotten. `compliance_events` records each
 * `leads.erased` and `tenant.deleted` for exactly this.
 *
 * `--since` should be the dump's `created_at` from the R2 object metadata, not
 * the time the restore finished.
 *
 * READ THIS BEFORE RUNNING FOR REAL:
 *  - `--dry-run` first. It reports the candidates and changes nothing.
 *  - Migrations are NOT run by this script (a restore may sit on an older schema,
 *    and applying migrations to it is a separate, deliberate act).
 *  - A real run writes an `erasure.replayed` compliance event with the timestamp
 *    and the counts.
 */
import 'reflect-metadata';
import { AppDataSource } from '../src/database/data-source';
import { replayErasuresSince } from '../src/compliance/replay-erasures.service';

function parseArgs(argv: string[]): { since: Date; dryRun: boolean } {
  const args = argv.slice(2);
  const sinceIdx = args.indexOf('--since');
  const raw = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
  if (!raw) {
    throw new Error('--since <ISO timestamp of the dump> is required');
  }
  const since = new Date(raw);
  if (Number.isNaN(since.getTime())) {
    throw new Error(`--since is not a date: ${raw}`);
  }
  return { since, dryRun: args.includes('--dry-run') };
}

async function main(): Promise<void> {
  const { since, dryRun } = parseArgs(process.argv);

  // Deliberately does not run migrations: pointing this at a restored database
  // must not change its schema as a side effect of replaying erasures.
  AppDataSource.setOptions({ migrationsRun: false, logging: false });
  await AppDataSource.initialize();
  try {
    const result = await replayErasuresSince(since, { dryRun });
    console.log(JSON.stringify(result, null, 2));
    if (result.failures.length > 0) {
      console.error(`\n${result.failures.length} subject(s) failed — re-run to retry them.`);
      process.exitCode = 1;
    }
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((error) => {
  console.error('replay-erasures failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
