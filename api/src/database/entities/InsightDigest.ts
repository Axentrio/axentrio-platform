/**
 * InsightDigest — the weekly Enterprise AI digest (P3 / ADR-0014, D6).
 * One row per (tenant, summarized week). The row IS the email outbox: the
 * `send*` columns drive a claim-based reconciler (lease + bounded backoff),
 * so a digest is never double-sent and survives crashes/concurrent runs.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';

export type DigestSendState = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

@Entity('chatbot_insight_digests')
@Unique(['tenantId', 'weekStart'])
export class InsightDigest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  /** Monday 00:00 UTC of the SUMMARIZED week (the complete week that just ended). */
  @Column({ type: 'date', name: 'week_start' })
  weekStart!: string;

  @Column({ type: 'text', name: 'summary_md' })
  summaryMd!: string;

  /** Structured header (outcomes vs prior week, gap movements, top experiment). */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  metrics!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 16, name: 'send_state', default: 'pending' })
  sendState!: DigestSendState;

  @Column({ type: 'timestamptz', name: 'send_started_at', nullable: true })
  sendStartedAt?: Date | null;

  @Column({ type: 'timestamptz', name: 'send_claimed_until', nullable: true })
  sendClaimedUntil?: Date | null;

  /** null on terminal failure (cap reached) so the row is never reclaimed. */
  @Column({ type: 'timestamptz', name: 'send_next_attempt_at', nullable: true })
  sendNextAttemptAt?: Date | null;

  @Column({ type: 'int', name: 'send_attempts', default: 0 })
  sendAttempts!: number;

  @Column({ type: 'varchar', length: 255, name: 'provider_message_id', nullable: true })
  providerMessageId?: string | null;

  @Column({ type: 'text', name: 'last_send_error', nullable: true })
  lastSendError?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
