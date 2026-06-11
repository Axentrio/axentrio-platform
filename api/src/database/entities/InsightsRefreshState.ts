/**
 * InsightsRefreshState — per-Tenant watermark + completeness for the nightly
 * RefreshInsightsJob (ADR-0006). One row per tenant, created on first run.
 * `lastRefreshedAt` is the judge watermark (sessions closed after it are
 * pending); `judgmentsCompleteness` is judged-eligible / total-eligible for
 * the current 7-day window — below 0.9 the UI shows "Insights incomplete".
 */
import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

@Entity('chatbot_insights_refresh_state')
export class InsightsRefreshState {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'timestamptz', name: 'last_refreshed_at', nullable: true })
  lastRefreshedAt?: Date | null;

  /** 0..1; null until the first run computes it. */
  @Column({ type: 'numeric', name: 'judgments_completeness', precision: 5, scale: 4, nullable: true })
  judgmentsCompleteness?: string | null;

  @Column({ type: 'text', name: 'last_run_error', nullable: true })
  lastRunError?: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
