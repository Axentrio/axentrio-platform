/**
 * LeadConversation — one row per (lead, conversation).
 *
 * `chatbot_leads` is the IDENTITY row: one per durable contact, deduped on
 * `dedupe_key`. That grain cannot express Story 3's per-conversation asks
 * ("conversation history summary", per-request intent/urgency, repeat detection),
 * because a returning customer collapses onto the same lead row — and the upsert
 * keeps only the LATEST `session_id` and the LATEST `notes`, so the identity row
 * silently describes whichever conversation touched it last.
 *
 * This table is the per-conversation SSOT. Two hard rules came out of review:
 *
 * 1. **No booking columns here.** A session can hold 0..n bookings, and neither
 *    reschedule nor cancel notifies the lead, so a cached `booking_status` would
 *    go stale invisibly. Booking facts are DERIVED on read by joining
 *    `chatbot_bookings.lead_id`. Address / requested service / preferred date /
 *    status / list price are all read that way, never copied.
 *
 * 2. **One conversation maps to at most one lead** — `UNIQUE (tenant_id, session_id)`.
 *    Rows are created by a narrow `associateLeadSession()` that inserts and does
 *    nothing else (no webhook, no notification, no lead-field write), so the
 *    association path can never replay the lead-creation fan-out. A session already
 *    linked to a DIFFERENT lead is an audited conflict, not a silent reparent.
 *
 * The extraction columns below are written only by the Release B enrichment job and
 * stay NULL until it runs. Every one of them is nullable on purpose: the extractor
 * is fail-closed, so "we could not establish this" is the normal outcome and must be
 * representable. There are deliberately NO CHECK constraints on the model-produced
 * vocabularies (`urgency`, `intent`) — a CHECK on an LLM vocabulary turns a bad
 * generation into a failed transaction, and widening it later means an ALTER.
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
import { Lead } from './Lead';
import { ChatSession } from './ChatSession';

/**
 * Enrichment lifecycle.
 *  - `pending`          — linked, not yet analyzed (also the Release A steady state)
 *  - `claimed`          — a worker holds the lease (`enrich_claimed_until`)
 *  - `enriched`         — extraction committed
 *  - `abstained`        — ran, but nothing cleared the grounding bar. NOT a failure:
 *                         the honest outcome for a conversation with no hard facts.
 *  - `failed`           — transient error; retried until attempts are exhausted
 *  - `skipped_legacy`   — predates enrichment; never analyzed by design (no backfill,
 *                         because a backfill would stamp the newest conversation's
 *                         urgency onto the oldest, most confidently for repeat customers)
 *  - `skipped_guardrail`— transcript was flagged spam/scam; deliberately not analyzed
 *  - `erased`           — subject exercised erasure; terminal, never re-enriched
 */
export type LeadEnrichState =
  | 'pending'
  | 'claimed'
  | 'enriched'
  | 'abstained'
  | 'failed'
  | 'skipped_legacy'
  | 'skipped_guardrail'
  | 'erased';

/** Where a structured value came from. Booking facts outrank model output. */
export type LeadConversationSource = 'link' | 'booking' | 'extractor';

/**
 * Per-field provenance + grounding. `value` is what we show; `evidenceMessageId`
 * is the CUSTOMER-authored message it came from (bot/agent text is not admissible —
 * otherwise an injected instruction could launder itself into a "grounded" field);
 * `span` is the verbatim substring, re-checked in code against the stored message.
 */
export interface LeadFieldEvidence {
  field: string;
  evidenceMessageId: string;
  span: string;
  source: LeadConversationSource;
}

