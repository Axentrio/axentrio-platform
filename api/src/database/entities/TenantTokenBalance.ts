/**
 * One row per tenant for the current billing-period token budget.
 * The row rolls forward in place; the allowance is read live from entitlements.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { Tenant } from './Tenant';

@Entity('tenant_token_balance')
@Unique('UQ_tenant_token_balance_tenant', ['tenantId'])
export class TenantTokenBalance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;

  @Column({ type: 'timestamptz', name: 'period_start' })
  periodStart!: Date;

  @Column({ type: 'timestamptz', name: 'period_end' })
  periodEnd!: Date;

  @Column({ type: 'bigint', default: 0, name: 'period_used' })
  periodUsed!: string;

  @Column({ type: 'bigint', default: 0, name: 'top_up_balance' })
  topUpBalance!: string;

  @Column({ type: 'timestamptz', nullable: true, name: 'warned80_at' })
  warned80At?: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
