/**
 * Output-validation decision log — the durable record written by the Global AI
 * Workflow Guardrails OUTPUT gate (one row per flagged reply, including
 * shadow-mode observations). Together with SpamScamLog (inbound) this forms the
 * guardrails decision journal (AC13). See .scratch/plan-global-ai-guardrails.md.
 *
 * Append-only audit table; the actor is the automated guardrail (not a human),
 * so it is NOT the generic AuditLog. We deliberately do NOT store the offending
 * reply text — a leaked_internals hit may contain a real secret/API key. For
 * shadow-mode FP tuning, correlate a row to its message by conversation_id +
 * created_at (validation runs PRE-persist on every path, so outbound_message_id
 * is reserved for future use and currently always null).
 */

import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('guardrail_output_logs')
@Index(['tenantId', 'createdAt'])
@Index(['conversationId'])
export class GuardrailOutputLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  /** The chat session (conversation) this reply belongs to. */
  @Column({ type: 'uuid', name: 'conversation_id' })
  conversationId!: string;

  @Column({ type: 'varchar', length: 32, name: 'source_channel' })
  sourceChannel!: string;

  /** Reserved: a direct link to the flagged outbound message. Currently always
   *  null — validation runs before the reply is persisted (see class comment). */
  @Column({ type: 'uuid', nullable: true, name: 'outbound_message_id' })
  outboundMessageId?: string | null;

  /** Which reply path produced the content: coalescer | legacy | rag | n8n. */
  @Column({ type: 'varchar', length: 16, name: 'generation_path' })
  generationPath!: string;

  /** Distinct violation families (leaked_internals | plan_leakage | …). */
  @Column({ type: 'jsonb' })
  families!: string[];

  /** Human-readable per-violation evidence. */
  @Column({ type: 'jsonb', nullable: true })
  reasons?: string[] | null;

  /** False = shadow-mode observation (logged, original reply still sent);
   *  True  = enforced (the reply was replaced with the fallback). */
  @Column({ type: 'boolean', default: true, name: 'enforced' })
  enforced!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
