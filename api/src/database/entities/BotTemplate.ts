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

/**
 * What a template intends about the bot's SKILLS, as opposed to its identity (#103).
 *
 * - `explicit`          — exactly the skills the resolved version selects. Every specialty.
 * - `inherit_entitled`  — every feature-gated skill the tenant's plan already enables. Blank.
 * - `none`              — deliberately tool-free, whatever is selected or entitled.
 *
 * Resolution lives in `templates/template-resolver.ts#effectiveSkillIds`, which is the ONLY
 * place allowed to turn this into a skill list.
 */
export type SkillPolicy = 'explicit' | 'inherit_entitled' | 'none';
export const SKILL_POLICIES: readonly SkillPolicy[] = ['explicit', 'inherit_entitled', 'none'];

/** Commercial tier this template belongs to; mirrors the tenant plan names
 *  (minus 'free'). A template lives in exactly one tier — tiers do not cross. */
export type BotTemplateTier = 'essential' | 'pro' | 'enterprise';
export const BOT_TEMPLATE_TIERS: readonly BotTemplateTier[] = ['essential', 'pro', 'enterprise'];

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

  /** Commercial tier bucket (essential | pro | enterprise). Curation only —
   *  it groups the catalog; it does not by itself gate tenant access. */
  @Column({ type: 'varchar', length: 20, default: 'essential' })
  tier!: BotTemplateTier;

  /**
   * Access scope. A tenant may bind this template iff this is true OR a
   * TenantBotTemplate grant row exists — AND the D2 billable precheck passes.
   */
  @Column({ type: 'boolean', default: false, name: 'available_to_all_tenants' })
  availableToAllTenants!: boolean;

  /** 'archived' hides it from new bindings; bound bots fall back per T21. */
  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: BotTemplateStatus;

  /**
   * What this template intends about the bot's SKILLS, as opposed to its identity (#103).
   *
   * A specialty template curates its skills and is `explicit`. `Blank (no template)` says "no
   * specialty identity" and used to mean "no capabilities", because skills were only ever an
   * explicit selection and Blank selects nothing — so choosing a neutral-sounding, documented
   * option silently removed booking, lead capture and handoff from a paying customer's bot.
   * `inherit_entitled` lets it mean what it says. `none` stays deliberately tool-free.
   *
   * Lives on the TEMPLATE rather than the version: it is part of what the template IS, so
   * repairing Blank repairs every bot bound to it, including bots pinned to an old version.
   *
   * Default `explicit` matters — a template that has never heard of this column must not inherit.
   */
  @Column({ type: 'varchar', length: 20, default: 'explicit', name: 'skill_policy' })
  skillPolicy!: SkillPolicy;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
