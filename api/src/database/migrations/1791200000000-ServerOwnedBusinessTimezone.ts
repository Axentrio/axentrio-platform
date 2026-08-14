import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Server-owned Business Time, step 1a (plan: pilot-operations-timezone-routing).
 *
 * Until now the person configuring a bot was the business-time authority twice over:
 * onboarding wrote the BROWSER's timezone into both the operational businessHours and the
 * booking availability rule, and two portal screens let anyone type a third opinion. A
 * Belgian salon configured from a laptop in Kuala Lumpur ran its off-hours gate eight hours
 * wrong, silently.
 *
 * Two new columns make the server the only authority:
 *
 * - `tenants.operating_country` — the tenant's admitted operating country (business-wide
 *   fact; every bot of a tenant operates in the same country). Backfilled `BE`: the whole
 *   platform is Belgium-only (company lookup, Places and Geocoding are all BE-restricted).
 * - `chatbot_bots.business_timezone` — the canonical per-bot IANA business timezone,
 *   resolved from the bot's venue country when a venue exists, else the tenant's operating
 *   country. Backfilled `Europe/Brussels`, the only value the Belgium-only resolver can
 *   produce.
 *
 * `chatbot_availability_rules.timezone` stays as a denormalized compatibility column, but
 * it is realigned here to the canonical value. This is the plan's explicit migration
 * policy: for today's Belgium-only data, Europe/Brussels wins over BOTH legacy values
 * (the browser-derived operational timezone and the rule timezone) — every divergent value
 * is a corruption artifact of the browser-authority bug, not information. The realignment
 * is a one-way data repair: `down` restores the schema, not the corrupted timezones.
 */
export class ServerOwnedBusinessTimezone1791200000000 implements MigrationInterface {
  name = 'ServerOwnedBusinessTimezone1791200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // NOT NULL + DEFAULT backfills existing rows in place (PG 11+), no table rewrite.
    await queryRunner.query(`
      ALTER TABLE tenants
        ADD COLUMN IF NOT EXISTS operating_country varchar(2) NOT NULL DEFAULT 'BE'
    `);

    await queryRunner.query(`
      ALTER TABLE chatbot_bots
        ADD COLUMN IF NOT EXISTS business_timezone varchar(64) NOT NULL DEFAULT 'Europe/Brussels'
    `);

    // Realign the denormalized booking timezone to the canonical value. Belgium-only
    // policy: Brussels wins over every legacy browser-derived value.
    await queryRunner.query(`
      UPDATE chatbot_availability_rules
         SET timezone = 'Europe/Brussels',
             updated_at = now()
       WHERE timezone IS DISTINCT FROM 'Europe/Brussels'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The availability-rule realignment is deliberately not reversed: the overwritten
    // values were browser-clock corruption, and no record of them is worth restoring.
    await queryRunner.query(`ALTER TABLE chatbot_bots DROP COLUMN IF EXISTS business_timezone`);
    await queryRunner.query(`ALTER TABLE tenants DROP COLUMN IF EXISTS operating_country`);
  }
}
