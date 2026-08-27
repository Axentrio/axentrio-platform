/**
 * CustomerMemoryRun — one extraction job per chat session.
 *
 * Indexes MUST match migration `1793500000000-CreateCustomerMemory` so the
 * test schema (synchronize-from-entities) and prod (migration) agree. Discover
 * relies on ON CONFLICT DO NOTHING against
 * `uq_chatbot_customer_memory_runs_session`.
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

export type CustomerMemoryRunState =
  | 'pending'
  | 'claimed'
  | 'extracted'
  | 'abstained'
  | 'failed'
  | 'skipped_disabled'
  | 'skipped_no_subject';

@Entity('chatbot_customer_memory_runs')
@Index('uq_chatbot_customer_memory_runs_session', ['sessionId'], {
  unique: true,
})
@Index('ix_chatbot_customer_memory_runs_due', ['state', 'nextAttemptAt'])
export class CustomerMemoryRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  @Column({ type: 'uuid', name: 'memory_id', nullable: true })
  memoryId?: string | null;

  @Column({ type: 'varchar', length: 24, default: 'pending' })
  state!: CustomerMemoryRunState;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'timestamptz', name: 'claimed_until', nullable: true })
  claimedUntil?: Date | null;

  @Column({ type: 'timestamptz', name: 'next_attempt_at', nullable: true })
  nextAttemptAt?: Date | null;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError?: string | null;

  @Column({ type: 'int', name: 'extracted_revision', nullable: true })
  extractedRevision?: number | null;

  @Column({ type: 'int', name: 'facts_written', default: 0 })
  factsWritten!: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  model?: string | null;

  @Column({ type: 'varchar', length: 32, name: 'prompt_version', nullable: true })
  promptVersion?: string | null;

  @Column({ type: 'int', name: 'extraction_version', nullable: true })
  extractionVersion?: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;

  @ManyToOne(() => ChatSession, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'session_id' })
  session?: ChatSession;

  @ManyToOne(() => CustomerMemory, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'memory_id' })
  memory?: CustomerMemory | null;
}
