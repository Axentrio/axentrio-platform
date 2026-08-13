import { MigrationInterface, QueryRunner } from 'typeorm';

/** Make the Pending Correction states unrepresentable outside their lifecycle. */
export class EnforceAddressQuestionLifecycle1790700000000 implements MigrationInterface {
  name = 'EnforceAddressQuestionLifecycle1790700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The table predates the explicit question lifecycle. It has not been the production
    // authority yet, but void any draft/partial legacy question instead of letting one malformed
    // row block the deploy or pretending that it was delivered under the new evidence rule.
    await queryRunner.query(`
      UPDATE chatbot_address_bindings
         SET pending = NULL,
             version = version + 1,
             updated_at = NOW()
       WHERE pending IS NOT NULL
         AND (
           NULLIF(address, '') IS NULL
           OR NULLIF(pending->>'proposalId', '') IS NULL
           OR NULLIF(pending->>'formattedAddress', '') IS NULL
           OR NULLIF(pending->>'boundAddress', '') IS NULL
           OR pending->>'boundAddress' IS DISTINCT FROM address
           OR (pending->>'boundPlaceId') IS DISTINCT FROM place_id
           OR pending->>'boundSource' IS DISTINCT FROM source
           OR COALESCE(pending->>'status', '') NOT IN ('recorded', 'asked')
           OR (pending->>'status' = 'recorded'
             AND NULLIF(pending->>'askedMessageId', '') IS NOT NULL)
           OR (pending->>'status' = 'asked'
             AND NULLIF(pending->>'askedMessageId', '') IS NULL)
         )
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'ck_address_question_has_active_binding'
             AND conrelid = 'chatbot_address_bindings'::regclass
        ) THEN
          ALTER TABLE chatbot_address_bindings
            ADD CONSTRAINT ck_address_question_has_active_binding
            CHECK (pending IS NULL OR NULLIF(address, '') IS NOT NULL);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'ck_address_question_lifecycle_v1'
             AND conrelid = 'chatbot_address_bindings'::regclass
        ) THEN
          ALTER TABLE chatbot_address_bindings
            ADD CONSTRAINT ck_address_question_lifecycle_v1
            CHECK (
              pending IS NULL OR (
                NULLIF(pending->>'proposalId', '') IS NOT NULL
                AND NULLIF(pending->>'formattedAddress', '') IS NOT NULL
                AND NULLIF(pending->>'boundAddress', '') IS NOT NULL
                AND pending->>'boundAddress' = address
                AND (pending->>'boundPlaceId') IS NOT DISTINCT FROM place_id
                AND COALESCE(pending->>'boundSource', '') = source
                AND ((COALESCE(pending->>'status', '') = 'recorded'
                  AND NULLIF(pending->>'askedMessageId', '') IS NULL)
                  OR (COALESCE(pending->>'status', '') = 'asked'
                    AND NULLIF(pending->>'askedMessageId', '') IS NOT NULL))
              )
            );
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chatbot_address_bindings
        DROP CONSTRAINT IF EXISTS ck_address_question_lifecycle_v1,
        DROP CONSTRAINT IF EXISTS ck_address_question_has_active_binding
    `);
  }
}
