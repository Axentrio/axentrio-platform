/**
 * CustomerMemory — one remembered person per tenant, keyed on a durable
 * channel/device handle (`subject_key`) and optionally linked to a verified
 * contact (`person_key`) so a second device can find the same facts.
 *
 * Indexes MUST match migration `1793500000000-CreateCustomerMemory` so the
 * test schema (synchronize-from-entities) and prod (migration) agree. The
 * upsert's ON CONFLICT (tenant_id, subject_key) needs
 * `uq_chatbot_customer_memory_subject`.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Tenant } from './Tenant';

@Entity('chatbot_customer_memory')
@Index('uq_chatbot_customer_memory_subject', ['tenantId', 'subjectKey'], {
  unique: true,
})
@Index('ix_chatbot_customer_memory_person', ['tenantId', 'personKey'], {
  where: '"person_key" IS NOT NULL',
})
@Index('ix_chatbot_customer_memory_last_seen', ['lastSeenAt'])
export class CustomerMemory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 400, name: 'subject_key' })
  subjectKey!: string;

  @Column({ type: 'varchar', length: 400, name: 'person_key', nullable: true })
  personKey?: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  channel?: string | null;

  @Column({ type: 'timestamptz', name: 'first_seen_at', default: () => 'now()' })
  firstSeenAt!: Date;

  @Column({ type: 'timestamptz', name: 'last_seen_at', default: () => 'now()' })
  lastSeenAt!: Date;

  @Column({ type: 'int', name: 'session_count', default: 0 })
  sessionCount!: number;

  @Column({ type: 'int', name: 'live_fact_count', default: 0 })
  liveFactCount!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;
}
