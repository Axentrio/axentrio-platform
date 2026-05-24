import {
  Entity,
  PrimaryColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Tenant } from './Tenant';

/**
 * Trial reservation — one row per tenant who has ever consumed their
 * first-signup-only 14-day Pro trial. Inserted by the Stripe Checkout
 * pre-flight (`createCheckoutSession` in stripe.ts) with
 * `ON CONFLICT DO NOTHING`; the primary-key unique constraint serialises
 * concurrent Pro Checkout requests so each tenant gets at most one trial.
 *
 * The row persists indefinitely — its presence is the signal that this
 * tenant has already used their trial. There is no deletion path.
 *
 * Plan: .scratch/plan-m0-foundation-reshape.md § PR6 (codex round 7 item 1).
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
}
