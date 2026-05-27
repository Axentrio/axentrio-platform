/**
 * User Entity
 * Represents platform users (admins, supervisors, agents)
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToOne,
  Index,
} from 'typeorm';
import { Tenant } from './Tenant';
import { Agent } from './Agent';

export type UserRole = 'super_admin' | 'admin' | 'supervisor' | 'agent';

@Entity('users')
@Index(['tenantId', 'email'], { unique: true })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({ type: 'varchar', length: 255, nullable: true, unique: true, name: 'clerk_user_id' })
  clerkUserId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  password?: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({
    type: 'enum',
    enum: ['super_admin', 'admin', 'supervisor', 'agent'],
    default: 'agent',
  })
  role!: UserRole;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'avatar_url' })
  avatarUrl?: string;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive!: boolean;

  @Column({ type: 'boolean', default: false, name: 'email_verified' })
  emailVerified!: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'timezone' })
  timezone?: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  locale?: string;

  @Column({ type: 'jsonb', nullable: true, name: 'notification_preferences' })
  notificationPreferences?: {
    email?: boolean;
    push?: boolean;
    sound?: boolean;
    newMessage?: boolean;
    handoffRequest?: boolean;
  };

  @Column({ type: 'timestamptz', nullable: true, name: 'last_login_at' })
  lastLoginAt?: Date;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'last_login_ip' })
  lastLoginIp?: string;

  @Column({ type: 'timestamptz', nullable: true, name: 'password_changed_at' })
  passwordChangedAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'deleted_at' })
  deletedAt?: Date;

  // Relationships
  @ManyToOne(() => Tenant, (tenant) => tenant.users, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant;

  @OneToOne(() => Agent, (agent) => agent.user)
  agentProfile?: Agent;

  // Helper methods
  isAdmin(): boolean {
    return this.role === 'admin';
  }

  isAgent(): boolean {
    return this.role === 'agent';
  }

  isSupervisor(): boolean {
    return this.role === 'supervisor';
  }

  isSuperAdmin(): boolean {
    return this.role === 'super_admin';
  }

  canAccessAdminPanel(): boolean {
    return this.role === 'super_admin' || this.role === 'admin' || this.role === 'supervisor';
  }

  getDisplayName(): string {
    return this.name || this.email.split('@')[0];
  }
}
