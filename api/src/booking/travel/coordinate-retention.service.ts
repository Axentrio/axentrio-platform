/**
 * Deleting coordinates once they stop being ours.
 *
 * ADR-0014: the Maps terms permit `place_id` for as long as the booking and latitude and
 * longitude for **30 consecutive calendar days**, after which they must go. `storedPlace`
 * already refuses to USE an expired position, which is what stops a stale point from
 * deciding an appointment — but refusing to read a value is not deleting it, and deletion is
 * the half the licence actually constrains. This file is that half.
 *
 * IT IS NOT BOOKKEEPING. The default booking horizon is 60 days (`service-timing.ts`), so a
 * job booked two months out WILL outlive its coordinates, and re-resolving from the place id
 * is the ordinary path for a far-future appointment rather than an edge case. What this
 * sweep does to such a booking is exactly what the read path already assumes has happened.
 *
 * IDENTITY SURVIVES, POSITION DOES NOT. `customer_place_id` is the durable handle the
 * refresh goes through and is deliberately untouched; so are the verified address string and
 * the precision, which are what let a later reader audit a decision the gate made. Only the
 * two coordinates and their stamp are removed.
 *
 * NO ENTITLEMENT CHECK, NO ENV FLAG, and no per-tenant opt-in. This is a platform obligation
 * rather than a tenant preference, it is a no-op for every tenant that has never placed an
 * address — which is all of them today — and a licence control that only runs if somebody
 * remembers to switch it on is a licence control we do not have.
 *
 * NO TENANT NOTIFICATION either, unlike lead retention. Nothing an owner can see changes: the
 * appointment and the address they read are still there, and the position is restored the next
 * time anything needs it. Telling them would be reporting an internal cache eviction as an
 * event. The audit trail is per tenant, which is where the record belongs.
 *
 * `updated_at` IS DELIBERATELY NOT TOUCHED, which raw SQL gives for free and an entity-level
 * `update()` would not. A booking whose cached position was evicted has not been modified —
 * bumping the stamp would show the owner an appointment that looks edited and hand every
 * consumer watching that column a change to react to.
 *
 * ONE THING THIS DOES NOT COVER: `chatbot_booking_settings.venue_lat` / `venue_lng`. Nothing
 * writes them today — the premises are placed from their address text per call and never
 * persisted, precisely because those columns carry no timestamp and so no age could be
 * observed. Whichever ticket starts persisting a venue point has to add a stamp and a branch
 * here in the same change, or it reintroduces the breach this file closes.
 */
import { AppDataSource } from '../../database/data-source';
import { returningRows } from '../../utils/raw-sql';
import { logAudit } from '../../utils/audit';
import { logger } from '../../utils/logger';
import { COORDINATE_MAX_AGE_MS } from './booking-place';

/**
 * How often the sweep is expected to run, and therefore how early it has to delete.
 *
 * A DAILY sweep against a 30-day limit lets a row that ages out an hour after one run live
 * for nearly 31 days — a licence breach produced entirely by the scheduling, with the code
 * looking correct. Deleting a whole interval early means the worst case lands ON the limit
 * instead of past it. If the interval in `server.ts` changes, this constant must change with
 * it, which is why it is named after the schedule rather than after the number.
 */
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The age at which this job removes coordinates: strictly inside the licence's 30 days. */
export const COORDINATE_DELETE_AGE_MS = COORDINATE_MAX_AGE_MS - SWEEP_INTERVAL_MS;

/**
 * How far into the future a stamp may sit before it is treated as broken rather than fresh.
 *
 * Coordinates are stamped with the writing process's clock and swept against the sweeping
 * process's, so two app instances a few seconds apart would otherwise produce briefly
 * future-dated rows — and `storedPlace` refuses any future stamp, so those rows self-correct
 * within seconds. Deleting them would throw away coordinates that were about to be fine.
 *
 * A stamp an hour ahead is a different animal: a hand-edited row or a badly misconfigured
 * clock, whose age can never be shown to be inside the window and which would otherwise hold
 * coordinates for ever. That one is deleted, because an unprovable age IS the breach.
 */
export const FUTURE_STAMP_TOLERANCE_MS = 60 * 60 * 1000;

/** Rows per statement. Small enough not to hold a long write lock, large enough to drain. */
const BATCH_SIZE = 1_000;

/**
 * A stop on the batch loop, so a bug in the predicate cannot spin for ever.
 *
 * 100 batches is 100k coordinates in one run, orders of magnitude past any real backlog. It
 * is not a per-run quota to be topped up tomorrow: hitting it means something is wrong, and
 * it is logged as an error rather than counted.
 */
const MAX_BATCHES = 100;

let running = false;

export interface CoordinateSweepResult {
  /** Bookings whose coordinates were removed. */
  cleared: number;
  /** How many tenants those bookings belonged to. */
  tenantsAffected: number;
  batches: number;
  /** True when the loop stopped at `MAX_BATCHES` with rows still expired. */
  reachedBatchCeiling: boolean;
}

/**
 * Remove every coordinate pair the licence no longer covers.
 *
 * Re-entrant-safe in process and across processes: the guard below stops a slow run from
 * overlapping its own next tick, and `FOR UPDATE SKIP LOCKED` stops two app instances from
 * queueing on the same batch and double-counting rows one of them had already cleared.
 *
 * The cost of `SKIP LOCKED` is that a batch shortened by another instance's locks reads as a
 * drained one, so a few rows can wait for tomorrow's run. That is why the age above deletes a
 * whole interval early: a row deferred one run still goes at 30 days rather than past them.
 *
 * IT THROWS, and the caller in `server.ts` is what catches. That is the shape `sweepLeadRetention`
 * already has, and it is the right one: a licence job that swallowed its own database failures
 * would report a clean run every day while deleting nothing. What it must not do is lose the
 * batches that already committed — each is its own transaction — so a failure logs the running
 * total before it goes up, and only then rethrows.
 */
