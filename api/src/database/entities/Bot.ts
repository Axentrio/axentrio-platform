/**
 * Bot Entity
 * The configured AI bot that talks to a Tenant's customers. A Tenant may own
 * multiple Bots (gated by Tier). Each Bot owns a stable, never-moving
 * `publicKey` that the widget embeds with.
 *
 * NOTE on naming: the table is `chatbot_bots` (domain-prefixed) to avoid a
 * collision with n8n's own `agents` table in the shared `public` schema —
 * see the agents→support_agents rename. Do NOT use a bare `bots` table name.
 *
 * The `Agent` entity (`support_agents`) is the *human* handoff operator, not
 * this AI bot.
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { Tenant } from './Tenant';
import { ChatSession } from './ChatSession';

export type BotStatus = 'active' | 'paused';

/**
 * The per-bot slice of configuration, migrated out of `Tenant.settings`.
 * Mirrors the moved keys of `Tenant.settings`. Tenant-wide concerns
 * (LLM provider secret `ai.apiKey`, billing, n8n webhook, quotas, channels)
 * stay on the Tenant and are intentionally NOT part of this type.
 */
export interface BotSettings {
  theme?: {
    primaryColor?: string;
    logoUrl?: string;
    customCss?: string;
  };
  widget?: {
    avatarUrl?: string | null;
    launcherPosition?: 'bottom-right' | 'bottom-left';
    launcherLabel?: string | null;
  };
  features?: {
    fileUploadEnabled: boolean;
    handoffEnabled: boolean;
  };
  businessHours?: {
    enabled: boolean;
    timezone: string;
    schedule: Array<{
      day: string;
      open: string;
      close: string;
      closed: boolean;
    }>;
  };
  ai?: {
    enabled: boolean;
    provider?: 'openai' | 'anthropic' | null;
    model?: string | null;
    supportEmail?: string | null;
    /** Free-text supplementary context — rendered as a fenced, LOWEST-authority
     *  block in the prompt; can never override platform rules. Guardrails §11b. */
    extraInfo?: string;
    /** Selected specialty keys (SpecialtyCatalog S3) — scoped to the bot's vertical
     *  (bound template category). Bias KB retrieval and, for requiresSpecialPrompt
     *  specialties, inject an exception block. jsonb, no migration. */
    selectedSpecialties?: string[];
    brandVoice: {
      name: string;
      tone: string;
      customInstructions: string;
      /** Commercial/trading name used in this bot's prompt ({businessName}).
       *  Empty/absent → inherits the tenant's business name (tenant.name). */
      businessName?: string;
      templateId?: string | null;
    };
    guardrails: {
      topicsToAvoid: string[];
      escalationKeywords: string[];
      confidenceThreshold: number;
      maxResponseLength: number;
      greetingMessage: string;
      fallbackMessage: string;
      offHoursMessage: string;
    };
  };
  integrations?: {
    // Which booking backend this bot uses. Defaults to 'calcom' when unset so
    // existing bots keep their current behavior. 'internal' selects the
    // in-house scheduler (added in later slices).
    provider?: 'calcom' | 'internal';
    calcom?: {
      apiKey?: string | null;
      eventTypeId?: number;
      collectFields?: string[];
      language?: 'en' | 'nl' | 'fr' | 'de';
    };
  };
  skills?: Array<{
    name: string;
    displayName?: string;
    description?: string;
    trigger: string;
    tools: string[];
    instructions: string;
    maxSteps: number;
    enabled: boolean;
  }>;
  automations?: {
    emailNotifications?: Record<string, {
      enabled?: boolean;
      subject?: string;
      body?: string;
      recipients?: string[];
    }>;
  };
}

@Entity('chatbot_bots')
@Index(['tenantId', 'status'])
// Exactly one non-deleted default (anchor) bot per tenant.
@Index(['tenantId'], { unique: true, where: '"is_default" = true AND "deleted_at" IS NULL' })
// Composite-unique to support a future composite FK from the join table.
@Index(['tenantId', 'id'], { unique: true })
export class Bot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  /**
   * Stable, globally-unique key the widget embeds with. For the anchor bot
   * this equals the legacy `Tenant.apiKey`. New bots get a `bk_<random>` key.
   * The unique index spans soft-deleted rows too, so a freed key is never recycled.
   */
  @Column({ type: 'varchar', length: 255, unique: true, name: 'public_key' })
  publicKey!: string;

  @Column({
    type: 'enum',
    enum: ['active', 'paused'],
    default: 'active',
  })
  status!: BotStatus;

  /**
   * The anchor bot. Non-deletable and non-pausable in v1; owns the legacy
   * `Tenant.apiKey` so existing embeds keep resolving forever.
   */
  @Column({ type: 'boolean', default: false, name: 'is_default' })
  isDefault!: boolean;

  @Column({ type: 'jsonb', default: {} })
  settings!: BotSettings;

  /**
   * Bound BotTemplate (prompt identity). Nullable for now; Phase 2 binds every
   * existing bot to the seeded `blank-base` template. This is the SOLE binding
   * source — the legacy client-side `settings.ai.brandVoice.templateId` is
   * retired (T18, .scratch/plan-bot-templates.md).
   */
  @Column({ type: 'uuid', nullable: true, name: 'template_id' })
  templateId?: string | null;

  /**
   * Which version of the bound template to resolve: `'latest'` (default —
   * follows new publishes) or a stringified integer pinning a fixed version
   * (T4/T5). Pin resolution + fallback live in template-resolver.
   */
  @Column({ type: 'varchar', length: 20, default: 'latest', name: 'template_version' })
  templateVersion!: string;

  /**
   * Up to 3 bound templates (ordered; [0] = primary). Each entry pins a template
   * + version. `template_id`/`template_version` mirror the PRIMARY for back-compat
   * with single-binding queries; this is the authoritative multi-binding list.
   * Empty array = fall back to the single template_id binding (legacy bots).
   */
  @Column({ type: 'jsonb', default: () => "'[]'", name: 'template_bindings' })
  templateBindings!: Array<{ templateId: string; version: string }>;

  /**
   * How multiple bound templates combine in the composed prompt:
   * 'or' = independent specialities (AI answers using whichever the question
   * matches); 'and' = one combined offering (all roles always active).
   */
  @Column({ type: 'varchar', length: 8, default: 'or', name: 'template_mode' })
  templateMode!: 'and' | 'or';

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'deleted_at' })
  deletedAt?: Date;

  // Relationships
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant;

  @OneToMany(() => ChatSession, (session) => session.bot)
  sessions!: ChatSession[];
}
