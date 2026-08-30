/**
 * ServiceType — a bookable service for the internal scheduler.
 *
 * Multiple active services per bot (the catalog). Business availability lives
 * separately on `AvailabilityRule` (one per bot, shared by all services); each
 * service contributes its own duration/buffers/notice/horizon to the slot
 * engine. Cal.com bots don't use this — internal-provider only.
 *
 * Table is still `chatbot_service_types` (renamed from `chatbot_event_types`);
 * `Booking.event_type_id` keeps its column name for back-compat.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Tenant } from './Tenant';
import { Bot } from './Bot';

/**
 * Where a Service happens, as far as the calendar invite is concerned.
 *
 * `business_location` and `customer_location` are the explicit physical answers. The
 * dropdown offers those instead of `in_person`. `in_person` remains only as a review
 * leftover until the owner picks; it is not a value a new service can enter.
 *
 * `unset` is the state the column was MISSING, and #71 is what its absence cost. The column
 * shipped defaulting to `custom`, which means "put no location on the invite", and no migration
 * ever backfilled it - so every Service created by hand before the dropdown existed silently
 * said "no location". Rather than guess, `unset` means NOBODY WAS EVER ASKED, `custom` means
 * somebody was asked and chose none. The dropdown never offers `unset` or `in_person`.
 */
export type LocationType =
  | 'google_meet'
  | 'phone'
  | 'business_location'
  | 'customer_location'
  | 'in_person'
  | 'custom'
  | 'unset';
export type BookingMode = 'auto' | 'request';
/** Distinct from BookingMode: how a Booking Customer may move or cancel an existing appointment. */
export type CustomerChangeMode = 'auto' | 'request' | 'not_allowed';
export type DurationMode = 'fixed' | 'range' | 'ai';
export type PriceDisplayType = 'none' | 'fixed' | 'from' | 'range' | 'on_request' | 'free';

/** Optional discount layer applied on top of the configured price. */
export type DiscountType = 'percentage' | 'fixed';

/** P3: a per-service intake question the agent asks before booking/requesting. */
export type IntakeQuestionType = 'text' | 'choice';
export interface IntakeQuestion {
  /** Server-minted uuid, stable across edits (the answer key). */
  id: string;
  label: string;
  type: IntakeQuestionType;
  required: boolean;
  /** Only present for `choice`. */
  options?: string[];
  /**
   * A short owner-written steer for HOW or WHEN to ask, given to the model alongside the
   * label — "only if they mention a leak", "accept a rough guess". The label alone says
   * what to ask and nothing about judgement, which is the whole reason owners were
   * smuggling instructions into the label text.
   */
  aiInstruction?: string;
  /** A sample answer, shown to the model so it recognises a good one. */
  exampleAnswer?: string;
  /**
   * Whether this question is currently asked. Absent = true, which is every existing row.
   *
   * A paused question keeps its id, so ANSWERS ALREADY COLLECTED still render under their
   * label — deleting the question instead orphans them to a raw uuid.
   */
  active?: boolean;
  /**
   * Whether the answer goes on the owner's calendar entry. Absent = true (today's
   * behaviour). Off for the ones that are useful to the bot but noise in a calendar body.
   */
  includeInCalendar?: boolean;
}

/** Postgres `numeric` round-trips as a string in node-pg; map to number both ways. */
const numericTransformer = {
  to: (v: number | null | undefined) => v ?? null,
  from: (v: string | null) => (v === null || v === undefined ? null : Number(v)),
};

