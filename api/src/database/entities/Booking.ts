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
import type { GeocodePrecision, LocationSource } from '../../contracts/travel';

/**
 * `'failed'` is deliberately ABSENT.
 *
 * The epic specifies a Failed status for "calendar event creation failed, slot became
 * unavailable, required information missing, calendar connection broken". This design
 * handles all four differently and therefore never reaches such a state: a lost slot or
 * missing information throws before any row exists, an unreachable calendar degrades to
 * `request_created`, and a failed calendar MIRROR leaves a genuinely-held `confirmed`
 * booking carrying `sync_pending`/`sync_last_error` — surfaced to the owner as
 * `calendarSync` on the bookings list.
 *
 * Marking that last case `failed` would be actively wrong: the slot IS held by the
 * exclusion constraint, and `failed` is excluded from the analytics and lead-readiness
 * queries, so a real appointment would be reported as though it had evaporated. The value
 * sat in this union for months with no code path writing it (prod: zero rows). Those
 * queries still name it defensively, which is harmless and covers any legacy row.
 */
export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'request_created';

/** How the booking was handled: auto-confirmed vs captured as a request/lead. */
export type BookingMode = 'auto' | 'request';

@Index(['tenantId', 'botId', 'status'])
// Declared here AND in migration 1787800000000 so the synchronize-built test schema and
// the migration-built prod schema agree — an index that exists only in prod means its
// query plan is never exercised by any test.
@Index('ix_bookings_lead', ['leadId'], { where: '"lead_id" IS NOT NULL' })
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

  /**
   * The Lead this booking belongs to. Set by the booking hook so the Leads page can
   * DERIVE address / service / preferred date / status / list price by join rather
   * than copying them onto the lead — a cached status would go stale the moment the
   * booking is rescheduled or cancelled, and neither path notifies the lead row.
   */
  @Column({ type: 'uuid', name: 'lead_id', nullable: true })
  leadId?: string | null;

  @Column({ type: 'uuid', name: 'session_id', nullable: true })
  sessionId?: string | null;

  /**
   * What the service-area gate saw for this booking: 'inside' | 'outside' | 'unknown'.
   *
   * NULL means the gate did not apply — no address required, or no enforceable area — which
   * is not a fourth verdict and is what every pre-existing row holds. Recorded on the
   * REQUEST path too, where the gate deliberately does not enforce: capturing an out-of-area
   * job is correct, silently capturing it is not.
   */
  @Column({ type: 'varchar', length: 16, name: 'service_area_match', nullable: true })
  serviceAreaMatch?: 'inside' | 'outside' | 'unknown' | null;

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

  /**
   * WHERE the job is, as opposed to what the customer typed. All null on every row
   * created before travel-time scheduling, and all null forever on a service that needs
   * no address — which reads as "unknown location" and behaves exactly as today.
   *
   * The split between the next two groups is a licensing constraint, not a modelling
   * preference (ADR-0014). `customerPlaceId` is Google's durable identity and may be kept
   * for as long as the booking lives. The coordinates are a DERIVED CACHE the Maps terms
   * permit for 30 consecutive days and no longer, so they are deleted on expiry and
   * re-resolved from the place id — with a 60-day default booking horizon, re-resolution
   * before a far-future appointment is the normal path, not an edge case.
   */
  /**
   * TEXT rather than a bounded varchar on purpose: Google documents that "there is no
   * maximum length for place IDs". Any ceiling we picked would be a guess that turns a valid
   * answer into a failed INSERT on a customer's booking.
   */
  @Column({ type: 'text', name: 'customer_place_id', nullable: true })
  customerPlaceId?: string | null;

  @Column({ type: 'double precision', name: 'customer_lat', nullable: true })
  customerLat?: number | null;

  @Column({ type: 'double precision', name: 'customer_lng', nullable: true })
  customerLng?: number | null;

  /** When the coordinates above were resolved — what the 30-day deletion job reads. */
  @Column({ type: 'timestamptz', name: 'customer_coords_at', nullable: true })
  customerCoordsAt?: Date | null;

  /**
   * The address string that was actually placed and checked, which is not always the one
   * the customer typed. Bound to the booking so create cannot silently confirm against a
   * different string than the one availability was filtered on.
   */
  @Column({ type: 'varchar', length: 512, name: 'customer_address_verified', nullable: true })
  customerAddressVerified?: string | null;

  /**
   * How precisely Google placed it.
   *
   * Load-bearing, not metadata. `approximate` is a town centre — it collapses every
   * address in a municipality onto one dot, so it can prove a drive impossible and can
   * never prove one fine. Stored even when untrusted, so an owner or an audit can see
   * what the gate had to work with. Typed off the contract rather than left a bare
   * string, so `isTrustedForTravel` and this column can never fall out of step.
   */
  @Column({ type: 'varchar', length: 24, name: 'geocode_precision', nullable: true })
  geocodePrecision?: GeocodePrecision | null;

  /** `'pin'` (the customer shared a location) | `'geocoded'`. Provenance decides trust. */
  @Column({ type: 'varchar', length: 16, name: 'location_source', nullable: true })
  locationSource?: LocationSource | null;

  /**
   * What the travel gate DID: `'ok'` verified, `'degraded'` decided on the haversine
   * proofs alone because routing was unreachable or the tenant's cap was spent,
   * `'captured'` held as a request because there was nothing to reason over, and
   * `'overridden'` confirmed by the owner accepting that request.
   *
   * Null means no leg constrained the verdict — the gate did not apply, or there was simply
   * no drive to consider. Not a fifth verdict, and what every pre-existing row holds.
   *
   * `'degraded'` IS NOT A FAULT and a run of it IS NOT AN OUTAGE. It says only that routing
   * did not measure every constraining leg, which is the ordinary state of a business whose
   * jobs are close together — the haversine floor settles those for free, on purpose. An
   * outage looks identical in this column, which is why anything watching for one must key on
   * the structured cause the gate returns and never on this value.
   */
  @Column({ type: 'varchar', length: 24, name: 'travel_check', nullable: true })
  travelCheck?: 'ok' | 'degraded' | 'captured' | 'overridden' | null;

  /** P5c — frozen effective length in minutes (null only for pre-P5c rows). */
  @Column({ type: 'int', name: 'booked_duration_min', nullable: true })
  bookedDurationMin?: number | null;

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

  /**
   * The ICS ORGANIZER, frozen at creation — and it MUST stay frozen.
   *
   * It used to be resolved fresh from `ai.supportEmail` on every send, so a tenant editing
   * or clearing that setting silently changed the organizer of every in-flight booking.
   * Outlook and Exchange treat an update from a different organizer as coming from a
   * stranger: the reschedule duplicates instead of moving, and — the part that actually
   * hurts — the CANCEL never removes the customer's event.
   *
   * Null on rows created before this column existed; those fall back to the old
   * resolution so their update/cancel chain keeps matching the invite already sent.
   */
  @Column({ type: 'varchar', length: 320, name: 'organizer_email', nullable: true })
  organizerEmail?: string | null;

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
