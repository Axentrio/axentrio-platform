/**
 * Gap — the v1 kind of Insight: a topic customers asked about that the
 * Agent/KnowledgeBase did not satisfy. Fingerprinted on
 * (tenantId, canonicalTopicId) (ADR-0003); lifecycle per ADR-0005.
 *
 * Lifecycle states:
 *  - open            — Qualifying Pain in the current 7-day window
 *  - dormant         — previously open, pain subsided without a KB fix
 *  - resolved_data   — a KnowledgeDocument now satisfies the topic (a "Win")
 *  - resolved_manual — tenant marked it handled outside the KB (a "Win")
 *  - archived        — tenant dismissed it
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

export type GapStatus = 'open' | 'dormant' | 'resolved_data' | 'resolved_manual' | 'archived';
export type GapSeverity = 'red' | 'orange' | 'green';

@Entity('chatbot_gaps')
@Unique(['tenantId', 'canonicalTopicId'])
@Index(['tenantId', 'status'])
export class Gap {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'canonical_topic_id' })
  canonicalTopicId!: string;

  @Column({ type: 'varchar', length: 24, default: 'open' })
  status!: GapStatus;

  @Column({ type: 'varchar', length: 8, default: 'orange' })
  severity!: GapSeverity;

  /** Unsatisfied asks of this topic in the last aggregated 7-day window. */
  @Column({ type: 'int', default: 0 })
  occurrences!: number;

  /** Distinct visitorIds behind those asks (Qualifying Pain gate input). */
  @Column({ type: 'int', name: 'distinct_visitors', default: 0 })
  distinctVisitors!: number;

  @Column({ type: 'timestamptz', name: 'first_detected_at' })
  firstDetectedAt!: Date;

  @Column({ type: 'timestamptz', name: 'last_seen_at' })
  lastSeenAt!: Date;

  @Column({ type: 'timestamptz', name: 'resolved_at', nullable: true })
  resolvedAt?: Date | null;

  @Column({ type: 'timestamptz', name: 'archived_at', nullable: true })
  archivedAt?: Date | null;

  /** Regenerated each refresh (ADR-0003: not part of identity; ADR-0010: localised). */
  @Column({ type: 'text', nullable: true })
  recommendation?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