@Entity('chatbot_service_types')
export class ServiceType {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'bot_id' })
  botId!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 255 })
  slug!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  category?: string | null;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  /** auto = AI can confirm directly; request = collect info + create a lead/request. */
  @Column({ type: 'varchar', length: 16, name: 'booking_mode', default: 'auto' })
  bookingMode!: BookingMode;

  /**
   * Whether a Booking Customer may reschedule an existing appointment for this Service.
   * Default `auto` preserves today's behaviour. Not implied by `bookingMode`.
   */
  @Column({ type: 'varchar', length: 16, name: 'reschedule_mode', default: 'auto' })
  rescheduleMode!: CustomerChangeMode;

  @Column({ type: 'varchar', length: 16, name: 'cancel_mode', default: 'auto' })
  cancelMode!: CustomerChangeMode;

  /**
   * Minutes before start after which a customer reschedule is not allowed.
   * Null = no extra cutoff. `0` = until the start instant.
   */
  @Column({ type: 'int', name: 'reschedule_until_min', nullable: true })
  rescheduleUntilMin?: number | null;

  @Column({ type: 'int', name: 'cancel_until_min', nullable: true })
  cancelUntilMin?: number | null;

  @Column({ type: 'boolean', name: 'online_bookable', default: true })
  onlineBookable!: boolean;

  @Column({ type: 'varchar', length: 16, name: 'duration_mode', default: 'fixed' })
  durationMode!: DurationMode;

  @Column({ type: 'int', name: 'duration_min', default: 30 })
  durationMin!: number;

  @Column({ type: 'int', name: 'min_duration_min', nullable: true })
  minDurationMin?: number | null;

  @Column({ type: 'int', name: 'max_duration_min', nullable: true })
  maxDurationMin?: number | null;

  /**
   * The four timing fields below are NULLABLE, and null means INHERIT from
   * `BookingSettings` (then from the platform fallback). They were NOT NULL with DB
   * defaults, which made "unset" indistinguishable from 0 and business-level defaults
   * impossible to express. Resolve them through `resolveServiceTiming`, never directly.
   */
  @Column({ type: 'int', name: 'buffer_before_min', nullable: true })
  bufferBeforeMin?: number | null;

  @Column({ type: 'int', name: 'buffer_after_min', nullable: true })
  bufferAfterMin?: number | null;

  /** Minimum lead time before a slot can be booked, in minutes. */
  @Column({ type: 'int', name: 'min_notice_min', nullable: true })
  minNoticeMin?: number | null;

  /** How far ahead bookings are allowed, in days. */
  @Column({ type: 'int', name: 'max_horizon_days', nullable: true })
  maxHorizonDays?: number | null;

  @Column({ type: 'int', name: 'max_bookings_per_day', nullable: true })
  maxBookingsPerDay?: number | null;

  @Column({ type: 'varchar', length: 16, name: 'price_display_type', default: 'none' })
  priceDisplayType!: PriceDisplayType;

  @Column({ type: 'numeric', precision: 10, scale: 2, name: 'fixed_price', nullable: true, transformer: numericTransformer })
  fixedPrice?: number | null;

  @Column({ type: 'numeric', precision: 10, scale: 2, name: 'min_price', nullable: true, transformer: numericTransformer })
  minPrice?: number | null;

  @Column({ type: 'numeric', precision: 10, scale: 2, name: 'max_price', nullable: true, transformer: numericTransformer })
  maxPrice?: number | null;

  @Column({ type: 'varchar', length: 255, name: 'price_note', nullable: true })
  priceNote?: string | null;

  /**
   * Optional discount layer ON TOP of the configured price. `discountEnabled` off (default)
   * keeps every existing row at its list price. When on with a valid type + value, the
   * backend computes the final price; `resolveServiceDiscount` is the single source of truth,
   * never re-derived at a call site. The optional date window is a calendar day range in the
   * business timezone, inclusive; a null bound is open-ended on that side.
   */
  @Column({ type: 'boolean', name: 'discount_enabled', default: false })
  discountEnabled!: boolean;

  @Column({ type: 'varchar', length: 16, name: 'discount_type', nullable: true })
  discountType?: DiscountType | null;

  @Column({ type: 'numeric', precision: 10, scale: 2, name: 'discount_value', nullable: true, transformer: numericTransformer })
  discountValue?: number | null;

  /** Inclusive first day the discount applies, `yyyy-MM-dd` (business-local). Null = no lower bound. */
  @Column({ type: 'date', name: 'discount_start_on', nullable: true })
  discountStartOn?: string | null;

  /** Inclusive last day the discount applies, `yyyy-MM-dd` (business-local). Null = no upper bound. */
  @Column({ type: 'date', name: 'discount_end_on', nullable: true })
  discountEndOn?: string | null;

  /**
   * Whether the assistant may present the discount AS a discount. Off (default) = the bot
   * quotes the final price only and never advertises the reduction; on = the bot may
   * proactively state the original price, the discount and the final price.
   */
  @Column({ type: 'boolean', name: 'mention_discount_in_chat', default: false })
  mentionDiscountInChat!: boolean;

  @Column({ type: 'boolean', name: 'customer_location_required', default: false })
  customerLocationRequired!: boolean;

  @Column({ type: 'boolean', name: 'customer_address_required', default: false })
  customerAddressRequired!: boolean;

  /**
   * #149 — this Service can happen at the premises OR at the Booking Customer's
   * address; the customer chooses at booking time. A fact the resolver projects
   * into `customer_choice`. Default false = today's single-mode behaviour.
   */
  @Column({ type: 'boolean', name: 'customer_chooses_location', default: false })
  customerChoosesLocation!: boolean;

  @Column({ type: 'boolean', name: 'file_upload_allowed', default: false })
  fileUploadAllowed!: boolean;

  @Column({ type: 'text', name: 'preparation_instructions', nullable: true })
  preparationInstructions?: string | null;

  /**
   * P3: owner-authored intake questions (jsonb array, max ~8). Null = none.
   * Stays loosely typed on read — a legacy/hand-edited non-array degrades to
   * "no questions" at every consumer rather than throwing.
   */
  @Column({ type: 'jsonb', name: 'intake_questions', nullable: true })
  intakeQuestions?: IntakeQuestion[] | null;

  @Column({ type: 'varchar', length: 32, name: 'location_type', default: 'custom' })
  locationType!: LocationType;

  @Column({ type: 'int', name: 'sort_order', default: 0 })
  sortOrder!: number;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;

  @ManyToOne(() => Bot, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bot_id' })
  bot?: Bot;
}
