/**
 * BotTemplateVersion — one immutable-once-published version of a BotTemplate's
 * prompt body (.scratch/plan-bot-templates.md, T4/T19).
 *
 * Lifecycle: `draft` (editable) → `published` (frozen, eligible for `latest`)
 * → `unpublished` (frozen, withdrawn from `latest`; NEVER reverts to draft).
 * `latest` resolves to MAX(version WHERE status='published'). Rollback =
 * publish a new version copied from an older one — never edit a published row.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type BotTemplateVersionStatus = 'draft' | 'published' | 'unpublished';

/** A custom placeholder a template declares for tenants to fill (a "blank"). */
export interface TemplateVariable {
  /** The `{key}` used in the prompt body (e.g. 'cancellationPolicy'). */
  key: string;
  /** Human label shown on the tenant's fill form (defaults to a prettified key). */
  label?: string;
  /** Optional help text under the field. */
  help?: string;
  /** Whether the tenant must provide a value. */
  required?: boolean;
  /** Pre-fills the tenant's field; used until they change it. */
  default?: string;
}

/**
 * Identity/policy config the template owns (the "pre-defined bot"), versioned
 * with the body. Tone + the policy guardrails move here from the per-bot AI
 * settings (slim-down: tenants only pick a template + add instructions).
 * OPERATIONAL settings (businessHours, escalationKeywords) deliberately stay
 * tenant-owned and are NOT part of this — they're fetched per-tenant at runtime.
 */
export interface BotTemplateConfig {
  tone?: string;
  guardrails?: {
    topicsToAvoid?: string[];
    greetingMessage?: string;
    fallbackMessage?: string;
    offHoursMessage?: string;
    confidenceThreshold?: number;
    maxResponseLength?: number;
  };
}

@Entity('bot_template_versions')
@Index('ux_bot_template_versions_template_version', ['templateId', 'version'], { unique: true })
export class BotTemplateVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'template_id' })
  templateId!: string;

  /** Monotonic per template; allocated transactionally on draft create (T19). */
  @Column({ type: 'int' })
  version!: number;

  /** The prompt body (max 20k chars enforced at the authoring layer, T22). */
  @Column({ type: 'text', default: '' })
  body!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  changelog?: string | null;

  /** Advisory list of module ids this template expects (e.g. ['booking']), T13. */
  @Column({ type: 'jsonb', default: [], name: 'expected_modules' })
  expectedModules!: string[];

  /** Composable-templates: skill ids bound to this version (module==skill, 1:1),
   *  snapshotted at publish. NULL = use the legacy expectedModules path. */
  @Column({ type: 'jsonb', nullable: true, name: 'selected_skill_ids' })
  selectedSkillIds?: string[] | null;

  /** Per-template prose OVERRIDES for bound skills (skillId → prose). A skill's
   *  default prose is frozen in code; this replaces it for THIS template version
   *  only. NULL/absent skill = use the code default. */
  @Column({ type: 'jsonb', nullable: true, name: 'skill_prose' })
  skillProse?: Record<string, string> | null;

  /** Custom placeholders this template declares — the "blanks" a tenant fills when
   *  they adopt it (e.g. {cancellationPolicy}). Auto-seeded in the editor from the
   *  unknown {placeholders} in the body; each may carry a label/help/required/default. */
  @Column({ type: 'jsonb', nullable: true, name: 'variables' })
  variables?: TemplateVariable[] | null;

  /** Identity/policy the template owns (tone + policy guardrails). Versioned
   *  with the body; consumed at runtime via effectiveBotConfig(). */
  @Column({ type: 'jsonb', default: {} })
  config!: BotTemplateConfig;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status!: BotTemplateVersionStatus;

  @Column({ type: 'timestamptz', nullable: true, name: 'published_at' })
  publishedAt?: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'published_by' })
  publishedBy?: string | null;

  /** Optimistic-concurrency token for draft edits (T19/T22). */
  @Column({ type: 'int', default: 0, name: 'lock_version' })
  lockVersion!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
