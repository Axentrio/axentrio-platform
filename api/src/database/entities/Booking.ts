/**
 * Booking — the internal scheduler's source-of-truth appointment row.
 *
 * Only `provider = 'internal'` bookings live here; Cal.com bookings are not
 * mirrored. Concurrency safety is enforced at the DB level by a buffer-aware
 * exclusion constraint on (`calendar_key`, `blocked_range`) for rows in
 * `pending`/`confirmed` status — see the migration. `blocked_range` (a
 * `tstzrange`) is managed via raw SQL on write and intentionally not mapped
 * here (TypeORM has no first-class range support).
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'failed' | 'request_created';

/** How the booking was handled: auto-confirmed vs captured as a request/lead. */
export type BookingMode = 'auto' | 'request';

@Index(['tenantId', 'botId', 'status'])
@Entity('chatbot_bookings')
export class Booking {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'bot_id' })
  botId!: string;

  @Column({ type: 'varchar', length: 16, default: 'internal' })
  provider!: string;

  /** FK → chatbot_service_types.id. Column name kept as `event_type_id` for
   *  back-compat with existing analytics/webhook/admin payloads. */
  @Column({ type: 'uuid', name: 'event_type_id', nullable: true })
  eventTypeId?: string | null;

  /** auto = confirmed appointment; request = captured as a request/lead. */
  @Column({ type: 'varchar', length: 16, name: 'booking_mode', nullable: true })
  bookingMode?: BookingMode | null;

  @Column({ type: 'uuid', name: 'session_id', nullable: true })
  sessionId?: string | null;

  @Column({ type: 'varchar', length: 24, default: 'pending' })
  status!: BookingStatus;

  /** Set when the row needs reconciliation with an external calendar (Phase 1+). */
  @Column({ type: 'boolean', name: 'sync_pending', default: false })
  syncPending!: boolean;

  /** Reconciliation retry/claim state (P0-4). */
  @Column({ type: 'int', name: 'sync_attempts', default: 0 })
  syncAttempts!: number;

  @Column({ type: 'timestamptz', name: 'sync_next_attempt_at', nullable: true })
  syncNextAttemptAt?: Date | null;

  @Column({ type: 'text', name: 'sync_last_error', nullable: true })
  syncLastError?: string | null;

  /** Short lease so concurrent reconciler runs/replicas don't double-process a row. */
  @Column({ type: 'timestamptz', name: 'sync_claimed_until', nullable: true })
  syncClaimedUntil?: Date | null;

  @Column({ type: 'timestamptz', name: 'start_utc' })
  startUtc!: Date;

  @Column({ type: 'timestamptz', name: 'end_utc' })
  endUtc!: Date;

  /** Conflict key: external calendar id once connected, else the bot id. */
  @Column({ type: 'text', name: 'calendar_key' })
  calendarKey!: string;

  @Column({ type: 'varchar', length: 255, name: 'attendee_name', nullable: true })
  attendeeName?: string | null;

  @Column({ type: 'varchar', length: 320, name: 'attendee_email', nullable: true })
  attendeeEmail?: string | null;

  @Column({ type: 'varchar', length: 64, name: 'customer_phone', nullable: true })
  customerPhone?: string | null;

  @Column({ type: 'varchar', length: 512, name: 'customer_address', nullable: true })
  customerAddress?: string | null;

  /** Which channel the booking originated from (widget/messenger/instagram/…). */
  @Column({ type: 'varchar', length: 32, name: 'source_channel', nullable: true })
  sourceChannel?: string | null;

  /** Structured answers to the service's intake questions (P3). */
  @Column({ type: 'jsonb', name: 'intake_answers', nullable: true })
  intakeAnswers?: Record<string, unknown> | null;

  /** Links to files uploaded during the booking conversation (P5). */
  @Column({ type: 'jsonb', name: 'uploaded_files', nullable: true })
  uploadedFiles?: unknown[] | null;

  /** Short AI-generated summary of the request, for the owner's records. */
  @Column({ type: 'text', name: 'ai_summary', nullable: true })
  aiSummary?: string | null;

  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  /** Stable iCalendar UID; immutable across reschedule/cancel. */
  @Column({ type: 'varchar', length: 255, name: 'ics_uid' })
  icsUid!: string;

  @Column({ type: 'int', default: 0 })
  sequence!: number;

  @Column({ type: 'jsonb', name: 'reminder_job_ids', default: [] })
  reminderJobIds!: string[];

  @Column({ type: 'varchar', length: 255, name: 'idempotency_key', nullable: true })
  idempotencyKey?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
