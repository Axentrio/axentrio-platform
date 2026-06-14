/**
 * Judgment — one LLM verdict on one ChatSession, produced by the nightly
 * RefreshInsightsJob (ADR-0004). Gap evidence is sourced exclusively from
 * Judgments. One row per session (unique) — judged exactly once, whenever
 * the job runs (the ADR-0006 completeness watermark relies on this).
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';

@Entity('chatbot_judgments')
@Unique(['sessionId'])
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'canonicalTopicId', 'createdAt'])
export class Judgment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  /** Denormalised from the session for cheap distinct-visitor counts (Qualifying Pain). */
  @Column({ type: 'varchar', length: 255, name: 'visitor_id' })
  visitorId!: string;

  /** When the judged session started — Gap windows aggregate on this, not on judgment time. */
  @Column({ type: 'timestamptz', name: 'session_started_at' })
  sessionStartedAt!: Date;

  @Column({ type: 'boolean', name: 'had_question' })
  hadQuestion!: boolean;

  /** null when the session contained no question to satisfy. */
  @Column({ type: 'boolean', nullable: true })
  satisfied?: boolean | null;

  /** Raw topic phrase from the judge, before canonicalisation. */
  @Column({ type: 'varchar', length: 200, name: 'topic_phrase', nullable: true })
  topicPhrase?: string | null;

  @Column({ type: 'uuid', name: 'canonical_topic_id', nullable: true })
  canonicalTopicId?: string | null;

  /**
   * ADR-0009 layer 3: when topic validation fails, the judgment persists as
   * unsatisfied_unmapped evidence with diagnostics — no Gap contribution,
   * but queryable for drift monitoring.
   */
  @Column({ type: 'varchar', length: 200, name: 'rejected_topic', nullable: true })
  rejectedTopic?: string | null;

  @Column({ type: 'varchar', length: 64, name: 'reject_reason', nullable: true })
  rejectReason?: string | null;

  /** Message ids backing the verdict — the evidence drill-down reads these. */
  @Column({ type: 'jsonb', name: 'evidence_message_ids', default: () => "'[]'" })
  evidenceMessageIds!: string[];

  @Column({ type: 'text', nullable: true })
  reasoning?: string | null;

  /**
   * Sentiment (P3 / ADR-0014, D5) — populated only when the tenant has
   * `aiBusinessInsights` (Enterprise). Forward-only: sessions judged before
   * the flag flipped stay null (cold-start accepted).
   */
  @Column({ type: 'varchar', length: 8, nullable: true })
  sentiment?: 'positive' | 'negative' | 'neutral' | null;

  @Column({ type: 'uuid', name: 'sentiment_theme_id', nullable: true })
  sentimentThemeId?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
