import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Travel time is on by default, for the bots that exist and the ones that do not yet.
 *
 * `travel_time_enabled` was created `DEFAULT false` because the feature was unproven and
 * `travelTime` was entitled one tenant at a time by a super-admin override. Both halves of that
 * have gone: the rollout gates are closed (#63, #66, #67, #68, #77, and the Google billing
 * account is off its free trial) and travel is now a tier default on Pro and Enterprise. Leaving
 * the column off meant every owner had to go and find a switch for something they had already
 * been sold.
 *
 * ## Why a blanket backfill does not overwrite anybody's decision
 *
 * `updateSchedulerConfig` calls `requireFeature(tenantId, 'travelTime')` before it will write
 * this column, and until today `travelTime` was false at every tier with no tenant override in
 * existence. So no owner has ever been able to set it, every row is false because it was created
 * false, and there is no deliberate "off" here to preserve. This reasoning expires the moment
 * somebody switches it off on purpose — a later migration must not copy this one.
 *
 * ## Why on-by-default cannot do harm
 *
 * It cannot act where it should not:
 *
 *   - A Service that collects no customer address skips the travel gate entirely
 *     (`internal.provider.ts` returns the slots untouched), so a business that does not travel
 *     to its customers is unaffected and buys no Google elements.
 *   - The one configuration where travel makes a business WORSE off - two Agents sharing an
 *     itinerary key, where the gate strips slots for journeys nobody makes - is refused on the
 *     write path (`assertTravelEnableAllowed`) AND independently at runtime
 *     (`resolveTravelEligibility` returns `shared_itinerary`). This migration writes the column
 *     directly and so bypasses the write-path guard; the runtime one still holds, and the
 *     settings screen reports the row as `enabled` beside `blockedReason: 'shared_itinerary'`,
 *     which is a state it is already built to show. On, and visibly not running.
 *
 * ## Known interaction
 *
 * #59 is open: the scheduler models one Agent as one resource, so a multi-worker business is
 * already under-booked today. Travel narrows the same day further. It compounds an existing
 * defect rather than introducing one, and the fix belongs to #59.
 */
export class DefaultTravelTimeOn1790200000000 implements MigrationInterface {
  name = 'DefaultTravelTimeOn1790200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Future rows. TypeORM's entity default only applies to inserts it builds itself, so the
    // column default is what covers a raw insert or a hand-written row.
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        ALTER COLUMN "travel_time_enabled" SET DEFAULT true
    `);
    // Existing rows. Narrowed to the false ones so the write touches nothing already true and
    // the row count in the log is the number actually changed.
    await queryRunner.query(`
      UPDATE "chatbot_booking_settings"
         SET "travel_time_enabled" = true
       WHERE "travel_time_enabled" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Only the default is restored. Flipping the rows back would erase every owner who switched
    // travel on deliberately after this shipped, and nothing in the schema distinguishes them
    // from the rows this migration set. Reverting the rollout is a product decision that has to
    // name its own population; a `down` cannot guess it.
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        ALTER COLUMN "travel_time_enabled" SET DEFAULT false
    `);
  }
}
