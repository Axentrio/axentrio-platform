/**
 * CopilotTrace — metadata-only audit log of every Copilot turn.
 *
 * One row written per turn by the agent-loop wrapper (NOT by tool
 * implementations). Carries tool NAMES + OUTCOME STATUS only — never
 * tool args, never the user's query text, never tool inputs or
 * outputs, never resource IDs (per security invariant #11).
 *
 * Conversation transcripts live in `chatbot_copilot_messages.content`
 * — a SEPARATE table with explicit privacy/retention rules. This trace
 * row stores only the metrics + outcome needed for operator
 * monitoring, cost attribution, and post-incident debugging.
 *
 * `turnId` is FK to the assistant message row. A DB trigger
 * (migration `1784200000000`) asserts the referenced message is in the
 * same tenant + conversation and has `role='assistant'`.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Tenant } from './Tenant';
import { User } from './User';
import { CopilotConversation } from './CopilotConversation';
import { CopilotMessage, CopilotToolCallSummary } from './CopilotMessage';

export type CopilotTraceOutcome =
  | 'success'
  | 'aborted'
  | 'error'
  | 'agent_loop_exceeded';

export type CopilotRetrievalMode = 'lexical' | 'vector' | 'hybrid';

@Entity('chatbot_copilot_traces')
export class CopilotTrace {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'conversation_id', nullable: true })
  conversationId?: string | null;

  @Column({ type: 'uuid', name: 'turn_id', nullable: true })
  turnId?: string | null;

  @Column({ type: 'jsonb', name: 'tools_called', default: () => "'[]'::jsonb" })
  toolsCalled!: CopilotToolCallSummary[];

  @Column({ type: 'int', name: 'tokens_in', nullable: true })
  tokensIn?: number | null;

  @Column({ type: 'int', name: 'tokens_out', nullable: true })
  tokensOut?: number | null;

  @Column({ type: 'int', name: 'latency_ms', nullable: true })
  latencyMs?: number | null;

  @Column({ type: 'varchar', length: 32 })
  outcome!: CopilotTraceOutcome;

  @Column({ type: 'varchar', length: 16, name: 'retrieval_mode', nullable: true })
  retrievalMode?: CopilotRetrievalMode | null;

  @Column({ type: 'varchar', length: 64, name: 'llm_model', nullable: true })
  llmModel?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @ManyToOne(() => CopilotConversation, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'conversation_id' })
  conversation?: CopilotConversation | null;

  @ManyToOne(() => CopilotMessage, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'turn_id' })
  message?: CopilotMessage | null;
}
