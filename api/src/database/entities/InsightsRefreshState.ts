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

  /**
   * When the tenant last triggered analysis themselves. Separate from
   * `lastRefreshedAt`, which is the judge watermark and moves with consumed sessions
   * — a run that judged nothing would otherwise reset the cooldown, and a run frozen
   * at a failed session would block the retry it exists to allow.
   */
  @Column({ type: 'timestamptz', name: 'last_manual_run_at', nullable: true })
  lastManualRunAt?: Date | null;

  /**
   * Claim lease for an in-flight on-demand analysis — a timestamp, not a boolean, so a
   * process that dies mid-run expires instead of stranding the tenant on "analysing"
   * forever. Cleared when the run finishes, successfully or not.
   */
  @Column({ type: 'timestamptz', name: 'analysis_running_since', nullable: true })
  analysisRunningSince?: Date | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