export async function sweepExpiredCoordinates(
  opts: { batchSize?: number } = {}
): Promise<CoordinateSweepResult> {
  const result: CoordinateSweepResult = {
    cleared: 0,
    tenantsAffected: 0,
    batches: 0,
    reachedBatchCeiling: false,
  };
  if (running) return result;
  running = true;

  try {
    const now = Date.now();
    const batchSize = opts.batchSize ?? BATCH_SIZE;
    // Both bounds off the APP clock, the same one that stamps the coordinates. Comparing a
    // JS-written stamp against the database's `now()` is how the coalescer's re-arm loop
    // saturated the model's token budget in production; the two clocks are not the same clock.
    const oldest = new Date(now - COORDINATE_DELETE_AGE_MS);
    const newest = new Date(now + FUTURE_STAMP_TOLERANCE_MS);
    const perTenant = new Map<string, number>();
    let drained = false;

    while (!drained && result.batches < MAX_BATCHES) {
      // The three shapes are the three `storedPlace` refuses to read — too old, no stamp,
      // dated ahead — because a coordinate the read path will not use and this job will not
      // delete is one held for ever while pretending not to have it. The THRESHOLDS are
      // deliberately not the same: this side deletes a whole interval early and tolerates an
      // hour of clock skew, both argued above. So the two agree on what expiry MEANS and
      // disagree, on purpose, about when to act on it — this side always acting first.
      //
      // Nulling the stamp alongside the coordinates is what makes the loop terminate and the
      // count honest: a swept row no longer matches, so it is neither re-selected tomorrow
      // nor counted twice today.
      const rows = returningRows<{ tenant_id: string }>(
        await AppDataSource.query(
          `WITH expired AS (
             SELECT id FROM chatbot_bookings
              WHERE (customer_lat IS NOT NULL OR customer_lng IS NOT NULL)
                AND (customer_coords_at IS NULL
                     OR customer_coords_at < $1
                     OR customer_coords_at > $2)
              ORDER BY customer_coords_at ASC NULLS FIRST
              LIMIT $3
                FOR UPDATE SKIP LOCKED
           )
           UPDATE chatbot_bookings b
              SET customer_lat = NULL,
                  customer_lng = NULL,
                  customer_coords_at = NULL
             FROM expired e
            WHERE b.id = e.id
          RETURNING b.tenant_id`,
          [oldest.toISOString(), newest.toISOString(), batchSize]
        )
      );

      result.batches += 1;
      for (const row of rows) {
        perTenant.set(row.tenant_id, (perTenant.get(row.tenant_id) ?? 0) + 1);
        result.cleared += 1;
      }
      // A short batch is the only proof there is nothing left. A full one says only that the
      // limit was reached, so the loop asks again.
      drained = rows.length < batchSize;
    }

    result.reachedBatchCeiling = !drained;
    result.tenantsAffected = perTenant.size;

    for (const [tenantId, cleared] of perTenant) {
      await logAudit('system', 'bookings.coordinates_expired', 'tenant', tenantId, tenantId, {
        cleared,
        maxAgeDays: Math.round(COORDINATE_MAX_AGE_MS / 86_400_000),
      }).catch(() => {});
    }

    if (result.reachedBatchCeiling) {
      logger.error('[travel-coords] sweep stopped at the batch ceiling with rows still expired', result);
    }
    // Logged on EVERY run, including the empty ones. "It removed nothing" and "it did not run"
    // are the two answers this line exists to tell apart, and only one of them is a problem.
    logger.info('[travel-coords] sweep complete', result);
    return result;
  } catch (error) {
    // Each batch is its own transaction, so a failure part-way through has still deleted
    // everything up to it. Rethrowing without saying that would leave the operator reading a
    // stack trace and no record of what actually went, which is the AC this job is measured on.
    logger.error('[travel-coords] sweep failed part-way through', {
      ...result,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    running = false;
  }
}

/**
 * Put the sweep on its schedule.
 *
 * THE SCHEDULE LIVES HERE, not in `server.ts`, and that is a deliberate break from every other
 * background job in this codebase. For the others the interval is an operational preference:
 * run the lead sweep twice a day and nothing is wrong, only different. Here it is an input to
 * correctness — `COORDINATE_DELETE_AGE_MS` is derived from it, and a `setInterval` edited in
 * another file without the constant reintroduces the 31st day silently. A comment asking the
 * next reader to keep two numbers in step is not a mechanism. One caller, one number.
 *
 * ONE RUN SHORTLY AFTER BOOT AS WELL AS ON THE INTERVAL, and that is not belt-and-braces. A
 * plain 24-hour timer only ever fires if the process lives 24 hours, and this one redeploys
 * more often than that — so a deletion obligation hung on the interval alone could go months
 * without running while looking perfectly well scheduled. 90s of headroom so the first run
 * starts behind the boot traffic.
 */
export function startCoordinateExpirySweep(): void {
  const run = () => {
    sweepExpiredCoordinates().catch((error) => {
      // Already logged with its running total inside; this is the last line of defence that
      // keeps one bad night from taking an unhandled rejection to the process.
      logger.error('[travel-coords] scheduled sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  setTimeout(run, 90_000);
  setInterval(run, SWEEP_INTERVAL_MS);
}
