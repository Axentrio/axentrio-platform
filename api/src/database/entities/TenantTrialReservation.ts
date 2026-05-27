import {
  Entity,
  PrimaryColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Tenant } from './Tenant';

/**
 * Trial reservation — one row per tenant who has either (a) attempted a
 * Pro Checkout or (b) consumed their first-signup-only 14-day Pro trial.
 * Inserted by the Stripe Checkout pre-flight (`createCheckoutSession` in
 * stripe.ts) with `ON CONFLICT DO NOTHING`; the primary-key unique
 * constraint serialises concurrent Pro Checkout requests so each tenant
 * gets at most one trial across concurrent attempts.
 *
 * Lifecycle:
 *
 *   1. INSERT at Checkout creation. `checkout_session_id` is filled in
 *      after the Stripe session is created; `subscription_id` is NULL.
 *
 *   2a. Customer completes Checkout → `customer.subscription.created`
 *       handler sets `subscription_id`. Row is now "claimed" — permanent.
 *
 *   2b. Customer abandons Checkout → 24h later Stripe fires
 *       `checkout.session.expired`. The handler DELETEs the row WHERE
 *       `subscription_id IS NULL` AND `checkout_session_id` matches.
 *       The tenant is free to try again with a fresh trial — per M0
 *       spec line 532 (abandoned retries grant trial).
 *
 * The `checkout_session_id` scoping prevents an old expired event from
 * nuking a newer in-flight reservation. Rows with non-null
 * `subscription_id` are NEVER deleted by the webhook path.
 *
 * Plan: .scratch/plan-m0-foundation-reshape.md § PR6 + audit gap #2.
 */
@Entity('chatbot_tenant_trial_reservations')
export class TenantTrialReservation {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;

  @Column({ type: 'timestamptz', name: 'reserved_at', default: () => 'now()' })
  reservedAt!: Date;

  /**
   * Claim marker. Set by the `customer.subscription.created` webhook
   * handler. Non-null = trial was actually consumed; row must persist.
   */
  @Column({ type: 'varchar', length: 255, name: 'subscription_id', nullable: true })
  subscriptionId?: string | null;

  /**
   * The Stripe Checkout session that this reservation was created for.
   * Filled right after `stripe.checkout.sessions.create()` succeeds. Used
   * by the `checkout.session.expired` handler to scope the deletion.
   */
  @Column({ type: 'varchar', length: 255, name: 'checkout_session_id', nullable: true })
  checkoutSessionId?: string | null;
}
