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
/**
 * Worklist state. `new` ↔ `archived` are the operator's two states; `erased` is
 * TERMINAL — set only by `eraseLead`, never reachable via the worklist PATCH, and
 * never transitioned out of. An erased row is a husk kept for audit: `deleted_at`
 * is set so it leaves every list, export and aggregate.
 */
export type LeadStatus = 'new' | 'archived' | 'erased';

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
// The repeat-customer sweep's grouping read. Declared here as well as in the migration
// so the synchronize-built test schema and the migration-built prod schema agree — an
// index that exists only in prod means no test ever exercises the sweep's plan.
// NOT unique: several rows sharing a key is the entire point.
@Index('ix_chatbot_leads_person', ['tenantId', 'personKey'], {
  where: '"person_key" IS NOT NULL AND "deleted_at" IS NULL',
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

  /**
   * Operator override for the readiness score (0-100). NULL = use the computed value.
   *
   * Only the override is stored; the score itself is computed on read from facts already
   * on the row, so it cannot go stale when a booking is cancelled. A human override is
   * terminal — it always wins over the computed value.
   */
  @Column({ type: 'smallint', name: 'readiness_override', nullable: true })
  readinessOverride?: number | null;

  @Column({ type: 'uuid', name: 'readiness_override_by', nullable: true })
  readinessOverrideBy?: string | null;

  @Column({ type: 'timestamptz', name: 'readiness_override_at', nullable: true })
  readinessOverrideAt?: Date | null;

  /**
   * Repeat-customer detection (Story 3). All five columns are DERIVED state with a
   * single writer — `sweepRepeatCustomers` in `repeat-detection.service.ts`. Neither
   * the capture path nor any route may write them.
   *
   * Why stored and not computed on read: the key spans lead ROWS, so answering
   * "how many conversations has this person had" on read means a correlated
   * subquery that re-groups the tenant's whole lead table for every row of every
   * page. The nightly pass turns that into four column reads. Storing it is also
   * what makes the group inspectable — a computed-on-read grouping leaves no trace
   * to audit when an operator asks why two rows were treated as one person.
   *
   * They are a CACHE, never a source of truth: `person_key` is a pure function of
   * `phone`/`email` (see `computePersonKey`) and the counts are a pure function of
   * the live rows carrying that key, so the whole set is recomputable from scratch
   * on any run. NULL simply means "not computed yet", which every row is until the
   * first sweep — the read path falls back to this row's own conversation count.
   *
   * `person_key` is derived from personal data and is therefore personal data
   * itself: `eraseLead` clears it along with the phone and email it came from.
   */
  @Column({ type: 'varchar', length: 400, name: 'person_key', nullable: true })
  personKey?: string | null;

  /** Live lead rows sharing this person key — the merge-suggestion number. */
  @Column({ type: 'int', name: 'person_lead_count', nullable: true })
  personLeadCount?: number | null;

  /** Distinct conversations across all of this person's live lead rows. */
  @Column({ type: 'int', name: 'person_conversation_count', nullable: true })
  personConversationCount?: number | null;

  @Column({ type: 'timestamptz', name: 'person_first_seen_at', nullable: true })
  personFirstSeenAt?: Date | null;

  @Column({ type: 'timestamptz', name: 'person_last_seen_at', nullable: true })
  personLastSeenAt?: Date | null;

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
