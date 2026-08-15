/**
 * Conversation Command idempotency store (B-PR2b).
 *
 * One row per COMMITTED conversation command that carried a client idempotency
 * key. A retry with the same (session, command, key) replays the stored result
 * instead of re-applying the transition — so a re-sent claim / release / cancel
 * / close returns the same outcome and can never double-apply.
 *
 * The row is written INSIDE the command's transaction, so "result exists" and
 * "transition applied" are the same fact. Deliberately minimal: the stored
 * result is the serialized conversation summary the command returned.
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ChatSession } from './ChatSession';

@Entity('conversation_commands')
@Index('uq_conversation_commands_session_command_key', ['sessionId', 'command', 'idempotencyKey'], {
  unique: true,
})
export class ConversationCommand {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 32 })
  command!: string;

  @Column({ type: 'varchar', length: 128, name: 'idempotency_key' })
  idempotencyKey!: string;

  /** The committed command result (conversation summary + outcome), replayed verbatim on retry. */
  @Column({ type: 'jsonb' })
  result!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  // ON DELETE CASCADE: the bulk-delete admin path removes chat_sessions rows with
  // raw SQL and must not be blocked by command bookkeeping.
  @ManyToOne(() => ChatSession, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'session_id' })
  session!: ChatSession;
}
