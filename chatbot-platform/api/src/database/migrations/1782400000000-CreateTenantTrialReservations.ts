import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Subscription/feature-access epic — M0 PR6.
 *
 * Creates `chatbot_tenant_trial_reservations` — the source of truth for
 * whether a tenant has already consumed their first-signup-only 14-day Pro
 * trial. `chatbot_` prefix because n8n shares this Postgres `public`
 * schema (silent collision risk on unprefixed names).
 *
 * Used by `StripeBillingProvider.createCheckoutSession`: a Pro Checkout
 * attempts `INSERT … ON CONFLICT DO NOTHING RETURNING tenant_id`. The
 * primary-key unique constraint serialises concurrent checkouts, so even
 * under race conditions a tenant can hold at most one trial reservation.
 *
 * This replaces the round-3 `stripe.subscriptions.list` check — which
 * couldn't see in-flight Checkout sessions, so two concurrent checkouts
 * could each independently pass the trial-repeat guard.
 *
 * Explicit constraint names (no auto-generated identifiers) per the
 * shared-schema rule.
 *
 * See .scratch/plan-m0-foundation-reshape.md § PR6 (codex round 7 item 1).
 */
export class CreateTenantTrialReservations1782400000000 implements MigrationInterface {
  name = 'CreateTenantTrialReservations1782400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "chatbot_tenant_trial_reservations" (
         "tenant_id" uuid NOT NULL,
         "reserved_at" timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT "pk_chatbot_tenant_trial_reservations" PRIMARY KEY ("tenant_id"),
         CONSTRAINT "fk_chatbot_tenant_trial_reservations_tenant"
           FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
       )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_tenant_trial_reservations"`);
  }
}
