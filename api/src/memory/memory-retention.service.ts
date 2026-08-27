/**
 * Customer-memory retention (12 months) and stuck-run hygiene.
 *
 * Deletes go through the ORM so column quoting matches the entity. Facts and
 * run rows disappear with the subject through ON DELETE CASCADE.
 */
import { LessThan } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { CustomerMemory } from '../database/entities/CustomerMemory';
import { logger } from '../utils/logger';
import { returningRows } from '../utils/raw-sql';

export const CUSTOMER_MEMORY_RETENTION_DAYS = 365;

export async function sweepCustomerMemory(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - CUSTOMER_MEMORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await AppDataSource.getRepository(CustomerMemory).delete({
    lastSeenAt: LessThan(cutoff),
  });
  const deleted = result.affected ?? 0;
  if (deleted > 0) logger.info('[customer-memory] retention swept', { deleted });
  return { deleted };
}

export function startCustomerMemoryRetentionSweep(): void {
  const run = () => {
    sweepCustomerMemory().catch((error) => {
      logger.error('[customer-memory] sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  setTimeout(run, 90_000);
  setInterval(run, 24 * 60 * 60 * 1000);
}

export async function sweepStuckMemoryRuns(): Promise<{ released: number; exhausted: number }> {
  const releasedRows = returningRows<{ id: string }>(
    await AppDataSource.query(
      `UPDATE chatbot_customer_memory_runs
          SET state = 'pending', claimed_until = NULL, updated_at = now()
        WHERE state = 'claimed' AND claimed_until IS NOT NULL AND claimed_until < now() - interval '10 minutes'
        RETURNING id`,
    ),
  );
  const released = releasedRows.length;
  const [countRow] = await AppDataSource.query(
    `SELECT count(*)::int AS n FROM chatbot_customer_memory_runs WHERE state = 'failed' AND attempts >= 3`,
  );
  const exhausted = Number(countRow?.n ?? 0);
  if (released > 0 || exhausted > 0) {
    logger.warn('[customer-memory] stuck runs found', {
      expiredLeases: released,
      exhaustedAttempts: exhausted,
    });
  }
  return { released, exhausted };
}

export function startStuckMemoryRunWatcher(): void {
  const run = () => {
    sweepStuckMemoryRuns().catch((error) => {
      logger.error('[customer-memory] sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  setTimeout(run, 120_000);
  setInterval(run, 15 * 60 * 1000);
}
