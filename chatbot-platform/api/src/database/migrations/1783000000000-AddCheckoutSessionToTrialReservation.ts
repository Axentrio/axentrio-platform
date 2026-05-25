import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Subscription/feature-access epic — M0 audit gap #2 follow-up.
 *
 * Adds two columns to `chatbot_tenant_trial_reservations`:
 *
 * - `subscription_id` — set by the `customer.subscription.created` handler
 *   once a reservation is "claimed" by a real subscription. Reservations
 *   with a non-null `subscription_id` MUST NEVER be deleted; they're the
 *   "tenant has already used their trial" record.
 *
 * - `checkout_session_id` — set right after `createCheckoutSession`
 *   succeeds. Used by the `checkout.session.expired` handler to scope the
 *   deletion: only the row that WAS this expired session can be removed.
 *   Prevents an old expired event from deleting a newer pending row.
 *
 * Codex audit gap #2 → option A: M0 spec line 532 requires that an
 * abandoned Pro Checkout retry still grants the 14-day trial. The original
 * reservation table (M0 PR6, codex round 7 item 1) permanently consumed
 * the trial slot at checkout *creation*, so abandonment was a bug. The
 * `checkout.session.expired` handler unwinds the consumption iff no
 * subscription ever claimed the row.
 *
 * Explicit constraint/index names per the shared-schema rule.
 */
export class AddCheckoutSessionToTrialReservation1783000000000 implements MigrationInterface {
  name = 'AddCheckoutSessionToTrialReservation1783000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chatbot_tenant_trial_reservations"
         ADD COLUMN IF NOT EXISTS "subscription_id" varchar(255) NULL,
         ADD COLUMN IF NOT EXISTS "checkout_session_id" varchar(255) NULL`,
    );
    // Index supports the WHERE-by-session-id deletion path. Sparse — only
    // populated rows are indexed.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_chatbot_tenant_trial_reservations_checkout_session"
         ON "chatbot_tenant_trial_reservations" ("checkout_session_id")
         WHERE "checkout_session_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_chatbot_tenant_trial_reservations_checkout_session"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chatbot_tenant_trial_reservations"
         DROP COLUMN IF EXISTS "checkout_session_id",
         DROP COLUMN IF EXISTS "subscription_id"`,
    );
  }
}
