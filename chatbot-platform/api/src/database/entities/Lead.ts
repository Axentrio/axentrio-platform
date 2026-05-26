/**
 * Lead — first-class captured-contact record.
 *
 * Before M6, leads lived inside `chat_sessions.metadata.lead` (one
 * jsonb blob per session). They're now their own table — see
 * migration `1783100000000-CreateLeadsTable`. The `session_id` FK is
 * `ON DELETE SET NULL` so a lead survives the conversation that
 * captured it.
 *
 * Sources (extensible via the `source` column):
 *   - `'tool'` — `CaptureLeadTool` fired by the agent during a chat
 *   - `'manual'` — created by a portal user (future)
 *   - `'import'` — bulk-imported via CSV (future)
 *   - `'webhook'` — pushed from n8n (future)
 *
 * The `metadata` jsonb is a forward-compat extensibility hatch for
 * tenant-specific custom fields. The Pro-only "custom fields and
 * routing rules" promise on the LockedPreview lives here in v2.
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
import { Tenant } from './Tenant';
import { ChatSession } from './ChatSession';
import { Bot } from './Bot';

export type LeadSource = 'tool' | 'manual' | 'import' | 'webhook';

@Entity('chatbot_leads')
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'email'])
@Index(['sessionId'])
export class Lead {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'session_id', nullable: true })
  sessionId?: string | null;

  @Column({ type: 'uuid', name: 'bot_id', nullable: true })
  botId?: string | null;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 320 })
  email!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  phone?: string | null;

  @Column({ type: 'varchar', length: 32, default: 'tool' })
  source!: LeadSource;

  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', name: 'deleted_at', nullable: true })
  deletedAt?: Date | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;

  @ManyToOne(() => ChatSession, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'session_id' })
  session?: ChatSession;

  @ManyToOne(() => Bot, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'bot_id' })
  bot?: Bot;
}
