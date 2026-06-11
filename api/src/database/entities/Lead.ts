/**
 * Lead — first-class captured-contact record.
 *
 * Before M6, leads lived inside `chat_sessions.metadata.lead` (one
 * jsonb blob per session). They're now their own table — see
 * migration `1783100000000-CreateLeadsTable`. The `session_id` FK is
 * `ON DELETE SET NULL` so a lead survives the conversation that
 * captured it.
 *
 * Identity-polymorphic (leads-across-all-channels): a Lead is identified by
 * whatever durable contact the conversation provided. `dedupe_key` is the
 * single per-identity upsert anchor (`<channel>:<externalUserId>` for channel
 * conversations, `email:<…>` / `phone:<…>` for the widget). `email` and `name`
 * are nullable; a DB CHECK guarantees at least one of email/phone/externalUserId.
 *
 * Sources (extensible via the `source` column), strongest-signal last:
 *   - `'channel'` — auto-captured from a channel conversation at first message
 *   - `'tool'` — `CaptureLeadTool` fired by the agent during a widget chat
 *   - `'booking'` — captured when a booking was made/requested
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
  Check,
} from 'typeorm';
import { Tenant } from './Tenant';
import { ChatSession } from './ChatSession';
import { Bot } from './Bot';

export type LeadSource = 'channel' | 'tool' | 'booking' | 'manual' | 'import' | 'webhook';
export type LeadStatus = 'new' | 'archived';

@Entity('chatbot_leads')
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'email'])
@Index(['sessionId'])
// Per-identity dedup anchor — MUST match the migration so the test schema
// (synchronize-from-entities) and prod (migration) agree. The upsert's
// ON CONFLICT (tenant_id, dedupe_key) needs this exact partial unique index.
@Index('ux_chatbot_leads_tenant_dedupe', ['tenantId', 'dedupeKey'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
// Every Lead must carry at least one contact identifier.
@Check('chk_chatbot_leads_identity', '"email" IS NOT NULL OR "phone" IS NOT NULL OR "external_user_id" IS NOT NULL')
export class Lead {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'session_id', nullable: true })
  sessionId?: string | null;

  @Column({ type: 'uuid', name: 'bot_id', nullable: true })
  botId?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name?: string | null;

  @Column({ type: 'varchar', length: 320, nullable: true })
  email?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  phone?: string | null;

  /** Channel this lead originated from (widget/whatsapp/messenger/instagram/telegram). */
  @Column({ type: 'varchar', length: 32, nullable: true })
  channel?: string | null;

  /** Channel-side durable handle (wa_id / PSID / telegram id); null for widget. */
  @Column({ type: 'varchar', length: 255, name: 'external_user_id', nullable: true })
  externalUserId?: string | null;

  /** Per-identity dedup anchor, e.g. `whatsapp:32475…` / `email:a@b.com`. */
  @Column({ type: 'varchar', length: 400, name: 'dedupe_key', nullable: true })
  dedupeKey?: string | null;

  @Column({ type: 'varchar', length: 32, default: 'new' })
  status!: LeadStatus;

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
