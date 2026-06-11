/**
 * CanonicalTopic — a normalised, human-readable topic phrase in a per-Tenant
 * registry (e.g. "pricing", "emergency availability"). Each Gap is keyed on
 * one Canonical Topic. Created lazily as the LLM judge encounters new topic
 * phrases in ChatSessions; merge-or-create is race-free because the nightly
 * refresh runs sequentially within a Tenant (ADR-0003 / ADR-0006).
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';

@Entity('chatbot_canonical_topics')
@Unique(['tenantId', 'topic'])
@Index(['tenantId'])
export class CanonicalTopic {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  /** Normalised topic phrase — lowercase, trimmed (normalisation in the judge service). */
  @Column({ type: 'varchar', length: 200 })
  topic!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
