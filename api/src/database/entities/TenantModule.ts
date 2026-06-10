/**
 * TenantModule — per-tenant enablement row for an enablement-gated (bespoke)
 * Module. Feature-gated modules (e.g. booking) never have rows here; their
 * activeness comes from the entitlement resolver. See
 * .scratch/plan-entitlements-modules.md (D13).
 *
 * Written exclusively through the super-admin module endpoints (Phase 3) —
 * disabling upserts `enabled=false` (preserving config + audit fields for
 * re-enable), never deletes the row.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('tenant_modules')
@Index('ux_tenant_modules_tenant_module', ['tenantId', 'moduleId'], { unique: true })
export class TenantModule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  /** Catalog module id (varchar by design — unknown ids resolve inactive). */
  @Column({ type: 'varchar', length: 100, name: 'module_id' })
  moduleId!: string;

  @Column({ type: 'boolean', default: false })
  enabled!: boolean;

  /** Per-tenant module config, validated against the module's configSchema. */
  @Column({ type: 'jsonb', default: {} })
  config!: Record<string, unknown>;

  /** Audit: why this module was enabled/disabled for this tenant. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  reason?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'set_by' })
  setBy?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
