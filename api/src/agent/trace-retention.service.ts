/**
 * Agent-trace retention (30 days).
 *
 * The original sweep lived as a closure in `server.ts` and ran raw SQL against
 * `created_at`. The entity declares `@CreateDateColumn createdAt` with no `name:`
 * override, so the real column is quoted `"createdAt"` - every daily run threw
 * `column "created_at" does not exist`, and the catch around it logged and swallowed
 * the error. No row was ever deleted. It goes through the ORM here so the entity
 * metadata produces the quoting, which makes the casing bug impossible to write again.
 */
import { LessThan } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { AgentTrace } from '../database/entities/AgentTrace';
import { logger } from '../utils/logger';

/** How long a trace row is kept. */
export const TRACE_RETENTION_DAYS = 30;

/**
 * Delete every trace row older than the retention window.
 *
 * One statement, no batching and no re-entrancy guard: the table is a few megabytes
 * and grows about 30 rows a day, so there is no run long enough to overlap the next.
 */
export async function sweepAgentTraces(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await AppDataSource.getRepository(AgentTrace).delete({
    createdAt: LessThan(cutoff),
  });
  const deleted = result.affected ?? 0;
  if (deleted > 0) logger.info('[trace-retention] swept old agent traces', { deleted });
  return { deleted };
}

/**
 * Put the sweep on its schedule.
 *
 * ONE RUN SHORTLY AFTER BOOT AS WELL AS ON THE INTERVAL. A plain 24-hour timer only
 * fires if the process lives 24 hours, and this API redeploys more often than that -
 * so a deletion obligation hung on the interval alone can go months without running
 * while it looks perfectly well scheduled. 90s of headroom keeps the first run behind
 * the boot traffic.
 */
export function startAgentTraceRetentionSweep(): void {
  const run = () => {
    sweepAgentTraces().catch((error) => {
      logger.error('[trace-retention] sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  setTimeout(run, 90_000);
  setInterval(run, 24 * 60 * 60 * 1000);
}
