/**
 * Handoff Request Entity
 * Represents requests to transfer chat from bot to human agent
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ChatSession } from './ChatSession';
import { Agent } from './Agent';

export type HandoffStatus = 'requested' | 'accepted' | 'rejected' | 'completed' | 'timeout';
export type HandoffReason = 'user_request' | 'bot_confidence_low' | 'escalation_trigger' | 'business_hours';

@Entity('handoff_requests')
@Index(['sessionId', 'status'])
@Index(['tenantId', 'status'])
@Index(['assignedAgentId', 'status'])
export class HandoffRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'requested_by' })
  requestedBy!: string;

  @Column({ type: 'timestamp', name: 'requested_at' })
  requestedAt!: Date;

  @Column({
    type: 'enum',
    enum: ['requested', 'accepted', 'rejected', 'completed', 'timeout'],
    default: 'requested',
  })
  status!: HandoffStatus;

  @Column({
    type: 'enum',
    enum: ['user_request', 'bot_confidence_low', 'escalation_trigger', 'business_hours'],
  })
  reason!: HandoffReason;

  @Column({ type: 'enum', enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' })
  priority!: 'low' | 'medium' | 'high' | 'urgent';

  @Column({ type: 'uuid', nullable: true, name: 'assigned_agent_id' })
  assignedAgentId?: string;

  @Column({ type: 'timestamp', nullable: true, name: 'accepted_at' })
  acceptedAt?: Date;

  @Column({ type: 'timestamp', nullable: true, name: 'completed_at' })
  completedAt?: Date;

  @Column({ type: 'timestamp', nullable: true, name: 'timeout_at' })
  timeoutAt?: Date;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Column({ type: 'jsonb', nullable: true })
  context!: {
    messageHistory?: Array<{
      id: string;
      content: string;
      sender: string;
      timestamp: Date;
    }>;
    botConfidence?: number;
    detectedIntent?: string;
    detectedLanguage?: string;
    userSentiment?: 'positive' | 'neutral' | 'negative';
    customData?: Record<string, unknown>;
  };

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'rejection_reason' })
  rejectionReason?: string;

  @Column({ type: 'int', default: 0, name: 'wait_time_seconds' })
  waitTimeSeconds!: number;

  @Column({ type: 'int', default: 0, name: 'handle_time_seconds' })
  handleTimeSeconds!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  // Relationships
  @ManyToOne(() => ChatSession, (session) => session.handoffRequests, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'session_id' })
  session!: ChatSession;

  @ManyToOne(() => Agent, (agent) => agent.id)
  @JoinColumn({ name: 'assigned_agent_id' })
  assignedAgent?: Agent;

  // Helper methods
  accept(agentId: string): void {
    this.assignedAgentId = agentId;
    this.status = 'accepted';
    this.acceptedAt = new Date();
    this.waitTimeSeconds = Math.floor(
      (this.acceptedAt.getTime() - this.requestedAt.getTime()) / 1000
    );
  }

  reject(reason?: string): void {
    this.status = 'rejected';
    this.rejectionReason = reason;
  }

  complete(): void {
    this.status = 'completed';
    this.completedAt = new Date();
    if (this.acceptedAt) {
      this.handleTimeSeconds = Math.floor(
        (this.completedAt.getTime() - this.acceptedAt.getTime()) / 1000
      );
    }
  }

  markTimeout(): void {
    this.status = 'timeout';
    this.timeoutAt = new Date();
  }

  isPending(): boolean {
    return this.status === 'requested';
  }

  isActive(): boolean {
    return this.status === 'accepted';
  }

  getWaitTime(): number {
    if (this.waitTimeSeconds) {
      return this.waitTimeSeconds;
    }
    if (this.acceptedAt) {
      return Math.floor((this.acceptedAt.getTime() - this.requestedAt.getTime()) / 1000);
    }
    return Math.floor((Date.now() - this.requestedAt.getTime()) / 1000);
  }

  hasTimedOut(timeoutSeconds: number = 300): boolean {
    const waitTime = this.getWaitTime();
    return waitTime > timeoutSeconds;
  }
}
