/**
 * BookingSettings — booking configuration that belongs to the BUSINESS rather than to one
 * service or one weekly schedule.
 *
 * Why a table of its own rather than another column on `AvailabilityRule`: that row answers
 * *when* the owner is bookable, and a service area answers *where* they will work. They are
 * edited together in one card, but they are not the same fact, and folding one into the
 * other would leave the next business-level setting (a daily cap, a default notice period)
 * with nowhere honest to live either.
 *
 * One row per bot, created lazily on first write — a bot without one simply has no service
 * area, which is the behaviour every bot had before this table existed.
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
import type { ServiceAreaEntry } from '../../contracts/service-area';
import { Tenant } from './Tenant';
import { Bot } from './Bot';

@Entity('chatbot_booking_settings')
@Index(['botId'], { unique: true })
export class BookingSettings {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'bot_id' })
  botId!: string;

  /**
   * Places this business serves. Empty array = no area configured, which never blocks a
   * booking. Stays loosely typed on read: a legacy or hand-edited non-array degrades to
   * "no area" at every consumer rather than throwing mid-booking.
   */
  @Column({ type: 'jsonb', name: 'service_area', default: () => `'[]'::jsonb` })
  serviceArea!: ServiceAreaEntry[];

  /**
   * Capacity protection for a solo owner. All three are CEILINGS, not defaults: they apply
   * on top of whatever each service specifies, and the stricter of the two binds. Making
   * them inherit instead was not possible without a nullability migration — every other
   * per-service timing field is NOT NULL with a DB default, so "unset" is indistinguishable
   * from zero, and only `ServiceType.maxBookingsPerDay` has a real absent state.
   *
   * `null` or `0` means unlimited on all three, matching how the per-service cap already
   * degrades: a malformed value must read as "no limit", never as "no bookings".
   */

  /** Across every service, not per service — five services capped at 2 still allowed 10. */
  @Column({ type: 'int', name: 'max_bookings_per_day', nullable: true })
  maxBookingsPerDay?: number | null;

  /** Total booked minutes in a local day. Five 4-hour jobs used to fit an 8-hour day. */
  @Column({ type: 'int', name: 'max_booked_minutes_per_day', nullable: true })
  maxBookedMinutesPerDay?: number | null;

  /**
   * Free minutes left around every existing appointment, IN ADDITION to per-service
   * buffers. Additive rather than a floor on the total, because that is the version an
   * owner can predict: buffers are the service's own prep/cleanup, this is their travel
   * and breathing room. Doubles as the epic's "travel buffer" — a distance-derived one
   * needs geocoding this platform deliberately does not have.
   */
  @Column({ type: 'int', name: 'min_gap_min', nullable: true })
  minGapMin?: number | null;

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
