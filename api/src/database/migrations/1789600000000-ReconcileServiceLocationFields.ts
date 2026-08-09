import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #79 (LP1) - make the stored fields agree with the answer everything already gives.
 *
 * A Service's location lives in two columns that can contradict each other.
 * `customer_address_required` says the owner goes to the Booking Customer; `location_type` says
 * video / phone / in-person / custom / unset. Every reader already resolves the contradiction the
 * same way - the flag wins, because service-area gating refuses bookings on it alone without ever
 * reading `location_type` - so the rows are not misbehaving. They are just stating something that
 * is not true of them, and the next reader who trusts the column rather than the resolver will
 * get it wrong.
 *
 * THIS ONLY TOUCHES DISAGREEMENTS THAT CARRY NO BEHAVIOUR, and that limit is the whole design.
 *
 *   custom + travels  -> in_person. `custom` means "no location on the invite", which is already
 *                        overridden by the flag. Nothing observable changes.
 *   unset  + travels  -> in_person. `unset` means nobody was ever asked (#71) - but ticking
 *                        "travel to the customer" IS an answer, so the row is no longer unasked.
 *
 * LEFT ALONE, DELIBERATELY: `google_meet` and `phone` with the travel flag set. `location_type =
 * 'google_meet'` is what mints the Meet link - `internal.provider.ts` reads it at three sites and
 * `sync-reconciler.ts` at a fourth - so rewriting it to `in_person` would silently stop creating
 * meeting links for that Service. That is a real contradiction with real behaviour attached on
 * both sides, and it wants a person, not a migration. They are counted and logged instead.
 *
 * At the time of writing this touches ZERO rows in production: every Service is either
 * `google_meet` or `unset`, both with the flag clear. It is written for the state the columns can
 * reach rather than the state they happen to be in, which is also why it reports counts - a
 * migration that silently did nothing and a migration that silently did something look identical
 * afterwards.
 */
export class ReconcileServiceLocationFields1789600000000 implements MigrationInterface {
  name = 'ReconcileServiceLocationFields1789600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const reconciled: unknown[] = await queryRunner.query(
      `UPDATE "chatbot_service_types"
          SET "location_type" = 'in_person'
        WHERE "customer_address_required" = true
          AND "location_type" IN ('custom', 'unset')
        RETURNING 1`
    );

    const conflicting: Array<{ id: string; location_type: string }> = await queryRunner.query(
      `SELECT "id", "location_type" FROM "chatbot_service_types"
        WHERE "customer_address_required" = true
          AND "location_type" IN ('google_meet', 'phone')`
    );

    /* eslint-disable no-console */
    console.log(
      `[1789600000000] reconciled ${reconciled?.length ?? 0} service(s) to in_person ` +
        `(custom/unset with the travel flag set)`
    );
    if (conflicting.length) {
      // Named, not just counted. Each of these needs an owner to say which they meant, and an
      // operator cannot ask without knowing which rows to ask about.
      console.log(
        `[1789600000000] LEFT ALONE: ${conflicting.length} service(s) claim a remote modality AND ` +
          `the travel flag. Rewriting them would stop meeting links being created. ` +
          `ids: ${conflicting.map((r) => `${r.id}(${r.location_type})`).join(', ')}`
      );
    }
    /* eslint-enable no-console */
  }

  public async down(): Promise<void> {
    // NOT REVERSIBLE, and saying so is better than pretending.
    //
    // `up` collapses two distinct prior values - `custom` and `unset` - into one, and nothing
    // records which row was which. A `down` would have to guess, and guessing `unset` would put
    // rows back into "nobody was ever asked" when somebody had. The forward change is safe on its
    // own terms: it makes the column state what every reader already concludes, so re-running the
    // old code against the new data behaves identically.
  }
}
