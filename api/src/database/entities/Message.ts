/**
 * Message Entity
 * Represents chat messages with optional encryption
 *
 * Encryption is handled at the service layer (chat routes, socket handler),
 * NOT in entity hooks. The content column stores encrypted data directly.
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
import { Participant } from './Participant';

export type MessageType = 'text' | 'image' | 'file' | 'system' | 'typing';
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

@Entity('messages')
@Index(['sessionId', 'createdAt'])
@Index(['tenantId', 'createdAt'])
@Index(['participantId', 'createdAt'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'participant_id' })
  participantId!: string;

  @Column({
    type: 'enum',
    enum: ['text', 'image', 'file', 'system', 'typing'],
    default: 'text',
  })
  type!: MessageType;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'boolean', default: false, name: 'content_encrypted' })
  contentEncrypted!: boolean;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: {
    fileName?: string;
    fileSize?: number;
    fileType?: string;
    fileUrl?: string;
    thumbnailUrl?: string;
    duration?: number;
    dimensions?: { width: number; height: number };
    edited?: boolean;
    editedAt?: Date;
    quickReplies?: (string | { title: string; value?: string })[];
    customData?: Record<string, unknown>;
  };

  @Column({
    type: 'enum',
    enum: ['sending', 'sent', 'delivered', 'read', 'failed'],
    default: 'sending',
  })
  status!: MessageStatus;

  @Column({ type: 'uuid', nullable: true, name: 'reply_to_id' })
  replyToId?: string;

  @Column({ type: 'timestamptz', nullable: true, name: 'sent_at' })
  sentAt?: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'delivered_at' })
  deliveredAt?: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'read_at' })
  readAt?: Date;

  @Column({ type: 'int', default: 0, name: 'edit_count' })
  editCount!: number;

  @Column({ type: 'boolean', default: false, name: 'is_deleted' })
  isDeleted!: boolean;

  /**
   * Set true when the guardrails layer flags this inbound message (spam/scam/
   * bot-loop) or it arrived while the session was guardrail-disabled. Flagged
   * messages are excluded from AI history so a phishing/injection message can't
   * leak after reactivation. See .scratch/plan-global-ai-guardrails.md §3b/§1B.
   */
  @Column({ type: 'boolean', default: false, name: 'guardrail_flagged' })
  guardrailFlagged!: boolean;

  /**
   * Set true the first time the guardrails gate evaluates this message — the
   * idempotency anchor that makes the gate exactly-once across the coalescer
   * window, the legacy entry, drain, and 'stale' re-runs. `flagged` ⊆ `checked`.
   */
  @Column({ type: 'boolean', default: false, name: 'guardrail_checked' })
  guardrailChecked!: boolean;

  @Column({ type: 'timestamptz', nullable: true, name: 'deleted_at' })
  deletedAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  // Relationships
  @ManyToOne(() => ChatSession, (session) => session.messages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'session_id' })
  session!: ChatSession;

  @ManyToOne(() => Participant, (participant) => participant.messages)
  @JoinColumn({ name: 'participant_id' })
  participant!: Participant;

  // Helper methods
  markAsSent(): void {
    this.status = 'sent';
    this.sentAt = new Date();
  }

  markAsDelivered(): void {
    this.status = 'delivered';
    this.deliveredAt = new Date();
  }

  markAsRead(): void {
    this.status = 'read';
    this.readAt = new Date();
  }

  markAsFailed(): void {
    this.status = 'failed';
  }

  edit(newContent: string): void {
    this.content = newContent;
    this.contentEncrypted = false;
    this.metadata = {
      ...this.metadata,
      edited: true,
      editedAt: new Date(),
    };
    this.editCount++;
  }

  softDelete(): void {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.content = '[Deleted]';
    this.contentEncrypted = false;
  }

  isSystemMessage(): boolean {
    return this.type === 'system';
  }

  hasAttachment(): boolean {
    return this.type === 'image' || this.type === 'file';
  }
}
