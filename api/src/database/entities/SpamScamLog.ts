/**
 * Spam / scam / bot-loop detection log — the durable record written by the
 * Global AI Workflow Guardrails inbound gate (one row per detection event,
 * including shadow-mode observations). Mirrors the PRD "Spam and Scam Log"
 * fields. See .scratch/plan-global-ai-guardrails.md §3c.
 *
 * This is an append-only audit table; it is NOT the generic AuditLog (which
 * requires a UUID human actor). The actor here is the automated guardrail.
 */

import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('guardrail_spam_logs')
@Index(['tenantId', 'createdAt'])
@Index(['conversationId'])
export class SpamScamLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  /** The chat session (conversation) this detection belongs to. */
  @Column({ type: 'uuid', name: 'conversation_id' })
  conversationId!: string;

  @Column({ type: 'varchar', length: 32, name: 'source_channel' })
  sourceChannel!: string;

  @Column({ type: 'uuid', nullable: true, name: 'suspicious_message_id' })
  suspiciousMessageId?: string | null;

  /** One of the GuardrailCategory values (spam | scam | phishing | …). */
  @Column({ type: 'varchar', length: 32, name: 'detected_category' })
  detectedCategory!: string;

  @Column({ type: 'boolean', default: false, name: 'suspicious_links_detected' })
  suspiciousLinksDetected!: boolean;

  @Column({ type: 'boolean', default: false, name: 'repeated_message_detected' })
  repeatedMessageDetected!: boolean;

  @Column({ type: 'boolean', default: false, name: 'bot_loop_detected' })
  botLoopDetected!: boolean;

  @Column({ type: 'boolean', default: false, name: 'ai_auto_reply_disabled' })
  aiAutoReplyDisabled!: boolean;

  @Column({ type: 'boolean', default: false, name: 'notification_sent' })
  notificationSent!: boolean;

  /** Detector confidence (0..1) — tuning aid. */
  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true })
  score?: number | null;

  /** Human-readable detection signals. */
  @Column({ type: 'jsonb', nullable: true })
  reasons?: string[] | null;

  /** False = shadow-mode observation (logged but not enforced). */
  @Column({ type: 'boolean', default: true, name: 'enforced' })
  enforced!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
