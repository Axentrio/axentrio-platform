import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';

/**
 * WHAT WAS ACTUALLY PUT IN FRONT OF A CUSTOMER, and what they did about it (#80, LP3).
 *
 * The pre-steering baseline. LP5 has to prove that reordering slots helps, which means knowing
 * how often a customer took the FIRST slot offered before anything reordered them - and that
 * number cannot be reconstructed afterwards. Every booking taken before these tables exist is a
 * booking nothing can ever be compared against, which is why this ships before the pilot rather
 * than with it.
 *
 * MEASUREMENT ONLY. Nothing here changes what a customer sees, spends a Google element, or
 * reorders anything. LP4 populates the ranking columns in shadow; LP5 is the first phase that
 * acts.
 *
 * APPEND-ONLY, and every cohort is a query rather than a stored verdict. `selected`, `superseded`
 * and `expired unselected` are derived at read time, so nothing ever writes "abandoned" about a
 * customer who then books on day five. See `docs/specs/lp3-offer-record.md`.
 */

/**
 * How much is known about whether the message arrived.
 *
 * NOT a link to `MessageDelivery`, whose successful rows are deleted after 7 days
 * (`server.ts` channel-log sweep) - a foreign key here would dangle within a week. A static enum
 * captured at write time survives.
 */
export type OfferDeliveryBasis =
  /** An external channel transport reported success. A real acknowledgement. */
  | 'provider_accepted'
  /** The transport reported failure. The slots were composed but not delivered. */
  | 'provider_rejected'
  /** The widget path, which has no durable delivery record at all. Assumed, and labelled so. */
  | 'widget_assumed';

/**
 * One slot as the customer received it.
 *
 * BOTH the canonical instant and the presented text, and the reason is the finding that resized
 * this ticket. The record has to store what the customer SAW - channels truncate quick replies by
 * `capabilities.maxQuickReplies` and drop them where unsupported - but what they saw is
 * natural-language ("Wed 2:00 PM"), and `buildSlotQuickReplies` discards the ISO instant one line
 * after computing it. Storing only the presentation makes a Booking unmatchable; storing only the
 * instant records slots nobody was shown.
 */
export interface OfferedSlot {
  /** ISO instant, the join key back to `Booking.startUtc`. */
  start: string;
  /** The chip label as rendered. Evidence, never parsed. */
  title: string;
  /**
   * What the grouping scorer thought of this slot (#81), when it ran.
   *
   * Carried ON the slot rather than in a parallel array, because the pairing between a time and
   * its cost is the thing that must not drift - an array indexed by position is one truncation
   * away from attributing a cost to the wrong time.
   *
   * Absent means the scorer did not run for this offer at all. `costMinutes: null` WITH a reason
   * means it ran and declined to have an opinion, which is a different and useful fact.
   */
  costMinutes?: number | null;
  preferred?: boolean | null;
  neutralReason?: string | null;
  period?: 'morning' | 'afternoon' | null;
}

@Entity('chatbot_booking_offers')
// The attribution lookup: latest offer for this session and service before a given moment.
@Index('ix_booking_offers_attribution', ['sessionId', 'serviceId', 'createdAt'])
@Index('ix_booking_offers_created', ['createdAt'])
export class BookingOffer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'bot_id' })
  botId!: string;

  /** No foreign key: a purged session must not be held alive by a measurement row. */
  @Column({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  @Column({ type: 'uuid', name: 'service_id', nullable: true })
  serviceId?: string | null;

  /** The call these slots came from, so a surfaced call can be told from a discarded one. */
  @Column({ type: 'uuid', name: 'availability_call_id', nullable: true })
  availabilityCallId?: string | null;

  /**
   * The LP1 resolver's answer at the time of the offer (#79).
   *
   * Stored rather than joined, because a Service's mode can change and the baseline is about what
   * was true when the offer went out. Also what the location-scoped questions filter on, which is
   * how this table serves both the location-dependent and location-independent metrics without
   * needing a narrower table.
   */
  @Column({ type: 'varchar', length: 32, name: 'location_mode', nullable: true })
  locationMode?: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  channel?: string | null;

  /** Ordered, exactly as delivered, already truncated to what the channel actually sent. */
  @Column({ type: 'jsonb', name: 'offered_slots' })
  offeredSlots!: OfferedSlot[];

  /** Redundant with the array on purpose: the cheap check that a later reader parsed it right. */
  @Column({ type: 'int', name: 'offered_count' })
  offeredCount!: number;

  @Column({ type: 'varchar', length: 32, name: 'delivery_basis' })
  deliveryBasis!: OfferDeliveryBasis;

  /**
   * Which scorer produced the numbers on this row.
   *
   * Two versions disagreeing is not instability, and without this the gate could not tell them
   * apart - which would make "is the ranking stable" unfalsifiable the first time the scorer
   * changed.
   */
  @Column({ type: 'varchar', length: 32, name: 'scorer_version', nullable: true })
  scorerVersion?: string | null;

  /** Billable elements this scoring spent. Null when it did not run. */
  @Column({ type: 'int', name: 'scoring_elements', nullable: true })
  scoringElements?: number | null;

  @Column({ type: 'int', name: 'scoring_ms', nullable: true })
  scoringMs?: number | null;

  /**
   * The order the scorer WOULD have offered, as ISO instants.
   *
   * The counterfactual is the whole of LP4: nothing was reordered, so this is the only record of
   * what steering would have done, and LP5's comparison is against it. Stored explicitly rather
   * than recomputed from the costs later, because a recomputation would use whatever the ordering
   * rules had become by then.
   */
  @Column({ type: 'jsonb', name: 'counterfactual_order', nullable: true })
  counterfactualOrder?: string[] | null;

  /**
   * Did the scorer have anywhere better to point than the slot offered first?
   *
   * LP4's most decision-shaped number: if steering rarely has a cheaper alternative, the pilot
   * cannot move any metric whatever it does, and the epic stops here having cost one ticket
   * rather than a live feature.
   *
   * A COLUMN rather than a derivation, because it is a statement about every slot the scorer saw
   * and this row keeps only the ones the channel delivered. Recomputing it later would silently
   * answer a smaller question.
   */
  @Column({ type: 'boolean', name: 'cheaper_alternative_existed', nullable: true })
  cheaperAlternativeExisted?: boolean | null;

  /**
   * The order was actually CHANGED before this offer went out (#82, LP5).
   *
   * The owner's half of "both parties are told", in a form they can be shown and a query can
   * count. It is also what separates the pilot cohort from the shadow one: LP4 records what the
   * scorer would have done, and without this there is no way to tell the offers where it did.
   *
   * Null means the pilot was off for this offer; `false` would claim it looked and declined.
   */
  @Column({ type: 'boolean', name: 'grouping_applied', nullable: true })
  groupingApplied?: boolean | null;

  /** Minutes of driving the promoted slot saves over the one that would have been first. */
  @Column({ type: 'int', name: 'grouping_saved_minutes', nullable: true })
  groupingSavedMinutes?: number | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
