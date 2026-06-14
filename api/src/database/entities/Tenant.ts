/**
 * Tenant Entity
 * Represents a white-label customer/organization
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { ChatSession } from './ChatSession';
import { User } from './User';
import { Agent } from './Agent';

export type TenantTier = 'free' | 'essential' | 'pro' | 'enterprise';
export type TenantStatus = 'active' | 'suspended' | 'cancelled';

/**
 * One per-tenant feature override (explicit super-admin exception). `value`
 * alone governs behavior; the audit fields are provenance for the admin UI.
 * Written exclusively through the admin override endpoints — never via the
 * generic tenant PATCH. See .scratch/plan-entitlements-modules.md (D4/D5).
 */
export interface FeatureOverride {
  value: boolean;
  reason: string;
  setBy: string;
  setAt: string;
}

@Entity('tenants')
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 100, unique: true })
  @Index({ unique: true })
  slug!: string;

  @Column({ type: 'varchar', length: 255, unique: true, name: 'api_key' })
  @Index({ unique: true })
  apiKey!: string;

  @Column({ type: 'varchar', length: 255, nullable: true, unique: true, name: 'clerk_org_id' })
  clerkOrgId?: string;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'webhook_url' })
  webhookUrl?: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'webhook_secret' })
  webhookSecret?: string;

  @Column({
    type: 'enum',
    enum: ['free', 'essential', 'pro', 'enterprise'],
    default: 'free',
  })
  tier!: TenantTier;

  @Column({
    type: 'enum',
    enum: ['active', 'suspended', 'cancelled'],
    default: 'active',
  })
  status!: TenantStatus;

  @Column({ type: 'jsonb', default: {} })
  settings!: {
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
      apiKey?: string | null;
      supportEmail?: string | null;
      brandVoice: {
        name: string;
        tone: string;
        customInstructions: string;
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
    /** Enterprise AI Insights prefs (P3 / ADR-0014, D6). */
    insights?: {
      /** Weekly digest email — default-ON; only an explicit `false` opts out. */
      digestEmail?: boolean;
    };
  };

  /**
   * Per-tenant boolean feature overrides, merged over PLANS[tier].features by
   * the entitlement resolver (ignored entirely for free/non-active tenants).
   * Keys are FeatureKeys; unknown keys and malformed entries are ignored at
   * read time. Defaults to {} (no overrides).
   */
  @Column({ type: 'jsonb', default: {}, name: 'feature_overrides' })
  featureOverrides!: Record<string, FeatureOverride>;

  @Column({ type: 'int', default: 100, name: 'max_sessions' })
  maxSessions!: number;

  @Column({ type: 'int', default: 0, name: 'current_sessions' })
  currentSessions!: number;

  /**
   * Per-tenant daily LLM call cap. NULL means "use env default LLM_DAILY_LIMIT_PER_TENANT".
   * Enforced in src/llm/llm-rate-limit.ts.
   */
  @Column({ type: 'int', nullable: true, name: 'daily_llm_call_limit' })
  dailyLlmCallLimit?: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'custom_domain' })
  customDomain?: string;

  @Column({ type: 'jsonb', nullable: true, name: 'billing_info' })
  billingInfo?: {
    planId?: string;
    subscriptionId?: string;
    billingEmail?: string;
    nextBillingDate?: Date;
  };

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'deleted_at' })
  deletedAt?: Date;

  // Relationships
  @OneToMany(() => ChatSession, (session) => session.tenant)
  sessions!: ChatSession[];

  @OneToMany(() => User, (user) => user.tenant)
  users!: User[];

  @OneToMany(() => Agent, (agent) => agent.tenant)
  agents!: Agent[];

  // Helper methods
  isActive(): boolean {
    return this.status === 'active';
  }

  canCreateSession(): boolean {
    return this.currentSessions < this.maxSessions;
  }

  getFeature(feature: keyof NonNullable<typeof this.settings.features>): boolean {
    return this.settings?.features?.[feature] ?? false;
  }
}
