/**
 * Chat Session Entity
 * Represents a chat conversation between visitors and agents
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
import { Agent } from './Agent';
import { Participant } from './Participant';
import { Message } from './Message';
import { HandoffRequest } from './HandoffRequest';

export type SessionStatus = 'active' | 'closed' | 'waiting' | 'handoff' | 'bot';

@Entity('chat_sessions')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'visitorId'])
@Index(['assignedAgentId', 'status'])
export class ChatSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 255, name: 'visitor_id' })
  visitorId!: string;

  @Column({
    type: 'enum',
    enum: ['active', 'closed', 'waiting', 'handoff', 'bot'],
    default: 'waiting',
  })
  status!: SessionStatus;

  @Column({ type: 'uuid', nullable: true, name: 'assigned_agent_id' })
  assignedAgentId?: string;

  @Column({ type: 'varchar', length: 100, default: 'widget' })
  source!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  subject?: string;

  @Column({ type: 'jsonb', default: {} })
  metadata!: {
    userAgent?: string;
    ipAddress?: string;
    pageUrl?: string;
    referrer?: string;
    customData?: Record<string, unknown>;
  };

  @Column({ type: 'int', default: 0, name: 'message_count' })
  messageCount!: number;

  @Column({ type: 'int', default: 0, name: 'unread_count' })
  unreadCount!: number;

  @Column({ type: 'int', nullable: true, name: 'duration_seconds' })
  durationSeconds?: number;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'priority' })
  priority?: 'low' | 'medium' | 'high' | 'urgent';

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'tags', array: true })
  tags?: string[];

  @Column({ type: 'timestamp', name: 'started_at' })
  startedAt!: Date;

  @Column({ type: 'timestamp', nullable: true, name: 'ended_at' })
  endedAt?: Date;

  @Column({ type: 'timestamp', name: 'last_activity_at' })
  lastActivityAt!: Date;

  @Column({ type: 'timestamp', nullable: true, name: 'first_response_at' })
  firstResponseAt?: Date;

  @Column({ type: 'int', nullable: true, name: 'first_response_time_seconds' })
  firstResponseTimeSeconds?: number;

  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true, name: 'satisfaction_rating' })
  satisfactionRating?: number;

  @Column({ type: 'text', nullable: true, name: 'satisfaction_feedback' })
  satisfactionFeedback?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamp', nullable: true, name: 'deleted_at' })
  deletedAt?: Date;

  // Relationships
  @ManyToOne(() => Tenant, (tenant) => tenant.sessions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant;

  @ManyToOne(() => Agent, (agent) => agent.assignedSessions)
  @JoinColumn({ name: 'assigned_agent_id' })
  assignedAgent?: Agent;

  @OneToMany(() => Participant, (participant) => participant.session)
  participants!: Participant[];

  @OneToMany(() => Message, (message) => message.session)
  messages!: Message[];

  @OneToMany(() => HandoffRequest, (handoff) => handoff.session)
  handoffRequests!: HandoffRequest[];

  // Helper methods
  isActive(): boolean {
    return this.status === 'active';
  }

  isClosed(): boolean {
    return this.status === 'closed';
  }

  close(): void {
    this.status = 'closed';
    this.endedAt = new Date();
    if (this.startedAt) {
      this.durationSeconds = Math.floor(
        (this.endedAt.getTime() - this.startedAt.getTime()) / 1000
      );
    }
  }

  assignAgent(agentId: string): void {
    this.assignedAgentId = agentId;
    this.status = 'active';
  }

  requestHandoff(): void {
    this.status = 'handoff';
  }

  incrementMessageCount(): void {
    this.messageCount++;
    this.lastActivityAt = new Date();
  }

  setFirstResponse(): void {
    if (!this.firstResponseAt) {
      this.firstResponseAt = new Date();
      this.firstResponseTimeSeconds = Math.floor(
        (this.firstResponseAt.getTime() - this.startedAt.getTime()) / 1000
      );
    }
  }

  updateActivity(): void {
    this.lastActivityAt = new Date();
  }
}