@Entity('chatbot_lead_conversations')
// One lead's conversations, newest first — the detail drawer's read.
@Index('ix_lead_conv_lead', ['leadId', 'createdAt'])
// The association invariant. Partial on session_id so a future non-session-backed
// row (manual entry) doesn't collide on NULL.
@Index('ux_lead_conv_tenant_session', ['tenantId', 'sessionId'], {
  unique: true,
  where: '"session_id" IS NOT NULL',
})
// The enrichment sweep's claim query. Declared HERE as well as in the migration so
// the synchronize-built test schema and the migration-built prod schema agree —
// an index that exists only in prod means the sweep's plan is never exercised by
// any test, which is how index-shape surprises reach production in this repo.
@Index('ix_lead_conv_enrich_due', ['enrichNextAttemptAt'], {
  where: `"enrich_state" IN ('pending', 'failed')`,
})
export class LeadConversation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'lead_id' })
  leadId!: string;

  /** The conversation. Nullable so the row survives session deletion. */
  @Column({ type: 'uuid', name: 'session_id', nullable: true })
  sessionId?: string | null;

  @Column({ type: 'uuid', name: 'bot_id', nullable: true })
  botId?: string | null;

  /** Channel of this conversation (widget/whatsapp/messenger/instagram/telegram). */
  @Column({ type: 'varchar', length: 32, nullable: true })
  channel?: string | null;

  // ── Extracted, per-conversation (Release B writes these) ──────────────────
  /** What the customer asked for, in their own words where possible. */
  @Column({ type: 'text', nullable: true })
  request?: string | null;

  /** Verbatim service phrase. The AUTHORITATIVE service name comes from the
   *  joined booking's ServiceType when a booking exists — this is the fallback
   *  for conversations that never reached a booking. */
  @Column({ type: 'varchar', length: 160, name: 'service_requested', nullable: true })
  serviceRequested?: string | null;

  /** Verbatim, never translated or normalized — a "tidied" address is a wrong one. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  address?: string | null;

  /** Resolved in TS from a verbatim span + the evidence message's timestamp and the
   *  tenant timezone. The model never emits a date: "Tuesday evening" is only
   *  resolvable against when it was said. NULL whenever that resolution is ambiguous. */
  @Column({ type: 'timestamptz', name: 'preferred_at', nullable: true })
  preferredAt?: Date | null;

  /** The customer's own words, kept even when `preferred_at` could not be resolved,
   *  so an operator can read "Tuesday evening" instead of an empty cell. */
  @Column({ type: 'varchar', length: 160, name: 'preferred_at_text', nullable: true })
  preferredAtText?: string | null;

  /** Closed allowlist, mapped in code: emergency | urgent | routine. Anything else → NULL. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  urgency?: string | null;

  /** Closed allowlist: booking | quote | question | complaint | other. */
  @Column({ type: 'varchar', length: 24, nullable: true })
  intent?: string | null;

  /** Real Postgres text[] — NOT TypeORM `simple-array`, which is a comma-joined
   *  string and would corrupt any tag containing a comma. */
  @Column({ type: 'text', array: true, nullable: true })
  tags?: string[] | null;

  /** Bounded, key-allowlisted vertical tail (number of guests, problem type, …).
   *  Never a home for special-category data — see the extractor's deny-list. */
  @Column({ type: 'jsonb', name: 'enrichment', default: {} })
  enrichment!: Record<string, unknown>;

  /** Per-field grounding, so the UI can show the quote a value came from and a
   *  reviewer can audit it. Without this an inferred field is unfalsifiable. */
  @Column({ type: 'jsonb', name: 'evidence', default: [] })
  evidence!: LeadFieldEvidence[];

  // ── Enrichment control ────────────────────────────────────────────────────
  @Column({ type: 'varchar', length: 24, name: 'enrich_state', default: 'pending' })
  enrichState!: LeadEnrichState;

  /**
   * The `chat_sessions.transcript_revision` this row was enriched against.
   * Enrichment commits with a compare-and-swap on it: a message inserted, edited
   * or deleted mid-extraction advances the session's revision, the CAS fails, and
   * the work is requeued rather than committing a stale reading. A
   * `(created_at, id)` high-water mark cannot do this — it misses edits, deletes
   * and out-of-order commits.
   */
  @Column({ type: 'int', name: 'enriched_revision', nullable: true })
  enrichedRevision?: number | null;

  @Column({ type: 'smallint', name: 'enrich_attempts', default: 0 })
  enrichAttempts!: number;

  @Column({ type: 'timestamptz', name: 'enrich_next_attempt_at', nullable: true })
  enrichNextAttemptAt?: Date | null;

  /** Lease held by the claiming worker. Makes the sweep safe across replicas. */
  @Column({ type: 'timestamptz', name: 'enrich_claimed_until', nullable: true })
  enrichClaimedUntil?: Date | null;

  @Column({ type: 'text', name: 'enrich_last_error', nullable: true })
  enrichLastError?: string | null;

  /** Bumped when the extraction schema changes, so old rows are identifiable
   *  rather than silently compared against new-shape output. */
  @Column({ type: 'smallint', name: 'enrichment_version', nullable: true })
  enrichmentVersion?: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  model?: string | null;

  @Column({ type: 'varchar', length: 32, name: 'prompt_version', nullable: true })
  promptVersion?: string | null;

  /** Language the transcript was actually in. Recorded because a mismatch between
   *  it and the tenant's locale is the tell for the extraction-quality problems
   *  this platform has hit before. */
  @Column({ type: 'varchar', length: 8, name: 'extracted_language', nullable: true })
  extractedLanguage?: string | null;

  @Column({ type: 'varchar', length: 16, default: 'link' })
  source!: LeadConversationSource;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;

  // Erasure removes the lead; its conversation rows go with it.
  @ManyToOne(() => Lead, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'lead_id' })
  lead?: Lead;

  @ManyToOne(() => ChatSession, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'session_id' })
  session?: ChatSession;
}
