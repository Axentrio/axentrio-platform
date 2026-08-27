import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Split `in_person` into explicit location types.
 *
 * SAFE MAP ONLY: a travel-flagged In person row is already a job at the customer's
 * address, so it becomes `customer_location`. Other `in_person` rows stay as a review
 * leftover until the owner picks. Live booking behaviour does not change for those rows.
 *
 * `customer_chooses_location` on a mapped travel row is cleared: the travel flag already
 * won, and customer_location cannot also be a per-booking choice.
 */
export class SplitInPersonLocationType1793300000000 implements MigrationInterface {
  name = 'SplitInPersonLocationType1793300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const mapped: Array<{ id: string }> = await queryRunner.query(
      `UPDATE "chatbot_service_types"
          SET "location_type" = 'customer_location',
              "customer_chooses_location" = false
        WHERE "location_type" = 'in_person'
          AND "customer_address_required" = true
        RETURNING "id"`,
    );

    const review: Array<{ id: string }> = await queryRunner.query(
      `SELECT "id" FROM "chatbot_service_types" WHERE "location_type" = 'in_person'`,
    );

    /* eslint-disable no-console */
    console.log(
      `[1793300000000] mapped ${mapped.length} travel in_person service(s) to customer_location`,
    );
    if (review.length) {
      console.log(
        `[1793300000000] LEFT FOR REVIEW: ${review.length} in_person service(s) without the travel flag. ` +
          `ids: ${review.map((r) => r.id).join(', ')}`,
      );
    }
    /* eslint-enable no-console */
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "chatbot_service_types"
          SET "location_type" = 'in_person',
              "customer_address_required" = true
        WHERE "location_type" = 'customer_location'`,
    );
    // Review leftovers that stayed `in_person` need no reverse write.
    // `business_location` rows created after this migration are not restored to `in_person`
    // because that would re-introduce the ambiguous value on purpose.
  }
}
