import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #71 - separate "nobody was ever asked" from "somebody chose none".
 *
 * `location_type` shipped with `NOT NULL DEFAULT 'custom'` and no backfill ever ran. `custom`
 * means "put no location on the invite", so every Service created by hand before the dropdown
 * existed has been silently saying that - and a venue the owner typed into Settings reached
 * nothing: not the calendar event, not the ICS `LOCATION`, not the "Where:" line in the
 * customer's email. The Availability card promises the opposite, unconditionally.
 *
 * The hard part is that a migration cannot tell a legacy row from a deliberate one. Both say
 * `custom`. For a Service created AFTER the dropdown shipped, `custom` is an informed choice
 * whose helper text reads "No location is put on the invite", and overwriting that would put an
 * address on invites an owner deliberately left blank.
 *
 * SO THIS DOES NOT GUESS INTENT. It marks the rows that COULD NOT have expressed any, and the
 * read path decides what to do about them.
 *
 * THE CUTOFF is `0acfc6d`, "make locationType a real setting instead of a stuck default",
 * committed 2026-08-05 08:23:47 UTC - the change that first put the control in front of an
 * owner. A row created before it had no way to say anything, whatever it stores.
 *
 * The commit timestamp is used rather than the deploy time that followed it, and the direction
 * of that choice is deliberate: it marks FEWER rows, so a deliberate `custom` is never
 * reclassified. Rows created in the window between commit and deploy stay `custom` and are
 * treated as intentional. That is the recoverable error - an owner who sees no location can add
 * one - where the opposite silently puts their address on a customer's invite.
 *
 * Reversible exactly: `unset` exists nowhere else, so `down` restores every marked row.
 */
export class MarkNeverAskedServiceLocation1789500000000 implements MigrationInterface {
  name = 'MarkNeverAskedServiceLocation1789500000000';

  /** `0acfc6d`, the commit that first showed an owner this control. */
  private readonly DROPDOWN_SHIPPED_AT = '2026-08-05 08:23:47+00';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const marked: Array<{ count: string }> = await queryRunner.query(
      `UPDATE "chatbot_service_types"
          SET "location_type" = 'unset'
        WHERE "location_type" = 'custom'
          AND "created_at" < $1::timestamptz
        RETURNING 1 AS count`,
      [this.DROPDOWN_SHIPPED_AT]
    );
    // Logged rather than silent: this is a data change on rows nobody chose, and the number is
    // the only evidence of how wide it was.
    // eslint-disable-next-line no-console
    console.log(`[1789500000000] marked ${marked?.length ?? 0} service(s) as location never-asked`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // `unset` is not selectable and is written nowhere else, so every row holding it was marked
    // by `up`. Restoring them to `custom` returns the table exactly to its prior state.
    await queryRunner.query(
      `UPDATE "chatbot_service_types" SET "location_type" = 'custom' WHERE "location_type" = 'unset'`
    );
  }
}
