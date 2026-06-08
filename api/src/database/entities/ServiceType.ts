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

export type LocationType = 'google_meet' | 'phone' | 'in_person' | 'custom';
export type BookingMode = 'auto' | 'request';
export type DurationMode = 'fixed' | 'range' | 'ai';
export type PriceDisplayType = 'none' | 'fixed' | 'from' | 'range' | 'on_request';

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

  @Column({ type: 'int', name: 'buffer_before_min', default: 0 })
  bufferBeforeMin!: number;

  @Column({ type: 'int', name: 'buffer_after_min', default: 0 })
  bufferAfterMin!: number;

  /** Minimum lead time before a slot can be booked, in minutes. */
  @Column({ type: 'int', name: 'min_notice_min', default: 0 })
  minNoticeMin!: number;

  /** How far ahead bookings are allowed, in days. */
  @Column({ type: 'int', name: 'max_horizon_days', default: 60 })
  maxHorizonDays!: number;

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

  @Column({ type: 'boolean', name: 'customer_location_required', default: false })
  customerLocationRequired!: boolean;

  @Column({ type: 'boolean', name: 'customer_address_required', default: false })
  customerAddressRequired!: boolean;

  @Column({ type: 'boolean', name: 'file_upload_allowed', default: false })
  fileUploadAllowed!: boolean;

  @Column({ type: 'text', name: 'preparation_instructions', nullable: true })
  preparationInstructions?: string | null;

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
