/**
 * Timed human-control expiry sweep (B-PR5a, pilot-operations capability B3).
 *
 * A timed takeover writes `human_control_until`; this sweep is what makes that
 * deadline real. Every tick it returns expired HUMAN_OWNED sessions to the bot
 * through the transactional command service, so ownership + legacy status +
 * ownership_version + the open handoff row + the system event stay consistent
 * (never a raw status write).
 *
 * Concurrency discipline (mirrors the stale-handoff sweep in server.ts, made
 * importable so the worker is testable):
 *  - Each batch is ONE transaction. The candidate SELECT takes the row locks
 *    with `FOR UPDATE SKIP LOCKED`, so two concurrent sweep instances (or a
 *    sweep racing an in-flight operator command that holds the row lock) pick
 *    disjoint rows and never double-process.
 *  - Each locked row is released through
 *    `conversationCommands.releaseExpiredHumanControl` ON THE SAME manager.
 *    The command re-checks the expiry predicate on the locked row, which makes
 *    the sweep re-entrant: a session an operator released, re-claimed, or
 *    closed meanwhile is a no-op ('not_applicable' / 'not_expired').
 *  - Emit-after-commit: the normalized conversation:upsert for each released
 *    session fires only after the batch transaction committed. An emit failure
 *    is logged, never rolled into the write path.
 *
 * The 60s cadence (wired in server.ts) is a LIVENESS floor only - correctness
 * does not depend on it, because the inbound-message check in
 * message-forwarding releases an expired session before routing.
 */

import { AppDataSource } from '../database/data-source';
import { conversationCommands } from './conversation-command.service';
import { emitConversationUpsertForSession } from '../realtime/conversation-events';
import { logger } from '../utils/logger';

const EXPIRY_BATCH_SIZE = 100;
// Cap the tick at 1000 sessions; a larger backlog drains on subsequent ticks.
const EXPIRY_MAX_BATCHES = 10;

export const TIMED_CONTROL_EXPIRY_SOURCE = 'timed_control_expiry';

// In-flight guard: a slow tick (large backlog, slow DB) must not overlap the
// next interval fire in the SAME process. Cross-process overlap is what the
// FOR UPDATE SKIP LOCKED batches are for.
let sweepInFlight = false;

/** One sweep tick. Returns the number of sessions released to the bot.
 *  Returns 0 immediately when a tick is already running in this process. */
export async function sweepExpiredTimedControl(): Promise<number> {
  if (sweepInFlight) return 0;
  sweepInFlight = true;
  try {
    return await runSweep();
  } finally {
    sweepInFlight = false;
  }
}

async function runSweep(): Promise<number> {
  let totalReleased = 0;
  let batchSelected: number;
  let batches = 0;
  do {
    const releasedIds: string[] = [];
    batchSelected = 0;
    await AppDataSource.transaction(async (manager) => {
      // Oldest deadline first (fair: a full batch can never starve the
      // longest-overdue sessions behind newer ones); `<= now()` matches the
      // command's own DB-clock predicate. No partial index for this predicate
      // yet - that needs a migration and pilot scale does not need it; add
      // one if the sweep ever shows in pg_stat_statements.
      const rows = (await manager.query(
        `SELECT id FROM chat_sessions
          WHERE ownership = 'human_owned'
            AND human_control_mode = 'timed'
            AND human_control_until <= now()
          ORDER BY human_control_until ASC, id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [EXPIRY_BATCH_SIZE],
      )) as Array<{ id: string }>;
      batchSelected = rows.length;
      for (const row of rows) {
        // Same manager = same transaction = the SELECT's row lock is the lock
        // the command re-locks (a re-lock inside one transaction is free). The
        // command's own predicate re-check keeps this re-entrant even though a
        // locked row cannot change under us here.
        const result = await conversationCommands.releaseExpiredHumanControl(row.id, {
          manager,
          source: TIMED_CONTROL_EXPIRY_SOURCE,
        });
        if (result.outcome === 'released') releasedIds.push(row.id);
      }
    });
    // Post-commit only: the transaction above is done, the facts are durable.
    for (const id of releasedIds) {
      await emitConversationUpsertForSession(id);
    }
    totalReleased += releasedIds.length;
    batches++;
  } while (batchSelected === EXPIRY_BATCH_SIZE && batches < EXPIRY_MAX_BATCHES);

  if (totalReleased > 0) {
    logger.info(`Timed-control expiry sweep released ${totalReleased} sessions to bot`);
  }
  return totalReleased;
}
