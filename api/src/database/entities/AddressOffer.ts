import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';

/**
 * One offered address suggestion on a Meta channel (#97 D3).
 *
 * The random `id` IS the button token: it is placed in the postback payload, so a tap names exactly
 * one offer row, and an old render's button can never consume a newer re-offer for the same place.
 * Only the durable `placeId` is stored, never the Google suggestion text (ADR-0014). `setId` groups
 * the options of one render; a tap consumes the whole set in one transaction, so picking any option
 * retires its siblings and two taps cannot move the binding twice.
 *
 * The entity exists alongside the migration because the integration test schema is built by
 * `synchronize()` from entity metadata, not by running migrations. The two must agree column for
 * column; see `AddressBinding` for the same rule.
 */
@Entity('chatbot_address_offers')
@Index(['setId'])
export class AddressOffer {
  /** The opaque token the button carries, in `ax:addr:pick:<id>`. */
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Shared by every option of one picker render, so a tap consumes the whole offer. */
  @Column({ type: 'uuid', name: 'set_id' })
  setId!: string;

  @Column({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  @Column({ type: 'varchar', length: 20 })
  channel!: string;

  /** The durable place identity, resolved afresh on a tap. ADR-0014 permits keeping this. */
  @Column({ type: 'text', name: 'place_id' })
  placeId!: string;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  /** Null until a tap claims the set. Set on all sibling rows at once. */
  @Column({ type: 'timestamptz', name: 'consumed_at', nullable: true })
  consumedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
