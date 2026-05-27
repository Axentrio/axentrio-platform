import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Tenant } from './Tenant';

/**
 * Demand-signal telemetry primitive.
 *
 * Captures "Notify me" / "Contact Sales" clicks on Coming Soon features so
 * we can size demand before building. The `feature` column is intentionally
 * an open `varchar(64)` at the DB layer — new Coming Soon features should be
 * added by extending the closed allow-list in
 * `src/schemas/demand-signal.schema.ts`, not via DB migrations.
 *
 * Plan reference: `.scratch/plan-m0-foundation-reshape.md` § PR11.
 */
@Entity('chatbot_demand_signals')
@Index('idx_chatbot_demand_signals_tenant_feature_created', ['tenantId', 'feature', 'createdAt'])
export class DemandSignal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant;

  @Column({ type: 'varchar', length: 64, name: 'feature' })
  feature!: string;

  @Column({ type: 'varchar', length: 32, name: 'current_tier' })
  currentTier!: string;

  @Column({ type: 'varchar', length: 8, name: 'locale' })
  locale!: string;

  @Column({ type: 'jsonb', name: 'context', default: () => `'{}'::jsonb` })
  context!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
