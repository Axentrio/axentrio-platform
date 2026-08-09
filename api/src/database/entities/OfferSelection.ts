import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';

/**
 * A customer took one of the slots they were offered (#80, LP3).
 *
 * The only outcome that is ever WRITTEN. `superseded` and `expired unselected` are derived at
 * query time from the offers themselves, so nothing here ever asserts that a customer abandoned
 * anything - a claim the system cannot observe, and one that would be permanently wrong about
 * somebody who books on day five.
 */

/**
 * What the row was AT SELECTION TIME, frozen.
 *
 * A Request is not a separate entity in this schema - it is a `chatbot_bookings` row with status
 * `request_created`, and the owner can later accept it into `confirmed`. So this cannot be
 * derived from current status: every accepted Request would migrate from expressed-choice into
 * conversion, and the baseline would improve on its own without anything having changed.
 */
export type OfferSelectionType =
  /** The customer's chosen time was booked. */
  | 'booking'
  /** The gate captured it as a Request instead. Expressed choice, not conversion. */
  | 'request';

@Entity('chatbot_offer_selections')
@Index('ix_offer_selections_offer', ['offerId'])
export class OfferSelection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'offer_id' })
  offerId!: string;

  /**
   * The `chatbot_bookings` row this selection produced. UNIQUE, and that is the constraint that
   * matters: one Booking gets exactly one attribution. A uniqueness rule on `(offer, entity)`
   * would still allow the same Booking to be attributed to several offers and counted twice in
   * every denominator.
   */
  @Column({ type: 'uuid', name: 'selection_entity_id', unique: true })
  selectionEntityId!: string;

  @Column({ type: 'varchar', length: 16, name: 'selection_type' })
  selectionType!: OfferSelectionType;

  /** 1-based position in `offeredSlots`. `1` is the whole point of the baseline. */
  @Column({ type: 'int', name: 'selected_ordinal' })
  selectedOrdinal!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
