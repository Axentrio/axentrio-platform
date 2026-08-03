import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `last_manual_run_at` + `analysis_running_since` on the per-tenant insights state.
 *
 * Essential and Pro analyse on demand rather than nightly, so the cooldown between
 * manual runs needs its own timestamp. It cannot reuse `last_refreshed_at`: that is the
 * judge WATERMARK — it moves with the sessions consumed and is deliberately frozen at a
 * failed session so the next pass retries. Deriving a cooldown from it would let a run
 * that judged nothing reset the clock, or a failed run block the retry it exists to allow.
 *
 * Nullable with no backfill: null reads as "never run manually", which is true for every
 * existing tenant and makes the first manual run immediately available rather than
 * starting everyone inside a cooldown they never triggered.
 *
 * `analysis_running_since` is a claim LEASE, not a boolean. An on-demand analysis is one
 * LLM call per conversation and runs far longer than any HTTP request should, so it runs
 * in the background and the portal polls. A boolean would strand the UI on "analysing"
 * forever if the process died mid-run; a timestamp lets a stale claim expire, and it
 * works across instances where an in-memory flag would not.
 */
export class AddInsightsManualRun1788300000000 implements MigrationInterface {
  name = 'AddInsightsManualRun1788300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chatbot_insights_refresh_state
        ADD COLUMN IF NOT EXISTS last_manual_run_at timestamptz,
        ADD COLUMN IF NOT EXISTS analysis_running_since timestamptz
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chatbot_insights_refresh_state
        DROP COLUMN IF EXISTS last_manual_run_at,
        DROP COLUMN IF EXISTS analysis_running_since
    `);
  }
}
