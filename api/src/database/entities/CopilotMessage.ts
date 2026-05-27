/**
 * CopilotMessage — one persisted row in a Copilot conversation.
 *
 * Each user-initiated cycle persists exactly two rows: a `user` row at
 * turn N and a paired `assistant` row at turn N+1, both inserted in one
 * tx under `SELECT next_turn FROM conversations FOR UPDATE`.
 *
 * Tool invocations during the agent loop are NOT persisted as separate
 * rows. They accumulate as `{ name, outcome }` entries on the paired
 * assistant row's `toolsCalled` JSONB array. Tool args / results / raw
 * payloads are NEVER persisted (per security invariant #11).
 *
 * `streamStartedAt` powers stale-pending detection: an assistant row
 * with `outcome: 'pending'` older than 90s (1.5× the 60s agent-loop
 * hard timeout) is treated as crashed/interrupted by the UI.
 *
 * `tenantId` is denormalized for query performance; a DB trigger
 * (migration `1784200000000`) enforces it matches the parent
 * conversation's `tenantId` on every insert/update.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { CopilotConversation } from './CopilotConversation';

export type CopilotMessageRole = 'user' | 'assistant';

export type CopilotMessageOutcome =
  | 'pending'
  | 'success'
  | 'aborted'
  | 'error'
  | 'agent_loop_exceeded';

export interface CopilotToolCallSummary {
  name: string;
  outcome: 'success' | 'error';
}

@Entity('chatbot_copilot_messages')
export class CopilotMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'conversation_id' })
  conversationId!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'int' })
  turn!: number;

  @Column({ type: 'varchar', length: 16 })
  role!: CopilotMessageRole;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'jsonb', name: 'tools_called', nullable: true })
  toolsCalled?: CopilotToolCallSummary[] | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  outcome?: CopilotMessageOutcome | null;

  @Column({ type: 'int', name: 'tokens_in', nullable: true })
  tokensIn?: number | null;

  @Column({ type: 'int', name: 'tokens_out', nullable: true })
  tokensOut?: number | null;

  @Column({ type: 'int', name: 'latency_ms', nullable: true })
  latencyMs?: number | null;

  @Column({ type: 'timestamptz', name: 'stream_started_at', nullable: true })
  streamStartedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne(() => CopilotConversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation?: CopilotConversation;
}
