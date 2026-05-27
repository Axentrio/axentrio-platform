import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('agent_traces')
@Index(['tenantId', 'createdAt'])
@Index(['sessionId', 'createdAt'])
export class AgentTrace {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'uuid', nullable: true })
  sessionId?: string;

  @Column({ type: 'uuid', nullable: true })
  messageId?: string;

  @Column({ type: 'jsonb', default: {} })
  trace!: Record<string, unknown>;

  @Column({ type: 'integer', nullable: true })
  totalTokens?: number;

  @Column({ type: 'integer', nullable: true })
  totalLatencyMs?: number;

  @Column({ type: 'varchar', length: 30, nullable: true })
  finishReason?: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
