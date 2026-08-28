/**
 * Daily per-path LLM spend rollup. One row per (day, tenant, path, model).
 * No FK to tenants: a cascade delete would erase cost history.
 */
import { Entity, PrimaryColumn, Column } from 'typeorm';

/** Stored for platform work that has no tenant (health_probe, admin_template_preview). */
export const PLATFORM_TENANT_SENTINEL = '00000000-0000-0000-0000-000000000000';

@Entity('llm_usage_daily')
export class LlmUsageDaily {
  @PrimaryColumn({ type: 'date' })
  day!: string;

  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @PrimaryColumn({ type: 'varchar', length: 48 })
  path!: string;

  @PrimaryColumn({ type: 'varchar', length: 64 })
  model!: string;

  @Column({ type: 'bigint', default: 0 })
  calls!: string;

  @Column({ type: 'bigint', default: 0, name: 'prompt_tokens' })
  promptTokens!: string;

  @Column({ type: 'bigint', default: 0, name: 'completion_tokens' })
  completionTokens!: string;

  @Column({ type: 'numeric', precision: 14, scale: 6, default: 0, name: 'cost_usd' })
  costUsd!: string;
}
