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

export type BillingEventProvider = 'stripe' | 'manual' | 'system';

@Entity('billing_events')
@Index(['tenantId', 'createdAt'])
@Index('UQ_billing_events_provider_event', ['provider', 'providerEventId'], {
  unique: true,
  where: '"provider_event_id" IS NOT NULL',
})
export class BillingEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true, name: 'tenant_id' })
  tenantId?: string | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant | null;

  @Column({ type: 'varchar', length: 32 })
  provider!: BillingEventProvider;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'provider_event_id' })
  providerEventId?: string | null;

  @Column({ type: 'varchar', length: 64, name: 'event_type' })
  eventType!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true, name: 'raw_payload' })
  rawPayload?: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', default: () => 'now()', name: 'processed_at' })
  processedAt!: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
