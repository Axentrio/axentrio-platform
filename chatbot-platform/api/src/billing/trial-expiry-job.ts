/**
 * Trial-expiry Bull job — schedules per-tenant delayed expiry checks plus
 * a daily safety-net sweep.
 *
 * Two job types share the `billing` queue:
 *
 *   - `expire_trial`       — fires once per tenant at the tenant's `trial_end`.
 *   - `sweep_expired_trials` — repeatable cron job (daily) that picks up
 *                              trials whose delayed job never ran (queue
 *                              outage, app restart pre-schedule, etc.).
 *
 * Both call `service.expireTrialIfStillManual` (or the sweep wrapper),
 * which is idempotent — safe to run twice.
 *
 * Plan: .scratch/plan-billing.md § Reverse-trial signup flow → Trial-expiry job
 *       and Daily safety-net sweep, § Implementation outline step 5.
 */

import { Job } from 'bull';
import { getQueue, registerProcessor } from '../queue/message-queue';
import { logger } from '../utils/logger';
import { expireTrialIfStillManual, sweepExpiredTrials } from './service';

const QUEUE_NAME = 'billing';
const JOB_EXPIRE_TRIAL = 'expire_trial';
const JOB_SWEEP_TRIALS = 'sweep_expired_trials';

// Cron expression: every day at 03:17 UTC. Off-peak, prime-numbered to
// reduce chance of colliding with other repeatable jobs.
const SWEEP_CRON = '17 3 * * *';

interface ExpireTrialJobData {
  type: typeof JOB_EXPIRE_TRIAL;
  tenantId: string;
}

interface SweepTrialsJobData {
  type: typeof JOB_SWEEP_TRIALS;
}

type BillingJobData = ExpireTrialJobData | SweepTrialsJobData;

/**
 * Schedule a one-shot trial-expiry job for `tenantId` at `trialEnd`.
 * Idempotent via jobId: a second call for the same tenant within the
 * same trial window replaces the previous schedule.
 *
 * No-op (with warning) when the queue isn't available (Redis down).
 * The daily sweep is the authoritative recovery path; this scheduling
 * just shaves latency in the happy path.
 */
export async function scheduleTrialExpiry(tenantId: string, trialEnd: Date): Promise<void> {
  const queue = getQueue(QUEUE_NAME);
  if (!queue) {
    logger.warn('billing queue unavailable — relying on daily sweep for trial expiry', { tenantId });
    return;
  }
  const delayMs = Math.max(0, trialEnd.getTime() - Date.now());
  await queue.add(
    { type: JOB_EXPIRE_TRIAL, tenantId } satisfies ExpireTrialJobData,
    {
      jobId: `expire_trial:${tenantId}`,
      delay: delayMs,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: 50,
    },
  );
}

/**
 * Register the repeatable daily sweep job. Called once at server startup.
 * The repeatable jobId is fixed so re-registration replaces the existing
 * schedule rather than adding a duplicate.
 *
 * **Throws** when the billing queue is unavailable — the daily sweep is the
 * authoritative recovery path for trial expiry, so a missing queue is a
 * fatal condition the caller (server.ts) must surface. Production startup
 * refuses to come up; non-prod logs and continues.
 */
export async function scheduleDailySweep(): Promise<void> {
  const queue = getQueue(QUEUE_NAME);
  if (!queue) {
    throw new Error(
      'scheduleDailySweep: billing queue unavailable — cannot register the authoritative trial-expiry sweep',
    );
  }
  await queue.add(
    { type: JOB_SWEEP_TRIALS } satisfies SweepTrialsJobData,
    {
      jobId: 'sweep_expired_trials',
      repeat: { cron: SWEEP_CRON },
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
}

/**
 * Register the queue processor. Called once at server startup, after
 * `initializeQueues()`.
 */
export function registerTrialExpiryProcessor(): void {
  registerProcessor(QUEUE_NAME, async (job: Job<BillingJobData>) => {
    const data = job.data;
    if (data.type === JOB_EXPIRE_TRIAL) {
      const result = await expireTrialIfStillManual(data.tenantId);
      logger.info('Trial expiry job processed', {
        tenantId: data.tenantId,
        downgraded: result.downgraded,
        reason: result.reason,
      });
      return;
    }
    if (data.type === JOB_SWEEP_TRIALS) {
      const summary = await sweepExpiredTrials();
      logger.info('Trial sweep complete', summary);
      return;
    }
    // Unknown payload shape — log and ignore (don't throw to avoid retry storms).
    logger.warn('Unknown billing job type', { data });
  });
}
