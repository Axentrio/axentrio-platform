/**
 * InsightExperiment — correlation + sentiment insights (P3 / ADR-0014).
 *
 * Experiments are NOT resolvable (ADR-0001): there is no status/resolved column and
 * `state` is CHECK-constrained to active|dismissed, so a "resolved experiment" is
 * physically unwritable. Fingerprinted by (tenant, kind, fingerprint) for upsert.
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

export type ExperimentKind = 'correlation' | 'sentiment';
export type ExperimentState = 'active' | 'dismissed';
export type ExperimentSeverity = 'red' | 'orange' | 'green';

@Entity('chatbot_insight_experiments')
@Unique(['tenantId', 'kind', 'fingerprint'])
@Index(['tenantId', 'state'])
export class InsightExperiment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: ExperimentKind;

  /** Stable dedup key per kind (D3): e.g. `channel-conv:whatsapp:conversion`, or theme id. */
  @Column({ type: 'varchar', length: 200 })
  fingerprint!: string;

  @Column({ type: 'varchar', length: 8, default: 'orange' })
  severity!: ExperimentSeverity;

  @Column({ type: 'text' })
  title!: string;

  /** LLM-phrased body (non-causal for correlation, D4). */
  @Column({ type: 'text', nullable: true })
  detail?: string | null;

  /** Kind-specific stats/evidence (the contingency table, theme counts, etc.). */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  payload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  state!: ExperimentState;

  @Column({ type: 'timestamptz', name: 'first_seen_at', default: () => 'now()' })
  firstSeenAt!: Date;

  @Column({ type: 'timestamptz', name: 'last_seen_at', default: () => 'now()' })
  lastSeenAt!: Date;

  @Column({ type: 'timestamptz', name: 'dismissed_at', nullable: true })
  dismissedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
