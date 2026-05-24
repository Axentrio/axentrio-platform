/**
 * Agent Entity
 * Represents chat agents with their status and capabilities
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
  OneToMany,
  Index,
} from 'typeorm';
import { Tenant } from './Tenant';
import { User } from './User';
import { ChatSession } from './ChatSession';

export type AgentStatus = 'online' | 'away' | 'busy' | 'offline';

@Entity('support_agents')
@Index(['tenantId', 'status'])
export class Agent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'user_id', unique: true })
  userId!: string;

  @Column({
    type: 'enum',
    enum: ['online', 'away', 'busy', 'offline'],
    default: 'offline',
  })
  status!: AgentStatus;

  @Column({ type: 'int', default: 5, name: 'max_concurrent_chats' })
  maxConcurrentChats!: number;

  @Column({ type: 'int', default: 0, name: 'current_chat_count' })
  currentChatCount!: number;

  @Column({ type: 'text', array: true, default: [] })
  skills!: string[];

  @Column({ type: 'varchar', length: 10, array: true, default: ['en'] })
  languages!: string[];

  @Column({ type: 'int', default: 0, name: 'total_chats_handled' })
  totalChatsHandled!: number;

  @Column({ type: 'int', default: 0, name: 'avg_response_time_seconds' })
  avgResponseTimeSeconds!: number;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0, name: 'satisfaction_score' })
  satisfactionScore!: number;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_status_change_at' })
  lastStatusChangeAt?: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_active_at' })
  lastActiveAt?: Date;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'current_ip' })
  currentIp?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'deleted_at' })
  deletedAt?: Date;

  // Relationships
  @ManyToOne(() => Tenant, (tenant) => tenant.agents, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant;

  @OneToOne(() => User, (user) => user.agentProfile)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @OneToMany(() => ChatSession, (session) => session.assignedAgent)
  assignedSessions!: ChatSession[];

  // Helper methods
  isAvailable(): boolean {
    return this.status === 'online' && this.currentChatCount < this.maxConcurrentChats;
  }

  canTakeMoreChats(): boolean {
    return this.currentChatCount < this.maxConcurrentChats;
  }

  incrementChatCount(): void {
    this.currentChatCount++;
    this.totalChatsHandled++;
  }

  decrementChatCount(): void {
    if (this.currentChatCount > 0) {
      this.currentChatCount--;
    }
  }

  updateStatus(newStatus: AgentStatus): void {
    this.status = newStatus;
    this.lastStatusChangeAt = new Date();
  }

  updateResponseTime(responseTimeSeconds: number): void {
    // Calculate running average
    const totalResponses = this.totalChatsHandled;
    this.avgResponseTimeSeconds = Math.round(
      (this.avgResponseTimeSeconds * (totalResponses - 1) + responseTimeSeconds) / totalResponses
    );
  }
}
