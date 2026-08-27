/**
 * CustomerMemoryFact — one version of one remembered fact.
 *
 * The partial unique index `uq_chatbot_customer_facts_live` is load-bearing
 * for supersede-on-write: exactly one live value per (memory, key). MUST
 * match migration `1793500000000-CreateCustomerMemory` so the test schema
 * (synchronize-from-entities) and prod (migration) agree.
 *
 * `evidence_message_id` has no FK: message rows are hard-deletable and a
 * dangling citation must degrade to "no citation shown".
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
import { ChatSession } from './ChatSession';
import { CustomerMemory } from './CustomerMemory';

@Entity('chatbot_customer_facts')
@Index('uq_chatbot_customer_facts_live', ['memoryId', 'factKey'], {
  unique: true,
  where: '"superseded_at" IS NULL',
})
@Index('ix_chatbot_customer_facts_key', ['tenantId', 'factKey'])
export class CustomerMemoryFact {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'memory_id' })
  memoryId!: string;

  @Column({ type: 'varchar', length: 48, name: 'fact_key' })
  factKey!: string;

  @Column({ type: 'text', name: 'value_enc' })
  valueEnc!: string;

  @Column({ type: 'boolean', name: 'value_encrypted', default: true })
  valueEncrypted!: boolean;

  @Column({ type: 'smallint' })
  confidence!: number;

  @Column({ type: 'uuid', name: 'evidence_message_id', nullable: true })
  evidenceMessageId?: string | null;

  @Column({ type: 'text', name: 'evidence_span', nullable: true })
  evidenceSpan?: string | null;

  @Column({ type: 'uuid', name: 'source_session_id', nullable: true })
  sourceSessionId?: string | null;

  @Column({ type: 'varchar', length: 64 })
  model!: string;

  @Column({ type: 'varchar', length: 32, name: 'prompt_version' })
  promptVersion!: string;

  @Column({ type: 'int', name: 'extraction_version' })
  extractionVersion!: number;

  @Column({ type: 'timestamptz', name: 'first_seen_at', default: () => 'now()' })
  firstSeenAt!: Date;

  @Column({ type: 'timestamptz', name: 'last_confirmed_at', default: () => 'now()' })
  lastConfirmedAt!: Date;

  @Column({ type: 'timestamptz', name: 'superseded_at', nullable: true })
  supersededAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;

  @ManyToOne(() => CustomerMemory, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'memory_id' })
  memory?: CustomerMemory;

  @ManyToOne(() => ChatSession, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'source_session_id' })
  sourceSession?: ChatSession | null;
}
