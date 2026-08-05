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

  /**
   * Business-level timing DEFAULTS — distinct from the ceilings above.
   *
   * A ceiling always applies and the stricter wins; a default applies only where the
   * service left the field null. This is what stops a solo owner restating the same
   * notice period and buffers on every service they offer. Null here too means "no
   * business default", falling through to the platform fallback.
   */
  @Column({ type: 'int', name: 'default_buffer_before_min', nullable: true })
  defaultBufferBeforeMin?: number | null;

  @Column({ type: 'int', name: 'default_buffer_after_min', nullable: true })
  defaultBufferAfterMin?: number | null;

  @Column({ type: 'int', name: 'default_min_notice_min', nullable: true })
  defaultMinNoticeMin?: number | null;

  @Column({ type: 'int', name: 'default_max_horizon_days', nullable: true })
  defaultMaxHorizonDays?: number | null;

  /**
   * Where customers come TO — never the VAT/legal address.
   *
   * The registered address sits in the tenant's onboarding record and is off limits here:
   * it is write-once, unvalidated, and for a sole trader is usually their home. Putting it
   * on invites sent to strangers is what GDPR Art. 25(2) means by making personal data
   * accessible to an indefinite number of people *by default*. So these start null for
   * every tenant, are never backfilled, and reach an invite only once an owner types one
   * in. Components rather than a single line because Graph accepts structure and ICS does
   * not — flattening later is free, parsing later is not.
   */
  @Column({ type: 'varchar', length: 200, name: 'venue_street', nullable: true })
  venueStreet?: string | null;

  @Column({ type: 'varchar', length: 200, name: 'venue_postal_code', nullable: true })
  venuePostalCode?: string | null;

  @Column({ type: 'varchar', length: 200, name: 'venue_city', nullable: true })
  venueCity?: string | null;

  @Column({ type: 'varchar', length: 2, name: 'venue_country', nullable: true })
  venueCountry?: string | null;

  /**
   * "Stop taking new bookings", without dismantling anything.
   *
   * An owner who is ill, away, or simply full had only two options: delete their weekly
   * hours (and rebuild them afterwards from memory) or pause the whole bot, which also
   * silences it for every question that has nothing to do with booking.
   *
   * NOT NULL with a default rather than nullable: the venue columns are nullable because
   * "unset" is a meaningful, GDPR-relevant state for an address. A switch has two states,
   * and a nullable boolean would invent a third that means the same as false.
   *
   * Paused CAPTURES, it does not refuse — see the enforcement in internal.provider, which
   * joins the same fork as "no connected calendar".
   */
  @Column({ type: 'boolean', name: 'bookings_paused', default: false })
  bookingsPaused!: boolean;

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
