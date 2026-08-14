import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The single-use offer table for the Meta address picker (#97 D3).
 *
 * Each offered option is a row whose random `id` is the token the button carries. A tap loads the
 * offer by that id, then consumes the whole `set_id` in one transaction and writes the binding, so
 * two taps cannot move the address twice. Only the durable `place_id` is stored, never the Google
 * suggestion text (ADR-0014). The `AddressOffer` entity mirrors this table so `synchronize()` builds
 * it for the integration suite; keep the two in step column for column.
 *
 * Additive and idempotent: `CREATE TABLE IF NOT EXISTS` is safe on boot and on a re-run.
 */
export class CreateAddressOffers1790900000000 implements MigrationInterface {
  name = 'CreateAddressOffers1790900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS chatbot_address_offers (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        set_id      uuid NOT NULL,
        session_id  uuid NOT NULL,
        channel     varchar(20) NOT NULL,
        place_id    text NOT NULL,
        expires_at  timestamptz NOT NULL,
        consumed_at timestamptz,
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_address_offers_set" ON chatbot_address_offers (set_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS chatbot_address_offers`);
  }
}
