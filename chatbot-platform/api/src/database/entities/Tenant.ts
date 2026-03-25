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

export type TenantTier = 'free' | 'pro' | 'enterprise';
export type TenantStatus = 'active' | 'suspended' | 'cancelled';

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

  @Column({
    type: 'enum',
    enum: ['free', 'pro', 'enterprise'],
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
    features?: {
      fileUploadEnabled: boolean;
      handoffEnabled: boolean;
      aiEnabled: boolean;
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
  };

  @Column({ type: 'int', default: 100, name: 'max_sessions' })
  maxSessions!: number;

  @Column({ type: 'int', default: 0, name: 'current_sessions' })
  currentSessions!: number;

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

  @Column({ type: 'timestamp', nullable: true, name: 'deleted_at' })
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
