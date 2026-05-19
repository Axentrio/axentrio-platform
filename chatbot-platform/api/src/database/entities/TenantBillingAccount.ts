import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { Tenant } from './Tenant';

export type BillingProviderName = 'stripe' | 'manual';
export type BillingStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'none';
export type BillingPlanId = 'free' | 'pro' | 'premium' | 'enterprise';

@Entity('tenant_billing_accounts')
@Unique('UQ_tenant_billing_accounts_tenant_provider', ['tenantId', 'provider'])
@Index('UQ_tenant_billing_accounts_primary', ['tenantId'], {
  unique: true,
  where: '"is_primary" = true',
})
@Index('UQ_tenant_billing_accounts_provider_customer', ['provider', 'customerId'], {
  unique: true,
  where: '"customer_id" IS NOT NULL',
})
@Index('UQ_tenant_billing_accounts_provider_subscription', ['provider', 'subscriptionId'], {
  unique: true,
  where: '"subscription_id" IS NOT NULL',
})
export class TenantBillingAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;

  @Column({ type: 'varchar', length: 32 })
  provider!: BillingProviderName;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'customer_id' })
  customerId?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'subscription_id' })
  subscriptionId?: string | null;

  @Column({ type: 'varchar', length: 32 })
  status!: BillingStatus;

  @Column({ type: 'varchar', length: 32, name: 'current_plan_id' })
  currentPlanId!: BillingPlanId;

  @Column({ type: 'timestamptz', nullable: true, name: 'current_period_end' })
  currentPeriodEnd?: Date | null;

  @Column({ type: 'boolean', default: false, name: 'cancel_at_period_end' })
  cancelAtPeriodEnd!: boolean;

  @Column({ type: 'varchar', length: 32, nullable: true, name: 'pending_plan_id' })
  pendingPlanId?: BillingPlanId | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'pending_plan_effective_at' })
  pendingPlanEffectiveAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'trial_end' })
  trialEnd?: Date | null;

  @Column({ type: 'boolean', default: true, name: 'is_primary' })
  isPrimary!: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'billing_email' })
  billingEmail?: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb", name: 'raw_provider_data' })
  rawProviderData!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
