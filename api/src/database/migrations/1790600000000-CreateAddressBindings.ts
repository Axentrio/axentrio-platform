import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The address a conversation is about, moved from Redis into the database (#95).
 *
 * The reason is not storage preference. The booking INSERT lands in Postgres, and a Redis lease
 * cannot fence a Postgres write: when the lease lapses, a customer's confirmation can land between
 * the version check and the insert, and the booking persists an address the customer has already
 * replaced. Holding the binding here lets the booking take a row lock in the same transaction as
 * its insert, which is the only arrangement where the check and the write cannot be separated.
 *
 * Idempotent throughout, because `server.ts` runs migrations on every container boot and a
 * migration that fails its second run crash-loops production.
 *
 * No enum type: house convention is varchar plus a named CHECK, after a test-DB enum versus prod
 * varchar mismatch crash-looped a deploy once.
 */
export class CreateAddressBindings1790600000000 implements MigrationInterface {
  name = 'CreateAddressBindings1790600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS chatbot_address_bindings (
        session_id uuid PRIMARY KEY,
        address    text,
        place_id   text,
        source     varchar(16),
        pending    jsonb,
        version    integer NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // The active fields are null TOGETHER or populated consistently. `picked` carries the identity
    // the customer chose; `confirmed` never does, because a proposal is a question and nothing was
    // geocoded. Added separately from CREATE TABLE so the migration stays idempotent on a table
    // that already exists from an earlier partial run.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          -- Scoped to the table. Constraint names are not unique across tables, so matching on the
          -- name alone lets an unrelated constraint elsewhere silently skip this one - and only
          -- in production, since the test schema comes from the entity.
          SELECT 1 FROM pg_constraint
           WHERE conname = 'ck_address_binding_active_consistent'
             AND conrelid = 'chatbot_address_bindings'::regclass
        ) THEN
          ALTER TABLE chatbot_address_bindings
            ADD CONSTRAINT ck_address_binding_active_consistent CHECK (
              -- COALESCE, not a bare comparison: with source NULL the clauses read
              -- FALSE OR NULL OR NULL = NULL, and a CHECK passes on NULL. The first
              -- version of this constraint accepted an address with no source.
              -- NULLIF too: '' is neither an address nor an identity, but '' IS NOT NULL.
              (NULLIF(address, '') IS NULL AND source IS NULL AND NULLIF(place_id, '') IS NULL)
              OR (NULLIF(address, '') IS NOT NULL AND COALESCE(source, '') = 'picked' AND NULLIF(place_id, '') IS NOT NULL)
              OR (NULLIF(address, '') IS NOT NULL AND COALESCE(source, '') = 'confirmed' AND NULLIF(place_id, '') IS NULL)
            );
        END IF;
      END $$;
    `);

    // Reclaiming expired rows. The read path already treats anything older than the window as
    // absent, so this index serves the sweep rather than the hot path - which is why it is on
    // `updated_at` alone and not a partial index tied to a predicate that would have to match a
    // query character for character.
    //
    // Not CONCURRENTLY: TypeORM wraps each migration in a transaction and CREATE INDEX
    // CONCURRENTLY cannot run inside one. This is documented twice elsewhere in this directory and
    // was got wrong once already.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_address_bindings_updated_at
        ON chatbot_address_bindings (updated_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping the table takes the constraint and the index with it. Listing them separately would
    // only create a second thing to keep in step.
    await queryRunner.query(`DROP TABLE IF EXISTS chatbot_address_bindings`);
  }
}
