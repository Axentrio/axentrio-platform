/**
 * TenantBotTemplate — per-tenant grant row making a BotTemplate available to a
 * tenant that is NOT marked availableToAllTenants (.scratch/plan-bot-templates.md,
 * T7). Mirrors the entitlements grant model; written exclusively through the
 * super-admin endpoints (Phase 3), audit-stamped.
 *
 * A globally-available template needs NO row — same "no backfill" property as
 * tenant_modules.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('tenant_bot_templates')
@Index('ux_tenant_bot_templates_tenant_template', ['tenantId', 'templateId'], { unique: true })
export class TenantBotTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'template_id' })
  templateId!: string;

  /** Audit: which super-admin granted access. */
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'set_by' })
  setBy?: string | null;

  @CreateDateColumn({ name: 'set_at' })
  setAt!: Date;
}
