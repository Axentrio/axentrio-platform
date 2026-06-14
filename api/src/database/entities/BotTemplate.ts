/**
 * BotTemplate — a super-admin-authored, versioned prompt IDENTITY that a tenant
 * binds a bot to (.scratch/plan-bot-templates.md, T1/T2/T4). Distinct axis from
 * a Module (capability): a Template answers "who is this bot?".
 *
 * The template row holds metadata + access scope; the actual prompt text lives
 * in BotTemplateVersion rows (immutable once published). Authored exclusively
 * through the super-admin endpoints (Phase 3).
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type BotTemplateStatus = 'active' | 'archived';

@Entity('bot_templates')
@Index('ux_bot_templates_key', ['key'], { unique: true })
export class BotTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Stable human-readable slug (e.g. 'plumber-booking', 'blank-base'). */
  @Column({ type: 'varchar', length: 100 })
  key!: string;

  @Column({ type: 'varchar', length: 200, name: 'display_name' })
  displayName!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  category?: string | null;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  /**
   * Access scope. A tenant may bind this template iff this is true OR a
   * TenantBotTemplate grant row exists — AND the D2 billable precheck passes.
   */
  @Column({ type: 'boolean', default: false, name: 'available_to_all_tenants' })
  availableToAllTenants!: boolean;

  /** 'archived' hides it from new bindings; bound bots fall back per T21. */
  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: BotTemplateStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
